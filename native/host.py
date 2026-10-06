from __future__ import annotations

import collections
import base64
import ctypes
import errno
import importlib.metadata
import importlib.util
import json
import os
import re
import shutil
import signal
import struct
import subprocess
import sys
import threading
import uuid
from pathlib import Path
from typing import Any, BinaryIO, Callable
from urllib.parse import urlsplit


HELPER_VERSION = "1.4.1"
MAX_MESSAGE_BYTES = 1_048_576
MAX_URL_LENGTH = 8_192
MAX_ERROR_LENGTH = 1_200
PROGRESS_PREFIX = "__VIDEOLENS_PROGRESS__"
FILE_PREFIX = "__VIDEOLENS_FILE__"
QUALITY_HEIGHTS = {"best": None, "1080": 1080, "720": 720, "480": 480}
FOLDER_SAVE_LOCK = threading.Lock()


class ProtocolError(ValueError):
    pass


class SaveCancelled(Exception):
    pass


SAVE_DIALOG_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$options = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.TopMost = $true
$owner.StartPosition = 'CenterScreen'
$owner.Width = 1
$owner.Height = 1
$owner.Show()
$dialog = New-Object System.Windows.Forms.SaveFileDialog
$dialog.Title = 'Save visave download'
$dialog.FileName = $options.filename
$dialog.InitialDirectory = $options.directory
$dialog.DefaultExt = $options.output
$dialog.Filter = $options.filter
$dialog.AddExtension = $true
$dialog.OverwritePrompt = $true
$dialog.CheckPathExists = $true
$dialog.ValidateNames = $true
$dialog.RestoreDirectory = $true
try {
    while ($true) {
        $result = $dialog.ShowDialog($owner)
        if ($result -ne [Windows.Forms.DialogResult]::OK) {
            [Console]::Write('null')
            break
        }
        if ([IO.Path]::GetExtension($dialog.FileName) -ine ('.' + $options.output)) {
            [void][Windows.Forms.MessageBox]::Show($owner, ('Use a .' + $options.output + ' filename.'), 'visave')
            continue
        }
        $selection = @{ path = $dialog.FileName; overwrite = [IO.File]::Exists($dialog.FileName) }
        [Console]::Write(($selection | ConvertTo-Json -Compress))
        break
    }
} finally {
    $dialog.Dispose()
    $owner.Dispose()
}
"""


FOLDER_DIALOG_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$options = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.TopMost = $true
$owner.Width = 1
$owner.Height = 1
$owner.Show()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Save visave downloads to this folder'
$dialog.SelectedPath = $options.directory
$dialog.ShowNewFolderButton = $true
try {
    if ($dialog.ShowDialog($owner) -eq [Windows.Forms.DialogResult]::OK) {
        [Console]::Write((@{ folder = $dialog.SelectedPath } | ConvertTo-Json -Compress))
    } else { [Console]::Write('null') }
} finally { $dialog.Dispose(); $owner.Dispose() }
"""


def validate_save_folder(value: Any) -> Path:
    if not isinstance(value, str) or not value or len(value) > 4096 or "\x00" in value:
        raise ProtocolError("Choose a download folder in Settings.")
    path = Path(value)
    if not path.is_absolute():
        raise ProtocolError("The download folder must be an absolute path.")
    try:
        resolved = path.resolve(strict=True)
        if not resolved.is_dir():
            raise OSError("Not a folder")
        return resolved
    except OSError as exc:
        raise ProtocolError("The saved download folder is unavailable. Choose another folder in Settings.") from exc


def _read_exact(stream: BinaryIO, length: int) -> bytes:
    chunks: list[bytes] = []
    remaining = length
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            raise ProtocolError("Native message ended before its declared length.")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_message(stream: BinaryIO) -> dict[str, Any] | None:
    header = stream.read(4)
    if not header:
        return None
    if len(header) != 4:
        raise ProtocolError("Native message header is incomplete.")
    (length,) = struct.unpack("=I", header)
    if length == 0 or length > MAX_MESSAGE_BYTES:
        raise ProtocolError("Native message length is invalid.")
    payload = _read_exact(stream, length)
    try:
        message = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProtocolError("Native message is not valid UTF-8 JSON.") from exc
    if not isinstance(message, dict):
        raise ProtocolError("Native message must be a JSON object.")
    return message


def encode_message(message: dict[str, Any]) -> bytes:
    payload = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(payload) > MAX_MESSAGE_BYTES:
        raise ProtocolError("Native response is too large.")
    return struct.pack("=I", len(payload)) + payload


class NativeWriter:
    def __init__(self, stream: BinaryIO):
        self._stream = stream
        self._lock = threading.Lock()

    def send(self, message: dict[str, Any]) -> None:
        frame = encode_message(message)
        with self._lock:
            self._stream.write(frame)
            self._stream.flush()


def _request_id(message: object) -> str | int | None:
    if not isinstance(message, dict):
        return None
    value = message.get("id")
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return None
    if isinstance(value, str) and (not value or len(value) > 128):
        return None
    return value


def validate_url(value: object) -> str:
    if not isinstance(value, str) or not value or len(value) > MAX_URL_LENGTH:
        raise ProtocolError("URL must be a non-empty HTTP or HTTPS URL.")
    if any(ord(character) < 32 for character in value):
        raise ProtocolError("URL contains invalid control characters.")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise ProtocolError("URL is malformed.") from exc
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise ProtocolError("Only HTTP and HTTPS video URLs are supported.")
    if parsed.username is not None or parsed.password is not None:
        raise ProtocolError("URLs containing credentials are not accepted.")
    if port is not None and not 1 <= port <= 65535:
        raise ProtocolError("URL port is invalid.")
    return value


def validate_request(message: dict[str, Any]) -> dict[str, Any]:
    request_id = _request_id(message)
    if request_id is None:
        raise ProtocolError("Request id must be a short string or integer.")
    action = message.get("action")
    if action not in {"probe", "download", "cancel", "chooseFolder", "saveFile"}:
        raise ProtocolError("Unsupported helper action.")

    allowed = {
        "probe": {"id", "action"},
        "download": {"id", "action", "url", "output", "quality", "useCookies", "saveAs", "reveal", "saveBefore", "suggestedFilename", "saveFolder", "filename"},
        "cancel": {"id", "action", "jobId"},
        "chooseFolder": {"id", "action"},
        "saveFile": {"id", "action", "filename", "saveFolder"},
    }[action]
    if set(message) - allowed:
        raise ProtocolError("Request contains unsupported fields.")

    normalized: dict[str, Any] = {"id": request_id, "action": action}
    if action == "download":
        normalized["url"] = validate_url(message.get("url"))
        output = message.get("output")
        quality = message.get("quality")
        if output not in {"mp4", "mp3"}:
            raise ProtocolError("Output must be mp4 or mp3.")
        if quality not in QUALITY_HEIGHTS:
            raise ProtocolError("Quality must be best, 1080, 720, or 480.")
        use_cookies = message.get("useCookies", False)
        if not isinstance(use_cookies, bool):
            raise ProtocolError("useCookies must be true or false.")
        normalized.update(output=output, quality=quality, useCookies=use_cookies)
        for name in ("saveAs", "reveal", "saveBefore"):
            value = message.get(name, name != "saveBefore")
            if not isinstance(value, bool):
                raise ProtocolError(f"{name} must be true or false.")
            normalized[name] = value
        if "saveFolder" in message:
            normalized["saveFolder"] = str(validate_save_folder(message["saveFolder"]))
            normalized.update(saveAs=False, reveal=False, saveBefore=False)
        if "filename" in message:
            filename = message["filename"]
            if not isinstance(filename, str) or not filename or len(filename) > 200 or re.search(r'[<>:"/\\|?*\x00-\x1f]', filename) or Path(filename).suffix.lower() != "." + output or re.match(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", filename, re.I):
                raise ProtocolError("filename must be a plain media filename with the requested extension.")
            normalized["filename"] = filename
        if normalized["saveBefore"]:
            if not normalized["saveAs"]:
                raise ProtocolError("saveBefore requires saveAs.")
            filename = message.get("suggestedFilename", f"video.{output}")
            if not isinstance(filename, str) or not filename or len(filename) > 200 or re.search(r'[<>:"/\\|?*\x00-\x1f]', filename) or Path(filename).suffix.lower() != "." + output:
                raise ProtocolError("suggestedFilename must be a plain filename with the requested extension.")
            if re.match(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", filename, re.I):
                raise ProtocolError("suggestedFilename cannot use a reserved Windows filename.")
            normalized["suggestedFilename"] = filename
    elif action == "saveFile":
        normalized["saveFolder"] = str(validate_save_folder(message.get("saveFolder")))
        filename = message.get("filename")
        if not isinstance(filename, str) or len(filename) > 4096 or "\x00" in filename or not Path(filename).is_absolute():
            raise ProtocolError("The completed browser file must have an absolute path.")
        try:
            source = Path(filename).resolve(strict=True)
        except OSError as exc:
            raise ProtocolError("The completed browser file is unavailable.") from exc
        if not source.is_file() or source.parent.parent.name != "pending" or source.parent.parent.parent.name != "Video Lens" or not re.fullmatch(r"browser-[a-zA-Z0-9-]{8,128}", source.parent.name):
            raise ProtocolError("Only a Video Lens staged browser download can be saved.")
        normalized["filename"] = str(source)
    elif action == "cancel":
        job_id = message.get("jobId")
        if not isinstance(job_id, str) or not job_id or len(job_id) > 128:
            raise ProtocolError("jobId must be a non-empty string.")
        normalized["jobId"] = job_id
    return normalized


def download_directory() -> Path:
    profile = os.environ.get("USERPROFILE")
    base = Path(profile) if profile else Path.home()
    return base / "Downloads" / "Video Lens"


def executable_tools() -> dict[str, str | None]:
    bundled = Path(__file__).resolve().parent / "bin"
    return {name: str(bundled / (name + ".exe")) if (bundled / (name + ".exe")).is_file()
            else shutil.which(name) for name in ("ffmpeg", "ffprobe", "node")}


def probe_result() -> dict[str, Any]:
    tools = executable_tools()
    try:
        yt_dlp_version = importlib.metadata.version("yt-dlp")
    except importlib.metadata.PackageNotFoundError:
        yt_dlp_version = None
    return {
        "version": HELPER_VERSION,
        "ytDlp": bool(yt_dlp_version and importlib.util.find_spec("yt_dlp")),
        "ytDlpVersion": yt_dlp_version,
        "ffmpeg": bool(tools["ffmpeg"]),
        "ffprobe": bool(tools["ffprobe"]),
        "jsRuntime": bool(tools["node"]),
        "downloadDirectory": str(download_directory()),
        "saveBeforeSupported": os.name == "nt",
        "saveFolderSupported": os.name == "nt",
        "filenameSupported": True,
    }


def _format_selector(output: str, quality: str) -> str:
    height = QUALITY_HEIGHTS[quality]
    if output == "mp3":
        return "bestaudio/best"
    if height is None:
        return "bestvideo*+bestaudio/best"
    return f"bestvideo*[height<=?{height}]+bestaudio/best[height<=?{height}]"


def is_youtube_url(url: str) -> bool:
    hostname = (urlsplit(url).hostname or "").lower().rstrip(".")
    return hostname in {"youtu.be", "youtube.com", "youtube-nocookie.com"} or hostname.endswith(
        (".youtube.com", ".youtube-nocookie.com")
    )


def build_yt_dlp_args(
    request: dict[str, Any],
    *,
    ffmpeg_path: str,
    node_path: str | None,
    destination: Path,
    python_executable: str | None = None,
) -> list[str]:
    args = [
        python_executable or sys.executable,
        "-m",
        "yt_dlp",
        "--ignore-config",
        "--no-playlist",
        "--match-filter",
        "!is_live",
        "--newline",
        "--progress",
        "--no-color",
        "--encoding",
        "utf-8",
        "--ffmpeg-location",
        ffmpeg_path,
        "--paths",
        str(destination),
        "--output",
        "%(title).180B [%(id)s].%(ext)s",
        "--progress-template",
        f"download:{PROGRESS_PREFIX}%(progress._percent_str)s|%(progress.status)s",
        "--print",
        f"after_move:{FILE_PREFIX}%(filepath)j",
        "--format",
        _format_selector(request["output"], request["quality"]),
    ]
    if is_youtube_url(request["url"]):
        if not node_path:
            raise ProtocolError("Node.js is required for YouTube's JavaScript challenges.")
        args.extend(["--js-runtimes", f"node:{node_path}"])
    if request["output"] == "mp4":
        args.extend(["--merge-output-format", "mp4", "--recode-video", "mp4"])
    else:
        args.extend(["--extract-audio", "--audio-format", "mp3", "--audio-quality", "192K"])
    if request.get("useCookies") is True:
        args.extend(["--cookies-from-browser", "firefox::none"])
    args.extend(["--", request["url"]])
    return args


def validate_completed_file(filepath: str | None, destination: Path, output: str) -> str:
    if not filepath:
        raise ProtocolError(
            "No output file was produced. Active live streams are disabled; otherwise update the helper and check site restrictions."
        )
    candidate = Path(filepath)
    if not candidate.is_absolute():
        candidate = destination / candidate
    try:
        resolved = candidate.resolve()
        destination_root = destination.resolve(strict=True)
    except OSError as exc:
        raise ProtocolError("Could not read the completed download location.") from exc
    try:
        resolved.relative_to(destination_root)
    except ValueError as exc:
        raise ProtocolError("yt-dlp reported an output outside the Video Lens download directory.") from exc
    if not resolved.is_file():
        raise ProtocolError("The completed file could not be found at the reported path. Check " + str(destination_root))
    if resolved.suffix.lower() != f".{output}":
        raise ProtocolError(f"yt-dlp did not create the requested {output.upper()} file.")
    return resolved.name


def choose_save_destination(
    source: Path,
    output: str,
    register_process: Callable[[subprocess.Popen[str]], None],
    cancelled: threading.Event,
) -> tuple[Path, bool]:
    if cancelled.is_set():
        raise SaveCancelled()
    if os.name != "nt":
        return source, False
    encoded_script = base64.b64encode(SAVE_DIALOG_SCRIPT.encode("utf-16-le")).decode("ascii")
    command = ["powershell.exe", "-NoProfile", "-STA", "-EncodedCommand", encoded_script]
    options = {
        "filename": source.name,
        "directory": str(download_directory().parent),
        "output": output,
        "filter": f"{output.upper()} file (*.{output})|*.{output}",
    }
    process = subprocess.Popen(
        command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", shell=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    register_process(process)
    try:
        stdout, stderr = process.communicate(json.dumps(options, ensure_ascii=False))
        if cancelled.is_set():
            raise SaveCancelled()
        if process.returncode:
            raise ProtocolError("The save dialog could not open: " + _bounded_error(stderr))
        try:
            selection = json.loads(stdout)
        except (json.JSONDecodeError, TypeError) as exc:
            raise ProtocolError("The save dialog did not return a valid destination.") from exc
        if selection is None:
            raise SaveCancelled()
        if not isinstance(selection, dict) or not isinstance(selection.get("path"), str) or not isinstance(selection.get("overwrite"), bool):
            raise ProtocolError("The save dialog returned an invalid destination.")
        target = Path(selection["path"])
        if not target.is_absolute() or target.suffix.lower() != "." + output:
            raise ProtocolError("Choose an absolute destination with the requested file extension.")
        return target, selection["overwrite"]
    finally:
        if process.poll() is None:
            terminate_process_tree(process)


def choose_download_folder(register_process: Callable[[subprocess.Popen[str]], None], cancelled: threading.Event) -> str:
    if cancelled.is_set():
        raise SaveCancelled()
    if os.name != "nt":
        raise ProtocolError("The folder picker is available with the Windows helper.")
    encoded = base64.b64encode(FOLDER_DIALOG_SCRIPT.encode("utf-16-le")).decode("ascii")
    process = subprocess.Popen(
        ["powershell.exe", "-NoProfile", "-STA", "-EncodedCommand", encoded],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", shell=False, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    register_process(process)
    try:
        stdout, stderr = process.communicate(json.dumps({"directory": str(download_directory().parent)}, ensure_ascii=False))
        if cancelled.is_set():
            raise SaveCancelled()
        if process.returncode:
            raise ProtocolError("The folder picker could not open: " + _bounded_error(stderr))
        try:
            selection = json.loads(stdout)
        except (json.JSONDecodeError, TypeError) as exc:
            raise ProtocolError("The folder picker returned an invalid result.") from exc
        if selection is None:
            raise SaveCancelled()
        if not isinstance(selection, dict):
            raise ProtocolError("The folder picker returned an invalid result.")
        return str(validate_save_folder(selection.get("folder")))
    finally:
        if process.poll() is None:
            terminate_process_tree(process)


def save_to_folder(source: Path, folder: Path, cancelled: threading.Event, filename: str | None = None) -> Path:
    folder = validate_save_folder(str(folder))
    name = Path(filename or source.name)
    with FOLDER_SAVE_LOCK:
        for index in range(10000):
            target = folder / (name.name if index == 0 else f"{name.stem} ({index}){name.suffix}")
            if target.exists():
                continue
            try:
                return save_completed_file(source, target, False, cancelled)
            except (FileExistsError, ProtocolError):
                if not target.exists():
                    raise
        raise ProtocolError("Too many files with the same name in the saved folder.")


def save_completed_file(source: Path, target: Path, overwrite: bool, cancelled: threading.Event) -> Path:
    source = source.resolve(strict=True)
    if cancelled.is_set():
        raise SaveCancelled()
    if not target.is_absolute() or target.suffix.lower() != source.suffix.lower():
        raise ProtocolError("The save location must use the completed file's extension.")
    target = target.parent.resolve(strict=True) / target.name
    if source == target:
        return source
    if target.exists() and (not target.is_file() or not overwrite):
        raise ProtocolError("The destination exists without overwrite confirmation. The completed file was kept.")
    try:
        if overwrite:
            os.replace(source, target)
        else:
            source.rename(target)
        return target
    except OSError as exc:
        if exc.errno != errno.EXDEV:
            raise
    temporary = target.parent / (".video-lens-" + uuid.uuid4().hex + ".tmp")
    try:
        with source.open("rb") as incoming, temporary.open("xb") as outgoing:
            while chunk := incoming.read(1024 * 1024):
                if cancelled.is_set():
                    raise SaveCancelled()
                outgoing.write(chunk)
        shutil.copystat(source, temporary)
        if cancelled.is_set():
            raise SaveCancelled()
        if overwrite:
            os.replace(temporary, target)
        else:
            temporary.rename(target)
        source.unlink()
        return target
    finally:
        temporary.unlink(missing_ok=True)


def reveal_saved_file(path: Path) -> None:
    if os.name != "nt":
        return
    saved = path.resolve(strict=True)
    if not saved.is_file():
        raise OSError("The saved file is no longer available.")
    shell = ctypes.WinDLL("shell32")
    ole = ctypes.WinDLL("ole32")
    ole.CoInitializeEx.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    ole.CoInitializeEx.restype = ctypes.c_long
    ole.CoUninitialize.argtypes = []
    ole.CoUninitialize.restype = None
    ole.CoTaskMemFree.argtypes = [ctypes.c_void_p]
    ole.CoTaskMemFree.restype = None
    shell.SHParseDisplayName.argtypes = [ctypes.c_wchar_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p), ctypes.c_ulong, ctypes.c_void_p]
    shell.SHParseDisplayName.restype = ctypes.c_long
    shell.SHOpenFolderAndSelectItems.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_ulong]
    shell.SHOpenFolderAndSelectItems.restype = ctypes.c_long

    def check_result(result: int) -> None:
        if result < 0:
            raise OSError(f"Windows file selection failed (0x{result & 0xffffffff:08x}).")

    check_result(ole.CoInitializeEx(None, 2))
    item = ctypes.c_void_p()
    try:
        check_result(shell.SHParseDisplayName(str(saved), None, ctypes.byref(item), 0, None))
        if not item.value:
            raise OSError("Windows could not identify the saved file.")
        # A full file PIDL with zero children opens its parent and selects that file.
        check_result(shell.SHOpenFolderAndSelectItems(item, 0, None, 0))
    finally:
        if item.value:
            ole.CoTaskMemFree(item)
        ole.CoUninitialize()


def _bounded_error(value: str) -> str:
    compact = " ".join(value.replace("\x00", "").split())
    return compact[:MAX_ERROR_LENGTH] or "Download failed without an error message."


def humanize_download_error(stderr_text: str, return_code: int) -> str:
    lowered = stderr_text.lower()
    if "drm" in lowered or "digital rights management" in lowered:
        return "This video appears to use DRM. visave cannot bypass DRM protection."
    if "http error 403" in lowered or "403 forbidden" in lowered:
        return (
            "The site returned HTTP 403. Update the visave installation, then check whether "
            "the site restricts downloads or requires cookie consent."
        )
    if "unsupported url" in lowered:
        return "This site or URL is not supported by the installed yt-dlp version. Update the helper and try again."
    if "sign in" in lowered or "login" in lowered or "cookies" in lowered:
        return "The site requires a signed-in session. Enable Firefox cookie access for this download and try again."
    last_line = next((line.strip() for line in reversed(stderr_text.splitlines()) if line.strip()), "")
    if last_line:
        return _bounded_error(last_line)
    return f"yt-dlp exited with code {return_code}. Update the helper and check the site's download restrictions."


def terminate_process_tree(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    else:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        if os.name == "nt":
            process.kill()
        else:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                process.kill()


class DownloadJob:
    def __init__(
        self,
        job_id: str,
        request: dict[str, Any],
        writer: NativeWriter,
        on_done: Callable[[str], None],
        *,
        ffmpeg_path: str,
        node_path: str | None,
        destination: Path,
    ):
        self.job_id = job_id
        self.request = request
        self.writer = writer
        self.on_done = on_done
        self.ffmpeg_path = ffmpeg_path
        self.node_path = node_path
        self.destination = destination
        self.cancelled = threading.Event()
        self._process: subprocess.Popen[str] | None = None
        self._process_lock = threading.Lock()
        self._terminal_lock = threading.Lock()
        self._terminal_sent = False
        self.selected_destination: tuple[Path, bool] | None = None
        self.thread = threading.Thread(target=self._run, name=f"video-lens-{job_id}", daemon=True)

    def start(self) -> None:
        self.thread.start()

    def cancel(self) -> None:
        self.cancelled.set()
        with self._process_lock:
            process = self._process
        if process is not None:
            terminate_process_tree(process)

    def _register_process(self, process: subprocess.Popen[str]) -> None:
        with self._process_lock:
            self._process = process
            cancel_now = self.cancelled.is_set()
        if cancel_now:
            terminate_process_tree(process)

    def _finish_file(self, completed_path: str | None) -> None:
        filename = validate_completed_file(completed_path, self.destination, self.request["output"])
        source = Path(completed_path or filename)
        if not source.is_absolute():
            source = self.destination / source
        source = source.resolve(strict=True)
        saved = source
        try:
            if self.request.get("saveFolder"):
                saved = save_to_folder(source, Path(self.request["saveFolder"]), self.cancelled, self.request.get("filename"))
            elif self.request.get("saveAs", True):
                if self.selected_destination is None:
                    self._event("progress", phase="awaiting_save")
                    suggestion = source.parent / self.request.get("filename", source.name)
                    target, overwrite = choose_save_destination(suggestion, self.request["output"], self._register_process, self.cancelled)
                else:
                    target, overwrite = self.selected_destination
                saved = save_completed_file(source, target, overwrite, self.cancelled)
            elif self.cancelled.is_set():
                raise SaveCancelled()
        except SaveCancelled:
            self._terminal_event("cancelled", filename=str(source), notice="Completed media kept at " + str(source))
            return
        except (OSError, ProtocolError, subprocess.SubprocessError) as exc:
            raise ProtocolError(_bounded_error(str(exc)) + " Completed media kept at " + str(source)) from exc
        notice = None
        if self.request.get("reveal", True) and not self.request.get("saveFolder"):
            try:
                reveal_saved_file(saved)
            except OSError:
                notice = "The file was saved, but File Explorer could not open. Open the saved location manually."
        self._terminal_event("complete", filename=str(saved), notice=notice)

    def _event(self, event: str, **fields: Any) -> None:
        payload = {"event": event, "jobId": self.job_id}
        payload.update({key: value for key, value in fields.items() if value is not None})
        self.writer.send(payload)

    def _terminal_event(self, event: str, **fields: Any) -> None:
        with self._terminal_lock:
            if self._terminal_sent:
                return
            self._terminal_sent = True
        self._event(event, **fields)

    def _read_stderr(self, stream: Any, lines: collections.deque[str]) -> None:
        for line in iter(stream.readline, ""):
            lines.append(line)
        stream.close()

    def _progress(self, line: str) -> None:
        value = line[len(PROGRESS_PREFIX) :].strip()
        percent_text, _, status = value.partition("|")
        match = re.search(r"(\d+(?:\.\d+)?)", percent_text.replace(",", "."))
        percent = min(100.0, max(0.0, float(match.group(1)))) if match else None
        phase = "processing" if status.strip().lower() == "finished" else "downloading"
        self._event("progress", percent=percent, phase=phase)

    def _run(self) -> None:
        stderr_lines: collections.deque[str] = collections.deque(maxlen=80)
        completed_path: str | None = None
        process: subprocess.Popen[str] | None = None
        try:
            if self.request.get("saveBefore") and os.name == "nt":
                self._event("progress", phase="awaiting_save")
                suggestion = self.destination / self.request.get("suggestedFilename", f"video.{self.request['output']}")
                self.selected_destination = choose_save_destination(suggestion, self.request["output"], self._register_process, self.cancelled)
                if self.cancelled.is_set():
                    raise SaveCancelled()
                self._event("progress", phase="downloading", percent=0)
            self.destination.mkdir(parents=True, exist_ok=True)
            args = build_yt_dlp_args(
                self.request,
                ffmpeg_path=self.ffmpeg_path,
                node_path=self.node_path,
                destination=self.destination,
            )
            popen_options: dict[str, Any] = {
                "stdin": subprocess.DEVNULL,
                "stdout": subprocess.PIPE,
                "stderr": subprocess.PIPE,
                "text": True,
                "encoding": "utf-8",
                "errors": "replace",
                "bufsize": 1,
                "shell": False,
            }
            if os.name == "nt":
                popen_options["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | getattr(subprocess, "CREATE_NO_WINDOW", 0)
            else:
                popen_options["start_new_session"] = True
            process = subprocess.Popen(args, **popen_options)
            self._register_process(process)
            assert process.stdout is not None and process.stderr is not None
            stderr_thread = threading.Thread(
                target=self._read_stderr,
                args=(process.stderr, stderr_lines),
                name=f"video-lens-stderr-{self.job_id}",
                daemon=True,
            )
            stderr_thread.start()
            for raw_line in iter(process.stdout.readline, ""):
                line = raw_line.rstrip("\r\n")
                if line.startswith(PROGRESS_PREFIX):
                    self._progress(line)
                elif line.startswith(FILE_PREFIX):
                    try:
                        completed_path = json.loads(line[len(FILE_PREFIX) :])
                    except json.JSONDecodeError as exc:
                        raise ProtocolError("yt-dlp returned an invalid completed-file path.") from exc
                    if not isinstance(completed_path, str):
                        raise ProtocolError("yt-dlp returned an invalid completed-file path.")
            process.stdout.close()
            return_code = process.wait()
            stderr_thread.join(timeout=2)
            if self.cancelled.is_set():
                self._terminal_event("cancelled")
            elif return_code == 0:
                self._finish_file(completed_path)
            else:
                error = humanize_download_error("".join(stderr_lines), return_code)
                self._terminal_event("error", error=error)
        except SaveCancelled:
            self._terminal_event("cancelled")
        except (OSError, ProtocolError, subprocess.SubprocessError) as exc:
            if self.cancelled.is_set():
                self._terminal_event("cancelled")
            else:
                self._terminal_event("error", error=_bounded_error(str(exc)))
        finally:
            with self._process_lock:
                self._process = None
            if process is not None and process.poll() is None:
                terminate_process_tree(process)
            self.on_done(self.job_id)


class NativeTask(DownloadJob):
    def __init__(self, request: dict[str, Any], writer: NativeWriter, on_done: Callable[[str], None], operation: Callable[..., dict[str, Any]]):
        self.operation = operation
        super().__init__("request-" + str(request["id"]), request, writer, on_done, ffmpeg_path="", node_path=None, destination=Path("."))

    def _run(self) -> None:
        try:
            result = self.operation(self._register_process, self.cancelled)
            self.writer.send({"id": self.request["id"], "ok": True, "result": result})
        except SaveCancelled:
            self.writer.send({"id": self.request["id"], "ok": True, "result": {"cancelled": True}})
        except (OSError, ProtocolError, subprocess.SubprocessError) as exc:
            self.writer.send({"id": self.request["id"], "ok": False, "error": _bounded_error(str(exc))})
        finally:
            with self._process_lock:
                process, self._process = self._process, None
            if process is not None and process.poll() is None:
                terminate_process_tree(process)
            self.on_done(self.job_id)


class NativeHost:
    def __init__(self, reader: BinaryIO, writer: NativeWriter):
        self.reader = reader
        self.writer = writer
        self._jobs: dict[str, DownloadJob] = {}
        self._jobs_lock = threading.Lock()

    def _remove_job(self, job_id: str) -> None:
        with self._jobs_lock:
            self._jobs.pop(job_id, None)

    def _prepare(self, message: dict[str, Any]) -> tuple[dict[str, Any] | None, DownloadJob | None]:
        request = validate_request(message)
        request_id = request["id"]
        if request["action"] == "probe":
            return {"id": request_id, "ok": True, "result": probe_result()}, None
        if request["action"] in {"chooseFolder", "saveFile"}:
            def operation(register: Callable[..., None], cancelled: threading.Event) -> dict[str, Any]:
                if request["action"] == "chooseFolder":
                    return {"folder": choose_download_folder(register, cancelled)}
                source = Path(request["filename"])
                try:
                    saved = save_to_folder(source, Path(request["saveFolder"]), cancelled)
                    return {"filename": str(saved)}
                except (OSError, ProtocolError) as exc:
                    raise ProtocolError(str(exc) + " Completed media kept at " + str(source)) from exc
            task = NativeTask(request, self.writer, self._remove_job, operation)
            with self._jobs_lock:
                self._jobs[task.job_id] = task
            return None, task
        if request["action"] == "cancel":
            with self._jobs_lock:
                job = self._jobs.get(request["jobId"])
            if job is None:
                raise ProtocolError("Download job was not found or has already finished.")
            job.cancel()
            return {"id": request_id, "ok": True, "result": {"jobId": job.job_id}}, None

        if request.get("saveBefore") and os.name != "nt":
            raise ProtocolError("Choosing a save location before downloading is available with the Windows helper.")

        if not importlib.util.find_spec("yt_dlp"):
            raise ProtocolError("yt-dlp is not installed. Run Setup.cmd to repair the installation.")
        tools = executable_tools()
        if not tools["ffmpeg"] or not tools["ffprobe"]:
            raise ProtocolError("FFmpeg and FFprobe are required for MP4 and MP3 output. Install FFmpeg and reopen Firefox.")
        if is_youtube_url(request["url"]) and not tools["node"]:
            raise ProtocolError("Node.js is required for YouTube's JavaScript challenges. Install Node.js and reopen Firefox.")
        job_id = uuid.uuid4().hex
        job = DownloadJob(
            job_id,
            request,
            self.writer,
            self._remove_job,
            ffmpeg_path=tools["ffmpeg"],
            node_path=tools["node"],
            destination=download_directory() / ".pending" / job_id if (request["saveAs"] or request.get("saveFolder")) and os.name == "nt" else download_directory(),
        )
        with self._jobs_lock:
            self._jobs[job_id] = job
        return {"id": request_id, "ok": True, "result": {"jobId": job_id}}, job

    def _error_reply(self, request_id: str | int | None, error: Exception) -> dict[str, Any]:
        return {"id": request_id, "ok": False, "error": _bounded_error(str(error))}

    def serve(self) -> None:
        try:
            while True:
                try:
                    message = read_message(self.reader)
                except ProtocolError as exc:
                    self.writer.send(self._error_reply(None, exc))
                    continue
                if message is None:
                    break
                try:
                    reply, job = self._prepare(message)
                except ProtocolError as exc:
                    self.writer.send(self._error_reply(_request_id(message), exc))
                    continue
                if reply is not None:
                    self.writer.send(reply)
                if job is not None:
                    job.start()
        finally:
            self.shutdown()

    def shutdown(self) -> None:
        with self._jobs_lock:
            jobs = list(self._jobs.values())
        for job in jobs:
            job.cancel()
        for job in jobs:
            if job.thread.is_alive():
                job.thread.join(timeout=5)


def main() -> int:
    host = NativeHost(sys.stdin.buffer, NativeWriter(sys.stdout.buffer))
    try:
        host.serve()
    except (BrokenPipeError, OSError):
        host.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

