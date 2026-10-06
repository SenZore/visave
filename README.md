# visave

visave is a Firefox extension for inspecting videos on a page and saving available video or audio. A bundled Windows companion handles supported-site extraction, stream merging, audio conversion, and a persistent download folder.

The project is maintained by [senzdev](https://github.com/senzore). Version 0.3.2 is an unsigned preview. Load the Firefox extension as a temporary add-on; Firefox removes it when it restarts. A signed AMO release is a future goal, and no approved AMO listing or signed release is available yet.

## Windows installation

For the unsigned preview, first load the [Firefox extension ZIP](https://github.com/SenZore/visave/releases/download/v0.3.2/senzdev_visave-0.3.2.zip) as a temporary add-on. In Firefox, open `about:debugging#/runtime/this-firefox`, select **Load Temporary Add-on**, and choose the ZIP. Firefox removes temporary add-ons when it restarts, so you must load it again after a restart.

Then install the Windows companion from the extension:

1. Open **Settings → Installation** and select **Install dependencies**. The extension downloads [`visave-setup-0.3.2.exe`](https://github.com/SenZore/visave/releases/download/v0.3.2/visave-setup-0.3.2.exe) from the [0.3.2 preview release](https://github.com/SenZore/visave/releases/tag/v0.3.2).
2. Open the downloaded installer once. It installs for your Windows user and does not need administrator access. Windows may warn that the publisher is unknown because this preview installer is unsigned. This guide does not advise bypassing Windows warnings; stop if you are unsure about a prompt or the file's source.
3. In the installer, select **Install**. It downloads and installs the required components, then registers the Firefox connection. Setup needs internet access.
4. Return to the extension. It checks the connection automatically; you can also select **Check installation**.
5. Choose a folder under **Settings → Save downloaded files to**. Refresh a supported video page, start playback, and use the **Now playing** row to download.

The setup program installs per user. It does not install Python, Node.js, or FFmpeg system-wide. Setup downloads pinned Python, Node.js, yt-dlp dependencies, and FFmpeg from their publishers; the FFmpeg archive is verified before installation. These private components use disk space and setup requires an internet connection. Firefox cannot install native Windows programs for an extension, so you must open the setup program and select **Install** yourself. This is a short manual step, not a silent or one-click installation.

The [0.3.2 preview release](https://github.com/SenZore/visave/releases/tag/v0.3.2) provides the [Windows bundle](https://github.com/SenZore/visave/releases/download/v0.3.2/visave-windows-0.3.2.zip), its [SHA-256 checksum](https://github.com/SenZore/visave/releases/download/v0.3.2/visave-windows-0.3.2.sha256), the [unsigned Firefox extension ZIP](https://github.com/SenZore/visave/releases/download/v0.3.2/senzdev_visave-0.3.2.zip), and [source archive](https://github.com/SenZore/visave/releases/download/v0.3.2/visave-source.zip). Review the installer and release notes before running it. Do not treat a checksum as proof that a file is safe.

## What it does

- Shows video rows with format choices, previews, and download actions.
- Ranks visible playing videos first and groups other loaded players in a collapsed list.
- Uses Firefox downloads for direct files. The Windows companion handles supported-site extraction, stream merging, MP3 conversion, and folder selection.
- Saves to a chosen folder without opening Explorer after each download. Files with duplicate names receive numbered names.
- The optional **Use my Firefox login for this download** choice is off by default and resets after an accepted download request. When selected, yt-dlp uses the most recently updated Firefox cookie database among the profiles it finds. That may differ from the profile you are browsing. Firefox container cookies are excluded. visave does not run in private windows.
- Includes an offline, searchable snapshot of site extractors. A listed extractor may stop working when a site changes.

Page restrictions, login requirements, unusual players, expiring URLs, and ambiguous multi-player pages can prevent detection or downloading. DRM-protected media is not supported.

## Data and permissions

visave does not send telemetry. Downloads connect to the page's source site. Optional cookie access is off by default and reads cookies locally after you enable it. Read [docs/PRIVACY.md](docs/PRIVACY.md) for the permission and data details.

## Inspect the release

The Windows bundle contains readable setup scripts and application source, a `SHA256SUMS.json` file, dependency inventories, hash-pinned Python requirements, and dependency license files. It does not contain FFmpeg binaries. Setup downloads the pinned FFmpeg archive from its publisher and checks its SHA-256 hash before installing it. The checksums detect changes relative to their supplied manifests. They do not prove that a file is safe or that the publisher is trusted.

The 0.3.2 preview is unsigned and has not had an independent security audit. Review the source and release files before running them. Read [docs/FIREFOX-RELEASE.md](docs/FIREFOX-RELEASE.md) for the temporary-install limitation and release status, and [SECURITY.md](SECURITY.md) for vulnerability reports.

## Development

Use Node.js 22 and Python 3.13 on Windows to build the full Windows bundle. A normal test and lint run is:

```powershell
npm ci
npm test
npm run lint
python -m unittest discover -s tests/native
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/bootstrap-check.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/media-tools-check.ps1
npm run build
```

Build the extension with `npm run build`. `tools/build-windows.py`, `tools/check-bundle.py`, and `tools/package.py` build and check the Windows bundle and source archive. Windows packaging downloads pinned upstream runtimes and dependencies, so it needs network access. The installed companion also downloads FFmpeg directly from its publisher and checks the pinned hash. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow.

The browser checks in `tools/browser-check.cjs`, `tools/toolbar-check.cjs`, and `tools/youtube-check.cjs` exercise real Firefox pages. A full clean-machine or VM check and authenticated Instagram download check remain release gates.

## License

Original visave code is licensed under the MIT License. Third-party components remain under their respective licenses. See [LICENSE](LICENSE) and the dependency license files in each Windows bundle.
