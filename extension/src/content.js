(function () {
  "use strict";

  const records = new Map();
  const observedRoots = new WeakSet();
  let nextId = 1;
  let currentPageUrl = location.href;
  let subscriberUntil = 0;
  let snapshotTimer = 0;
  let discoveryTimer = 0;
  let sendTimer = 0;
  let stopped = false;
  const visibilityObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const record = records.get(entry.target);
      if (record) record.visibleRatio = entry.isIntersecting ? entry.intersectionRatio : 0;
    }
    queueSnapshot(20);
  }, { threshold: Array.from({ length: 101 }, (_, index) => index / 100) });

  const finite = (value) => Number.isFinite(value) ? value : null;
  const cleanText = (value, fallback = "") => String(value || fallback).replace(/\s+/g, " ").trim().slice(0, 300);

  function pageUrl() {
    return VideoLens.httpUrl(location.href) || null;
  }

  function permalinkFor(video) {
    const page = pageUrl();
    if (!page) return null;
    const url = new URL(page);
    const host = url.hostname.toLowerCase();
    const nearestLink = video.closest("a[href]")?.href;
    const validLink = VideoLens.httpUrl(nearestLink);

    if (host === "youtu.be" || host.endsWith(".youtu.be")) {
      const id = url.pathname.split("/").filter(Boolean)[0];
      return id ? `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` : page;
    }
    if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtube-nocookie.com" || host.endsWith(".youtube-nocookie.com")) {
      const pathId = url.pathname.match(/^\/(?:shorts|embed)\/([^/?#]+)/)?.[1];
      const id = url.pathname === "/watch" ? url.searchParams.get("v") : pathId;
      return id ? `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` : page;
    }
    if (host === "instagram.com" || host.endsWith(".instagram.com")) {
      const isPost = (value) => {
        try { return /^\/(?:p|reel|reels|stories)\//.test(new URL(value).pathname); }
        catch { return false; }
      };
      const articleLink = Array.from(video.closest("article, [role='article']")?.querySelectorAll("a[href]") || [])
        .map((anchor) => VideoLens.httpUrl(anchor.href))
        .find((href) => href && isPost(href) && new URL(href).hostname.endsWith("instagram.com"));
      if (validLink && isPost(validLink) && new URL(validLink).hostname.endsWith("instagram.com")) return validLink;
      if (articleLink) return articleLink;
      if (isPost(page)) return page;
      return null;
    }
    if (host === "tiktok.com" || host.endsWith(".tiktok.com")) {
      const isVideo = (value) => {
        try { return /\/@[^/]+\/video\/\d+/.test(new URL(value).pathname); }
        catch { return false; }
      };
      if (validLink && isVideo(validLink)) return validLink;
      return page;
    }
    if (host === "player.vimeo.com" && /^\/video\/\d+/.test(url.pathname)) {
      return `https://vimeo.com/${url.pathname.split("/")[2]}`;
    }
    if (host === "vimeo.com" || host.endsWith(".vimeo.com")) {
      if (validLink && /^\/\d+/.test(new URL(validLink).pathname)) return validLink;
      return page;
    }
    if (host === "twitch.tv" || host.endsWith(".twitch.tv")) {
      if (validLink && /^\/(?:videos|clip)\//.test(new URL(validLink).pathname)) return validLink;
      return page;
    }
    return page;
  }

  function titleFor(video) {
    const explicit = video.getAttribute("aria-label") || video.getAttribute("title");
    const nearby = video.closest("article, [role='article']")?.querySelector("h1, h2, h3, [role='heading']")?.textContent;
    return explicit || nearby ? cleanText(explicit || nearby) : VideoLens.cleanTitle(cleanText(document.title, "Video on this page"));
  }

  function posterFor(video) {
    const own = VideoLens.httpUrl(video.poster);
    if (own) return own;
    const fromId = VideoLens.thumbnailFor(permalinkFor(video) || location.href);
    if (fromId) return fromId;
    if (records.size === 1) {
      const meta = document.querySelector('meta[property="og:image"], meta[name="twitter:image"]')?.content;
      try { return VideoLens.httpUrl(meta ? new URL(meta, location.href).href : ""); }
      catch { return null; }
    }
    return null;
  }

  function visibleScore(record) {
    const video = record.video;
    const rect = video.getBoundingClientRect();
    for (let element = video; element; element = element.parentElement || element.getRootNode().host || null) {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return 0;
    }
    // Browser intersections respect containing blocks and root overflow propagation.
    return Math.round(rect.width * rect.height * record.visibleRatio * (video.paused ? 1 : 1.2));
  }

  function rangeValue(ranges, index, method) {
    try { return ranges.length ? finite(ranges[method](index)) : null; }
    catch { return null; }
  }

  function bufferedAhead(video) {
    try {
      for (let index = 0; index < video.buffered.length; index += 1) {
        if (video.buffered.start(index) <= video.currentTime && video.currentTime <= video.buffered.end(index)) {
          return Math.max(0, video.buffered.end(index) - video.currentTime);
        }
      }
    } catch { }
    return null;
  }

  function quality(video) {
    try { return typeof video.getVideoPlaybackQuality === "function" ? video.getVideoPlaybackQuality() : null; }
    catch { return null; }
  }

  function resetSampling(record) {
    record.sampleStarted = performance.now();
    record.sampleFrames = 0;
    record.fps = null;
  }

  function stopFrameSampling(record) {
    if (record.frameCallback !== null && typeof record.video.cancelVideoFrameCallback === "function") {
      try { record.video.cancelVideoFrameCallback(record.frameCallback); } catch { }
    }
    record.frameCallback = null;
  }

  function sampleFrames(record) {
    if (stopped || Date.now() > subscriberUntil || record.frameCallback !== null || typeof record.video.requestVideoFrameCallback !== "function") return;
    const tick = (now) => {
      record.frameCallback = null;
      if (stopped || Date.now() > subscriberUntil || !record.video.isConnected) return;
      record.sampleFrames += 1;
      const elapsed = now - record.sampleStarted;
      if (elapsed >= 750) {
        record.fps = record.video.paused || record.video.ended ? null : record.sampleFrames * 1000 / elapsed;
        record.sampleStarted = now;
        record.sampleFrames = 0;
      }
      record.frameCallback = record.video.requestVideoFrameCallback(tick);
    };
    record.frameCallback = record.video.requestVideoFrameCallback(tick);
  }

  function snapshot(record) {
    const video = record.video;
    const sourceUrl = video.currentSrc || video.src || video.querySelector("source[src]")?.src || "";
    if (sourceUrl !== record.sourceUrl) {
      record.sourceUrl = sourceUrl;
      resetSampling(record);
    }
    const playback = quality(video);
    const seekableStart = rangeValue(video.seekable, 0, "start");
    const seekableEnd = rangeValue(video.seekable, video.seekable.length - 1, "end");
    return {
      id: record.id,
      title: titleFor(video),
      posterUrl: posterFor(video),
      pageUrl: pageUrl(),
      targetUrl: permalinkFor(video),
      site: VideoLens.siteName(pageUrl()),
      sourceUrl,
      sourceKind: VideoLens.sourceKind(sourceUrl, video.getAttribute("type") || ""),
      width: finite(video.videoWidth),
      height: finite(video.videoHeight),
      currentTime: finite(video.currentTime),
      duration: Number.isFinite(video.duration) ? video.duration : null,
      isLive: video.duration === Infinity,
      paused: Boolean(video.paused),
      ended: Boolean(video.ended),
      muted: Boolean(video.muted),
      volume: finite(video.volume),
      playbackRate: finite(video.playbackRate),
      bufferedAhead: bufferedAhead(video),
      seekableStart,
      seekableEnd,
      totalFrames: finite(playback?.totalVideoFrames),
      droppedFrames: finite(playback?.droppedVideoFrames),
      fps: finite(record.fps),
      encrypted: Boolean(record.encrypted || video.mediaKeys),
      visibleScore: visibleScore(record),
      error: video.error ? video.error.code : null
    };
  }

  function sendSnapshot() {
    if (stopped) return Promise.resolve();
    prune();
    const videos = Array.from(records.values(), snapshot);
    return browser.runtime.sendMessage({ type: "SNAPSHOT", videos, pageUrl: pageUrl() }).catch(() => undefined);
  }

  function queueSnapshot(delay = 80) {
    clearTimeout(sendTimer);
    sendTimer = setTimeout(sendSnapshot, delay);
  }

  function onVideoEvent(event, record) {
    if (event.type === "encrypted") record.encrypted = true;
    if (["emptied", "loadstart", "seeking", "play", "pause", "ratechange"].includes(event.type)) resetSampling(record);
    queueSnapshot(event.type === "timeupdate" ? 250 : 40);
  }

  const watchedEvents = ["play", "pause", "ended", "volumechange", "ratechange", "durationchange", "loadedmetadata", "resize", "progress", "emptied", "loadstart", "seeking", "seeked", "error", "encrypted"];

  function addVideo(video) {
    if (records.has(video)) return;
    const record = { video, id: `v${nextId++}`, visibleRatio: 0, encrypted: false, sourceUrl: "", fps: null, sampleStarted: performance.now(), sampleFrames: 0, frameCallback: null, listeners: [] };
    records.set(video, record);
    visibilityObserver.observe(video);
    for (const type of watchedEvents) {
      const listener = (event) => onVideoEvent(event, record);
      video.addEventListener(type, listener, { passive: true });
      record.listeners.push([type, listener]);
    }
    sampleFrames(record);
    queueSnapshot(20);
  }

  function removeVideo(record) {
    visibilityObserver.unobserve(record.video);
    stopFrameSampling(record);
    for (const [type, listener] of record.listeners) record.video.removeEventListener(type, listener);
    records.delete(record.video);
  }

  function prune() {
    for (const record of records.values()) if (!record.video.isConnected) removeVideo(record);
  }

  function observeRoot(root) {
    if (!root || observedRoots.has(root)) return;
    observedRoots.add(root);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) if (node.nodeType === Node.ELEMENT_NODE) discover(node);
      }
      prune();
    });
    observer.observe(root, { childList: true, subtree: true });
  }

  function discover(root = document) {
    if (stopped) return;
    observeRoot(root);
    if (root instanceof HTMLVideoElement) addVideo(root);
    const elements = root.querySelectorAll ? root.querySelectorAll("video, *") : [];
    for (const element of elements) {
      if (element instanceof HTMLVideoElement) addVideo(element);
      if (element.shadowRoot) discover(element.shadowRoot);
    }
    prune();
  }

  function beginLiveSnapshots() {
    const restarting = Date.now() > subscriberUntil;
    subscriberUntil = Date.now() + 2500;
    for (const record of records.values()) {
      if (restarting) resetSampling(record);
      sampleFrames(record);
    }
    if (snapshotTimer) return;
    snapshotTimer = setInterval(() => {
      if (Date.now() > subscriberUntil) {
        clearInterval(snapshotTimer);
        snapshotTimer = 0;
        for (const record of records.values()) stopFrameSampling(record);
        return;
      }
      discover();
      for (const record of records.values()) sampleFrames(record);
      sendSnapshot();
    }, 1000);
  }

  function control(videoId, action, time) {
    const record = Array.from(records.values()).find((item) => item.id === videoId);
    if (!record) throw new Error("The selected video is no longer available.");
    const video = record.video;
    if (action === "playPause") {
      if (video.paused || video.ended) return Promise.resolve(video.play()).then(() => ({ action, paused: video.paused }));
      video.pause();
    } else if (action === "mute") {
      video.muted = !video.muted;
    } else if (action === "seek") {
      if (!Number.isFinite(time)) throw new Error("Seek time must be a finite number.");
      const upper = Number.isFinite(video.duration) ? video.duration : Number.MAX_SAFE_INTEGER;
      video.currentTime = Math.max(0, Math.min(time, upper));
    } else {
      throw new Error("Unsupported player action.");
    }
    queueSnapshot(10);
    return Promise.resolve({ action, paused: video.paused, muted: video.muted, currentTime: finite(video.currentTime) });
  }

  browser.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== "object") return undefined;
    if (message.type === "REFRESH") {
      beginLiveSnapshots();
      discover();
      return sendSnapshot().then(() => ({ ok: true, result: null }), (error) => ({ ok: false, error: error.message }));
    }
    if (message.type === "CONTROL") {
      return Promise.resolve().then(() => control(message.videoId, message.action, message.time)).then(
        (result) => ({ ok: true, result }),
        (error) => ({ ok: false, error: error.message || "Could not control the video." })
      );
    }
    return undefined;
  });

  function stop(event) {
    if (event?.persisted) {
      clearInterval(snapshotTimer);
      snapshotTimer = 0;
      clearInterval(discoveryTimer);
      discoveryTimer = 0;
      for (const record of records.values()) stopFrameSampling(record);
      browser.runtime.sendMessage({ type: "SNAPSHOT", videos: [], pageUrl: pageUrl() }).catch(() => undefined);
      addEventListener("pageshow", resume, { once: true });
      return;
    }
    if (stopped) return;
    stopped = true;
    visibilityObserver.disconnect();
    clearInterval(snapshotTimer);
    clearInterval(discoveryTimer);
    clearTimeout(sendTimer);
    for (const record of records.values()) removeVideo(record);
    browser.runtime.sendMessage({ type: "SNAPSHOT", videos: [], pageUrl: pageUrl() }).catch(() => undefined);
  }

  function startDiscoveryTimer() {
    clearInterval(discoveryTimer);
    discoveryTimer = setInterval(() => {
      if (location.href !== currentPageUrl) {
        currentPageUrl = location.href;
        for (const record of records.values()) resetSampling(record);
        queueSnapshot(10);
      }
      discover();
    }, 4000);
  }

  function resume() {
    currentPageUrl = location.href;
    for (const record of records.values()) {
      record.visibleRatio = 0;
      visibilityObserver.unobserve(record.video);
      visibilityObserver.observe(record.video);
    }
    discover();
    sendSnapshot();
    startDiscoveryTimer();
    addEventListener("pagehide", stop, { once: true });
  }

  discover();
  sendSnapshot();
  startDiscoveryTimer();
  addEventListener("pagehide", stop, { once: true });
})();
