(function (root) {
  "use strict";

  function httpUrl(value) {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch {
      return null;
    }
  }

  function siteName(value) {
    try {
      const host = new URL(value).hostname.toLowerCase();
      const matches = (name) => host === name || host.endsWith("." + name);
      if (matches("youtube.com") || matches("youtu.be") || matches("youtube-nocookie.com")) return "YouTube";
      if (matches("instagram.com")) return "Instagram";
      if (matches("tiktok.com")) return "TikTok";
      if (matches("vimeo.com")) return "Vimeo";
      if (matches("twitch.tv")) return "Twitch";
      return host || "This page";
    } catch {
      return "This page";
    }
  }

  function sourceKind(value, mime = "") {
    if (!value) return "unknown";
    if (value.startsWith("blob:")) return "blob";
    if (!httpUrl(value)) return "unavailable";
    const url = new URL(value);
    const path = url.pathname.toLowerCase();
    const type = mime.toLowerCase().split(";")[0].trim();
    if (/\.m3u8$/.test(path) || /mpegurl/.test(type)) return "hls";
    if (/\.mpd$/.test(path) || type === "application/dash+xml") return "dash";
    if (/(^|\.)googlevideo\.com$/.test(url.hostname) || /\.(m4s|ts|cmfv|cmfa)$/.test(path) || url.searchParams.has("range") || url.searchParams.has("bytestart")) return "segment";
    if (/\.mp4$/.test(path) || type === "video/mp4") return "mp4";
    if (/\.webm$/.test(path) || type === "video/webm") return "webm";
    if (/\.(ogv|ogg)$/.test(path) || type === "video/ogg") return "ogg";
    if (type.startsWith("audio/")) return "audio";
    if (type.startsWith("video/")) return "video";
    return "unknown";
  }

  function safeFilename(title, extension) {
    const base = String(title || "video").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").trim().slice(0, 120) || "video";
    const name = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base) ? "video_" + base : base;
    return name + "." + extension;
  }

  function timeLabel(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "Unknown";
    const whole = Math.floor(seconds);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor(whole / 60) % 60;
    const sec = String(whole % 60).padStart(2, "0");
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${sec}` : `${minutes}:${sec}`;
  }

  function cleanTitle(title, fallback = "Video on this page") {
    const text = String(title || "")
      .replace(/^\s*\(\d+\+?\)\s*/, "")
      .replace(/\s+[-\u2013\u2014|]\s+(YouTube|Instagram|TikTok|Vimeo|Twitch)\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
    return text || fallback;
  }

  function youtubeId(value) {
    try {
      if (!httpUrl(value)) return null;
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      if (host !== "youtu.be" && !/(^|\.)youtube(-nocookie)?\.com$/.test(host)) return null;
      const id = host === "youtu.be" ? url.pathname.split("/").filter(Boolean)[0] : url.pathname === "/watch" ? url.searchParams.get("v") : url.pathname.match(/^\/(?:shorts|embed)\/([^/?#]+)/)?.[1];
      return id && /^[\w-]{6,20}$/.test(id) ? id : null;
    } catch {
      return null;
    }
  }

  function thumbnailFor(value) {
    const id = youtubeId(value);
    return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
  }

  function isGhost(video) {
    return !video.duration && !video.width && !video.height && !video.sourceUrl && video.paused !== false;
  }

  function currentVideo(videos) {
    const playing = (video) => video.paused === false && !video.ended && !video.error;
    return videos.filter((video) => Number.isFinite(video.visibleScore) && video.visibleScore > 0)
      .sort((a, b) => Number(playing(b)) - Number(playing(a)) || b.visibleScore - a.visibleScore)[0] || null;
  }

  function downloadPlan(video, output = "mp4") {
    if (!video) return { route: "disabled", reason: "Select a video first." };
    if (video.encrypted) return { route: "disabled", reason: "Protected media detected. Download is unavailable." };
    if (video.isLive) return { route: "disabled", reason: "Live playback has no complete file yet. Open a recorded video to download it." };
    if (output === "original" && ["mp4", "webm", "ogg", "video"].includes(video.sourceKind) && httpUrl(video.sourceUrl)) {
      return { route: "browser", extension: video.sourceKind === "video" ? "bin" : video.sourceKind, reason: "Save the file exposed by this player." };
    }
    if (output === "original") return { route: "disabled", reason: "This player exposes a stream rather than a complete file. Choose MP4 or MP3 with the local companion." };
    if (output === "mp4" && video.sourceKind === "mp4" && httpUrl(video.sourceUrl)) {
      return { route: "browser", extension: "mp4", reason: "Save the MP4 file exposed by this player." };
    }
    if (!httpUrl(video.targetUrl) && !httpUrl(video.sourceUrl)) return { route: "disabled", reason: "No downloadable source or video page URL is available." };
    return { route: "helper", reason: output === "mp3" ? "The local companion extracts audio and converts it to MP3." : "The local companion downloads and combines video and audio into MP4." };
  }

  const api = { httpUrl, siteName, sourceKind, safeFilename, timeLabel, downloadPlan, cleanTitle, youtubeId, thumbnailFor, isGhost, currentVideo };
  root.VideoLens = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
