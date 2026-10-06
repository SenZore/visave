# Contributing

Thanks for taking the time to report a problem or suggest a change.

## Before opening a pull request

For bugs, include the visave version, Firefox version, Windows version when relevant, the page type involved, and the steps that reproduce the problem. Remove cookies, access tokens, personal URLs, and other private data from logs or screenshots.

For larger changes, open an issue first so the scope and expected behavior are clear. Do not include copyrighted media or credentials in a report.

## Development checks

Use Node.js 22 and Python 3.13. Install Node dependencies and run the checks from the repository root:

```powershell
npm ci
npm test
npm run lint
python -m pip install --require-hashes -r setup/windows-requirements.txt
python -m unittest discover -s tests/native
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/bootstrap-check.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/media-tools-check.ps1
npm run build
```

The Windows bundle build downloads upstream runtimes and Python dependencies. It requires Windows PowerShell and network access. The installed companion downloads the pinned FFmpeg archive from its publisher and verifies its SHA-256 hash during setup; that binary is not part of the GitHub release bundle.

The 0.3.3 extension flow downloads the versioned `visave-setup-0.3.3.exe` from GitHub Releases. Users must open the unsigned EXE and select **Install**; Firefox cannot install native Windows programs for an extension. Setup installs per user without administrator access, downloads and verifies its required components, and needs an internet connection. Test the flow from the extension Settings page as well as by running the underlying setup checks. Do not describe it as silent, one-click, AMO-approved, or permanently installable in Firefox while the extension remains unsigned.

```powershell
python tools/import-sites.py
npm run build
python tools/build-bootstrap.py
python tools/build-windows.py
python tools/check-bundle.py
python tools/package.py
```

Browser checks use a real Firefox installation and may contact public websites. Run them only when you can review the pages and network requests they use. Do not put authenticated cookies or tokens into test fixtures.

## Pull requests

Keep changes focused and describe the user-visible behavior they change. Include the commands you ran and any checks you could not run. Update documentation when installation, permissions, supported behavior, or release contents change.

For installation changes, document the exact sequence from loading the extension through dependency setup, readiness check, and choosing a save folder. Keep the installer version, release asset name, checksum, extension version, and tag aligned. State when a file is unsigned and describe Windows publisher warnings without telling users to bypass them.

Do not add downloaded binaries, generated archives, browser profiles, test results, or secrets to a pull request. Keep upstream license notices and provenance with bundled dependencies, and keep the FFmpeg publisher URL and hash aligned with the setup script.
