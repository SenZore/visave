# Security policy

## Supported versions

Security fixes are made against the latest source on the default branch. Preview releases may contain known limitations; check the release notes before installing one.

## 0.3.3 download resource limits

A review reported three medium-severity denial-of-service issues that required a user to start a download. The supplied findings did not report credential theft or remote code execution. Version 0.3.3 adds bounds for native requests and extractor processing, and blocks collection and multi-video extraction. Read [the 0.3.3 security-fix notes](docs/SECURITY-FIXES-0.3.3.md) for the changes, tests, and limits.

Users need both the 0.3.3 extension and companion. The 0.3.3 extension checks for the companion's current download protections and keeps downloads disabled if an older companion is installed. Reinstall or repair the companion from the matching release, then check installation again. These changes address the supplied findings; they are not a full security rescan or audit, and they do not mean all malicious pages or media are safe.

The development dependency tree currently includes `node-forge` 1.4.0 through `web-ext` for its Android tooling. The maintainer's npm audit found this version within the reported vulnerable range, and no patched version was available in the npm registry at review time. It is a development-only dependency and is not included in the Windows runtime bundle. Recheck the advisory and dependency tree before each release; do not treat this note as a general security assessment.

## Report a vulnerability

Please use GitHub's private vulnerability reporting flow for this repository when it is available. If it is unavailable, open an issue asking for a private reporting route. Do not include exploit details, private account data, or working attack steps in a public issue.

Include the affected version, the steps needed to reproduce the issue, and the impact you observed. Do not send passwords, cookies, or other secrets in a report.

The project does not promise a response time or a coordinated disclosure schedule. The maintainer will update this policy if a supported reporting channel or response commitment changes.
