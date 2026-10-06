"use strict";
const check = document.getElementById("check-installation");
const status = document.getElementById("installation-status");
check.addEventListener("click", async () => {
  check.disabled = true;
  status.textContent = "Checking Firefox connection and installed components…";
  try {
    const reply = await browser.runtime.sendMessage({ type: "HELPER_PROBE" });
    if (!reply?.ok) throw new Error(reply?.error || "No response from the installation.");
    const info = reply.result;
    const missing = [["yt-dlp", info.ytDlp], ["FFmpeg", info.ffmpeg], ["FFprobe", info.ffprobe], ["Node.js", info.jsRuntime], ["saved-folder support", info.saveFolderSupported]].filter(([, ready]) => !ready).map(([name]) => name);
    status.textContent = missing.length ? `Connected, but missing ${missing.join(", ")}. Run Setup.cmd again using the current Windows bundle.` : `Installation ready. Companion ${info.version}, yt-dlp ${info.ytDlpVersion}. Try a supported video below; site access still matters.`;
  } catch (error) {
    status.textContent = `Not connected: ${error.message} Run Setup.cmd, then reload the extension and check again.`;
  } finally { check.disabled = false; }
});
