# Release process

This project currently distributes an unsigned Firefox preview for x64 Windows 10 and Windows 11. Firefox temporary add-ons must be loaded again after Firefox restarts. A permanent extension release requires Mozilla signing. Do not describe an unsigned archive as signed, AMO-listed, audited, or suitable for permanent installation.

## Before tagging

1. Confirm the default branch is clean and the intended source version is set consistently in `package.json`, extension metadata, and the Windows packager.
2. Run the checks in [CONTRIBUTING.md](../CONTRIBUTING.md), then build and verify the Windows bundle on Windows.
3. Verify the extension in Firefox and complete the clean-machine or VM check. Resolve release blockers documented in [docs/FIREFOX-RELEASE.md](FIREFOX-RELEASE.md).
4. Review every archive, dependency inventory, license notice, checksum, setup script, and source archive. Confirm the Windows bundle does not contain FFmpeg binaries and the setup script fetches the pinned archive from its publisher, verifies the SHA-256 hash, and installs it. Do not include secrets, test profiles, or unrelated files.
5. Confirm the installer's versioned URL and checksum verification match the release tag and exact asset names.

## Preview 0.3.1 assets

The planned tag is `v0.3.1`. The release should include:

| Asset | Purpose |
| --- | --- |
| `visave-windows-0.3.1.zip` | Windows x64 companion and extension bundle; setup downloads FFmpeg from its publisher |
| `visave-windows-0.3.1.sha256` | SHA-256 checksum for the Windows bundle |
| `senzdev_visave-0.3.1.zip` | Unsigned Firefox extension ZIP |
| `visave-source.zip` | Source archive prepared by the packaging script |

Create a GitHub prerelease for the tag, attach the reviewed files, and state clearly that the extension is unsigned and temporary. Do not claim that GitHub's checksum, the ZIP manifest, or Windows Security establishes that the bundle is safe.

## After publication

Open each release URL and download every asset once. Compare the published checksum with the downloaded Windows archive. Check that the bootstrap script points to the exact tag and filename. Update the README only when the release exists and its assets are available.
