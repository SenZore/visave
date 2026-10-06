"use strict";

const ui = Object.fromEntries(Array.from(document.querySelectorAll("[id]")).map((element) => [element.id, element]));
let state = null;
let selectedUid = null;
let helper = null;
let checkingHelper = false;
let refreshing = false;
let busy = false;
let manualSelection = false;
let visibleJobId = null;
const dismissedJobs = new Set();
const rows = new Map();
const outputs = new Map();
let panelMode = null;
let menuUid = null;
let currentUid = null;
let panelTrigger = null;
let preferenceWrite = null;
let downloadFolder = "";
let choosingFolder = false;
const explicitTarget = new URLSearchParams(location.search).get("tabId");
const targetTab = explicitTarget === null ? null : Number(explicitTarget);

function actionError(message = "") {
  ui["action-status"].textContent = message;
  ui["action-status"].hidden = !message;
}

async function request(type, values = {}) {
  const reply = await browser.runtime.sendMessage({ type, ...values });
  if (!reply?.ok) throw new Error(reply?.error || "Firefox did not respond. Reload this tab and try again.");
  return reply.result;
}

function notice(message, error = false) {
  ui.notice.textContent = message;
  ui.notice.classList.toggle("error", error);
  ui.notice.hidden = !message;
}

function selectedVideo() {
  return state?.videos.find((video) => video.uid === selectedUid) || null;
}

function selectVideo(uid) {
  selectedUid = uid;
  manualSelection = true;
  ui.output.value = outputs.get(uid) || "mp4";
}

const kindBadges = { mp4: "MP4", webm: "WEBM", ogg: "OGG", video: "FILE", blob: "BLOB", hls: "HLS", dash: "DASH", segment: "SEG", audio: "AUDIO", unknown: "", unavailable: "" };
const sourceLabels = { mp4: "Direct MP4", webm: "Direct WebM", ogg: "Direct Ogg", video: "Video file", blob: "Blob / media stream", hls: "HLS stream", dash: "DASH stream", segment: "Adaptive segment", audio: "Audio source", unknown: "Not exposed", unavailable: "Unavailable" };

function closePanel(restoreFocus = true) {
  ui.panel.hidden = true;
  panelMode = null;
  ui.player.after(ui.panel);
  if (restoreFocus && panelTrigger?.isConnected) panelTrigger.focus();
  panelTrigger = null;
}

function openPanel(uid, mode, trigger) {
  closeMenu();
  if (selectedUid === uid && panelMode === mode) { closePanel(); return; }
  selectVideo(uid);
  panelMode = mode;
  panelTrigger = trigger;
  ui["panel-label"].textContent = mode === "options" ? "Download options" : "Video details";
  ui["options-view"].hidden = mode !== "options";
  ui["details-view"].hidden = mode !== "details";
  rows.get(uid)?.append(ui.panel);
  ui.panel.hidden = false;
  renderPlayer();
  (mode === "options" ? ui.output : ui["close-panel"]).focus();
}

function closeMenu(restoreFocus = false) {
  if (ui.menu.hidden) return;
  const trigger = rows.get(menuUid)?.querySelector(".row-more");
  ui.menu.hidden = true;
  document.body.append(ui.menu);
  menuUid = null;
  trigger?.setAttribute("aria-expanded", "false");
  if (restoreFocus) trigger?.focus();
}

function openMenu(uid, trigger) {
  if (!ui.menu.hidden && menuUid === uid) { closeMenu(true); return; }
  const video = state?.videos.find((item) => item.uid === uid);
  if (!video) return;
  closePanel(false);
  selectVideo(uid);
  menuUid = uid;
  const can = (output) => !busy && !VideoLens.installationMissing(helper).length && VideoLens.downloadPlan(video, output).route !== "disabled";
  const items = [
    ["Download video (MP4)", () => runDownload(uid, "mp4"), !can("mp4")],
    ["Download audio (MP3)", () => runDownload(uid, "mp3"), !can("mp3")],
    ["Download original file", () => runDownload(uid, "original"), !can("original")],
    null,
    ["Copy page URL", async (button) => {
      try { await navigator.clipboard.writeText(video.targetUrl || video.pageUrl || state.tab.url); button.textContent = "Copied"; }
      catch { button.textContent = "Copy failed"; }
      setTimeout(() => { if (menuUid === uid && button.isConnected) closeMenu(true); }, 700);
      return "keep";
    }, false],
    ["Quality and options", () => openPanel(uid, "options", trigger), false],
    ["Playback details", () => openPanel(uid, "details", trigger), false]
  ];
  ui.menu.replaceChildren(...items.map((item) => {
    if (!item) return document.createElement("hr");
    const [label, action, disabled] = item;
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.textContent = label;
    button.disabled = disabled;
    button.addEventListener("click", async () => {
      try {
        const result = await action(button);
        if (result !== "keep" && menuUid === uid && button.isConnected) closeMenu(true);
      } catch (error) { actionError(error.message); closeMenu(true); }
    });
    return button;
  }));
  rows.get(uid).append(ui.menu);
  ui.menu.hidden = false;
  ui.menu.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
  if (state) renderRows(state.videos || []);
}

function runDownload(uid, output) {
  if (busy) return;
  closeMenu(true);
  outputs.set(uid, output);
  selectVideo(uid);
  renderPlayer();
  return download();
}

function renderRows(videos) {
  const current = VideoLens.currentVideo(videos);
  currentUid = current?.uid || null;
  ui["watching-label"].hidden = !current;
  const label = current && (current.paused || current.ended || current.error ? "On screen" : "Now playing");
  if (ui["watching-label"].textContent !== (label || "")) ui["watching-label"].textContent = label || "";
  const otherCount = videos.length - (current ? 1 : 0);
  ui["other-videos"].hidden = !otherCount;
  ui["other-label"].textContent = "Other loaded videos (" + otherCount + ")";
  if (!otherCount) ui["other-videos"].open = false;
  const focused = document.activeElement;
  for (const [uid, row] of rows) {
    if (!videos.some((video) => video.uid === uid)) {
      if (menuUid === uid) closeMenu();
      if (row.contains(ui.panel)) closePanel(false);
      row.remove();
      rows.delete(uid);
      outputs.delete(uid);
    }
  }
  const positions = new Map();
  videos.forEach((video) => {
    let row = rows.get(video.uid);
    if (!row) {
      row = document.createElement("article");
      row.className = "video-row";
      row.dataset.uid = video.uid;
      row.setAttribute("role", "listitem");
      const preview = document.createElement("div");
      preview.className = "preview";
      const image = document.createElement("img");
      image.alt = "";
      image.referrerPolicy = "no-referrer";
      image.hidden = true;
      const fallback = document.createElement("span");
      fallback.className = "nopreview";
      fallback.textContent = "No preview";
      const dur = document.createElement("span");
      dur.className = "dur";
      dur.hidden = true;
      preview.append(image, fallback, dur);
      image.addEventListener("load", () => { image.hidden = false; fallback.hidden = true; });
      image.addEventListener("error", () => { image.hidden = true; fallback.hidden = false; });
      const body = document.createElement("div");
      body.className = "row-body";
      const title = document.createElement("button");
      title.type = "button";
      title.className = "row-title";
      title.dataset.action = "details";
      title.title = "View playback details";
      const meta = document.createElement("p");
      meta.className = "row-meta";
      const actions = document.createElement("div");
      actions.className = "row-actions";
      const downloadButton = document.createElement("button");
      downloadButton.type = "button";
      downloadButton.className = "primary row-download";
      downloadButton.dataset.action = "download";
      const options = document.createElement("button");
      options.type = "button";
      options.className = "row-more";
      options.dataset.action = "menu";
      options.textContent = "▾";
      options.setAttribute("aria-haspopup", "menu");
      options.setAttribute("aria-controls", "menu");
      const split = document.createElement("div");
      split.className = "split";
      split.append(downloadButton, options);
      const format = document.createElement("select");
      format.className = "row-format";
      for (const [value, label] of [["mp4", "MP4"], ["mp3", "MP3"], ["original", "Original"]]) format.add(new Option(label, value));
      format.addEventListener("change", () => {
        if (selectedUid !== video.uid) closePanel(false);
        outputs.set(video.uid, format.value);
        selectVideo(video.uid);
        renderPlayer();
      });
      actions.append(format, split);
      body.append(title, meta, actions);
      row.append(preview, body);
      rows.set(video.uid, row);
    }
    const container = video.uid === currentUid ? ui.video : ui["other-list"];
    const index = positions.get(container) || 0;
    if (container.children[index] !== row) container.insertBefore(row, container.children[index] || null);
    positions.set(container, index + 1);
    row.classList.toggle("is-current", video.uid === currentUid);
    const title = video.title || "Video on this page";
    const titleButton = row.querySelector(".row-title");
    titleButton.textContent = title;
    titleButton.setAttribute("aria-label", "Video details: " + title);
    const meta = row.querySelector(".row-meta");
    meta.replaceChildren();
    const addBadge = (text, cls = "") => { if (!text) return; const b = document.createElement("span"); b.className = "badge " + cls; b.textContent = text; meta.append(b); };
    addBadge(kindBadges[video.sourceKind] || "");
    if (video.encrypted) addBadge("DRM");
    else if (video.isLive) addBadge("LIVE", "live");
    const playback = video.error ? "Player error" : video.ended ? "Ended" : video.paused ? "Paused" : "Playing";
    const detail = [video.height ? video.height + "p" : "", playback].filter(Boolean).join(" · ");
    const text = document.createElement("span");
    text.textContent = detail + (!video.paused && !video.ended && !video.error && Number.isFinite(video.fps) ? " · " + video.fps.toFixed(0) + " fps sampled" : "");
    meta.append(text);
    const dur = row.querySelector(".dur");
    dur.hidden = video.isLive || !(video.duration > 0);
    dur.textContent = VideoLens.timeLabel(video.duration);
    const poster = VideoLens.httpUrl(video.posterUrl) || "";
    const image = row.querySelector("img");
    if ((image.dataset.poster || "") !== poster) {
      image.dataset.poster = poster;
      image.hidden = true;
      row.querySelector(".nopreview").hidden = false;
      if (poster) image.src = poster;
      else image.removeAttribute("src");
    }
    const options = row.querySelector(".row-more");
    options.setAttribute("aria-label", "More download options: " + title);
    options.setAttribute("aria-expanded", String(!ui.menu.hidden && menuUid === video.uid));
    const button = row.querySelector(".row-download");
    const formatSelect = row.querySelector(".row-format");
    const output = outputs.get(video.uid) || "mp4";
    if (formatSelect.value !== output) formatSelect.value = output;
    formatSelect.setAttribute("aria-label", "Download format: " + title);
    formatSelect.disabled = busy;
    button.textContent = "Download";
    button.disabled = busy || VideoLens.installationMissing(helper).length > 0 || VideoLens.downloadPlan(video, output).route === "disabled";
    button.setAttribute("aria-label", "Download " + output + ": " + title);
    button.title = VideoLens.installationMissing(helper).length ? "Install dependencies in Settings before downloading." : VideoLens.downloadPlan(video, output).reason;
  });
  if (focused?.isConnected && document.activeElement !== focused && focused.closest(".video-row")) focused.focus({ preventScroll: true });
}

function renderPlayer() {
  const video = selectedVideo();
  ui.player.hidden = !video;
  if (!video) return;
  ui.title.textContent = video.title || "Video on this page";
  ui.elapsed.textContent = VideoLens.timeLabel(video.currentTime);
  ui.duration.textContent = video.isLive ? "Live" : VideoLens.timeLabel(video.duration);
  ui["playback-state"].textContent = video.encrypted ? "Protected playback" : video.error ? "Player reported an error" : video.ended ? "Ended" : video.paused ? "Paused" : "Playing";
  ui.timeline.value = video.duration > 0 ? Math.min(100, Math.max(0, video.currentTime / video.duration * 100)) : 0;
  ui.resolution.textContent = video.width && video.height ? `${video.width} × ${video.height}` : "Waiting for metadata";
  ui.fps.textContent = video.paused || video.ended ? "Paused" : Number.isFinite(video.fps) ? `${video.fps.toFixed(1)} fps` : "Sampling...";
  ui.rate.textContent = Number.isFinite(video.playbackRate) ? `${video.playbackRate}×` : "Unknown";
  ui.buffer.textContent = Number.isFinite(video.bufferedAhead) ? `${video.bufferedAhead.toFixed(1)} s` : "Unknown";
  ui.frames.textContent = Number.isFinite(video.totalFrames) ? `${video.droppedFrames ?? 0} / ${video.totalFrames}` : "Not exposed";
  ui.volume.textContent = video.muted ? "Muted" : Number.isFinite(video.volume) ? `${Math.round(video.volume * 100)}%` : "Unknown";
  ui["source-kind"].textContent = sourceLabels[video.sourceKind] || "Not exposed";
  const bytes = video.fileSize || video.sizeBytes || video.contentLength;
  ui.size.textContent = Number.isFinite(bytes) && bytes > 0 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : "Not exposed";
  ui["play-pause"].textContent = video.paused || video.ended ? "Play" : "Pause";
  ui.mute.textContent = video.muted ? "Unmute" : "Mute";
  ui["page-url"].textContent = `Video page: ${video.targetUrl || video.pageUrl || state.tab.url}`;
  ui["source-url"].textContent = `Player source: ${video.sourceUrl || "The player has not exposed a source."}`;
  ui.seekable.textContent = Number.isFinite(video.seekableStart) && Number.isFinite(video.seekableEnd) ? `Seekable window: ${VideoLens.timeLabel(video.seekableStart)} to ${VideoLens.timeLabel(video.seekableEnd)}` : "No seekable window is exposed.";
  ui.network.textContent = `${state.resources?.length || 0} media responses observed in this tab. Only matching player sources contribute file details.`;
  renderDownload();
}

function renderDownload() {
  ui["setup-hint"].hidden = VideoLens.installationMissing(helper).length === 0;
  const video = selectedVideo();
  const output = ui.output.value;
  const plan = output === "original" && !["mp4", "webm", "ogg", "video"].includes(video?.sourceKind)
    ? { route: "disabled", reason: "This player exposes a stream rather than a complete file. Choose MP4 or MP3 with the local companion." }
    : VideoLens.downloadPlan(video, output);
  ui["download-reason"].textContent = plan.reason;
  if (plan.route === "helper" && output === "mp4" && ui.quality.value !== "best") ui["download-reason"].textContent += " If the site does not report dimensions, the helper uses the available source.";
  ui.download.textContent = output === "original" ? "Download original file" : `Download ${output.toUpperCase()}`;
  ui.download.disabled = busy || VideoLens.installationMissing(helper).length > 0 || plan.route === "disabled";
  ui.quality.disabled = output !== "mp4" || plan.route !== "helper";
  ui["cookie-choice"].hidden = plan.route !== "helper";
  ui["cookie-note"].hidden = plan.route !== "helper";
  ui.cookies.disabled = Boolean(state?.tab.incognito || (state?.tab.cookieStoreId && state.tab.cookieStoreId !== "firefox-default"));
  if (ui.cookies.disabled) ui.cookies.checked = false;
  if (state) renderRows(state.videos || []);
}

function renderJobs() {
  const jobs = (state?.jobs || []).filter((job) => job.tabId === state.tab.id).sort((a, b) => b.createdAt - a.createdAt);
  const job = jobs.find((item) => item.jobId === visibleJobId) || jobs[0];
  const active0 = job && ["starting", "downloading", "converting", "awaiting_save"].includes(job.state);
  ui.job.hidden = !job || (dismissedJobs.has(job.jobId) && !active0);
  if (ui.job.hidden) return;
  visibleJobId = job.jobId;
  const active = ["starting", "downloading", "converting", "saving", "awaiting_save"].includes(job.state);
  ui["dismiss-job"].hidden = active;
  const labels = { starting: "Starting download...", downloading: "Downloading", converting: "Converting media...", saving: "Saving to selected folder...", awaiting_save: "Choose a save location in the open dialog", complete: "Saved", error: "Download failed", cancelled: "Download cancelled" };
  const percent = job.state === "downloading" && Number.isFinite(job.percent) ? Math.min(100, Math.max(0, job.percent)) : null;
  ui["job-status"].textContent = `${labels[job.state] || job.state}${active && percent !== null ? ` (${percent.toFixed(0)}%)` : ""}${job.state === "error" && job.error ? `: ${job.error}` : ""}`;
  ui["job-progress"].hidden = !active || job.state === "awaiting_save";
  if (percent === null) ui["job-progress"].removeAttribute("value");
  else ui["job-progress"].value = percent;
  ui["job-file"].textContent = job.filename || (active && job.saveFolder ? job.saveFolder : job.kind === "native" && active ? "Choose the final folder after conversion finishes." : "");
  ui["job-note"].textContent = job.notice || "";
  ui["job-note"].hidden = !job.notice;
  ui.cancel.hidden = !active;
  ui["show-file"].hidden = job.state !== "complete" || job.kind !== "browser" || Boolean(job.saveFolder);
}

function renderState(next) {
  state = next;
  ui.site.textContent = VideoLens.siteName(state.tab.url);
  const videos = state.videos || [];
  if (!videos.some((video) => video.uid === selectedUid)) { manualSelection = false; selectedUid = null; }
  if (!manualSelection) selectedUid = VideoLens.currentVideo(videos)?.uid || videos[0]?.uid || null;
  ui.output.value = outputs.get(selectedUid) || "mp4";
  ui.count.textContent = videos.length > 1 ? " · " + videos.length + " loaded" : "";
  renderRows(videos);
  notice(videos.length ? currentUid ? "" : "No video on screen." : state.permissions === false ? "Firefox has not granted access to this site. Allow access from the extension menu, then reload the page." : "No video.");
  renderPlayer();
  renderJobs();
}

async function refresh(force = false) {
  if (refreshing) return;
  refreshing = true;
  ui.refresh.disabled = true;
  try {
    const next = await request(force ? "REFRESH" : "GET_STATE", state ? { tabId: state.tab.id } : targetTab > 0 ? { tabId: targetTab } : {});
    renderState(next);
  } catch (error) {
    notice(error.message, true);
  } finally {
    refreshing = false;
    ui.refresh.disabled = false;
  }
}

async function checkHelper() {
  if (checkingHelper) return helper;
  checkingHelper = true;
  ui["check-helper"].disabled = true;
  ui["helper-status"].textContent = "Checking installation...";
  try {
    helper = await request("HELPER_PROBE");
    const missing = VideoLens.installationMissing(helper);
    ui["helper-status"].textContent = missing.length ? `Installation incomplete. Missing ${missing.join(", ")}. Run the installer, then check again.` : "Installation ready. Downloads are enabled.";
    ui["install-dependencies"].textContent = missing.length ? "Install dependencies" : "Repair installation";
    return helper;
  } catch (error) {
    helper = null;
    ui["helper-status"].textContent = "Installation needed. Click Install dependencies, open the downloaded setup file, then click Install.";
    throw error;
  } finally { checkingHelper = false; ui["check-helper"].disabled = false; renderDownload(); }
}

async function download() {
  const video = selectedVideo();
  if (!video || busy) return;
  if (choosingFolder) { notice("Finish choosing a folder, or cancel the folder dialog, before downloading."); return; }
  busy = true;
  actionError();
  renderDownload();
  try {
    if (preferenceWrite) await preferenceWrite;
    const output = ui.output.value;
    const plan = VideoLens.downloadPlan(video, output);
    if (plan.route === "disabled") throw new Error(plan.reason);
    let result;
    if (plan.route === "browser") {
      result = await request("FILE_DOWNLOAD", { tabId: state.tab.id, videoUid: video.uid, output });
    } else {
      const available = helper || await checkHelper();
      if (!available.ytDlp || !available.ffmpeg || available.ffprobe === false) throw new Error("Install yt-dlp and FFmpeg/FFprobe using the helper setup instructions.");
      if (VideoLens.siteName(video.targetUrl || video.pageUrl) === "YouTube" && !available.jsRuntime) throw new Error("Install Node.js for YouTube downloads, then restart Firefox and check installation again.");
      result = await request("HELPER_DOWNLOAD", { tabId: state.tab.id, videoUid: video.uid, output, quality: ui.quality.value, useCookies: ui.cookies.checked && !ui.cookies.disabled });
    }
    visibleJobId = result?.jobId || null;
    if (visibleJobId) dismissedJobs.delete(visibleJobId);
    ui.cookies.checked = false;
    notice("");
    await refresh();
  } catch (error) { actionError(error.message); }
  finally { busy = false; renderDownload(); }
}

async function control(action) {
  const video = selectedVideo();
  if (!video) return;
  try {
    actionError();
    await request("CONTROL", { tabId: state.tab.id, videoUid: video.uid, action });
    await refresh(true);
  } catch (error) { actionError(error.message); }
}

ui.refresh.addEventListener("click", () => refresh(true));
ui.player.addEventListener("click", (event) => {
  const trigger = event.target.closest("button[data-action]");
  const row = trigger?.closest(".video-row");
  if (!row) return;
  const uid = row.dataset.uid;
  if (trigger.dataset.action === "download") {
    if (busy) return;
    if (selectedUid !== uid) closePanel(false);
    selectVideo(uid);
    renderPlayer();
    download();
  } else if (trigger.dataset.action === "menu") openMenu(uid, trigger);
  else openPanel(uid, trigger.dataset.action, trigger);
});
document.addEventListener("click", (event) => {
  if (!ui.menu.hidden && !event.target.closest("#menu, .row-more")) closeMenu();
});
ui.menu.addEventListener("keydown", (event) => {
  const buttons = [...ui.menu.querySelectorAll("button:not(:disabled)")];
  const index = buttons.indexOf(document.activeElement);
  if (event.key === "ArrowDown") { buttons[(index + 1) % buttons.length]?.focus(); event.preventDefault(); }
  else if (event.key === "ArrowUp") { buttons[(index - 1 + buttons.length) % buttons.length]?.focus(); event.preventDefault(); }
  else if (event.key === "Home") { buttons[0]?.focus(); event.preventDefault(); }
  else if (event.key === "End") { buttons.at(-1)?.focus(); event.preventDefault(); }
  else if (event.key === "Tab") { closeMenu(true); }
});
ui["close-panel"].addEventListener("click", () => closePanel());
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!ui.menu.hidden) { closeMenu(true); event.preventDefault(); return; }
  if (!ui.panel.hidden) { closePanel(); event.preventDefault(); }
  else if (ui.settings.open) { ui.settings.open = false; ui.settings.querySelector("summary").focus(); event.preventDefault(); }
});
ui.output.addEventListener("change", () => {
  if (selectedUid) outputs.set(selectedUid, ui.output.value);
  renderDownload();
});
ui.quality.addEventListener("change", renderDownload);
ui.download.addEventListener("click", download);
ui["play-pause"].addEventListener("click", () => control("playPause"));
ui.mute.addEventListener("click", () => control("mute"));
ui["check-helper"].addEventListener("click", () => checkHelper().catch(() => {}));
async function installDependencies(event) {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const setup = await request("INSTALL_DEPENDENCIES");
    notice(`Setup is downloading. Open ${setup.filename} from Firefox Downloads, then click Install. Downloads unlock when all components are detected.`);
  } catch (error) { notice(error.message, true); }
  finally { button.disabled = false; }
}
ui["install-dependencies"].addEventListener("click", installDependencies);
ui["install-start"].addEventListener("click", installDependencies);
ui.cancel.addEventListener("click", async () => {
  try { await request("CANCEL_JOB", { jobId: visibleJobId }); await refresh(); }
  catch (error) { actionError(error.message); }
});
ui["dismiss-job"].addEventListener("click", () => { if (visibleJobId) dismissedJobs.add(visibleJobId); ui.job.hidden = true; });
ui["show-file"].addEventListener("click", async () => {
  try { await request("SHOW_DOWNLOAD", { jobId: visibleJobId }); }
  catch (error) { actionError(error.message); }
});
ui.theme.addEventListener("change", async () => {
  document.documentElement.dataset.theme = ui.theme.value;
  try { await browser.storage.local.set({ theme: ui.theme.value }); }
  catch (error) { notice(`Could not save appearance: ${error.message}`, true); }
});
function renderSaveFolder() {
  ui["choose-folder"].textContent = downloadFolder || "Choose folder…";
  ui["choose-folder"].title = downloadFolder;
  ui["choose-folder"].disabled = choosingFolder || Boolean(preferenceWrite);
  ui["clear-folder"].hidden = !downloadFolder;
  ui["clear-folder"].disabled = choosingFolder || Boolean(preferenceWrite);
  ui["folder-hint"].textContent = choosingFolder ? "Choose a folder in the open dialog." : downloadFolder ? "Downloads save here automatically. No dialogs or File Explorer." : "Choose once. Future downloads save there without dialogs or File Explorer.";
}
ui["choose-folder"].addEventListener("click", async () => {
  choosingFolder = true;
  renderSaveFolder();
  try {
    const selected = await request("CHOOSE_FOLDER");
    if (selected.folder) { downloadFolder = selected.folder; notice(""); }
  } catch (error) { notice(`Could not choose a folder: ${error.message} Check the download helper in Settings.`, true); }
  finally { choosingFolder = false; renderSaveFolder(); }
});
ui["clear-folder"].addEventListener("click", async () => {
  preferenceWrite = browser.storage.local.set({ downloadFolder: "" });
  renderSaveFolder();
  try { await preferenceWrite; downloadFolder = ""; }
  catch (error) { notice(`Could not clear the folder: ${error.message}`, true); }
  finally { preferenceWrite = null; renderSaveFolder(); }
});

async function start() {
  if (explicitTarget !== null && (!Number.isInteger(targetTab) || targetTab <= 0)) {
    notice("This inspector link has an invalid tab ID. Open Video Lens from the toolbar.", true);
    return;
  }
  try {
    const settings = await browser.storage.local.get(["theme", "downloadFolder"]);
    ui.theme.value = ["light", "dark"].includes(settings.theme) ? settings.theme : "system";
    downloadFolder = typeof settings.downloadFolder === "string" ? settings.downloadFolder : "";
    document.documentElement.dataset.theme = ui.theme.value;
  } catch { /* The popup remains usable if preferences are unavailable. */ }
  renderSaveFolder();
  await refresh(true);
  checkHelper().catch(() => {});
  const timer = setInterval(() => { if (!busy) refresh(true); }, 1000);
  const installationTimer = setInterval(() => { if (!busy && !document.hidden && VideoLens.installationMissing(helper).length) checkHelper().catch(() => {}); }, 5000);
  window.addEventListener("pagehide", () => { clearInterval(timer); clearInterval(installationTimer); }, { once: true });
}
start();
