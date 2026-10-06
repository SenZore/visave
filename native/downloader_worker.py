"""Run one selected-video download with bounded metadata and worker memory."""
import ctypes
import os
import sys
from ctypes import wintypes

MAX_METADATA_BYTES = 16 * 1024 * 1024
PROCESS_MEMORY_BYTES = 1024 * 1024 * 1024
JOB_MEMORY_BYTES = 2 * PROCESS_MEMORY_BYTES
_job_handle = None


def contain_memory():
    global _job_handle
    if os.name != "nt":
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (JOB_MEMORY_BYTES, JOB_MEMORY_BYTES))
        return

    class BasicLimits(ctypes.Structure):
        _fields_ = [("processTime", ctypes.c_longlong), ("jobTime", ctypes.c_longlong),
                    ("flags", wintypes.DWORD), ("minimumWorkingSet", ctypes.c_size_t),
                    ("maximumWorkingSet", ctypes.c_size_t), ("activeProcesses", wintypes.DWORD),
                    ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD), ("scheduling", wintypes.DWORD)]

    class Limits(ctypes.Structure):
        _fields_ = [("basic", BasicLimits), ("ioCounters", ctypes.c_ulonglong * 6),
                    ("processMemory", ctypes.c_size_t), ("jobMemory", ctypes.c_size_t),
                    ("peakProcessMemory", ctypes.c_size_t), ("peakJobMemory", ctypes.c_size_t)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    job = kernel.CreateJobObjectW(None, None)
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    limits = Limits()
    # Limit each process and the entire downloader/Node/FFmpeg process tree.
    limits.basic.flags = 0x100 | 0x200 | 0x2000
    limits.processMemory = PROCESS_MEMORY_BYTES
    limits.jobMemory = JOB_MEMORY_BYTES
    if not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)) or not kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess()):
        error = ctypes.WinError(ctypes.get_last_error())
        kernel.CloseHandle(job)
        raise error
    # Keep the handle open until exit; closing it terminates the contained tree.
    _job_handle = job


def install_guards():
    import yt_dlp
    from yt_dlp.extractor.common import InfoExtractor
    from yt_dlp.utils import ExtractorError

    class MetadataResponse:
        def __init__(self, response, budget):
            self.response, self.budget = response, budget

        def __getattr__(self, name):
            return getattr(self.response, name)

        def read(self, size=-1):
            requested = self.budget + 1 if size is None or size < 0 else min(size, self.budget + 1)
            chunks, total = [], 0
            while total < requested:
                chunk = self.response.read(min(65536, requested - total))
                if not chunk:
                    break
                total += len(chunk)
                if total > self.budget:
                    self.response.close()
                    raise ExtractorError("Metadata response exceeds the 16 MiB limit. Download stopped.", expected=True)
                chunks.append(chunk)
            self.budget -= total
            return b"".join(chunks)

    original_read = InfoExtractor._webpage_read_content

    def bounded_read(extractor, response, *args, **kwargs):
        prefix = kwargs.get("prefix", args[5] if len(args) > 5 else None)
        budget = MAX_METADATA_BYTES - len(prefix or b"")
        if budget < 0:
            raise ExtractorError("Metadata response exceeds the 16 MiB limit. Download stopped.", expected=True)
        return original_read(extractor, MetadataResponse(response, budget), *args, **kwargs)

    InfoExtractor._webpage_read_content = bounded_read

    class SelectedVideoDL(yt_dlp.YoutubeDL):
        _selected_video_started = False

        def process_ie_result(self, result, download=True, extra_info=None):
            if result.get("_type") in {"playlist", "multi_video", "compat_list"} or "entries" in result:
                raise ExtractorError("This page contains a collection. Open the selected video on its own page before downloading.", expected=True)
            return super().process_ie_result(result, download, extra_info)

        def process_video_result(self, result, download=True):
            if download:
                if self._selected_video_started:
                    raise ExtractorError("Only one selected video can be downloaded per request.", expected=True)
                self._selected_video_started = True
            return super().process_video_result(result, download)

    yt_dlp.YoutubeDL = SelectedVideoDL
    return MetadataResponse, SelectedVideoDL


def main():
    try:
        contain_memory()
        install_guards()
        import yt_dlp
        yt_dlp.main()
    except (OSError, MemoryError) as error:
        print("ERROR: Download worker could not stay within its memory protections: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
