# visave installation and release status

Updated October 6, 2026. The public project is [SenZore/visave](https://github.com/SenZore/visave). Version 0.3.2 is an unsigned Windows x64 preview. A signed AMO listing is a future goal, not an approved or available release.

## First-time setup

1. Install the unsigned extension ZIP from the 0.3.2 preview release as a temporary add-on in Firefox. Use `about:debugging#/runtime/this-firefox` and **Load Temporary Add-on**. Firefox removes temporary add-ons when it restarts.
2. In the extension, open **Settings → Installation** and select **Install dependencies**. The extension downloads `visave-setup-0.3.2.exe` from GitHub Releases.
3. Open the downloaded setup program once and select **Install**. Firefox cannot install native Windows programs itself, so this user action is required.
4. Setup installs the companion for the current Windows user, checks its files and dependencies, and registers the native messaging connection. It does not require administrator access or install dependencies system-wide.
5. Return to Firefox. The extension checks whether the companion is ready; use **Check installation** to check again manually. Choose a download folder in Settings before downloading.

The setup EXE is an unsigned bootstrap for the existing readable PowerShell installation flow. It fetches pinned component packages, verifies their hashes, and installs a private runtime. Setup requires internet access and uses disk space for the private Python, Node.js, yt-dlp dependencies, and FFmpeg. The FFmpeg archive comes directly from its publisher and is verified before installation. These components are not system-wide installs. Because the setup EXE is unsigned, Windows may display an unknown-publisher warning. This guide does not advise bypassing Windows warnings; stop if you are unsure about a prompt or the file's source.

This flow reduces manual dependency setup, but it is not silent or one-click. Users still need to download and open the setup program and select **Install**. Do not describe it as AMO-approved, signed, or approved for permanent Firefox installation. Until Mozilla signs the extension, users must load the ZIP temporarily and reload it after Firefox restarts.

## Implemented behavior

- The Firefox Installation settings section downloads the versioned setup EXE and shows progress or failure.
- After users install the companion, the extension rechecks native messaging readiness automatically and offers a manual **Check installation** action.
- Setup installs per user under LocalAppData, checks files and component imports, runs offline MP4/MP3 encoding and inspection, and probes native messaging before registration. Failed checks leave an existing registration untouched.
- Setup does not change global PATH, create startup tasks, or install a service.
- The companion supports on-demand native messaging, upgrade-compatible IDs, saved folders, cancellation, and uninstall that preserves media.
- The bundle carries a private Python runtime, Node.js, yt-dlp and its Python dependencies, inventories, hashes, and license files. Setup downloads FFmpeg from Gyan and verifies the publisher archive and executable hashes; the bundle does not include FFmpeg executables.

## Why native setup remains separate

Firefox extensions cannot install or run Python, FFmpeg, or Node.js directly. Native messaging connects the extension to the separately installed companion. The companion runs yt-dlp for supported-site extraction, FFmpeg for stream merging and audio conversion, FFprobe for inspection, and Node/EJS for YouTube JavaScript challenges. Packaging dependencies avoids separate runtime installers, but it cannot make every website or video downloadable.

## Release checks

1. Test first install, repair, upgrade, and uninstall in a fresh Windows x64 account or VM without developer runtimes.
2. Test extension-driven setup download, opening and installing the EXE, readiness recheck, manual check, and failure recovery. Verify the signed AMO flow separately after Mozilla signing becomes available.
3. Check representative authenticated Instagram downloads and other site access cases. A listed extractor can fail when a site changes or restricts access. DRM and active live streams remain excluded.
4. Review every release file, dependency inventory, license notice, checksum, setup source, and source archive. Confirm that the setup downloads the pinned FFmpeg archive from its publisher and checks its hash.
5. Confirm the version, installer filename, asset URLs, hash, and extension metadata agree with the tag. Publish only after required checks pass.
6. Decide whether to obtain a Windows code-signing certificate and arrange an independent security review. Neither signing nor scans prove an absolute safety guarantee.

## Evidence distributed with each bundle

The release provides readable setup and application source, a SHA-256 inventory, pinned dependency URLs and hashes, and dependency licenses. The builder verifies publisher digests; setup checks the manifest before executing components. No unattended dependency updates run on users' computers. New dependencies arrive in a reviewed release.

FFmpeg remains GPL software. Setup downloads its verified package from the Gyan publisher; visave does not redistribute the executables. The package's source and license links stay in the setup documentation. If a future release bundles or mirrors FFmpeg, it must also meet corresponding source and notice obligations. See [Firefox release notes](docs/FIREFOX-RELEASE.md) and [privacy details](docs/PRIVACY.md).

## Sources

- [Mozilla native messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging)
- [Mozilla signing and distribution](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)
- [Python Windows releases](https://www.python.org/downloads/windows/)
- [Node distributions](https://nodejs.org/dist/v22.22.0/)
- [FFmpeg downloads and Windows build providers](https://ffmpeg.org/download.html)
- [Gyan build release and source commit](https://github.com/GyanD/codexffmpeg/releases/tag/9.0.2)
- [yt-dlp supported extractors and compatibility disclaimer](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)
