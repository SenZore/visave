# Release process

The current distribution is an unsigned Firefox preview for x64 Windows 10 and Windows 11. Firefox removes temporary add-ons after restart. A permanent AMO release requires Mozilla signing and approval. Do not describe an unsigned archive or an unreviewed AMO submission as signed, AMO-listed, approved, audited, or suitable for permanent installation.

## Before tagging

1. Confirm the default branch is clean and the version agrees in `package.json`, extension metadata, the setup EXE, Windows bundle, and source archive.
2. Run the checks in [CONTRIBUTING.md](../CONTRIBUTING.md), build and verify the Windows bundle, and test on a fresh Windows x64 account or VM.
3. Test the extension Installation flow: **Install dependencies** downloads the exact versioned EXE, the user opens it and selects **Install**, then extension readiness updates automatically and **Check installation** works manually.
4. Verify first install, repair, upgrade, failed setup, and uninstall. Confirm failures do not damage a previous registration or remove saved media.
5. Review every archive, source file, dependency inventory, license notice, checksum, installer, and setup script. Confirm no secrets, test profiles, unrelated files, or FFmpeg binaries are included in the bundle. Confirm setup fetches the pinned FFmpeg archive from its publisher and verifies its hashes.
6. Check the installer EXE and extension ZIP versions, tag, asset names, download URLs, and hashes. State that the setup EXE is unsigned and requires the user to open it and choose **Install**. Do not imply silent or one-click setup.
7. Do not call the extension signed or AMO-approved until Mozilla has signed and approved the listing. After that, verify persistent installation through the actual AMO listing.
8. For 0.3.3, review [the security-fix notes](SECURITY-FIXES-0.3.3.md). Confirm the bundle includes `downloader_worker.py`, the extension requires `securityLimitsSupported`, and an older companion is reported incomplete with downloads disabled. Run the bounded-metadata, collection, memory-inheritance, frame, URL, and serialized-request tests. Complete the normal MP4/MP3 bundle-conversion checks before release; the security tests alone do not replace them.

## Preview 0.3.3 assets

Prepare the `v0.3.3` preview release with the following versioned files. Verify final names against the built output before publishing.

| Asset | Purpose |
| --- | --- |
| `visave-setup-0.3.3.exe` | Unsigned Windows bootstrap that downloads and starts the readable per-user setup flow |
| `visave-windows-0.3.3.zip` | Windows x64 bundle and extension files for manual inspection or setup |
| `visave-windows-0.3.3.sha256` | SHA-256 checksum for the Windows bundle |
| `senzdev_visave-0.3.3.zip` | Unsigned Firefox extension ZIP for temporary installation |
| `visave-source.zip` | Source archive prepared by the packaging script |

Create a GitHub prerelease for `v0.3.3`, attach the reviewed files, and state clearly that the extension is unsigned and temporary. Explain that users must open the setup EXE and select **Install**, that setup needs internet access, and that Windows may report an unknown publisher. Do not ask users to bypass Windows warnings. A checksum detects changes relative to the supplied digest; it does not prove a file is safe.

## After publication

Open each release URL and confirm the files are available. Download and verify the Windows bundle checksum. Test the setup EXE download link shown in extension Settings and confirm the EXE fetches the exact matching release version. Verify the unsigned extension archive loads temporarily in Firefox. Update public documentation only after the release and its assets are published.
