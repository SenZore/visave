from __future__ import annotations

import http.server
import json
import os
import queue
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from native.host import encode_message, read_message


def main() -> None:
    output = ROOT / "test-results" / "native"
    output.mkdir(parents=True, exist_ok=True)
    clip = output / "source.webm"
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
        "testsrc2=size=320x180:rate=24", "-f", "lavfi", "-i", "sine=frequency=600:sample_rate=44100",
        "-t", "2", "-c:v", "libvpx", "-b:v", "150k", "-c:a", "libvorbis", str(clip),
    ], check=True)

    class MediaHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = clip.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "video/webm")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), MediaHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    staging = output / "staging café ⧸ 音楽"
    saved_directory = output / "saved"
    saved_directory.mkdir(exist_ok=True)
    reveal_log = output / "revealed.json"
    picker_log = output / "picker.json"
    bootstrap = (
        "from pathlib import Path; import json; from native import host; "
        "host.download_directory=lambda: Path(" + repr(str(staging)) + "); "
        "host.choose_save_destination=lambda source, *args: (Path(" + repr(str(picker_log)) + ").write_text(json.dumps({'sourceExists':source.exists(),'suggestion':source.name}), encoding='utf-8'), (Path(" + repr(str(saved_directory)) + ") / source.name, True))[1]; "
        "host.reveal_saved_file=lambda saved: Path(" + repr(str(reveal_log)) + ").write_text(json.dumps(str(saved)), encoding='utf-8'); "
        "host.choose_download_folder=lambda *args: " + repr(str(saved_directory)) + "; "
        "host.main()"
    )
    process = subprocess.Popen([sys.executable, "-u", "-c", bootstrap], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    messages: queue.Queue = queue.Queue()

    def reader():
        while True:
            message = read_message(process.stdout)
            if message is None:
                return
            messages.put(message)

    threading.Thread(target=reader, daemon=True).start()
    checks = []
    try:
        process.stdin.write(encode_message({"id": "probe", "action": "probe"}))
        process.stdin.flush()
        probe = messages.get(timeout=15)
        assert probe["ok"] and probe["result"]["ytDlp"] and probe["result"]["ffmpeg"], probe
        checks.append("Native framing and installed dependency probe respond correctly")
        for kind, before in (("mp4", False), ("mp3", False), ("mp4", True), ("mp3", True)):
            mode = "before" if before else "after"
            filename = quote(mode + kind + " café ⧸ 音楽.webm")
            suggestion = f"Chosen {mode} {kind} café ⧸ 音楽.{kind}"
            process.stdin.write(encode_message({"id": mode + kind, "action": "download", "url": f"http://127.0.0.1:{server.server_port}/{filename}", "output": kind, "quality": "720", "useCookies": False, "saveAs": True, "reveal": True, "saveBefore": before, "suggestedFilename": suggestion}))
            process.stdin.flush()
            reply = messages.get(timeout=20)
            assert reply.get("ok"), reply
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                event = messages.get(timeout=30)
                if event.get("event") in ("complete", "error", "cancelled"):
                    break
            assert event.get("event") == "complete", event
            saved = Path(event["filename"])
            assert saved.exists() and saved.suffix == "." + kind, saved
            assert saved.parent == saved_directory and "⧸" in saved.name, saved
            picker = json.loads(picker_log.read_text(encoding="utf-8"))
            assert picker["sourceExists"] == (not before), picker
            if before:
                assert saved.name == suggestion, saved
            assert json.loads(reveal_log.read_text(encoding="utf-8")) == str(saved)
            info = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=format_name:stream=codec_name,codec_type", "-of", "json", str(saved)]))
            if kind == "mp3":
                assert all(stream["codec_type"] == "audio" for stream in info["streams"]), info
                assert info["streams"][0]["codec_name"] == "mp3", info
            else:
                assert "mp4" in info["format"]["format_name"], info
                assert any(stream["codec_type"] == "video" for stream in info["streams"]), info
                assert any(stream["codec_type"] == "audio" for stream in info["streams"]), info
            checks.append(f"Real {kind.upper()} conversion chooses the location {mode} download, preserves Unicode paths, moves the file and requests Explorer; FFprobe verifies codecs (OS dialog/reveal substituted)")
        picker_log.unlink(missing_ok=True)
        reveal_log.unlink(missing_ok=True)
        for kind in ("mp4", "mp3"):
            name = f"Instagram-{uuid.uuid4().hex[:12]}.{kind}"
            process.stdin.write(encode_message({"id": "folder-" + kind, "action": "download", "url": f"http://127.0.0.1:{server.server_port}/folder-{kind}.webm", "output": kind, "quality": "best", "saveFolder": str(saved_directory), "filename": name, "saveAs": True, "reveal": True}))
            process.stdin.flush()
            reply = messages.get(timeout=20)
            assert reply.get("ok"), reply
            while True:
                event = messages.get(timeout=30)
                if event.get("event") in ("complete", "error", "cancelled"):
                    break
            assert event.get("event") == "complete", event
            saved = Path(event["filename"])
            assert saved.parent == saved_directory and saved.name == name and saved.exists(), event
            assert not picker_log.exists() and not reveal_log.exists()
            checks.append(f"Saved-folder {kind.upper()} conversion uses the supplied Instagram name with no Save As or Explorer request")
        process.stdin.write(encode_message({"id": "folder-picker", "action": "chooseFolder"})); process.stdin.flush()
        selected = messages.get(timeout=15)
        assert selected["ok"] and selected["result"]["folder"] == str(saved_directory), selected
        checks.append("Asynchronous folder-selection request returns its selected folder (OS picker substituted)")
        for index in [0, 1]:
            staged = output / "browser-downloads" / "Video Lens" / "pending" / ("browser-" + uuid.uuid4().hex) / "browser clip café.webm"
            staged.parent.mkdir(parents=True)
            staged.write_bytes(clip.read_bytes())
            process.stdin.write(encode_message({"id": "browser-save-" + str(index), "action": "saveFile", "filename": str(staged), "saveFolder": str(saved_directory)})); process.stdin.flush()
            moved = messages.get(timeout=15)
            assert moved["ok"], moved
            final = Path(moved["result"]["filename"])
            assert final.parent == saved_directory and final.read_bytes() == clip.read_bytes() and not staged.exists(), moved
            if index == 0: first = final
            else: assert final != first and first.exists(), moved
            assert not picker_log.exists() and not reveal_log.exists()
        checks.append("Real browser-stage transfers preserve bytes, number duplicate filenames and open no dialogs or Explorer")
        (ROOT / "test-results" / "native-check.json").write_text(json.dumps({"checks": checks}, indent=2), encoding="utf-8")
        for check in checks:
            print("PASS", check)
    finally:
        process.stdin.close()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
        stderr = process.stderr.read().decode("utf-8", errors="replace")
        if stderr:
            print(stderr, file=sys.stderr)
        server.shutdown()


if __name__ == "__main__":
    main()
