# Visave privacy notice

Last updated: October 6, 2026

Visave is a Firefox extension with an optional local Windows companion. This notice describes the current project code. It is not legal advice. Review the [Firefox release guide](FIREFOX-RELEASE.md) for distribution notes.

Windows Setup requires an internet connection. It downloads the pinned FFmpeg package directly from Gyan's publisher release and checks its hashes before installing it on your computer. Gyan's release host receives the download request and ordinary connection details such as your IP address; Setup does not send page information, cookies, or Visave usage data. See [Gyan's FFmpeg build page](https://www.gyan.dev/ffmpeg/builds/) for the publisher's build and license information.

## What Visave reads

While Visave is enabled, its content script inspects eligible HTTP and HTTPS pages as they load, including while its popup is closed. It reads video elements and nearby page information so it can show available players. It can read the page URL and title, video or audio source and poster URLs, playback details, and media response URLs and headers. It does not inspect unrelated form contents or collect typed passwords.

Visave keeps current player information, media-resource details, and download job status in Firefox's session storage so the toolbar can continue showing the current state. These records stay on your computer and session data is removed when Firefox ends the session. Visave clears page and media-resource records as tabs navigate or close; a download job can remain visible until the session ends. Your chosen download folder is saved in Firefox's local extension settings. The project contains no Visave account service, analytics endpoint, or telemetry upload.

## When you download

If you start a direct download, Firefox downloads the media URL from the page. If you start a companion download, the extension sends the selected media or page URL, chosen output/quality settings, and download options to the Visave native companion installed on your computer. The companion runs yt-dlp and FFmpeg locally. It connects to the selected source platform to retrieve and process the media, then writes the result to your chosen location. Visave does not receive a copy of the downloaded file.

The **Use my Firefox login for this download** option is off unless you select it for that download. Only after you select it does the local companion ask yt-dlp to read Firefox cookies. Visave specifies Firefox's `none` container, so cookies stored in Firefox containers are excluded. The bundled yt-dlp version selects the Firefox cookie database with the most recent modification time among the profiles it finds. That may not be the profile you are currently viewing in Firefox. It uses relevant cookies in requests to the selected source platform, which may identify you to that platform. Visave does not send cookies to a Visave server. Visave is not available in private windows. Select this option only when you want an authenticated request to the source platform. See the [pinned yt-dlp cookie-loader source](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/yt_dlp/cookies.py#L141) and [cookie option documentation](https://github.com/yt-dlp/yt-dlp#filesystem-options).

Firefox native messaging connects the extension to the companion on the same computer. The extension may send the selected folder path and a completed staged file path to the companion when you use the saved-folder feature. Those paths remain on your computer.

## What Visave does not do

The current project code does not send browsing history, player information, cookies, filenames, or downloaded media to a Visave-operated server. It does not include analytics or advertising. Download requests go directly from the local companion or Firefox to the selected source platform and may include ordinary network information the platform receives from any request. If you opt to use Firefox cookies, authenticated requests may identify your account to that platform.

## Your choices and controls

You can close a tab, remove Visave, or change Firefox's site permissions to stop page inspection. Leave the cookie option off to avoid using your Firefox login for a companion download. Use Firefox's Add-ons Manager to remove the extension. Use the Windows uninstaller to remove the companion; downloaded files are preserved.

## Platform rules and downloaded content

Visave cannot grant rights to media or override a site's terms. Download only media you own or are authorized to save, and only where the platform's current terms permit the method. Do not use Visave to bypass access restrictions, DRM, or copy protection, or to redistribute another person's work without permission. See [YouTube's Terms](https://www.youtube.com/t/terms), [Instagram's Terms of Use](https://help.instagram.com/581066165581870), and the [release guide](FIREFOX-RELEASE.md).

## Policy and implementation note

Starting with version 0.3.1, the manifest declares `browsingActivity`, `websiteContent`, and `websiteActivity` for Firefox's built-in data disclosure, and disallows private-window use. These categories describe URLs and media/request details inspected on eligible pages while the extension is enabled, plus the user-started download action passed to the native companion. The cookie option remains off until selected for a particular download. Firefox requires users to accept required data categories when installing; reviewers should verify the install and upgrade prompts and confirm that the categories match the shipped behavior. Mozilla's [data classification and consent guidance](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/) says data sent through native messaging must be declared.

For questions about this notice, use the contact channel listed on the Visave project page.
