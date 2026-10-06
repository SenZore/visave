# visave

visave is a Firefox extension for inspecting videos on a page and saving available video or audio. A bundled Windows companion handles supported-site extraction, stream merging, audio conversion, and a persistent download folder.

The project is maintained by [senzdev](https://github.com/senzore). The public preview is version 0.3.1. It is unsigned and must be loaded as a temporary add-on in Firefox. Firefox removes temporary add-ons when it restarts. Permanent installation requires Mozilla signing; no signed release or AMO listing is available yet.

## Windows installation

Download the [Windows bundle](https://github.com/SenZore/visave/releases/download/v0.3.1/visave-windows-0.3.1.zip) and its [SHA-256 checksum](https://github.com/SenZore/visave/releases/download/v0.3.1/visave-windows-0.3.1.sha256) from the [0.3.1 preview release](https://github.com/SenZore/visave/releases/tag/v0.3.1). The bundle targets x64 Windows 10 and Windows 11. The release also provides the [unsigned Firefox extension ZIP](https://github.com/SenZore/visave/releases/download/v0.3.1/senzdev_visave-0.3.1.zip) and [source archive](https://github.com/SenZore/visave/releases/download/v0.3.1/visave-source.zip).

For the guided setup, download the bundle, extract it, and open `START-HERE.html`. Review the instructions, then run `Setup.cmd`. Setup installs the bundled files for the current Windows user and checks them before registering the Firefox connection. Setup needs internet access to download FFmpeg from its publisher and verify the pinned SHA-256 hash. You do not need to install Python, Node.js, or FFmpeg yourself.

The optional PowerShell bootstrap downloads the same versioned bundle and verifies its SHA-256 checksum before starting setup:

```powershell
irm https://raw.githubusercontent.com/senzore/visave/v0.3.1/install.ps1 | iex
```

This command executes the published `install.ps1` script. If you prefer to inspect it first, download `install.ps1` from the tagged source, review it, and run it locally. You can also download and inspect the release ZIP manually.

After the companion setup completes, load the extension ZIP from the bundle:

1. In Firefox, open `about:debugging#/runtime/this-firefox`.
2. Select **Load Temporary Add-on** and choose `visave-firefox-0.3.1.zip` from the extracted bundle.
3. In visave, open **Settings → Installation → Check installation**.
4. Choose a download folder in **Settings → Save downloaded files to**.
5. Refresh a supported video page, start playback, and use the **Now playing** row to download.

The extension may need to be loaded again after each Firefox restart until Mozilla signs a permanent release. Site support depends on each page, account state, and current extractor behavior. The list in visave is an offline snapshot, not a guarantee that every listed site or video will work. DRM downloads and active live streams are disabled.

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

The 0.3.1 preview is unsigned and has not had an independent security audit. Review the source and bundle before running them. Read [docs/FIREFOX-RELEASE.md](docs/FIREFOX-RELEASE.md) for the temporary-install limitation and release status, and [SECURITY.md](SECURITY.md) for vulnerability reports.

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
