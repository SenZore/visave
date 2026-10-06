# visave installation and release status

Updated October 6, 2026. The public project is [SenZore/visave](https://github.com/SenZore/visave). Version 0.3.1 is a Windows x64 preview; permanent Firefox distribution still requires Mozilla signing.

## Implemented

- One Windows x64 ZIP with Setup.cmd and Uninstall.cmd. It includes private Python 3.13.13, Node.js 22.22.0, yt-dlp 2026.8.19, EJS 0.8.0 and hash-pinned Python dependencies. Setup downloads Gyan FFmpeg/FFprobe 9.0.2 directly from its publisher and checks the archive and executable hashes. The visave ZIP does not include those executables.
- One versioned PowerShell command downloads the GitHub release, verifies its checksum, and runs the same setup. Setup opens START-HERE.html after success to explain the Firefox step.
- Per-user installation under LocalAppData. Setup needs internet access. Users do not need separate dependency installers or administrator access. Setup does not change global PATH or add startup tasks or a service.
- File integrity checks, component imports, offline MP4/MP3 encoding/inspection and a framed native-host probe before registration. Failed checks leave the existing registration untouched.
- On-demand native messaging, upgrade-compatible IDs, saved folders, cancellation, and uninstall that preserves media.
- An Installation section in the popup and a step-by-step guide with a live connection check, dependency explanations, provenance, integrity details and compatibility limits.
- A searchable, paginated offline supported-site snapshot from upstream yt-dlp, including broken-entry markers and an upstream link.

## Why a separate installation is required

Firefox extensions cannot install/run Python, FFmpeg or Node directly. Native messaging connects the extension to an separately installed application. Python runs the downloader; yt-dlp extracts site streams; FFmpeg converts/merges; FFprobe inspects; Node/EJS handle YouTube JavaScript challenges. Packaging hides dependency management from end users but cannot make every website downloadable.

## Remaining release gates

1. Test install/repair/upgrade/uninstall in a fresh Windows x64 account/VM without developer runtimes. The current development-PC test excludes system tools from PATH but is not a complete clean-machine test.
2. Check representative authenticated Instagram downloads and other site access cases. A listed extractor can still fail due to site changes or restrictions. DRM and active live streams remain excluded.
3. Choose Mozilla AMO or signed self-distribution, submit the extension for signing with an authorized developer account, and test persistent installation. The current ZIP is unsigned and temporary in ordinary Firefox.
4. Publish the checked Windows bundle, extension preview, source archive and checksum at the tagged [GitHub release](https://github.com/SenZore/visave/releases). Confirm the bootstrap's exact version and asset names against the published release. No signed AMO listing exists yet.
5. Decide whether to obtain a Windows signing certificate and arrange independent security review. Signing and scans can add evidence; neither proves an absolute “not a virus” guarantee.

## Evidence distributed with each bundle

Readable setup/application source, a complete SHA-256 inventory, Python dependency URLs/hashes, upstream binary URLs/hashes, a hash-pinned requirements file and dependency licenses. The builder verifies Node/FFmpeg publisher digests and Python executable signature; setup checks manifest integrity before execution. No unattended dependency updates run on users' computers. New dependencies arrive in a new reviewed bundle.

FFmpeg remains GPL software. Setup downloads its verified package from the Gyan publisher; visave does not redistribute the executables. The package's source and license links stay in the setup documentation. Any future visave release that bundles FFmpeg must also satisfy the matching source and notice obligations. See [release rules](docs/FIREFOX-RELEASE.md) and [privacy details](docs/PRIVACY.md).

## Sources

- [Mozilla native messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging)
- [Mozilla signing and distribution](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)
- [Python Windows releases](https://www.python.org/downloads/windows/)
- [Node distributions](https://nodejs.org/dist/v22.22.0/)
- [FFmpeg downloads and Windows build providers](https://ffmpeg.org/download.html)
- [Gyan build release and source commit](https://github.com/GyanD/codexffmpeg/releases/tag/9.0.2)
- [yt-dlp supported extractors and compatibility disclaimer](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)
