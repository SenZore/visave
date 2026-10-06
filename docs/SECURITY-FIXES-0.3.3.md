# Security fixes in 0.3.3

The supplied review reported three medium-severity denial-of-service issues that required a user to start a download. The findings did not report credential theft or remote code execution. Version 0.3.3 adds input and extraction limits, memory containment, and single-video enforcement. These changes address the reported cases; they are not a full security rescan or an independent audit.

## What changed

- **Native requests and diagnostics have size limits.** The extension rejects normalized URLs longer than 8,192 characters and serialized native requests larger than 64 KiB. The companion rejects native-message frames larger than 1 MiB. A malformed frame produces one bounded error reply, then that native connection closes instead of parsing more bytes from the invalid stream. Downloader stdout is read in lines up to 65,536 characters; stderr reads are capped at 8,192 characters per line and retain at most 80 lines.
- **Extractor metadata is bounded before decoding.** The bundled worker limits each webpage response's decompressed metadata to 16 MiB before yt-dlp decodes it into text. The byte budget covers repeated reads of that response.
- **The downloader and child processes have memory ceilings on supported Windows.** Before importing yt-dlp or making network requests, the worker joins a Windows Job Object. Windows limits committed memory to 1 GiB per process and 2 GiB for the downloader process tree, including child processes such as Node.js and FFmpeg. Microsoft documents how the process and job memory limits work in [JOBOBJECT_EXTENDED_LIMIT_INFORMATION](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information) and [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).
- **Each request processes one selected video.** The worker rejects playlist, multi-video, compatibility-list, or other results with an `entries` collection before it expands the entries. It also stops a second video from being processed in the same request. Ordinary video/audio merging and MP3 conversion remain available.

The worker wraps the pinned yt-dlp 2026.08.19 webpage-read and result-processing methods. See the corresponding upstream source for [`InfoExtractor._webpage_read_content`](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/yt_dlp/extractor/common.py) and [`YoutubeDL.process_ie_result` and `process_video_result`](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/yt_dlp/YoutubeDL.py). The wrapper must be checked again whenever the pinned yt-dlp version changes.

The worker also has a POSIX `RLIMIT_AS` fallback capped at 2 GiB for development and tests. visave's packaged companion supports x64 Windows 10 and 11; this fallback does not establish supported Linux or macOS builds.

## Updating

Install both the 0.3.3 extension and its matching companion. An older companion reports that current download protections are missing, and the extension keeps downloads disabled until the user updates or repairs the companion and checks installation again. Updating only the extension does not add the worker protections to an already installed companion.

## Verification and remaining limits

The tests include an actual gzip-compressed response larger than 16 MiB, a template containing multiple video elements, collection results whose entries must not be consumed, a worker and child-process memory-limit check, a containment failure that stops before importing yt-dlp, bounded downloader diagnostics, and an oversized native frame with a body. The current tested build passed 57 native tests and 33 JavaScript tests, 28 real Firefox checks, and three toolbar checks. Packaged MP4 and MP3 conversion checks also passed. A packaged Python/Node worker also completed a yt-dlp `--simulate` check for the public Blender video `aqz-KE-bpKQ`, resolved that video ID, and exited successfully without downloading media or using cookies. This confirms one public YouTube metadata path, not all YouTube videos.

These limits do not make arbitrary websites trustworthy or guarantee that a page cannot cause all failures. They address the reviewed resource-exhaustion paths while preserving ordinary single-video downloads and conversions. The 0.3.3 preview remains unsigned for Firefox and has not had an independent security audit.
