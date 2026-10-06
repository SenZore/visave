const test = require("node:test");
const assert = require("node:assert/strict");
const lens = require("../extension/src/shared.js");

test("sources classify manifests and fragments before download candidates", () => {
  assert.equal(lens.sourceKind("blob:https://example.org/123"), "blob");
  assert.equal(lens.sourceKind("https://example.org/master.m3u8"), "hls");
  assert.equal(lens.sourceKind("https://example.org/manifest", "application/dash+xml"), "dash");
  assert.equal(lens.sourceKind("https://r1.googlevideo.com/videoplayback", "video/mp4"), "segment");
  assert.equal(lens.sourceKind("https://example.org/movie.mp4?range=0-100"), "segment");
  assert.equal(lens.sourceKind("https://example.org/movie", "video/mp4; codecs=avc1"), "mp4");
  assert.equal(lens.sourceKind("https://example.org/movie.webm"), "webm");
});

test("MP3 requires conversion and protected/live videos cannot download", () => {
  const video = { sourceUrl: "https://example.org/movie.mp4", sourceKind: "mp4", targetUrl: "https://example.org/watch" };
  assert.equal(lens.downloadPlan(video, "mp4").route, "browser");
  assert.equal(lens.downloadPlan(video, "mp3").route, "helper");
  assert.equal(lens.downloadPlan({ ...video, sourceKind: "blob", sourceUrl: "blob:https://example.org/player" }, "original").route, "disabled");
  assert.equal(lens.downloadPlan({ ...video, encrypted: true }, "mp3").route, "disabled");
  assert.equal(lens.downloadPlan({ ...video, isLive: true }, "mp4").route, "disabled");
});

test("URLs reject scripts and credentials; filenames cannot escape a download directory", () => {
  assert.equal(lens.httpUrl("javascript:alert(1)"), null);
  assert.equal(lens.httpUrl("https://user:pass@example.org/video.mp4"), null);
  assert.equal(lens.httpUrl("https://example.org/a.mp4"), "https://example.org/a.mp4");
  assert.equal(lens.safeFilename("../../bad:name", "mp4"), ".._.._bad_name.mp4");
  assert.equal(lens.safeFilename("CON", "mp3"), "video_CON.mp3");
  assert.equal(lens.timeLabel(3665), "1:01:05");
  assert.equal(lens.timeLabel(null), "Unknown");
});

test("YouTube thumbnails use validated identifiers on supported HTTP hosts", () => {
  for (const url of ["https://www.youtube.com/watch?v=aqz-KE-bpKQ", "https://youtu.be/aqz-KE-bpKQ?t=5", "https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ", "https://www.youtube.com/shorts/aqz-KE-bpKQ"]) {
    assert.equal(lens.thumbnailFor(url), "https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg");
  }
  for (const url of ["https://youtube.com.evil.test/watch?v=aqz-KE-bpKQ", "https://youtu.be/%2Fbad", "https://user:pass@youtu.be/aqz-KE-bpKQ", "ftp://youtu.be/aqz-KE-bpKQ", "not a URL"]) {
    assert.equal(lens.thumbnailFor(url), null);
  }
});

test("Uninitialized placeholders are distinguished from loaded, live and active players", () => {
  assert.equal(lens.isGhost({ duration: null, width: 0, height: 0, sourceUrl: "", paused: true }), true);
  for (const video of [{ sourceUrl: "blob:https://example.org/player" }, { width: 640 }, { duration: 20 }, { paused: false }]) {
    assert.equal(lens.isGhost(video), false);
  }
  assert.equal(lens.cleanTitle("(2) Test clip - YouTube"), "Test clip");
});

test("Current video prefers visible playback and excludes offscreen autoplay", () => {
  const preload = { uid: "preload", paused: false, visibleScore: 0 };
  const paused = { uid: "paused", paused: true, visibleScore: 100000 };
  const current = { uid: "current", paused: false, visibleScore: 50000 };
  assert.equal(lens.currentVideo([preload, paused, current]), current);
  assert.equal(lens.currentVideo([preload, paused]), paused);
  assert.equal(lens.currentVideo([preload]), null);
  assert.equal(lens.currentVideo([]), null);
  assert.equal(lens.currentVideo([{ ...current, ended: true }, paused]), paused);
  assert.equal(lens.currentVideo([{ ...current, error: 3 }, paused]), paused);
  assert.equal(lens.currentVideo([current, { ...current, uid: "larger", visibleScore: 60000 }]).uid, "larger");
});
