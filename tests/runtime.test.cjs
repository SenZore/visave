const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

class FakeEvent {
  constructor() { this.listeners = []; }
  addListener(listener) { this.listeners.push(listener); }
  emit(...args) { return this.listeners.map((listener) => listener(...args)); }
}

function harness(initialStored = {}, nativeCapabilities = { saveBeforeSupported: true, saveFolderSupported: true, filenameSupported: true }) {
  const runtimeMessages = new FakeEvent();
  const downloadChanges = new FakeEvent();
  const tabRemoved = new FakeEvent();
  const headersReceived = new FakeEvent();
  const committed = new FakeEvent();
  const nativeMessages = new FakeEvent();
  const nativeDisconnect = new FakeEvent();
  const calls = { tabMessages: [], downloads: [], cancelled: [], shown: [], native: [], nativeConnections: 0 };
  const stored = structuredClone(initialStored);
  const tabs = new Map([[7, { id: 7, url: "https://example.test/watch", title: "Example", incognito: false, cookieStoreId: "firefox-default" }]]);
  let nextDownload = 20;

  const nativePort = {
    onMessage: nativeMessages,
    onDisconnect: nativeDisconnect,
    postMessage(message) {
      calls.native.push(message);
      setImmediate(() => {
        if (message.action === "probe") nativeMessages.emit({ id: message.id, ok: true, result: { ytDlp: true, ffmpeg: true, jsRuntime: true, ...nativeCapabilities } });
        else if (message.action === "download") nativeMessages.emit({ id: message.id, ok: true, result: { jobId: "native-job-1" } });
        else if (message.action === "chooseFolder") nativeMessages.emit({ id: message.id, ok: true, result: { folder: "D:/Videos/Saved" } });
        else if (message.action === "saveFile") nativeMessages.emit({ id: message.id, ok: true, result: { filename: message.saveFolder + "/" + message.filename.split(/[\\/]/).at(-1) } });
        else nativeMessages.emit({ id: message.id, ok: true, result: { jobId: message.jobId } });
      });
    }
  };

  const browser = {
    runtime: {
      id: "video-lens@local",
      lastError: null,
      onMessage: runtimeMessages,
      getURL: (value = "") => `moz-extension://unit/${value}`,
      connectNative(name) {
        assert.equal(name, "com.videolens.downloader");
        calls.nativeConnections += 1;
        return nativePort;
      }
    },
    storage: {
      local: {
        async get(keys) {
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.filter(key => Object.hasOwn(stored, key)).map(key => [key, stored[key]]));
        },
        async set(values) { Object.assign(stored, structuredClone(values)); }
      },
      session: {
        async get(keys) {
          return Object.fromEntries(keys.filter((key) => Object.hasOwn(stored, key)).map((key) => [key, stored[key]]));
        },
        async set(values) { Object.assign(stored, structuredClone(values)); }
      }
    },
    tabs: {
      onRemoved: tabRemoved,
      async get(id) {
        if (!tabs.has(id)) throw new Error("Missing tab");
        return tabs.get(id);
      },
      async query() { return [tabs.get(7)]; },
      async sendMessage(tabId, message, options) {
        calls.tabMessages.push({ tabId, message, options });
        return { ok: true, result: { action: message.action } };
      }
    },
    downloads: {
      onChanged: downloadChanges,
      async download(options) { calls.downloads.push(options); return nextDownload++; },
      async cancel(id) { calls.cancelled.push(id); },
      async show(id) { calls.shown.push(id); }
    },
    webRequest: { onHeadersReceived: headersReceived },
    webNavigation: { onCommitted: committed }
  };

  const context = vm.createContext({ browser, console, URL, crypto: webcrypto, setTimeout, clearTimeout, Promise, Map, Set, Date, Math, structuredClone });
  for (const file of ["shared.js", "background.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", "extension", "src", file), "utf8");
    vm.runInContext(source, context, { filename: file });
  }

  const uiSender = { id: browser.runtime.id, url: browser.runtime.getURL("popup/popup.html") };
  const contentSender = { id: browser.runtime.id, url: "https://example.test/watch", tab: tabs.get(7), frameId: 3 };
  async function message(payload, sender = uiSender) {
    const listener = runtimeMessages.listeners[0];
    return listener(payload, sender);
  }
  async function snapshot(videos, extra = {}) {
    const reply = await message({ type: "SNAPSHOT", videos, pageUrl: "https://example.test/watch", ...extra }, contentSender);
    assert.equal(reply.ok, true);
    assert.equal(reply.result, null);
  }
  return { browser, calls, message, snapshot, uiSender, contentSender, nativePort, events: { downloadChanges, tabRemoved, headersReceived, committed, nativeMessages, nativeDisconnect }, tabs };
}

function video(id, values = {}) {
  return {
    id,
    title: "A video",
    pageUrl: "https://example.test/watch",
    targetUrl: "https://example.test/watch",
    sourceUrl: "https://cdn.example.test/movie.mp4",
    sourceKind: "mp4",
    width: 1920,
    height: 1080,
    currentTime: 12,
    duration: 120,
    paused: false,
    volume: 1,
    playbackRate: 1,
    visibleScore: 100,
    ...values
  };
}

test("snapshots and response metadata are bounded by frame and observed headers", async () => {
  const h = harness();
  await h.snapshot([video("main", { sourceUrl: "https://cdn.example.test/media?id=1", sourceKind: "unknown" })]);
  h.events.headersReceived.emit({
    tabId: 7,
    frameId: 3,
    url: "https://cdn.example.test/media?id=1",
    responseHeaders: [
      { name: "Content-Type", value: "video/mp4" },
      { name: "Content-Range", value: "bytes 0-1023/543210" }
    ]
  });
  const reply = await h.message({ type: "GET_STATE", tabId: 7 });
  assert.equal(reply.ok, true);
  assert.equal(reply.result.videos[0].uid, "3:main");
  assert.equal(reply.result.videos[0].sourceKind, "mp4");
  assert.equal(reply.result.videos[0].fileSize, 543210);
  assert.equal(reply.result.resources[0].frameId, 3);
  assert.equal(reply.result.tab.cookieStoreId, "firefox-default");
  assert.equal(h.calls.nativeConnections, 0, "GET_STATE must not start the helper");
});

test("unloaded placeholders produce an empty list while paused loaded videos remain available", async () => {
  const h = harness();
  await h.snapshot([video("placeholder", { sourceUrl: "", width: 0, height: 0, duration: null, paused: true })]);
  assert.equal((await h.message({ type: "GET_STATE", tabId: 7 })).result.videos.length, 0);
  await h.snapshot([video("loaded", { paused: true })]);
  assert.equal((await h.message({ type: "GET_STATE", tabId: 7 })).result.videos.length, 1);
});

test("content senders cannot invoke privileged routes", async () => {
  const h = harness();
  const reply = await h.message({ type: "GET_STATE", tabId: 7 }, h.contentSender);
  assert.equal(reply.ok, false);
  assert.match(reply.error, /visave pages/);
  const folder = await h.message({ type: "CHOOSE_FOLDER" }, h.contentSender);
  assert.equal(folder.ok, false);
  assert.equal(h.calls.downloads.length, 0);
  assert.equal(h.calls.nativeConnections, 0);
  const detachedUi = { id: h.browser.runtime.id, url: h.browser.runtime.getURL("popup/popup.html?tabId=7"), tab: h.tabs.get(7) };
  const allowed = await h.message({ type: "GET_STATE", tabId: 7 }, detachedUi);
  assert.equal(allowed.ok, true);
});

test("controls target the selected frame and direct downloads use stored metadata", async () => {
  const h = harness();
  await h.snapshot([video("main")]);
  const control = await h.message({ type: "CONTROL", tabId: 7, videoUid: "3:main", action: "mute" });
  assert.equal(control.ok, true);
  assert.equal(h.calls.tabMessages[0].tabId, 7);
  assert.equal(h.calls.tabMessages[0].message.type, "CONTROL");
  assert.equal(h.calls.tabMessages[0].message.videoId, "main");
  assert.equal(h.calls.tabMessages[0].message.action, "mute");
  assert.equal(h.calls.tabMessages[0].options.frameId, 3);

  const download = await h.message({ type: "FILE_DOWNLOAD", tabId: 7, videoUid: "3:main", output: "mp4", url: "https://evil.test/payload" });
  assert.equal(download.ok, true);
  assert.equal(h.calls.downloads[0].url, "https://cdn.example.test/movie.mp4");
  assert.equal(h.calls.downloads[0].saveAs, true);
  assert.match(h.calls.downloads[0].filename, /^Video Lens\//);
  await Promise.all(h.events.downloadChanges.emit({ id: 20, state: { current: "complete" }, filename: { current: "movie.mp4" } }));
  await Promise.all(h.events.downloadChanges.emit({ id: 20, state: { current: "complete" } }));
  assert.deepEqual(h.calls.shown, [20]);
  const state = await h.message({ type: "GET_STATE", tabId: 7 });
  assert.equal(state.result.jobs[0].state, "complete");
  assert.equal(state.result.jobs[0].percent, 100);
});

test("protected and live videos never reach browser or native downloads", async () => {
  const h = harness();
  await h.snapshot([
    video("drm", { encrypted: true }),
    video("live", { sourceUrl: "blob:https://example.test/live", sourceKind: "blob", isLive: true, duration: null })
  ]);
  const drm = await h.message({ type: "HELPER_DOWNLOAD", tabId: 7, videoUid: "3:drm", output: "mp3", quality: "best", useCookies: false });
  const live = await h.message({ type: "HELPER_DOWNLOAD", tabId: 7, videoUid: "3:live", output: "mp4", quality: "720", useCookies: false });
  assert.equal(drm.ok, false);
  assert.match(drm.error, /Protected/);
  assert.equal(live.ok, false);
  assert.match(live.error, /Live/);
  assert.equal(h.calls.nativeConnections, 0);
  assert.equal(h.calls.downloads.length, 0);
});

test("native jobs keep progress while the popup is closed and can be cancelled", async () => {
  const h = harness();
  await h.snapshot([video("main")]);
  const reply = await h.message({ type: "HELPER_DOWNLOAD", tabId: 7, videoUid: "3:main", output: "mp3", quality: "best", useCookies: false });
  assert.equal(reply.ok, true);
  assert.equal(reply.result.jobId, "native-job-1");
  assert.equal(h.calls.native[0].url, "https://cdn.example.test/movie.mp4");
  assert.equal(h.calls.native[0].saveAs, true);
  assert.equal(h.calls.native[0].reveal, true);
  assert.equal(h.calls.native[0].saveBefore, undefined);
  h.events.nativeMessages.emit({ event: "progress", jobId: "native-job-1", percent: 42, phase: "processing" });
  let state = await h.message({ type: "GET_STATE", tabId: 7 });
  assert.equal(state.result.jobs[0].state, "converting");
  assert.equal(state.result.jobs[0].percent, 42);
  h.events.nativeMessages.emit({ event: "progress", jobId: "native-job-1", phase: "awaiting_save" });
  state = await h.message({ type: "GET_STATE", tabId: 7 });
  assert.equal(state.result.jobs[0].state, "awaiting_save");
  const cancelled = h.message({ type: "CANCEL_JOB", jobId: "native-job-1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await cancelled).ok, true);
  state = await h.message({ type: "GET_STATE", tabId: 7 });
  assert.equal(state.result.jobs[0].state, "cancelled");
});

test("saved folder disables helper dialogs and reveal; clearing it restores the existing flow", async () => {
  const h = harness({ downloadFolder: "D:/Videos", chooseSaveBefore: true });
  await h.snapshot([video("main", { title: "A title / with unsafe characters?" })]);
  const reply = await h.message({ type: "HELPER_DOWNLOAD", tabId: 7, videoUid: "3:main", output: "mp3", quality: "best", useCookies: false });
  assert.equal(reply.ok, true);
  const download = h.calls.native.find(item => item.action === "download");
  assert.equal(download.saveFolder, "D:/Videos");
  assert.equal(download.saveAs, false);
  assert.equal(download.reveal, false);
  assert.equal(download.saveBefore, undefined);
  const state = await h.message({ type: "GET_STATE", tabId: 7 });
  assert.equal(state.result.jobs[0].saveFolder, "D:/Videos");
  await h.browser.storage.local.set({ downloadFolder: "" });
  await h.message({ type: "HELPER_DOWNLOAD", tabId: 7, videoUid: "3:main", output: "mp3", quality: "best", useCookies: false });
  assert.equal(h.calls.native.at(-1).saveFolder, undefined);
  assert.equal(h.calls.native.at(-1).saveAs, true);
  assert.equal(h.calls.native.at(-1).reveal, true);
});

test("an old helper cannot silently ignore the saved folder", async () => {
  const h = harness({ downloadFolder: "D:/Videos" }, {});
  await h.snapshot([video("main")]);
  const reply = await h.message({ type: "HELPER_DOWNLOAD", tabId: 7, videoUid: "3:main", output: "mp3", quality: "best", useCookies: false });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /Update the visave installation/);
  assert.equal(h.calls.native.some(item => item.action === "download"), false);
});

test("folder selection persists and cancellation preserves the previous folder", async () => {
  const h = harness();
  const selected = await h.message({ type: "CHOOSE_FOLDER" });
  assert.equal(selected.result.folder, "D:/Videos/Saved");
  assert.equal((await h.browser.storage.local.get("downloadFolder")).downloadFolder, selected.result.folder);
  h.nativePort.postMessage = message => {
    setImmediate(() => h.events.nativeMessages.emit({ id: message.id, ok: true, result: message.action === "probe" ? { saveFolderSupported: true } : { cancelled: true } }));
  };
  const cancelled = await h.message({ type: "CHOOSE_FOLDER" });
  assert.equal(cancelled.result.cancelled, true);
  assert.equal((await h.browser.storage.local.get("downloadFolder")).downloadFolder, "D:/Videos/Saved");
  assert.equal(h.calls.downloads.length, 0);
  assert.equal(h.calls.shown.length, 0);
});

test("saved-folder direct downloads keep the Firefox transfer, move once and never reveal", async () => {
  const h = harness({ downloadFolder: "D:/Videos" });
  await h.snapshot([video("main")]);
  const direct = await h.message({ type: "FILE_DOWNLOAD", tabId: 7, videoUid: "3:main", output: "mp4" });
  assert.equal(direct.ok, true);
  const options = h.calls.downloads[0];
  assert.equal(options.saveAs, false);
  assert.ok(options.filename.startsWith("Video Lens/pending/browser-"));
  h.browser.downloads.search = async () => [{ state: "complete", exists: true, filename: "C:/Downloads/" + options.filename }];
  await Promise.all(h.events.downloadChanges.emit({ id: 20, state: { current: "complete" } }));
  await Promise.all(h.events.downloadChanges.emit({ id: 20, state: { current: "complete" } }));
  assert.equal(h.calls.native.filter(call => call.action === "saveFile").length, 1);
  assert.deepEqual(h.calls.shown, []);
  const state = await h.message({ type: "GET_STATE", tabId: 7 });
  assert.equal(state.result.jobs[0].state, "complete");
  assert.equal(state.result.jobs[0].filename, "D:/Videos/A video.mp4");
});

test("failed saved-folder moves retain the staged path and never open Explorer", async () => {
  const h = harness({ downloadFolder: "D:/Videos" });
  await h.snapshot([video("main")]);
  await h.message({ type: "FILE_DOWNLOAD", tabId: 7, videoUid: "3:main", output: "mp4" });
  const staged = "C:/Downloads/" + h.calls.downloads[0].filename;
  h.browser.downloads.search = async () => [{ state: "complete", exists: true, filename: staged }];
  h.nativePort.postMessage = message => setImmediate(() => h.events.nativeMessages.emit({ id: message.id, ok: false, error: "Saved folder unavailable" }));
  await Promise.all(h.events.downloadChanges.emit({ id: 20, state: { current: "complete" } }));
  const state = await h.message({ type: "GET_STATE", tabId: 7 });
  assert.equal(state.result.jobs[0].state, "error");
  assert.equal(state.result.jobs[0].filename, staged);
  assert.deepEqual(h.calls.shown, []);
});

test("saved-folder transfers can be cancelled without opening Explorer", async () => {
  const h = harness({ downloadFolder: "D:/Videos" });
  await h.snapshot([video("main")]);
  await h.message({ type: "FILE_DOWNLOAD", tabId: 7, videoUid: "3:main", output: "mp4" });
  h.browser.downloads.search = async () => [{ state: "complete", exists: true, filename: "C:/Downloads/" + h.calls.downloads[0].filename }];
  let move;
  h.nativePort.postMessage = message => {
    h.calls.native.push(message);
    if (message.action === "saveFile") move = message;
    else if (message.action === "cancel") setImmediate(() => {
      h.events.nativeMessages.emit({ id: message.id, ok: true, result: { jobId: message.jobId } });
      h.events.nativeMessages.emit({ id: move.id, ok: true, result: { cancelled: true } });
    });
  };
  const completion = Promise.all(h.events.downloadChanges.emit({ id: 20, state: { current: "complete" } }));
  await new Promise(resolve => setImmediate(resolve));
  const state = await h.message({ type: "GET_STATE", tabId: 7 });
  assert.equal(state.result.jobs[0].state, "saving");
  await h.message({ type: "CANCEL_JOB", jobId: state.result.jobs[0].jobId });
  await completion;
  assert.equal((await h.message({ type: "GET_STATE", tabId: 7 })).result.jobs[0].state, "cancelled");
  assert.equal(h.calls.cancelled.length, 0);
  assert.deepEqual(h.calls.shown, []);
});

test("Instagram direct and helper downloads use fresh random names", async () => {
  const h = harness();
  await h.snapshot([video("insta", { title: "Instagram", pageUrl: "https://www.instagram.com/reel/example/", targetUrl: "https://www.instagram.com/reel/example/" })]);
  await h.message({ type: "FILE_DOWNLOAD", tabId: 7, videoUid: "3:insta", output: "mp4" });
  await h.message({ type: "FILE_DOWNLOAD", tabId: 7, videoUid: "3:insta", output: "mp4" });
  const first = h.calls.downloads[0].filename;
  assert.match(first, /^Video Lens\/Instagram-[a-f0-9]{12}\.mp4$/);
  assert.notEqual(first, h.calls.downloads[1].filename);
  await h.message({ type: "HELPER_DOWNLOAD", tabId: 7, videoUid: "3:insta", output: "mp3", quality: "best", useCookies: false });
  assert.match(h.calls.native.at(-1).filename, /^Instagram-[a-f0-9]{12}\.mp3$/);
});

test("poster URLs are safe and reveal failures keep completed browser downloads saved", async () => {
  const h = harness();
  await h.snapshot([video("main", { posterUrl: "https://cdn.example.test/poster.jpg" }), video("unsafe", { posterUrl: "javascript:alert(1)" })]);
  let state = await h.message({ type: "GET_STATE", tabId: 7 });
  assert.equal(state.result.videos[0].posterUrl, "https://cdn.example.test/poster.jpg");
  assert.equal(state.result.videos[1].posterUrl, null);
  await h.message({ type: "FILE_DOWNLOAD", tabId: 7, videoUid: "3:main", output: "mp4" });
  h.browser.downloads.show = async () => { throw new Error("Explorer unavailable"); };
  await Promise.all(h.events.downloadChanges.emit({ id: 20, state: { current: "complete" } }));
  state = await h.message({ type: "GET_STATE", tabId: 7 });
  assert.equal(state.result.jobs[0].state, "complete");
  assert.match(state.result.jobs[0].notice, /file was saved/);
});

test("cancelled downloads do not reveal files and completed native jobs retain chosen paths", async () => {
  const h = harness();
  await h.snapshot([video("main")]);
  const direct = await h.message({ type: "FILE_DOWNLOAD", tabId: 7, videoUid: "3:main", output: "mp4" });
  await h.message({ type: "CANCEL_JOB", jobId: direct.result.jobId });
  await Promise.all(h.events.downloadChanges.emit({ id: 20, state: { current: "interrupted" } }));
  await Promise.all(h.events.downloadChanges.emit({ id: 20, state: { current: "complete" } }));
  assert.deepEqual(h.calls.shown, []);
  await h.message({ type: "HELPER_DOWNLOAD", tabId: 7, videoUid: "3:main", output: "mp3", quality: "best", useCookies: false });
  h.events.nativeMessages.emit({ event: "complete", jobId: "native-job-1", filename: "D:/Music/Chosen file.mp3", notice: "Saved, but Explorer unavailable" });
  const state = await h.message({ type: "GET_STATE", tabId: 7 });
  const native = state.result.jobs.find((job) => job.kind === "native");
  assert.equal(native.filename, "D:/Music/Chosen file.mp3");
  assert.equal(native.state, "complete");
  assert.match(native.notice, /Explorer/);
});

test("restored completed, legacy, failed and unrelated downloads never automatically reveal", async () => {
  const h = harness({ runtimeJobs: [
    { jobId: "old-complete", tabId: 7, kind: "browser", downloadId: 40, state: "complete", autoRevealPending: true },
    { jobId: "legacy", tabId: 7, kind: "browser", downloadId: 41, state: "downloading" },
    { jobId: "failed", tabId: 7, kind: "browser", downloadId: 42, state: "error", autoRevealPending: true }
  ] });
  await h.message({ type: "GET_STATE", tabId: 7 });
  await h.message({ type: "REFRESH", tabId: 7 });
  await h.message({ type: "HELPER_PROBE" });
  for (const id of [40, 41, 42, 999]) {
    await Promise.all(h.events.downloadChanges.emit({ id, state: { current: "complete" } }));
  }
  assert.deepEqual(h.calls.shown, []);
});

test("a restored active user download reveals once, but a deleted output never opens Explorer", async () => {
  const active = { jobId: "active", tabId: 7, kind: "browser", downloadId: 40, state: "downloading", autoRevealPending: true };
  const h = harness({ runtimeJobs: [active] });
  h.browser.downloads.search = async () => [{ id: 40, state: "complete", exists: true, filename: "C:/Videos/Chosen video.mp4" }];
  await Promise.all(h.events.downloadChanges.emit({ id: 40, state: { current: "complete" } }));
  await Promise.all(h.events.downloadChanges.emit({ id: 40, state: { current: "complete" } }));
  assert.deepEqual(h.calls.shown, [40]);
  const deleted = harness({ runtimeJobs: [active] });
  deleted.browser.downloads.search = async () => [{ id: 40, state: "complete", exists: false, filename: "C:/Videos/Deleted.mp4" }];
  await Promise.all(deleted.events.downloadChanges.emit({ id: 40, state: { current: "complete" } }));
  assert.deepEqual(deleted.calls.shown, []);
  const state = await deleted.message({ type: "GET_STATE", tabId: 7 });
  assert.equal(state.result.jobs[0].state, "complete");
  assert.match(state.result.jobs[0].notice, /file was saved/);
});

test("completion racing with a Cancel request cannot open Explorer", async () => {
  const h = harness();
  await h.snapshot([video("main")]);
  const direct = await h.message({ type: "FILE_DOWNLOAD", tabId: 7, videoUid: "3:main", output: "mp4" });
  let finishCancel;
  h.browser.downloads.cancel = () => new Promise(resolve => { finishCancel = resolve; });
  const cancelled = h.message({ type: "CANCEL_JOB", jobId: direct.result.jobId });
  await new Promise(resolve => setImmediate(resolve));
  await Promise.all(h.events.downloadChanges.emit({ id: 20, state: { current: "complete" } }));
  finishCancel();
  await cancelled;
  assert.deepEqual(h.calls.shown, []);
});

test("known-site permalinks win over observed manifests", async () => {
  const h = harness();
  await h.snapshot([video("youtube", {
    pageUrl: "https://www.youtube.com/watch?v=abc123",
    targetUrl: "https://www.youtube.com/watch?v=abc123",
    sourceUrl: "blob:https://www.youtube.com/player",
    sourceKind: "blob"
  })]);
  h.events.headersReceived.emit({
    tabId: 7,
    frameId: 3,
    url: "https://ads.example.test/ad-manifest.m3u8",
    responseHeaders: [{ name: "Content-Type", value: "application/vnd.apple.mpegurl" }]
  });
  const reply = await h.message({ type: "HELPER_DOWNLOAD", tabId: 7, videoUid: "3:youtube", output: "mp3", quality: "best", useCookies: false });
  assert.equal(reply.ok, true);
  assert.equal(h.calls.native[0].url, "https://www.youtube.com/watch?v=abc123");
});

test("generic blob pages reject an ambiguous multi-player manifest", async () => {
  const h = harness();
  await h.snapshot([
    video("one", { sourceUrl: "blob:https://example.test/one", sourceKind: "blob" }),
    video("two", { sourceUrl: "blob:https://example.test/two", sourceKind: "blob" })
  ]);
  h.events.headersReceived.emit({
    tabId: 7,
    frameId: 3,
    url: "https://cdn.example.test/master.m3u8",
    responseHeaders: [{ name: "Content-Type", value: "application/vnd.apple.mpegurl" }]
  });
  const reply = await h.message({ type: "HELPER_DOWNLOAD", tabId: 7, videoUid: "3:one", output: "mp4", quality: "720", useCookies: false });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /multiple streamed videos/);
  assert.equal(h.calls.nativeConnections, 0);
});

test("native disconnect marks an active helper job as failed", async () => {
  const h = harness();
  await h.snapshot([video("main")]);
  const started = await h.message({ type: "HELPER_DOWNLOAD", tabId: 7, videoUid: "3:main", output: "mp3", quality: "best", useCookies: false });
  assert.equal(started.ok, true);
  h.events.nativeMessages.emit({ event: "progress", jobId: "native-job-1", percent: 10, phase: "downloading" });
  h.browser.runtime.lastError = { message: "Host process exited" };
  h.events.nativeDisconnect.emit();
  const state = await h.message({ type: "GET_STATE", tabId: 7 });
  assert.equal(state.result.jobs[0].state, "error");
  assert.match(state.result.jobs[0].error, /Host process exited/);
});

test("top-level navigation clears frame and resource state", async () => {
  const h = harness();
  await h.snapshot([video("main")]);
  h.events.headersReceived.emit({ tabId: 7, frameId: 3, url: "https://cdn.example.test/master.m3u8", responseHeaders: [{ name: "Content-Type", value: "application/vnd.apple.mpegurl" }] });
  h.events.committed.emit({ tabId: 7, frameId: 0, url: "https://example.test/next" });
  const reply = await h.message({ type: "GET_STATE", tabId: 7 });
  assert.equal(reply.result.videos.length, 0);
  assert.equal(reply.result.resources.length, 0);
});
