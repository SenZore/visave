(function () {
  "use strict";

  const FRAME_TTL = 20_000;
  const MAX_RESOURCES = 60;
  const framesByTab = new Map();
  const resourcesByTab = new Map();
  const jobs = new Map();
  const accessByTab = new Map();
  const nativeRequests = new Map();
  let nativePort = null;
  let nativeSequence = 1;
  let resourceWriteTimer = 0;

  const storageArea = browser.storage.session || null;
  const ready = restore();

  function result(value) { return { ok: true, result: value }; }
  function failure(error) { return { ok: false, error: String(error?.message || error || "Request failed.") }; }
  function boundedText(value, fallback = "") { return String(value || fallback).replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 500); }
  function jobId(prefix) {
    const id = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}-${id}`;
  }

  async function restore() {
    if (!storageArea) return;
    try {
      const stored = await storageArea.get(["runtimeFrames", "runtimeResources", "runtimeJobs"]);
      for (const [tabId, entries] of Object.entries(stored.runtimeFrames || {})) {
        const tabFrames = new Map();
        for (const entry of entries || []) if (entry && Number.isInteger(entry.frameId)) tabFrames.set(entry.frameId, entry);
        if (tabFrames.size) framesByTab.set(Number(tabId), tabFrames);
      }
      for (const [tabId, entries] of Object.entries(stored.runtimeResources || {})) {
        if (Array.isArray(entries)) resourcesByTab.set(Number(tabId), entries.slice(-MAX_RESOURCES));
      }
      for (const item of stored.runtimeJobs || []) if (item?.jobId) {
        if (!["starting", "downloading"].includes(item.state)) item.autoRevealPending = false;
        if (item.state === "saving") { item.state = "error"; item.error = "Saving was interrupted. Check the selected folder and the staged file path."; }
        jobs.set(item.jobId, item);
      }
    } catch { }
  }

  function serializeFrames() {
    return Object.fromEntries(Array.from(framesByTab, ([tabId, frameMap]) => [tabId, Array.from(frameMap.values())]));
  }

  function serializeResources() {
    return Object.fromEntries(resourcesByTab);
  }

  async function persist(keys = ["runtimeFrames", "runtimeResources", "runtimeJobs"]) {
    if (!storageArea) return;
    const values = {};
    if (keys.includes("runtimeFrames")) values.runtimeFrames = serializeFrames();
    if (keys.includes("runtimeResources")) values.runtimeResources = serializeResources();
    if (keys.includes("runtimeJobs")) values.runtimeJobs = Array.from(jobs.values());
    try { await storageArea.set(values); } catch { }
  }

  function deferResourcePersist() {
    clearTimeout(resourceWriteTimer);
    resourceWriteTimer = setTimeout(() => persist(["runtimeResources"]), 250);
  }

  function safeHttp(value) { return VideoLens.httpUrl(value) || null; }

  function sanitizeVideo(video, frameId, timestamp, fallbackPage) {
    const id = boundedText(video?.id).slice(0, 100);
    if (!id) return null;
    const source = typeof video.sourceUrl === "string" && video.sourceUrl.startsWith("blob:") ? video.sourceUrl.slice(0, 4096) : safeHttp(video.sourceUrl);
    const targetUrl = safeHttp(video.targetUrl);
    const pageUrl = safeHttp(video.pageUrl) || fallbackPage;
    const number = (value, minimum = -Infinity, maximum = Infinity) => Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : null;
    const kind = ["blob", "hls", "dash", "segment", "mp4", "webm", "ogg", "audio", "video", "unknown", "unavailable"].includes(video.sourceKind)
      ? video.sourceKind : VideoLens.sourceKind(source || "");
    return {
      id,
      uid: `${frameId}:${id}`,
      frameId,
      timestamp,
      title: boundedText(video.title, "Video on this page").slice(0, 300),
      posterUrl: safeHttp(video.posterUrl),
      pageUrl,
      targetUrl,
      site: VideoLens.siteName(pageUrl || targetUrl || ""),
      sourceUrl: source || "",
      sourceKind: kind,
      width: number(video.width, 0, 32768),
      height: number(video.height, 0, 32768),
      currentTime: number(video.currentTime, 0),
      duration: number(video.duration, 0),
      isLive: video.isLive === true,
      paused: video.paused !== false,
      ended: video.ended === true,
      muted: video.muted === true,
      volume: number(video.volume, 0, 1),
      playbackRate: number(video.playbackRate, 0, 16),
      bufferedAhead: number(video.bufferedAhead, 0),
      seekableStart: number(video.seekableStart, 0),
      seekableEnd: number(video.seekableEnd, 0),
      totalFrames: number(video.totalFrames, 0),
      droppedFrames: number(video.droppedFrames, 0),
      fps: number(video.fps, 0, 1000),
      encrypted: video.encrypted === true,
      visibleScore: number(video.visibleScore, 0) || 0,
      error: Number.isInteger(video.error) && video.error >= 1 && video.error <= 4 ? video.error : null
    };
  }

  function acceptSnapshot(message, sender) {
    const tabId = sender.tab?.id;
    const frameId = Number.isInteger(sender.frameId) ? sender.frameId : 0;
    if (!Number.isInteger(tabId) || !Array.isArray(message.videos) || message.videos.length > 100) throw new Error("Invalid video snapshot.");
    const timestamp = Date.now();
    const fallbackPage = safeHttp(message.pageUrl) || safeHttp(sender.url);
    const videos = message.videos.map((video) => sanitizeVideo(video, frameId, timestamp, fallbackPage)).filter(Boolean);
    let tabFrames = framesByTab.get(tabId);
    if (!tabFrames) framesByTab.set(tabId, tabFrames = new Map());
    tabFrames.set(frameId, { frameId, timestamp, pageUrl: fallbackPage, videos });
    accessByTab.set(tabId, true);
    persist(["runtimeFrames"]);
    return null;
  }

  function resourceMatch(video, resources) {
    if (!safeHttp(video.sourceUrl)) return null;
    const exact = resources.filter((resource) => resource.frameId === video.frameId && resource.url === video.sourceUrl);
    return exact.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0] || null;
  }

  function videosForTab(tabId) {
    const now = Date.now();
    const tabFrames = framesByTab.get(tabId);
    if (!tabFrames) return [];
    for (const [frameId, frame] of tabFrames) if (now - frame.timestamp > FRAME_TTL) tabFrames.delete(frameId);
    const resources = resourcesByTab.get(tabId) || [];
    const all = Array.from(tabFrames.values()).flatMap((frame) => frame.videos).map((video) => {
      const resource = resourceMatch(video, resources);
      if (!resource) return video;
      return { ...video, sourceKind: VideoLens.sourceKind(video.sourceUrl, resource.mime), fileSize: resource.contentLength, contentLength: resource.contentLength };
    });
    const real = all.filter((video) => !VideoLens.isGhost(video));
    return real;
  }

  async function targetTab(tabId) {
    if (Number.isInteger(tabId) && tabId >= 0) return browser.tabs.get(tabId);
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]) throw new Error("No active tab is available.");
    return tabs[0];
  }

  async function getState(tabId) {
    await ready;
    const tab = await targetTab(tabId);
    return {
      tab: { id: tab.id, url: tab.url || "", title: tab.title || "", incognito: Boolean(tab.incognito), cookieStoreId: tab.cookieStoreId || "firefox-default" },
      videos: videosForTab(tab.id),
      resources: resourcesByTab.get(tab.id) || [],
      jobs: Array.from(jobs.values()).filter((job) => job.tabId === tab.id),
      permissions: accessByTab.get(tab.id) !== false
    };
  }

  function selectedVideo(tabId, uid) {
    const video = videosForTab(tabId).find((item) => item.uid === uid);
    if (!video) throw new Error("The selected video is no longer available. Refresh the page and try again.");
    return video;
  }

  async function refresh(tabId) {
    const tab = await targetTab(tabId);
    try {
      await browser.tabs.sendMessage(tab.id, { type: "REFRESH" });
      accessByTab.set(tab.id, true);
    } catch {
      accessByTab.set(tab.id, false);
    }
    return getState(tab.id);
  }

  async function control(message) {
    const tab = await targetTab(message.tabId);
    const video = selectedVideo(tab.id, message.videoUid);
    if (!["playPause", "mute", "seek"].includes(message.action)) throw new Error("Unsupported player action.");
    if (message.action === "seek" && !Number.isFinite(message.time)) throw new Error("Seek time must be a finite number.");
    const reply = await browser.tabs.sendMessage(tab.id, { type: "CONTROL", videoId: video.id, action: message.action, time: message.time }, { frameId: video.frameId });
    if (!reply?.ok) throw new Error(reply?.error || "The video did not accept that action.");
    return reply.result;
  }

  function storeJob(job) {
    jobs.set(job.jobId, job);
    persist(["runtimeJobs"]);
    return job;
  }

  function downloadFilename(video, extension) {
    const title = VideoLens.siteName(video.pageUrl || video.targetUrl) === "Instagram" ? `Instagram-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}` : video.title;
    return VideoLens.safeFilename(title, extension);
  }

  async function savedFolder() {
    const preference = await browser.storage.local.get("downloadFolder");
    return typeof preference.downloadFolder === "string" ? preference.downloadFolder : "";
  }

  async function requireFolderSupport() {
    const capabilities = await nativeRequest("probe");
    if (capabilities.saveFolderSupported !== true) throw new Error("Update the visave installation to use a saved folder.");
  }

  async function requireInstallation() {
    const missing = VideoLens.installationMissing(await nativeRequest("probe"));
    if (missing.length) throw new Error("Install dependencies before downloading. Missing " + missing.join(", ") + ".");
  }

  async function chooseFolder() {
    await requireFolderSupport();
    const selection = await nativeRequest("chooseFolder", {}, 300_000);
    if (selection?.cancelled) return { cancelled: true };
    if (typeof selection?.folder !== "string" || !selection.folder) throw new Error("The helper did not return a valid folder.");
    await browser.storage.local.set({ downloadFolder: selection.folder });
    return { folder: selection.folder };
  }

  async function fileDownload(message) {
    const tab = await targetTab(message.tabId);
    const video = selectedVideo(tab.id, message.videoUid);
    const output = message.output === "original" ? "original" : message.output === "mp4" ? "mp4" : null;
    if (!output) throw new Error("Direct downloads support original or MP4 output.");
    const plan = VideoLens.downloadPlan(video, output);
    if (plan.route !== "browser" || !safeHttp(video.sourceUrl) || video.sourceKind === "segment") throw new Error(plan.reason || "This player does not expose a complete downloadable file.");
    const folder = await savedFolder();
    if (folder) await requireFolderSupport();
    await requireInstallation();
    const id = jobId("browser");
    const job = storeJob({ jobId: id, tabId: tab.id, title: video.title, output, saveFolder: folder, state: "starting", percent: null, filename: "", error: "", kind: "browser", downloadId: null, autoRevealPending: !folder, createdAt: Date.now() });
    try {
      const filename = downloadFilename(video, plan.extension || "mp4");
      job.downloadId = await browser.downloads.download({ url: video.sourceUrl, filename: folder ? `Video Lens/pending/${id}/${filename}` : `Video Lens/${filename}`, saveAs: !folder });
      job.state = "downloading";
      persist(["runtimeJobs"]);
      if (typeof browser.downloads.search === "function") {
        try {
          const [item] = await browser.downloads.search({ id: job.downloadId });
          if (item) await updateBrowserDownload({ id: item.id, filename: { current: item.filename }, state: { current: item.state } });
        } catch { }
      }
      return { jobId: id };
    } catch (error) {
      job.state = /cancel|USER_CANCELED/i.test(error.message || "") ? "cancelled" : "error";
      job.error = boundedText(error.message, "Firefox could not start the download.");
      persist(["runtimeJobs"]);
      if (job.state === "cancelled") return { jobId: id };
      throw error;
    }
  }

  function helperUrl(video, tabId) {
    if (video.encrypted) throw new Error("Protected media detected. Download is unavailable.");
    if (video.isLive) throw new Error("Live playback has no complete file yet.");
    const supported = ["YouTube", "Instagram", "TikTok", "Vimeo", "Twitch"].includes(video.site);
    const complete = ["mp4", "webm", "ogg", "video", "audio"].includes(video.sourceKind) ? safeHttp(video.sourceUrl) : null;
    if (supported && safeHttp(video.targetUrl)) return safeHttp(video.targetUrl);
    if (!supported && complete) return complete;
    if (video.sourceKind === "blob") {
      const manifests = (resourcesByTab.get(tabId) || []).filter((resource) => resource.frameId === video.frameId && ["hls", "dash"].includes(resource.sourceKind));
      const unique = [...new Set(manifests.map((resource) => resource.url))];
      const playersInFrame = videosForTab(tabId).filter((item) => item.frameId === video.frameId);
      if (unique.length === 1 && playersInFrame.length === 1) return unique[0];
      if (video.site === "Instagram" && !/^https:\/\/(?:www\.)?instagram\.com\/(?:p|reel|reels|stories)\//i.test(video.targetUrl || "")) {
        throw new Error("Open the Instagram post, reel, or story itself before downloading this video.");
      }
      if (!supported && playersInFrame.length > 1) throw new Error("This page has multiple streamed videos. Open the selected video on its own page before downloading.");
    }
    return safeHttp(video.targetUrl) || complete || null;
  }

  function connectNative() {
    if (nativePort) return nativePort;
    const port = browser.runtime.connectNative("com.videolens.downloader");
    nativePort = port;
    port.onMessage.addListener((message) => {
      if (message && Object.prototype.hasOwnProperty.call(message, "id")) {
        const pending = nativeRequests.get(message.id);
        if (!pending) return;
        nativeRequests.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new Error(message.error || "The local companion rejected the request."));
        return;
      }
      if (message?.event && message.jobId) updateNativeJob(message);
    });
    port.onDisconnect.addListener(() => {
      if (nativePort !== port) return;
      const error = new Error(port.error?.message || browser.runtime.lastError?.message || "The local companion disconnected.");
      nativePort = null;
      for (const pending of nativeRequests.values()) { clearTimeout(pending.timer); pending.reject(error); }
      nativeRequests.clear();
      for (const job of jobs.values()) {
        if ((job.kind === "native" || job.nativeTransferId) && ["starting", "downloading", "converting", "saving", "awaiting_save"].includes(job.state)) { job.state = "error"; job.error = boundedText(error.message); }
      }
      persist(["runtimeJobs"]);
    });
    return port;
  }

  function nativeRequest(action, values = {}, timeoutMs = 15000, onRequestId = null) {
    return new Promise((resolve, reject) => {
      const message = { id: `extension-${nativeSequence++}`, action, ...values };
      if (new TextEncoder().encode(JSON.stringify(message)).byteLength > 65536) {
        reject(new Error("The download request is too large. Open the video on its own page and try again."));
        return;
      }
      let port;
      try { port = connectNative(); } catch (error) { reject(error); return; }
      const id = message.id;
      if (onRequestId) onRequestId(id);
      const timer = setTimeout(() => {
        nativeRequests.delete(id);
        reject(new Error("The local companion did not respond. Check its installation and try again."));
      }, timeoutMs);
      nativeRequests.set(id, { resolve, reject, timer });
      try { port.postMessage(message); }
      catch (error) { nativeRequests.delete(id); clearTimeout(timer); reject(error); }
    });
  }

  function updateNativeJob(message) {
    const job = jobs.get(message.jobId);
    if (!job || job.kind !== "native") return;
    if (message.event === "progress") {
      job.state = message.phase === "awaiting_save" ? "awaiting_save" : message.phase === "processing" ? "converting" : "downloading";
      if (Number.isFinite(message.percent)) job.percent = Math.min(100, Math.max(0, message.percent));
    } else if (["complete", "error", "cancelled"].includes(message.event)) {
      job.state = message.event;
      if (message.filename) job.filename = boundedText(message.filename);
      if (message.notice) job.notice = boundedText(message.notice);
      if (message.event === "complete") job.percent = 100;
      if (message.event === "error") job.error = boundedText(message.error, "The local companion could not finish the download.");
    }
    persist(["runtimeJobs"]);
  }

  async function helperDownload(message) {
    const tab = await targetTab(message.tabId);
    const video = selectedVideo(tab.id, message.videoUid);
    if (!["mp4", "mp3"].includes(message.output)) throw new Error("Output must be MP4 or MP3.");
    if (!["best", "1080", "720", "480"].includes(message.quality)) throw new Error("Choose a supported video quality.");
    if (typeof message.useCookies !== "boolean") throw new Error("Cookie consent must be explicitly enabled or disabled.");
    if (message.useCookies && (tab.incognito || (tab.cookieStoreId && tab.cookieStoreId !== "firefox-default"))) throw new Error("Firefox cookie access is unavailable in private windows and container tabs.");
    const plan = VideoLens.downloadPlan(video, message.output);
    if (plan.route !== "helper") throw new Error(plan.reason || "This download does not require the local companion.");
    const url = helperUrl(video, tab.id);
    if (!url) throw new Error("No safe video URL is available for the local companion.");
    const folder = await savedFolder();
    const values = { url, output: message.output, quality: message.quality, useCookies: message.useCookies, saveAs: true, reveal: true };
    if (folder) {
      await requireFolderSupport();
      values.saveFolder = folder;
      values.saveAs = false;
      values.reveal = false;
    }
    if (VideoLens.siteName(video.pageUrl || video.targetUrl) === "Instagram") {
      if (!folder && (await nativeRequest("probe")).filenameSupported !== true) throw new Error("Update the visave installation for random Instagram filenames.");
      values.filename = downloadFilename(video, message.output);
    }
    await requireInstallation();
    const response = await nativeRequest("download", values);
    const id = boundedText(response?.jobId).slice(0, 128);
    if (!id) throw new Error("The local companion returned an invalid job identifier.");
    storeJob({ jobId: id, tabId: tab.id, title: video.title, output: message.output, saveFolder: folder, state: "starting", percent: 0, filename: "", error: "", kind: "native", downloadId: null, createdAt: Date.now() });
    return { jobId: id };
  }

  async function cancelJob(id) {
    const job = jobs.get(id);
    if (!job) throw new Error("Download job was not found.");
    if (!["starting", "downloading", "converting", "saving", "awaiting_save"].includes(job.state)) throw new Error("This download has already finished.");
    if (job.kind === "native") await nativeRequest("cancel", { jobId: job.jobId });
    else if (job.state === "saving" && job.nativeTransferId) await nativeRequest("cancel", { jobId: job.nativeTransferId });
    else if (Number.isInteger(job.downloadId)) {
      job.autoRevealPending = false;
      await browser.downloads.cancel(job.downloadId);
    }
    else throw new Error("Cancel the open Firefox save dialog to stop this download.");
    job.state = "cancelled";
    await persist(["runtimeJobs"]);
    return { jobId: job.jobId };
  }

  async function showDownload(id) {
    const job = jobs.get(id);
    if (!job || job.kind !== "browser" || !Number.isInteger(job.downloadId) || job.state !== "complete" || job.saveFolder) throw new Error("Use the saved folder shown for this download.");
    if (await browser.downloads.show(job.downloadId) === false) throw new Error("File Explorer could not open this saved file.");
    return { jobId: job.jobId };
  }

  function isExtensionUi(sender) {
    const base = browser.runtime.getURL("");
    return sender?.id === browser.runtime.id && typeof sender.url === "string" && sender.url.startsWith(base);
  }

  function isContent(sender) {
    return sender?.id === browser.runtime.id && Number.isInteger(sender.tab?.id);
  }

  async function privileged(message) {
    switch (message.type) {
      case "GET_STATE": return getState(message.tabId);
      case "REFRESH": return refresh(message.tabId);
      case "CONTROL": return control(message);
      case "FILE_DOWNLOAD": return fileDownload(message);
      case "HELPER_PROBE": {
        const active = Array.from(jobs.values()).some(job => ["starting", "downloading", "converting", "saving", "awaiting_save"].includes(job.state));
        // Reconnect after setup updates the registration, without interrupting a download.
        if (nativePort && !active && nativeRequests.size === 0) {
          const previous = nativePort;
          nativePort = null;
          previous.disconnect();
        }
        return nativeRequest("probe");
      }
      case "INSTALL_DEPENDENCIES": {
        const platform = await browser.runtime.getPlatformInfo();
        if (platform.os !== "win" || platform.arch !== "x86-64") throw new Error("The installer supports x64 Windows 10 and 11. macOS, Linux and ARM packages are not available yet.");
        const version = browser.runtime.getManifest().version;
        if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid release version.");
        const filename = `visave-setup-${version}.exe`;
        const downloadId = await browser.downloads.download({ url: `https://github.com/SenZore/visave/releases/download/v${version}/${filename}`, filename, saveAs: false });
        return { downloadId, filename };
      }
      case "HELPER_DOWNLOAD": return helperDownload(message);
      case "CHOOSE_FOLDER": return chooseFolder();
      case "CANCEL_JOB": return cancelJob(message.jobId);
      case "SHOW_DOWNLOAD": return showDownload(message.jobId);
      default: throw new Error("Unsupported extension request.");
    }
  }

  browser.runtime.onMessage.addListener((message, sender) => {
    if (!message || typeof message !== "object") return undefined;
    if (message.type === "SNAPSHOT") {
      if (!isContent(sender)) return Promise.resolve(failure("Video snapshots are accepted only from inspected tabs."));
      return Promise.resolve(ready).then(() => acceptSnapshot(message, sender)).then(result, failure);
    }
    const privilegedTypes = new Set(["GET_STATE", "REFRESH", "CONTROL", "FILE_DOWNLOAD", "HELPER_PROBE", "INSTALL_DEPENDENCIES", "HELPER_DOWNLOAD", "CHOOSE_FOLDER", "CANCEL_JOB", "SHOW_DOWNLOAD"]);
    if (!privilegedTypes.has(message.type)) return undefined;
    if (!isExtensionUi(sender)) return Promise.resolve(failure("Privileged requests are accepted only from visave pages."));
    return Promise.resolve().then(() => privileged(message)).then(result, failure);
  });
  browser.runtime.onInstalled?.addListener(details => {
    if (details.reason === "install") browser.tabs.create({ url: browser.runtime.getURL("guide.html") });
  });

  async function updateBrowserDownload(delta) {
    await ready;
    const job = Array.from(jobs.values()).find((item) => item.kind === "browser" && item.downloadId === delta.id);
    if (!job) return;
    if (job.saveFolder && job.transferStarted) return;
    if (job.saveFolder && delta.state?.current === "complete") {
      if (!["starting", "downloading"].includes(job.state)) return;
      job.transferStarted = true;
      job.state = "saving";
      job.autoRevealPending = false;
      await persist(["runtimeJobs"]);
      try {
        const [saved] = await browser.downloads.search({ id: job.downloadId });
        if (!saved?.filename || saved.state !== "complete" || saved.exists === false) throw new Error("The completed file is unavailable.");
        job.filename = saved.filename;
        const moved = await nativeRequest("saveFile", { filename: saved.filename, saveFolder: job.saveFolder }, 600_000, id => { job.nativeTransferId = `request-${id}`; });
        if (moved?.cancelled) { job.state = "cancelled"; job.notice = "Completed media kept at " + saved.filename; }
        else {
          if (typeof moved?.filename !== "string" || !moved.filename) throw new Error("The helper did not return a saved filename.");
          job.filename = moved.filename;
          job.state = "complete";
          job.percent = 100;
        }
      } catch (error) {
        if (job.state !== "cancelled") { job.state = "error"; job.error = boundedText(error.message, "The file could not be saved to the selected folder."); }
      }
      await persist(["runtimeJobs"]);
      return;
    }
    const reveal = delta.state?.current === "complete" && job.autoRevealPending === true && ["starting", "downloading"].includes(job.state);
    if (delta.filename?.current) job.filename = delta.filename.current;
    if (delta.error?.current) { job.state = "error"; job.error = boundedText(delta.error.current); }
    if (delta.state?.current === "complete") { job.state = "complete"; job.percent = 100; job.revealed = true; }
    if (delta.state?.current === "interrupted" && job.state !== "cancelled") { job.state = "error"; job.error ||= "Firefox interrupted the download."; }
    if (["complete", "cancelled", "error"].includes(job.state)) job.autoRevealPending = false;
    await persist(["runtimeJobs"]);
    if (reveal) {
      try {
        if (typeof browser.downloads.search === "function") {
          const [saved] = await browser.downloads.search({ id: job.downloadId });
          if (!saved || saved.state !== "complete" || saved.exists === false || !saved.filename) throw new Error("Saved file unavailable");
        }
        if (await browser.downloads.show(job.downloadId) === false) throw new Error("File manager unavailable");
      }
      catch { job.notice = "The file was saved, but File Explorer could not open. Use Show saved file to try again."; await persist(["runtimeJobs"]); }
    }
  }
  browser.downloads.onChanged.addListener(updateBrowserDownload);

  function headerValue(headers, name) {
    return (headers || []).find((header) => header.name?.toLowerCase() === name)?.value || "";
  }

  browser.webRequest.onHeadersReceived.addListener((details) => {
    if (!Number.isInteger(details.tabId) || details.tabId < 0 || !safeHttp(details.url)) return;
    const mime = headerValue(details.responseHeaders, "content-type").split(";")[0].trim().toLowerCase();
    const kind = VideoLens.sourceKind(details.url, mime);
    const media = mime.startsWith("video/") || mime.startsWith("audio/") || ["hls", "dash", "segment", "mp4", "webm", "ogg", "audio", "video"].includes(kind);
    if (!media) return;
    const range = headerValue(details.responseHeaders, "content-range");
    const rangeTotal = Number(range.match(/\/(\d+)\s*$/)?.[1]);
    const length = Number(headerValue(details.responseHeaders, "content-length"));
    const contentLength = Number.isFinite(rangeTotal) && rangeTotal > 0 ? rangeTotal : Number.isFinite(length) && length > 0 ? length : null;
    const list = resourcesByTab.get(details.tabId) || [];
    const resource = { url: details.url, sourceKind: kind, mime, contentLength, frameId: Number.isInteger(details.frameId) ? details.frameId : 0, timestamp: Date.now() };
    const duplicate = list.findIndex((item) => item.url === resource.url && item.frameId === resource.frameId);
    if (duplicate >= 0) list.splice(duplicate, 1);
    list.push(resource);
    resourcesByTab.set(details.tabId, list.slice(-MAX_RESOURCES));
    deferResourcePersist();
  }, { urls: ["http://*/*", "https://*/*"] }, ["responseHeaders"]);

  browser.webNavigation.onCommitted.addListener((details) => {
    if (!Number.isInteger(details.tabId)) return;
    if (details.frameId === 0) {
      framesByTab.delete(details.tabId);
      resourcesByTab.delete(details.tabId);
      accessByTab.delete(details.tabId);
    } else {
      framesByTab.get(details.tabId)?.delete(details.frameId);
      const resources = resourcesByTab.get(details.tabId);
      if (resources) resourcesByTab.set(details.tabId, resources.filter((item) => item.frameId !== details.frameId));
    }
    persist(["runtimeFrames", "runtimeResources"]);
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    framesByTab.delete(tabId);
    resourcesByTab.delete(tabId);
    accessByTab.delete(tabId);
    persist(["runtimeFrames", "runtimeResources"]);
  });
})();
