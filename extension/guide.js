"use strict";
const check = document.getElementById("check-installation");
const status = document.getElementById("installation-status");
const install = document.getElementById("install-dependencies");
const components = document.getElementById("installation-components");
let checking = false;
let ready = false;
async function checkInstallation() {
  if (checking) return;
  checking = true;
  check.disabled = true;
  status.textContent = "Checking Firefox connection and installed components…";
  try {
    const reply = await browser.runtime.sendMessage({ type: "HELPER_PROBE" });
    if (!reply?.ok) throw new Error(reply?.error || "No response from the installation.");
    const info = reply.result;
    const missing = VideoLens.installationMissing(info);
    ready = missing.length === 0;
    components.replaceChildren(...[["yt-dlp", info.ytDlp], ["FFmpeg", info.ffmpeg], ["FFprobe", info.ffprobe], ["Node.js", info.jsRuntime], ["YouTube challenge support", info.ejs], ["Saved folders", info.saveFolderSupported], ["Current download protections", info.securityLimitsSupported]].map(([name, found]) => {
      const item = document.createElement("li");
      item.textContent = `${name}: ${found ? "detected" : "missing"}`;
      return item;
    }));
    status.textContent = ready ? "Installation ready. Downloads are enabled. Open a video in Firefox, then use visave." : `Connected, but missing ${missing.join(", ")}. Run the current installer to repair the installation.`;
    install.textContent = ready ? "Repair installation" : "Install dependencies";
  } catch (error) {
    ready = false;
    components.replaceChildren();
    status.textContent = "Not connected yet. Open the downloaded setup file and click Install. This page will check again automatically.";
  } finally { checking = false; check.disabled = false; }
}
install.addEventListener("click", async () => {
  install.disabled = true;
  const downloadStatus = document.getElementById("setup-download-status");
  try {
    const reply = await browser.runtime.sendMessage({ type: "INSTALL_DEPENDENCIES" });
    if (!reply?.ok) throw new Error(reply?.error || "Could not start the setup download.");
    downloadStatus.textContent = `Downloading ${reply.result.filename}. Open it from Firefox Downloads when finished, then click Install.`;
    ready = false;
  } catch (error) { downloadStatus.textContent = error.message; }
  finally { install.disabled = false; }
});
check.addEventListener("click", checkInstallation);
checkInstallation();
const timer = setInterval(() => { if (!ready && !document.hidden) checkInstallation(); }, 5000);
window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
