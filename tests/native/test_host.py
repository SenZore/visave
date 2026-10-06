import io
import ctypes
import errno
import json
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock


PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT))

from native import host


@unittest.skipUnless(host.os.name == "nt", "Windows Shell API")
class ExplorerTests(unittest.TestCase):
    def shell_apis(self):
        shell, ole = mock.Mock(), mock.Mock()
        ole.CoInitializeEx.return_value = 0
        def parse(name, context, output, flags, attributes):
            ctypes.cast(output, ctypes.POINTER(ctypes.c_void_p))[0] = 12345
            return 0
        shell.SHParseDisplayName.side_effect = parse
        shell.SHOpenFolderAndSelectItems.return_value = 0
        return shell, ole

    def test_unicode_file_uses_exact_shell_item_without_explorer_command_line(self):
        with tempfile.TemporaryDirectory() as temporary:
            saved = Path(temporary) / "Saved ⧸ clip, name.mp4"
            saved.write_bytes(b"media")
            shell, ole = self.shell_apis()
            with mock.patch.object(host.ctypes, "WinDLL", side_effect=[shell, ole]), mock.patch.object(host.subprocess, "Popen") as popen:
                host.reveal_saved_file(saved)
            self.assertEqual(shell.SHParseDisplayName.call_args.args[0], str(saved.resolve()))
            item, count, children, flags = shell.SHOpenFolderAndSelectItems.call_args.args
            self.assertEqual(item.value, 12345)
            self.assertEqual((count, children, flags), (0, None, 0))
            ole.CoTaskMemFree.assert_called_once()
            ole.CoUninitialize.assert_called_once()
            popen.assert_not_called()

    def test_missing_file_or_directory_never_opens_explorer(self):
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(host.ctypes, "WinDLL") as dll:
            for path in [Path(temporary), Path(temporary) / "missing.mp4"]:
                with self.assertRaises(OSError):
                    host.reveal_saved_file(path)
            dll.assert_not_called()

    def test_shell_failure_frees_item_and_does_not_launch_a_fallback_folder(self):
        with tempfile.TemporaryDirectory() as temporary:
            saved = Path(temporary) / "clip.mp4"
            saved.write_bytes(b"media")
            shell, ole = self.shell_apis()
            shell.SHOpenFolderAndSelectItems.return_value = -2147467259
            with mock.patch.object(host.ctypes, "WinDLL", side_effect=[shell, ole]), mock.patch.object(host.subprocess, "Popen") as popen:
                with self.assertRaisesRegex(OSError, "0x80004005"):
                    host.reveal_saved_file(saved)
            ole.CoTaskMemFree.assert_called_once()
            ole.CoUninitialize.assert_called_once()
            popen.assert_not_called()

    def test_real_windows_parser_round_trips_unicode_filename_without_opening_explorer(self):
        with tempfile.TemporaryDirectory() as temporary:
            saved = Path(temporary) / "Saved ⧸ clip, name.mp4"
            saved.write_bytes(b"media")
            shell = ctypes.WinDLL("shell32")
            ole = ctypes.WinDLL("ole32")
            shell.SHGetPathFromIDListW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
            shell.SHGetPathFromIDListW.restype = ctypes.c_int
            selected = []
            def select(item, count, children, flags):
                buffer = ctypes.create_unicode_buffer(32768)
                self.assertTrue(shell.SHGetPathFromIDListW(item, buffer))
                selected.append(buffer.value)
                self.assertEqual((count, children, flags), (0, None, 0))
                return 0
            with mock.patch.object(shell, "SHOpenFolderAndSelectItems", side_effect=select), mock.patch.object(host.ctypes, "WinDLL", side_effect=[shell, ole]):
                host.reveal_saved_file(saved)
            self.assertEqual(selected, [str(saved.resolve())])


class ProtocolTests(unittest.TestCase):
    def test_round_trip_frame_uses_native_uint32_and_utf8_json(self):
        message = {"id": "café", "action": "probe"}
        frame = host.encode_message(message)

        self.assertEqual(struct.unpack("=I", frame[:4])[0], len(frame[4:]))
        self.assertEqual(host.read_message(io.BytesIO(frame)), message)

    def test_read_message_rejects_truncated_payload(self):
        stream = io.BytesIO(struct.pack("=I", 12) + b"{}")

        with self.assertRaisesRegex(host.ProtocolError, "declared length"):
            host.read_message(stream)

    def test_read_message_rejects_oversized_payload_before_reading_body(self):
        stream = io.BytesIO(struct.pack("=I", host.MAX_MESSAGE_BYTES + 1))

        with self.assertRaisesRegex(host.ProtocolError, "length is invalid"):
            host.read_message(stream)

    def test_writer_serializes_complete_frames(self):
        class RecordingStream:
            def __init__(self):
                self.frames = []

            def write(self, value):
                self.frames.append(value)

            def flush(self):
                pass

        stream = RecordingStream()
        writer = host.NativeWriter(stream)
        threads = [threading.Thread(target=writer.send, args=({"id": number},)) for number in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(len(stream.frames), 8)
        decoded = [host.read_message(io.BytesIO(frame))["id"] for frame in stream.frames]
        self.assertCountEqual(decoded, range(8))


class ValidationTests(unittest.TestCase):
    def test_download_accepts_http_and_defaults_cookie_consent_to_false(self):
        request = host.validate_request(
            {"id": 1, "action": "download", "url": "https://example.test/watch?v=1", "output": "mp4", "quality": "720"}
        )

        self.assertFalse(request["useCookies"])
        self.assertTrue(request["saveAs"])
        self.assertTrue(request["reveal"])
        self.assertFalse(request["saveBefore"])
        with self.assertRaisesRegex(host.ProtocolError, "saveAs must"):
            host.validate_request({**request, "saveAs": "true"})

    def test_before_download_requires_safe_suggestion_and_boolean_preference(self):
        base = {"id": 1, "action": "download", "url": "https://example.test/watch", "output": "mp3", "quality": "best", "saveBefore": True}
        valid = host.validate_request({**base, "suggestedFilename": "Song café, 音楽.mp3"})
        self.assertEqual(valid["suggestedFilename"], "Song café, 音楽.mp3")
        for filename in ["../song.mp3", "C:\\song.mp3", "wrong.mp4", "CON.mp3", "line\n.mp3"]:
            with self.assertRaises(host.ProtocolError):
                host.validate_request({**base, "suggestedFilename": filename})
        with self.assertRaisesRegex(host.ProtocolError, "saveBefore must"):
            host.validate_request({**base, "saveBefore": "yes"})
        with self.assertRaisesRegex(host.ProtocolError, "requires saveAs"):
            host.validate_request({**base, "saveAs": False})

    def test_urls_must_be_http_without_embedded_credentials(self):
        invalid = [
            "file:///tmp/video.mp4",
            "javascript:alert(1)",
            "https://user:secret@example.test/video",
            "https://",
        ]

        for value in invalid:
            with self.subTest(value=value), self.assertRaises(host.ProtocolError):
                host.validate_url(value)

    def test_download_rejects_extra_fields_and_unfixed_options(self):
        request = {
            "id": "request",
            "action": "download",
            "url": "https://example.test/video",
            "output": "mp4",
            "quality": "best",
            "useCookies": False,
            "format": "arbitrary",
        }

        with self.assertRaisesRegex(host.ProtocolError, "unsupported fields"):
            host.validate_request(request)


class ArgumentTests(unittest.TestCase):
    def request(self, output="mp4", quality="best", cookies=False):
        return {
            "id": 1,
            "action": "download",
            "url": "https://www.youtube.com/watch?v=abc123",
            "output": output,
            "quality": quality,
            "useCookies": cookies,
        }

    def build(self, request):
        return host.build_yt_dlp_args(
            request,
            ffmpeg_path=r"C:\Tools\ffmpeg.exe",
            node_path=r"C:\Program Files\nodejs\node.exe",
            destination=Path(r"C:\Users\Test\Downloads\Video Lens"),
            python_executable=r"C:\Helper\.venv\Scripts\python.exe",
        )

    def test_mp4_uses_fixed_merge_and_recode_options(self):
        args = self.build(self.request(output="mp4", quality="1080"))

        self.assertIn("bestvideo*[height<=?1080]+bestaudio/best[height<=?1080]", args)
        self.assertEqual(args[args.index("--merge-output-format") + 1], "mp4")
        self.assertEqual(args[args.index("--recode-video") + 1], "mp4")
        self.assertNotIn("--extract-audio", args)
        self.assertEqual(args[args.index("--js-runtimes") + 1], r"node:C:\Program Files\nodejs\node.exe")
        self.assertEqual(args[-2:], ["--", "https://www.youtube.com/watch?v=abc123"])

    def test_mp3_performs_real_audio_conversion_at_192k(self):
        args = self.build(self.request(output="mp3", quality="best"))

        self.assertIn("--extract-audio", args)
        self.assertEqual(args[args.index("--audio-format") + 1], "mp3")
        self.assertEqual(args[args.index("--audio-quality") + 1], "192K")
        self.assertNotIn("--recode-video", args)

    def test_firefox_cookies_are_added_only_after_explicit_consent(self):
        without_consent = self.build(self.request(cookies=False))
        with_consent = self.build(self.request(cookies=True))

        self.assertNotIn("--cookies-from-browser", without_consent)
        index = with_consent.index("--cookies-from-browser")
        self.assertEqual(with_consent[index + 1], "firefox::none")

    def test_all_downloads_disable_playlists_and_use_argument_array(self):
        args = self.build(self.request())

        self.assertIsInstance(args, list)
        self.assertIn("--ignore-config", args)
        self.assertIn("--no-playlist", args)
        self.assertEqual(args[args.index("--encoding") + 1], "utf-8")
        self.assertEqual(args[args.index("--print") + 1], "after_move:" + host.FILE_PREFIX + "%(filepath)j")
        filter_index = args.index("--match-filter")
        self.assertEqual(args[filter_index + 1], "!is_live")
        self.assertEqual(args[:3], [r"C:\Helper\.venv\Scripts\python.exe", "-m", "yt_dlp"])

    def test_capped_quality_allows_formats_with_unknown_height(self):
        args = self.build(self.request(quality="720"))

        selector = args[args.index("--format") + 1]
        self.assertEqual(selector, "bestvideo*[height<=?720]+bestaudio/best[height<=?720]")

    def test_non_youtube_download_does_not_require_or_enable_node(self):
        request = self.request()
        request["url"] = "https://cdn.example.test/video.webm"
        args = host.build_yt_dlp_args(
            request,
            ffmpeg_path="ffmpeg",
            node_path=None,
            destination=Path("downloads"),
            python_executable="python",
        )

        self.assertNotIn("--js-runtimes", args)

    def test_youtube_download_requires_node_and_enables_it_explicitly(self):
        with self.assertRaisesRegex(host.ProtocolError, "Node.js"):
            host.build_yt_dlp_args(
                self.request(),
                ffmpeg_path="ffmpeg",
                node_path=None,
                destination=Path("downloads"),
                python_executable="python",
            )


class CompletedFileTests(unittest.TestCase):
    def test_completed_file_must_exist_with_requested_extension(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary)
            output = destination / "clip.mp4"
            output.write_bytes(b"media")

            self.assertEqual(host.validate_completed_file(str(output), destination, "mp4"), "clip.mp4")
            with self.assertRaisesRegex(host.ProtocolError, "requested MP3"):
                host.validate_completed_file(str(output), destination, "mp3")

    def test_missing_or_outside_file_cannot_be_reported_complete(self):
        with tempfile.TemporaryDirectory() as temporary, tempfile.TemporaryDirectory() as outside:
            destination = Path(temporary)
            outside_file = Path(outside) / "clip.mp4"
            outside_file.write_bytes(b"media")

            with self.assertRaisesRegex(host.ProtocolError, "Active live streams are disabled"):
                host.validate_completed_file(None, destination, "mp4")
            with self.assertRaisesRegex(host.ProtocolError, "outside"):
                host.validate_completed_file(str(outside_file), destination, "mp4")


class SaveLocationTests(unittest.TestCase):
    def test_before_picker_runs_before_network_and_is_not_reopened_after_conversion(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve()
            source = directory / "extracted name.mp4"
            chosen = directory / "chosen café.mp4"
            job = self.job(directory, url="https://example.org/video.webm", quality="best", saveBefore=True, suggestedFilename="Suggested.mp4")
            order = []
            def pick(*args):
                order.append("picker")
                self.assertEqual(args[0].name, "Suggested.mp4")
                self.assertFalse(source.exists())
                return chosen, False
            process = mock.Mock()
            process.stdout = io.StringIO(host.FILE_PREFIX + json.dumps(str(source)) + "\n")
            process.stderr = io.StringIO("")
            process.wait.return_value = 0
            process.poll.return_value = 0
            def launch(*args, **kwargs):
                order.append("download")
                source.write_bytes(b"completed-media")
                return process
            with mock.patch.object(host, "choose_save_destination", side_effect=pick) as picker, mock.patch.object(host.subprocess, "Popen", side_effect=launch), mock.patch.object(host, "reveal_saved_file") as reveal:
                job._run()
            self.assertEqual(order, ["picker", "download"])
            picker.assert_called_once()
            reveal.assert_called_once_with(chosen)
            self.assertEqual(chosen.read_bytes(), b"completed-media")
            self.assertEqual(job.writer.send.call_args.args[0]["event"], "complete")

    def test_cancelling_before_picker_starts_no_download_and_opens_no_explorer(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "not-created"
            job = self.job(directory, url="https://example.org/video.webm", quality="best", saveBefore=True)
            with mock.patch.object(host, "choose_save_destination", side_effect=host.SaveCancelled()), mock.patch.object(host.subprocess, "Popen") as popen, mock.patch.object(host, "reveal_saved_file") as reveal:
                job._run()
            popen.assert_not_called()
            reveal.assert_not_called()
            self.assertFalse(directory.exists())
            self.assertEqual(job.writer.send.call_args.args[0]["event"], "cancelled")

    def test_unicode_completed_path_reaches_save_dialog_and_explorer(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve()
            source = directory / "café ⧸ 音楽.mp4"
            source.write_bytes(b"completed-media")
            chosen = directory / "saved café ⧸ 音楽.mp4"
            process = mock.Mock()
            process.stdout = io.StringIO(host.FILE_PREFIX + json.dumps(str(source)) + "\n")
            process.stderr = io.StringIO("")
            process.wait.return_value = 0
            process.poll.return_value = 0
            job = self.job(directory, url="https://example.org/video.webm", quality="best")
            with mock.patch.object(host.subprocess, "Popen", return_value=process), mock.patch.object(host, "choose_save_destination", return_value=(chosen, False)) as picker, mock.patch.object(host, "reveal_saved_file") as reveal:
                job._run()
            self.assertEqual(picker.call_args.args[0], source)
            reveal.assert_called_once_with(chosen)
            self.assertEqual(chosen.read_bytes(), b"completed-media")
            self.assertEqual(job.writer.send.call_args.args[0]["event"], "complete")

    def test_missing_file_is_not_misreported_as_an_outside_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(host.ProtocolError, "could not be found"):
                host.validate_completed_file(str(Path(temporary) / "missing.mp4"), Path(temporary), "mp4")

    def job(self, directory, **options):
        request = {"output": "mp4", "saveAs": True, "reveal": True, **options}
        return host.DownloadJob("save-job", request, mock.Mock(), lambda unused: None, ffmpeg_path="ffmpeg", node_path=None, destination=directory)

    def test_selected_location_receives_completed_file_and_is_revealed(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve()
            source = directory / "clip.mp4"
            source.write_bytes(b"completed-media")
            chosen = directory / "chosen.mp4"
            job = self.job(directory)
            with mock.patch.object(host, "choose_save_destination", return_value=(chosen, False)), mock.patch.object(host, "reveal_saved_file") as reveal:
                job._finish_file(str(source))
            self.assertEqual(chosen.read_bytes(), b"completed-media")
            self.assertFalse(source.exists())
            reveal.assert_called_once_with(chosen)
            messages = [call.args[0] for call in job.writer.send.call_args_list]
            self.assertEqual(messages[0]["phase"], "awaiting_save")
            self.assertEqual(messages[-1]["event"], "complete")
            self.assertEqual(messages[-1]["filename"], str(chosen))

    def test_cancelled_save_dialog_keeps_completed_media_without_reveal(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "clip.mp4"
            source.write_bytes(b"completed-media")
            job = self.job(source.parent)
            with mock.patch.object(host, "choose_save_destination", side_effect=host.SaveCancelled()), mock.patch.object(host, "reveal_saved_file") as reveal:
                job._finish_file(str(source))
            self.assertTrue(source.exists())
            reveal.assert_not_called()
            message = job.writer.send.call_args.args[0]
            self.assertEqual(message["event"], "cancelled")
            self.assertIn("kept", message["notice"])

    def test_unconfirmed_overwrite_and_wrong_extension_preserve_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "clip.mp4"
            target = Path(temporary) / "existing.mp4"
            source.write_bytes(b"new")
            target.write_bytes(b"old")
            with self.assertRaisesRegex(host.ProtocolError, "overwrite confirmation"):
                host.save_completed_file(source, target, False, threading.Event())
            with self.assertRaisesRegex(host.ProtocolError, "extension"):
                host.save_completed_file(source, target.with_suffix(".mp3"), True, threading.Event())
            self.assertEqual(source.read_bytes(), b"new")
            self.assertEqual(target.read_bytes(), b"old")

    def test_cross_volume_move_copies_before_replacing_destination(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary).resolve() / "clip.mp4"
            target = Path(temporary).resolve() / "existing.mp4"
            source.write_bytes(b"new")
            target.write_bytes(b"old")
            replace = host.os.replace
            calls = []
            def across_volumes(incoming, outgoing):
                calls.append((incoming, outgoing))
                if len(calls) == 1:
                    raise OSError(errno.EXDEV, "different volumes")
                return replace(incoming, outgoing)
            with mock.patch.object(host.os, "replace", side_effect=across_volumes):
                saved = host.save_completed_file(source, target, True, threading.Event())
            self.assertEqual(saved, target)
            self.assertEqual(target.read_bytes(), b"new")
            self.assertFalse(source.exists())
            self.assertFalse(list(target.parent.glob(".video-lens-*.tmp")))

    def test_cancelled_cross_volume_copy_preserves_original_and_existing_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "clip.mp4"
            target = Path(temporary) / "existing.mp4"
            source.write_bytes(b"new")
            target.write_bytes(b"old")
            cancelled = threading.Event()
            def across_volumes(*unused):
                cancelled.set()
                raise OSError(errno.EXDEV, "different volumes")
            with mock.patch.object(host.os, "replace", side_effect=across_volumes), self.assertRaises(host.SaveCancelled):
                host.save_completed_file(source, target, True, cancelled)
            self.assertEqual(source.read_bytes(), b"new")
            self.assertEqual(target.read_bytes(), b"old")
            self.assertFalse(list(target.parent.glob(".video-lens-*.tmp")))

    def test_explorer_failure_reports_saved_instead_of_failed(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "clip.mp4"
            source.write_bytes(b"completed-media")
            job = self.job(source.parent, saveAs=False)
            with mock.patch.object(host, "reveal_saved_file", side_effect=OSError("Explorer unavailable")):
                job._finish_file(str(source))
            message = job.writer.send.call_args.args[0]
            self.assertEqual(message["event"], "complete")
            self.assertIn("file was saved", message["notice"])
            self.assertTrue(source.exists())

    def test_dialog_uses_fixed_script_and_json_input_without_shell(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "clip $(name).mp4"
            process = mock.Mock()
            process.communicate.return_value = (json.dumps({"path": str(source), "overwrite": True}), "")
            process.returncode = 0
            process.poll.return_value = 0
            register = mock.Mock()
            with mock.patch.object(host.subprocess, "Popen", return_value=process) as popen:
                target, overwrite = host.choose_save_destination(source, "mp4", register, threading.Event())
            self.assertEqual(target, source)
            self.assertTrue(overwrite)
            self.assertIn("-EncodedCommand", popen.call_args.args[0])
            self.assertFalse(popen.call_args.kwargs["shell"])
            self.assertNotIn(source.name, " ".join(popen.call_args.args[0]))
            self.assertEqual(json.loads(process.communicate.call_args.args[0])["filename"], source.name)
            register.assert_called_once_with(process)

    def test_dialog_cancel_returns_no_destination(self):
        process = mock.Mock()
        process.communicate.return_value = ("null", "")
        process.returncode = 0
        process.poll.return_value = 0
        with mock.patch.object(host.subprocess, "Popen", return_value=process), self.assertRaises(host.SaveCancelled):
            host.choose_save_destination(Path("C:/clip.mp4"), "mp4", mock.Mock(), threading.Event())


class SavedFolderTests(unittest.TestCase):
    def test_folder_mode_forces_no_dialog_or_reveal_and_validates_folder(self):
        with tempfile.TemporaryDirectory() as temporary:
            request = {"id": 1, "action": "download", "url": "https://example.test/video", "output": "mp3", "quality": "best", "saveFolder": temporary, "saveAs": True, "reveal": True, "saveBefore": True, "filename": "Instagram-a1b2c3d4.mp3"}
            valid = host.validate_request(request)
            self.assertFalse(valid["saveAs"])
            self.assertFalse(valid["reveal"])
            self.assertFalse(valid["saveBefore"])
            for invalid in ["relative", str(Path(temporary) / "missing")]:
                with self.assertRaises(host.ProtocolError):
                    host.validate_request({**request, "saveFolder": invalid})
            for name in ["../video.mp3", "wrong.mp4", "CON.mp3"]:
                with self.assertRaises(host.ProtocolError):
                    host.validate_request({**request, "filename": name})

    def test_saved_folder_uses_requested_random_name_and_never_invokes_dialog_or_explorer(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            stage, saved = root / "stage", root / "saved café"
            stage.mkdir(); saved.mkdir()
            source = stage / "Instagram.mp4"
            source.write_bytes(b"media")
            request = {"output": "mp4", "saveFolder": str(saved), "filename": "Instagram-a1b2c3d4.mp4", "saveAs": True, "reveal": True}
            job = host.DownloadJob("saved", request, mock.Mock(), lambda unused: None, ffmpeg_path="ffmpeg", node_path=None, destination=stage)
            with mock.patch.object(host, "choose_save_destination") as picker, mock.patch.object(host, "reveal_saved_file") as reveal:
                job._finish_file(str(source))
            picker.assert_not_called(); reveal.assert_not_called()
            self.assertEqual((saved / request["filename"]).read_bytes(), b"media")
            self.assertEqual(job.writer.send.call_args.args[0]["event"], "complete")

    def test_duplicates_are_numbered_without_overwriting_previous_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            saved = root / "saved"; saved.mkdir()
            (saved / "clip.mp3").write_bytes(b"original")
            for index in [1, 2]:
                source = root / "clip.mp3"; source.write_bytes(str(index).encode())
                result = host.save_to_folder(source, saved, threading.Event())
                self.assertEqual(result.name, f"clip ({index}).mp3")
            self.assertEqual((saved / "clip.mp3").read_bytes(), b"original")

    def test_unavailable_folder_preserves_completed_media_without_fallback(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "clip.mp4"; source.write_bytes(b"media")
            job = host.DownloadJob("saved", {"output": "mp4", "saveFolder": str(source.parent / "missing")}, mock.Mock(), lambda unused: None, ffmpeg_path="ffmpeg", node_path=None, destination=source.parent)
            with mock.patch.object(host, "choose_save_destination") as picker, mock.patch.object(host, "reveal_saved_file") as reveal:
                with self.assertRaisesRegex(host.ProtocolError, "kept"):
                    job._finish_file(str(source))
            self.assertTrue(source.exists()); picker.assert_not_called(); reveal.assert_not_called()

    def test_browser_transfer_accepts_only_owned_staging_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            staged = root / "Video Lens" / "pending" / "browser-12345678" / "clip.mp4"
            staged.parent.mkdir(parents=True); staged.write_bytes(b"media")
            request = {"id": "move", "action": "saveFile", "filename": str(staged), "saveFolder": str(root)}
            self.assertEqual(host.validate_request(request)["filename"], str(staged.resolve()))
            unrelated = root / "personal.mp4"; unrelated.write_bytes(b"keep")
            with self.assertRaisesRegex(host.ProtocolError, "staged"):
                host.validate_request({**request, "filename": str(unrelated)})

    def test_folder_task_returns_async_result_and_cancellation_cleans_up(self):
        writer, done = mock.Mock(), mock.Mock()
        operation = mock.Mock(return_value={"folder": "D:/Videos"})
        task = host.NativeTask({"id": "folder", "action": "chooseFolder"}, writer, done, operation)
        task._run()
        writer.send.assert_called_with({"id": "folder", "ok": True, "result": {"folder": "D:/Videos"}})
        done.assert_called_once_with("request-folder")
        operation.side_effect = host.SaveCancelled()
        task._run()
        writer.send.assert_called_with({"id": "folder", "ok": True, "result": {"cancelled": True}})

    def test_folder_picker_uses_fixed_script_and_preserves_unicode_selection(self):
        with tempfile.TemporaryDirectory(prefix="café-") as temporary:
            process = mock.Mock()
            process.communicate.return_value = (json.dumps({"folder": temporary}), "")
            process.returncode = 0; process.poll.return_value = 0
            with mock.patch.object(host.subprocess, "Popen", return_value=process) as popen:
                result = host.choose_download_folder(mock.Mock(), threading.Event())
            self.assertEqual(result, str(Path(temporary).resolve()))
            self.assertFalse(popen.call_args.kwargs["shell"])
            self.assertIn("-EncodedCommand", popen.call_args.args[0])


class ProbeTests(unittest.TestCase):
    def test_probe_reports_versions_and_both_ffmpeg_tools(self):
        tools = {"ffmpeg": "ffmpeg", "ffprobe": "ffprobe", "node": None}
        with mock.patch.object(host, "executable_tools", return_value=tools), mock.patch.object(
            host.importlib.metadata, "version", return_value="2026.1.1"
        ), mock.patch.object(host.importlib.util, "find_spec", return_value=object()):
            result = host.probe_result()

        self.assertEqual(result["ytDlpVersion"], "2026.1.1")
        self.assertTrue(result["ffmpeg"])
        self.assertTrue(result["ffprobe"])
        self.assertTrue(result["ejs"])
        self.assertFalse(result["jsRuntime"])

    def test_probe_reports_missing_youtube_solver(self):
        with mock.patch.object(host.importlib.util, "find_spec", side_effect=lambda name: None if name == "yt_dlp_ejs" else object()):
            self.assertFalse(host.probe_result()["ejs"])


class FailureTests(unittest.TestCase):
    def test_403_error_is_actionable(self):
        error = host.humanize_download_error("ERROR: HTTP Error 403: Forbidden", 1)

        self.assertIn("Update the visave installation", error)
        self.assertIn("restricts downloads", error)

    def test_drm_error_does_not_claim_bypass_support(self):
        error = host.humanize_download_error("ERROR: This format is DRM protected", 1)

        self.assertIn("cannot bypass DRM", error)

    def test_arbitrary_failure_is_bounded(self):
        error = host.humanize_download_error("ERROR: " + ("x" * 5000), 1)

        self.assertLessEqual(len(error), host.MAX_ERROR_LENGTH)


class CancellationTests(unittest.TestCase):
    def test_windows_cancellation_kills_the_process_tree_without_shell(self):
        process = mock.Mock()
        process.pid = 4321
        process.poll.return_value = None
        process.wait.return_value = 0

        with mock.patch.object(host.os, "name", "nt"), mock.patch.object(host.subprocess, "run") as run:
            host.terminate_process_tree(process)

        command = run.call_args.args[0]
        self.assertEqual(command, ["taskkill", "/PID", "4321", "/T", "/F"])
        self.assertFalse(run.call_args.kwargs.get("shell", False))

    def test_job_cancel_sets_flag_before_terminating(self):
        process = mock.Mock(spec=subprocess.Popen)
        writer = mock.Mock()
        job = host.DownloadJob(
            "job",
            {},
            writer,
            lambda unused: None,
            ffmpeg_path="ffmpeg",
            node_path="node",
            destination=Path("downloads"),
        )
        job._process = process

        with mock.patch.object(host, "terminate_process_tree") as terminate:
            job.cancel()

        self.assertTrue(job.cancelled.is_set())
        terminate.assert_called_once_with(process)

    def test_cancel_requested_before_process_start_is_not_lost(self):
        process = mock.Mock()
        process.stdout.readline.return_value = ""
        process.stdout.close.return_value = None
        process.stderr.readline.return_value = ""
        process.wait.return_value = 1
        process.poll.return_value = 1
        request = {
            "url": "https://cdn.example.test/video.webm",
            "output": "mp4",
            "quality": "best",
            "useCookies": False,
        }
        writer = mock.Mock()
        job = host.DownloadJob(
            "job",
            request,
            writer,
            lambda unused: None,
            ffmpeg_path="ffmpeg",
            node_path=None,
            destination=Path("downloads"),
        )
        job.cancelled.set()

        with mock.patch.object(host.Path, "mkdir"), mock.patch.object(
            host.subprocess, "Popen", return_value=process
        ), mock.patch.object(host, "terminate_process_tree") as terminate:
            job._run()

        terminate.assert_called_once_with(process)
        writer.send.assert_called_with({"event": "cancelled", "jobId": "job"})


if __name__ == "__main__":
    unittest.main()
