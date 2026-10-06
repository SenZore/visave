const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { Builder, By, until, Key } = require("selenium-webdriver");
const firefox = require("selenium-webdriver/firefox");
const logInspector = require("selenium-webdriver/bidi/logInspector");

const root = path.resolve(__dirname, "..");
const results = path.join(root, "test-results");
fs.mkdirSync(results, { recursive: true });
const media = path.join(results, "fixture.mp4");
const webm = path.join(results, "fixture.webm");
const poster = path.join(results, "poster.png");
const chosenFolder = path.join(results, "Saved café", "A long destination folder to exercise wrapping in the popup");
fs.mkdirSync(chosenFolder, { recursive: true });
for (const args of [
  ["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", media],
  ["-i", media, "-c:v", "libvpx", "-b:v", "180k", "-c:a", "libvorbis", webm],
  ["-i", media, "-frames:v", "1", "-vf", "scale=160:90", poster]
]) {
  const generated = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.error?.message || generated.stderr);
}
const mainTitle = "Generated 30 FPS test clip";
const fixture = '<!doctype html><html><head><title>Local playback fixture</title></head><body><h1>Generated playback fixture</h1><video id="main-video" title="' + mainTitle + '" controls loop muted width="640" height="360" poster="/poster.png" src="/fixture.mp4"></video><div id="shadow-host"></div><iframe src="/frame.html" title="Frame test"></iframe><script>const v=document.createElement("video");v.title="Shadow video";v.src="/fixture.mp4";v.muted=true;v.controls=true;document.querySelector("#shadow-host").attachShadow({mode:"open"}).append(v)</script></body></html>';
const server = http.createServer((req, res) => {
  const pathname = req.url.split("?")[0];
  if (pathname === "/native-test-move" && req.method === "POST") {
    let body = "";
    req.on("data", bytes => { body += bytes; });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        const source = path.resolve(data.filename);
        assert.ok(source.startsWith(path.join(results, "Video Lens", "pending") + path.sep));
        assert.equal(path.resolve(data.saveFolder), chosenFolder);
        const file = path.parse(source);
        let target = path.join(chosenFolder, file.base), index = 1;
        while (fs.existsSync(target)) target = path.join(chosenFolder, file.name + " (" + index++ + ")" + file.ext);
        fs.renameSync(source, target);
        res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true, result: { filename: target } }));
      } catch (error) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: false, error: error.message })); }
    });
  } else if (pathname === "/poster.png") {
    res.writeHead(200, { "Content-Type": "image/png" }); res.end(fs.readFileSync(poster));
  } else if (pathname === "/fixture.webm") {
    const bytes = fs.readFileSync(webm);
    res.writeHead(200, { "Content-Type": "video/webm", "Content-Length": bytes.length }); res.end(bytes);
  } else if (pathname === "/slow.mp4") {
    const bytes = fs.readFileSync(media);
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": bytes.length });
    let offset = 0;
    const timer = setInterval(() => {
      res.write(bytes.subarray(offset, offset + 4096)); offset += 4096;
      if (offset >= bytes.length) { clearInterval(timer); res.end(); }
    }, 100);
    res.on("close", () => clearInterval(timer));
  } else if (pathname === "/fixture.mp4") {
    const bytes = fs.readFileSync(media);
    const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
      res.writeHead(206, { "Content-Type": "video/mp4", "Content-Length": end - start + 1, "Content-Range": "bytes " + start + "-" + end + "/" + bytes.length, "Accept-Ranges": "bytes" });
      res.end(bytes.subarray(start, end + 1));
    } else {
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": bytes.length, "Accept-Ranges": "bytes" }); res.end(bytes);
    }
  } else if (pathname === "/root-overflow") {
    res.setHeader("Content-Type", "text/html");
    res.end('<!doctype html><title>Root overflow player fixture</title><style>body{margin:0;overflow-y:scroll}#player{position:absolute;top:20px;left:20px;width:640px;height:360px;overflow:hidden}#wrapper{display:contents;overflow:hidden}video{position:absolute;width:640px;height:360px}</style><div id="player"><div id="wrapper"><video id="visible" title="Root overflow current player" src="/fixture.mp4" muted loop autoplay></video></div></div>');
  } else if (pathname === "/feed") {
    res.setHeader("Content-Type", "text/html");
    res.end('<!doctype html><title>Generated eight-video feed fixture</title><body style="margin:0"><script>for(let i=0;i<8;i++){const v=document.createElement("video");v.id="feed-"+i;v.title="Feed video "+i;v.src="/fixture.mp4?slot="+i;v.poster="/poster.png";v.muted=true;v.loop=true;v.style.cssText="position:absolute;left:0;top:"+(2000+i*220)+"px;width:320px;height:180px";if(i===4)v.style.top="20px";if(i===5)v.style.cssText="position:absolute;left:330px;top:20px;width:300px;height:360px";if(i===7){const wrap=document.createElement("div");wrap.style.cssText="position:absolute;top:0;left:0;height:0;width:320px;overflow:hidden";v.style.top="0";v.style.width="640px";v.style.height="360px";wrap.append(v);document.body.append(wrap)}else document.body.append(v);if(i===0||i===4||i===7)v.play().catch(()=>{})}</script>');
  } else {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(req.url === "/frame.html" ? '<!doctype html><title>Frame fixture</title><meta property="og:image" content="http://["><video title="Iframe video" controls muted src="/fixture.mp4"></video>' : req.url === "/empty" ? '<!doctype html><title>Empty fixture</title><p>No video on this page.</p>' : fixture.replace('src="/frame.html"', 'src="http://localhost:' + server.address().port + '/frame.html"'));
  }
});

async function run() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const uuid = "e4e7ea8a-6086-4e3a-928d-76c1e0d6bc26";
  const extensionOrigin = "moz-extension://" + uuid;
  const version = JSON.parse(fs.readFileSync(path.join(root, "extension/manifest.json"), "utf8")).version;
  const options = new firefox.Options().setBinary("C:/Program Files/Mozilla Firefox/firefox.exe").addArguments("-headless").enableBidi()
    .setPreference("extensions.webextensions.uuids", JSON.stringify({ "video-lens@local": uuid }))
    .setPreference("media.autoplay.default", 0)
    .setPreference("browser.download.folderList", 2)
    .setPreference("browser.download.dir", results)
    .setPreference("browser.download.useDownloadDir", true);
  const driver = await new Builder().forBrowser("firefox").setFirefoxOptions(options).setFirefoxService(new firefox.ServiceBuilder().addArguments("--allow-system-access")).build();
  const checks = [];
  const logs = await logInspector(driver);
  const errors = [];
  const externalContexts = new Set();
  const recordError = (entry) => errors.push({ text: entry.text, context: entry.source.browsingContextId });
  await logs.onConsoleEntry((entry) => { if (entry.level === "error") recordError(entry); });
  await logs.onJavascriptException(recordError);
  const row = (title) => driver.findElement(By.xpath("//article[contains(@class,'video-row')][.//button[contains(@class,'row-title') and text()=" + JSON.stringify(title) + "]]"));
  async function openPanel(title, mode) {
    if (await driver.findElement(By.id("panel")).isDisplayed()) await driver.findElement(By.id("close-panel")).click();
    if (!(await (await row(title)).findElement(By.css(".row-title")).isDisplayed())) await driver.findElement(By.id("other-label")).click();
    await (await row(title)).findElement(By.css(mode === "details" ? ".row-title" : ".row-more")).click();
    if (mode === "options") await driver.findElement(By.xpath("//*[@id='menu']/button[text()='Quality and options']")).click();
    await driver.wait(until.elementIsVisible(driver.findElement(By.id(mode + "-view"))), 5000);
  }
  async function settings(open) {
    if (await driver.executeScript("return document.querySelector('#settings').open") !== open) await driver.findElement(By.css("#settings > summary")).click();
  }
  const backgroundChecks = () => driver.executeAsyncScript(function () {
    const done = arguments[arguments.length - 1];
    browser.runtime.getBackgroundPage().then((background) => done({ downloads: background.__checkDownloads, reveals: background.__checkReveals })).catch((error) => done({ error: error.message }));
  });
  try {
    await driver.installAddon(path.join(root, "dist", "senzdev_visave-" + version + ".zip"), true);
    await driver.get(origin);
    await driver.executeScript("return document.querySelector('video').play()");
    const fixtureHandle = await driver.getWindowHandle();
    await driver.switchTo().newWindow("tab");
    const inspectorHandle = await driver.getWindowHandle();
    await driver.get(extensionOrigin + "/guide.html");
    const tabId = await driver.executeAsyncScript("const done=arguments[arguments.length-1];browser.tabs.query({}).then(tabs=>done(tabs.find(tab=>tab.url===" + JSON.stringify(origin + "/") + "||tab.url===" + JSON.stringify(origin) + ")?.id))");
    assert.ok(tabId);
    const harness = await driver.executeAsyncScript(function () {
      const done = arguments[arguments.length - 1];
      browser.runtime.getBackgroundPage().then((background) => {
        background.__checkDownloads = [];
        background.__checkReveals = [];
        const download = background.browser.downloads.download.bind(background.browser.downloads);
        background.browser.downloads.download = (preferences) => {
          background.__checkDownloads.push(preferences);
          return download({ ...preferences, saveAs: false });
        };
        background.browser.downloads.show = async (id) => { background.__checkReveals.push(id); return true; };
        background.browser.runtime.connectNative = () => { throw new Error("Helper intentionally unavailable in this isolated test"); };
        done({ ok: true });
      }).catch((error) => done({ error: error.message }));
    });
    assert.equal(harness.ok, true, JSON.stringify(harness));
    const inspector = extensionOrigin + "/popup/popup.html?tabId=" + tabId;
    await driver.get(inspector);
    await driver.wait(async () => (await driver.findElements(By.css(".video-row"))).length >= 3, 15000);
    assert.equal(await driver.findElement(By.id("panel")).isDisplayed(), false);
    assert.equal(await driver.findElement(By.id("watching-label")).getText(), "Now playing");
    assert.equal(await driver.findElement(By.css("#video .row-title")).getText(), mainTitle);
    assert.equal(await driver.executeScript("return document.querySelector('#other-videos').open"), false);
    await driver.wait(async () => (await (await row(mainTitle)).findElement(By.css("img")).getAttribute("naturalWidth")) > 0, 5000);
    assert.equal(await (await row("Shadow video")).findElement(By.css(".preview span")).getAttribute("textContent"), "No preview");
    checks.push("Compact real-video rows detect playing, open-shadow and cross-origin iframe players; actual poster and honest fallback render");
    await openPanel(mainTitle, "details");
    assert.equal(await driver.findElement(By.id("resolution")).getText(), "640 × 360");
    await driver.wait(async () => /fps/.test(await driver.findElement(By.id("fps")).getText()), 10000);
    assert.ok((await (await row(mainTitle)).findElement(By.css(".row-meta")).getText()).includes("360p"));
    checks.push("Details show actual decoded size, time and sampled FPS; summary rows retain compact playback information");
    await driver.findElement(By.id("play-pause")).click();
    await driver.wait(until.elementTextIs(driver.findElement(By.id("playback-state")), "Paused"), 5000);
    assert.equal(await driver.findElement(By.id("watching-label")).getText(), "On screen");
    await driver.findElement(By.id("play-pause")).click();
    await driver.wait(until.elementTextIs(driver.findElement(By.id("playback-state")), "Playing"), 5000);
    await driver.findElement(By.id("mute")).click();
    await driver.wait(until.elementTextIs(driver.findElement(By.id("mute")), "Mute"), 5000);
    await driver.findElement(By.id("mute")).click();
    checks.push("Pause/play and mute/unmute control the selected real player");
    await driver.findElement(By.css(".source-details summary")).click();
    assert.ok((await driver.findElement(By.id("source-url")).getText()).includes("fixture.mp4"));
    await driver.findElement(By.id("close-panel")).click();
    await openPanel("Shadow video", "details");
    assert.equal(await driver.findElement(By.id("playback-state")).getText(), "Paused");
    await driver.findElement(By.id("close-panel")).click();
    checks.push("Video-title selection opens the corresponding details; source details expand and Close restores the list");
    await driver.findElement(By.id("refresh")).sendKeys(Key.ENTER);
    await driver.wait(until.elementIsEnabled(driver.findElement(By.id("refresh"))), 5000);
    await driver.findElement(By.id("refresh")).sendKeys(Key.TAB);
    assert.ok((await driver.executeScript("return document.activeElement.className")).includes("row-title"));
    assert.ok(await driver.executeScript("return parseFloat(getComputedStyle(document.activeElement).outlineWidth)>=3"));
    await driver.switchTo().activeElement().sendKeys(Key.SHIFT, Key.TAB, Key.NULL);
    assert.equal(await driver.executeScript("return document.activeElement.id"), "refresh");
    await openPanel(mainTitle, "options");
    await driver.findElement(By.id("output")).sendKeys(Key.ESCAPE);
    assert.equal(await driver.findElement(By.id("panel")).isDisplayed(), false);
    assert.ok((await driver.executeScript("return document.activeElement.className")).includes("row-more"));
    checks.push("Refresh activates with Enter; Tab/Shift+Tab follow row order with visible focus; Escape closes options and restores its trigger");
    await (await row(mainTitle)).findElement(By.css(".row-more")).click();
    assert.equal(await (await row(mainTitle)).findElement(By.css(".row-more")).getAttribute("aria-expanded"), "true");
    await driver.switchTo().activeElement().sendKeys(Key.END);
    assert.equal(await driver.switchTo().activeElement().getText(), "Playback details");
    await driver.switchTo().activeElement().sendKeys(Key.HOME, Key.ARROW_DOWN);
    assert.equal(await driver.switchTo().activeElement().getText(), "Download audio (MP3)");
    assert.ok(await driver.executeScript("return parseFloat(getComputedStyle(document.activeElement).outlineWidth)>=3"));
    await driver.switchTo().activeElement().sendKeys(Key.ESCAPE);
    assert.equal(await (await row(mainTitle)).findElement(By.css(".row-more")).getAttribute("aria-expanded"), "false");
    await (await row(mainTitle)).findElement(By.css(".row-more")).click();
    await driver.switchTo().activeElement().sendKeys(Key.TAB);
    assert.equal(await driver.findElement(By.id("menu")).isDisplayed(), false);
    checks.push("Download menu supports Arrow keys, Home, End, Escape and Tab with visible focus and accurate expanded state");
    await (await row("Shadow video")).findElement(By.css('.row-format option[value="mp3"]')).click();
    await driver.findElement(By.id("refresh")).click();
    assert.equal(await (await row("Shadow video")).findElement(By.css(".row-format")).getAttribute("value"), "mp3");
    assert.equal(await (await row(mainTitle)).findElement(By.css(".row-format")).getAttribute("value"), "mp4");
    await openPanel("Shadow video", "options");
    assert.equal(await driver.findElement(By.id("output")).getAttribute("value"), "mp3");
    await driver.findElement(By.css('#output option[value="mp4"]')).click();
    await driver.findElement(By.id("close-panel")).click();
    checks.push("Format selection belongs to each video and stays synchronized with its own options after refresh");
    await driver.manage().window().setRect({ width: 560, height: 1000 });
    for (const theme of ["light", "dark", "system"]) {
      await settings(true);
      await driver.findElement(By.css('#theme option[value="' + theme + '"]')).click();
      assert.equal(await driver.executeScript("return document.documentElement.dataset.theme"), theme);
      const contrast = await driver.executeScript(function () {
        const style = getComputedStyle(document.documentElement);
        const l = (key) => {
          const channels = style.getPropertyValue(key).trim().replace("#", "").match(/../g).map((value) => parseInt(value, 16) / 255).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
          return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
        };
        const ratio = (a, b) => (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
        const values = {};
        for (const background of ["--paper", "--surface"]) for (const foreground of ["--ink", "--secondary", "--error"]) values[background + foreground] = ratio(l(background), l(foreground));
        values.button = ratio(l("--accent"), l("--on-accent"));
        values.border = ratio(l("--paper"), l("--control"));
        values.focus = ratio(l("--paper"), l("--accent"));
        return values;
      });
      for (const [name, value] of Object.entries(contrast)) assert.ok(value >= (["border", "focus"].includes(name) ? 3 : 4.5), theme + " " + name + " contrast " + value);
      await settings(false);
      if (theme !== "system") {
        if (await driver.executeScript("return document.querySelector('#other-videos').open")) await driver.findElement(By.id("other-label")).click();
        await driver.executeScript("document.body.scrollTop=0;document.documentElement.scrollTop=0");
        fs.writeFileSync(path.join(results, "popup-" + theme + ".png"), await driver.findElement(By.css("main")).takeScreenshot(), "base64");
      }
    }
    checks.push("System/light/dark work; all text roles on both surfaces, primary button, controls and focus pass contrast thresholds");
    await driver.get(extensionOrigin + "/guide.html");
    await driver.executeScript("const frame=document.createElement('iframe');frame.id='narrow-panel';frame.src=arguments[0];frame.style.cssText='width:320px;height:1600px;border:0';document.body.replaceChildren(frame)", inspector);
    await driver.switchTo().frame(driver.findElement(By.id("narrow-panel")));
    await driver.wait(async () => (await driver.findElements(By.css(".video-row"))).length >= 3, 10000);
    assert.ok(await driver.executeScript("return innerWidth<=320"));
    await driver.executeScript("document.documentElement.style.fontSize='28px'");
    assert.equal(await driver.executeScript("return document.documentElement.scrollWidth>innerWidth"), false);
    await openPanel(mainTitle, "details");
    assert.equal(await driver.executeScript("return document.documentElement.scrollWidth>innerWidth"), false);
    await openPanel(mainTitle, "options");
    await driver.findElement(By.css('#output option[value="mp3"]')).click();
    assert.equal(await driver.executeScript("return document.documentElement.scrollWidth>innerWidth"), false);
    await settings(true);
    assert.equal(await driver.executeScript("return document.documentElement.scrollWidth>innerWidth"), false);
    await driver.findElement(By.id("close-panel")).click();
    await (await row(mainTitle)).findElement(By.css(".row-more")).click();
    const menuBounds = await driver.executeScript("const r=document.querySelector('#menu').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight}");
    assert.ok(menuBounds.left >= 0 && menuBounds.right <= menuBounds.width && menuBounds.top >= 0 && menuBounds.bottom <= menuBounds.height, JSON.stringify(menuBounds));
    await driver.switchTo().activeElement().sendKeys(Key.ESCAPE);
    checks.push("320px viewport at 200% root text has no horizontal overflow in list, details, options or settings");
    await driver.switchTo().defaultContent();
    await driver.get(inspector);
    await driver.wait(async () => (await driver.findElements(By.css(".video-row"))).length >= 3, 10000);
    await settings(true);
    const helperSummary = await driver.findElement(By.css(".helper-details summary"));
    await helperSummary.click();
    await helperSummary.sendKeys(Key.SPACE);
    assert.equal(await driver.executeScript("return document.querySelector('.helper-details').open"), false);
    await helperSummary.sendKeys(Key.ENTER);
    await driver.findElement(By.id("check-helper")).click();
    await driver.wait(async () => (await driver.findElement(By.id("helper-status")).getText()).includes("Installation needed"), 10000);
    checks.push("Settings and helper details open/close with mouse and keyboard; helper check provides an actionable unavailable state");
    await openPanel(mainTitle, "options");
    await driver.findElement(By.css('#output option[value="mp3"]')).click();
    assert.ok((await driver.findElement(By.id("download-reason")).getText()).includes("MP3"));
    await driver.findElement(By.id("cookies")).click();
    assert.equal(await driver.findElement(By.id("cookies")).isSelected(), true);
    await driver.findElement(By.id("cookies")).click();
    await driver.findElement(By.id("download")).click();
    await driver.wait(until.elementIsVisible(driver.findElement(By.id("action-status"))), 5000);
    await driver.findElement(By.id("refresh")).click();
    assert.equal(await driver.findElement(By.id("action-status")).isDisplayed(), true);
    checks.push("MP3 and explicit login opt-in work; helper download failure stays visible after refresh");
    await driver.findElement(By.css('#output option[value="mp4"]')).click();
    await driver.findElement(By.id("close-panel")).click();
    await (await row(mainTitle)).findElement(By.css(".row-download")).click();
    await driver.wait(async () => (await driver.findElement(By.id("job-status")).getText()).includes("Saved"), 10000);
    let captured = await backgroundChecks();
    assert.equal(captured.downloads[0].saveAs, true);
    assert.equal(captured.reveals.length, 1);
    await driver.findElement(By.id("show-file")).click();
    assert.equal((await backgroundChecks()).reveals.length, 2);
    await driver.findElement(By.id("dismiss-job")).click();
    await driver.findElement(By.id("refresh")).click();
    assert.equal(await driver.findElement(By.id("job")).isDisplayed(), false);
    checks.push("Per-row Download saves a real MP4; production requests Save As, automatically reveals once after completion, and manual Show works");
    await driver.switchTo().window(fixtureHandle);
    await driver.executeScript("const v=document.createElement('video');v.title='Conversion fixture';v.src='/fixture.webm';v.controls=true;document.body.append(v)");
    await driver.switchTo().window(inspectorHandle);
    await driver.findElement(By.id("refresh")).click();
    await driver.wait(async () => (await driver.findElements(By.css(".video-row"))).length >= 4, 10000);
    await openPanel("Conversion fixture", "options");
    await driver.findElement(By.css('#quality option[value="720"]')).click();
    assert.equal(await driver.findElement(By.id("quality")).getAttribute("value"), "720");
    await driver.findElement(By.css('#output option[value="original"]')).click();
    assert.equal(await driver.findElement(By.id("download")).isEnabled(), true);
    checks.push("Dynamically added WebM enables helper MP4 quality selection and original-file mode");
    await driver.switchTo().window(fixtureHandle);
    await driver.executeScript("const v=document.createElement('video');v.title='Cancellation fixture';v.src='/slow.mp4';v.controls=true;document.body.append(v)");
    await driver.switchTo().window(inspectorHandle);
    await driver.findElement(By.id("refresh")).click();
    await driver.wait(async () => (await driver.findElements(By.css(".video-row"))).length >= 5, 10000);
    await driver.findElement(By.id("close-panel")).click();
    await (await row("Cancellation fixture")).findElement(By.css(".row-download")).click();
    await driver.wait(until.elementIsVisible(driver.findElement(By.id("cancel"))), 5000);
    assert.equal(await driver.findElement(By.id("dismiss-job")).isDisplayed(), false);
    await driver.findElement(By.id("cancel")).click();
    await driver.wait(async () => (await driver.findElement(By.id("job-status")).getText()).includes("cancelled"), 10000);
    assert.equal((await backgroundChecks()).reveals.length, 2);
    checks.push("Cancel stops a real in-progress original download and does not request File Explorer");
    await driver.findElement(By.id("guide")).click();
    await driver.wait(async () => (await driver.getAllWindowHandles()).length === 3, 5000);
    const guideHandle = (await driver.getAllWindowHandles())[2];
    await driver.switchTo().window(guideHandle);
    const guideUrls = await Promise.all((await driver.findElements(By.css("main a[href]"))).map((link) => link.getAttribute("href")));
    assert.ok(guideUrls.includes("https://github.com/senzore"));
    assert.ok(guideUrls.includes("https://nodejs.org/"));
    await driver.findElement(By.id("check-installation")).click();
    await driver.wait(async () => (await driver.findElement(By.id("installation-status")).getText()).includes("Not connected"), 10000);
    checks.push("Installation guide explains bundled dependencies and reports missing installation with the next action");
    await driver.get(extensionOrigin + "/sites.html");
    await driver.wait(async () => (await driver.findElements(By.css("#site-results li"))).length === 60, 10000);
    const firstCount = await driver.findElement(By.id("site-count")).getText();
    assert.match(firstCount, /1363 groups/);
    await driver.findElement(By.id("more-sites")).click();
    assert.equal((await driver.findElements(By.css("#site-results li"))).length, 120);
    await driver.findElement(By.id("site-search")).sendKeys("Instagram");
    assert.ok((await driver.findElement(By.id("site-results")).getText()).includes("Instagram"));
    await driver.findElement(By.id("site-search")).clear();
    await driver.findElement(By.id("site-search")).sendKeys("20min");
    assert.ok((await driver.findElement(By.id("site-results")).getText()).includes("broken"));
    await driver.findElement(By.id("site-search")).clear();
    await driver.findElement(By.id("site-search")).sendKeys("<img src=x onerror=alert(1)>");
    assert.equal((await driver.findElements(By.css("#site-results li"))).length, 0);
    assert.equal((await driver.findElements(By.css("#site-results img"))).length, 0);
    await driver.findElement(By.id("site-search")).clear();
    await driver.findElement(By.id("site-search")).sendKeys("YouTube");
    fs.writeFileSync(path.join(results, "visave-supported-sites.png"), await driver.takeScreenshot(), "base64");
    checks.push("Supported sites page loads offline, paginates, searches Instagram/YouTube, marks broken extractors, and safely handles markup input");
    await driver.switchTo().window(inspectorHandle);
    await (await row("Conversion fixture")).findElement(By.css(".row-more")).click();
    await driver.switchTo().window(fixtureHandle);
    await driver.executeScript("document.querySelector('video[title=\"Conversion fixture\"]').remove()");
    await driver.switchTo().window(inspectorHandle);
    await driver.wait(async () => !(await driver.findElement(By.id("menu")).isDisplayed()), 10000);
    checks.push("Removing a video closes its open menu; malformed page poster metadata does not interrupt frame inspection");
    await driver.switchTo().window(fixtureHandle);
    await driver.get(origin + "/empty");
    await driver.switchTo().window(inspectorHandle);
    await driver.get(inspector);
    await driver.wait(async () => (await driver.findElement(By.id("notice")).getText()).includes("No video"), 10000);
    checks.push("Navigation removes stale rows and shows the real empty state");
    await driver.switchTo().window(fixtureHandle);
    await driver.navigate().back();
    await driver.executeScript("return document.querySelector('video').play()");
    await driver.switchTo().window(inspectorHandle);
    await driver.findElement(By.id("refresh")).click();
    await driver.wait(async () => (await driver.findElements(By.css(".video-row"))).length >= 3, 10000);
    checks.push("Back navigation resumes the compact inspector");
    await driver.switchTo().window(fixtureHandle);
    await driver.get(origin + "/feed");
    await driver.switchTo().window(inspectorHandle);
    await driver.get(inspector);
    await driver.wait(async () => (await driver.findElements(By.css(".video-row"))).length === 8, 10000);
    await driver.wait(async () => (await driver.findElement(By.css("#video .row-title")).getText()) === "Feed video 4", 10000);
    assert.equal(await driver.findElement(By.id("watching-label")).getText(), "Now playing");
    assert.equal(await driver.findElement(By.id("other-label")).getText(), "Other loaded videos (7)");
    assert.equal(await driver.executeScript("return document.querySelector('#other-videos').open"), false);
    assert.equal(await (await row("Feed video 0")).findElement(By.css(".row-title")).isDisplayed(), false);
    if (await driver.findElement(By.id("dismiss-job")).isDisplayed()) await driver.findElement(By.id("dismiss-job")).click();
    fs.writeFileSync(path.join(results, "feed-current.png"), await driver.findElement(By.css("main")).takeScreenshot(), "base64");
    await driver.findElement(By.id("other-label")).click();
    assert.equal(await (await row("Feed video 0")).findElement(By.css(".row-title")).isDisplayed(), true);
    await driver.findElement(By.id("other-label")).click();
    checks.push("Eight-video feed shows the visible playing video first and collapses seven other loaded players, excluding offscreen autoplay and clipped media");
    await driver.switchTo().window(fixtureHandle);
    await driver.executeScript("const old=document.querySelector('#feed-4');old.pause();old.style.top='2000px';const next=document.querySelector('#feed-6');next.style.top='20px';return next.play()");
    await driver.switchTo().window(inspectorHandle);
    await driver.wait(async () => (await driver.findElement(By.css("#video .row-title")).getText()) === "Feed video 6", 10000);
    await driver.findElement(By.css("#video .row-download")).click();
    await driver.wait(async () => (await driver.findElement(By.id("job-status")).getText()).includes("Saved"), 10000);
    const feedDownload = (await backgroundChecks()).downloads.at(-1);
    assert.ok(feedDownload.url.includes("slot=6"), JSON.stringify(feedDownload));
    checks.push("Current row follows the next visible playing feed video, and its Download button requests that player's own media source");
    await driver.switchTo().window(fixtureHandle);
    await driver.get(origin + "/root-overflow");
    assert.equal(await driver.executeScript("return document.body.getBoundingClientRect().height"), 0);
    await driver.switchTo().window(inspectorHandle);
    await driver.get(inspector);
    await driver.wait(async () => (await driver.findElements(By.css("#video .row-title"))).length === 1 && (await driver.findElement(By.css("#video .row-title")).getText()) === "Root overflow current player", 10000);
    assert.equal(await driver.findElement(By.id("watching-label")).getText(), "Now playing");
    checks.push("An absolute player stays current when the zero-height body propagates overflow to the viewport and a display:contents wrapper has no clipping box");
    await driver.switchTo().window(fixtureHandle);
    await driver.executeScript("document.querySelector('#player').style.top='2000px'");
    await driver.switchTo().window(inspectorHandle);
    await driver.wait(async () => (await driver.findElements(By.css("#video .row-title"))).length === 0, 10000);
    await driver.switchTo().window(fixtureHandle);
    await driver.executeScript("document.querySelector('#player').style.top='20px'");
    await driver.switchTo().window(inspectorHandle);
    await driver.wait(async () => (await driver.findElements(By.css("#video .row-title"))).length === 1, 10000);
    checks.push("Viewport intersection updates when the root-overflow player moves offscreen and returns");
    await driver.executeAsyncScript(function (folder, endpoint) {
      const done = arguments[arguments.length - 1];
      browser.runtime.getBackgroundPage().then(background => {
        background.__checkNative = [];
        background.__checkFolderCancelled = false;
        background.browser.runtime.connectNative = () => {
          const listeners = [];
          return {
            onMessage: { addListener: listener => listeners.push(listener) },
            onDisconnect: { addListener() {} },
            postMessage(message) {
              background.__checkNative.push(message);
              const reply = value => listeners.forEach(listener => listener({ id: message.id, ...value }));
              if (message.action === "saveFile") background.fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(message) }).then(response => response.json()).then(reply).catch(error => reply({ ok: false, error: error.message }));
              else setTimeout(() => reply({ ok: true, result: message.action === "probe" ? { saveFolderSupported: true, filenameSupported: true } : background.__checkFolderCancelled ? { cancelled: true } : { folder } }), 20);
            }
          };
        };
        done(true);
      });
    }, chosenFolder, origin + "/native-test-move");
    await settings(true);
    assert.equal(await driver.findElement(By.id("choose-folder")).getText(), "Choose folder…");
    assert.equal((await driver.findElements(By.id("save-before"))).length, 0);
    await driver.findElement(By.id("choose-folder")).click();
    const savedPreference = () => driver.executeAsyncScript("const done=arguments[arguments.length-1];browser.storage.local.get('downloadFolder').then(value=>done(value.downloadFolder))");
    await driver.wait(async () => await savedPreference() === chosenFolder, 5000);
    await driver.get(inspector);
    await settings(true);
    assert.equal(await driver.findElement(By.id("choose-folder")).getText(), chosenFolder);
    assert.equal(await driver.executeScript("return document.documentElement.scrollWidth<=document.documentElement.clientWidth"), true);
    fs.writeFileSync(path.join(results, "settings-saved-folder.png"), await driver.findElement(By.css("main")).takeScreenshot(), "base64");
    checks.push("Save downloaded files to opens a folder picker, persists across popup reloads, and wraps long paths without horizontal overflow");
    const revealsBefore = (await backgroundChecks()).reveals.length;
    await driver.findElement(By.css("#video .row-download")).click();
    await driver.wait(async () => (await driver.findElement(By.id("job-status")).getText()).includes("Saved") && (await driver.findElement(By.id("job-file")).getText()).startsWith(chosenFolder), 15000);
    const savedPath = await driver.findElement(By.id("job-file")).getText();
    assert.ok(fs.readFileSync(savedPath).equals(fs.readFileSync(media)));
    const silent = await backgroundChecks();
    assert.equal(silent.downloads.at(-1).saveAs, false);
    assert.equal(silent.reveals.length, revealsBefore);
    assert.equal(await driver.findElement(By.id("show-file")).isDisplayed(), false);
    checks.push("A real Firefox direct MP4 downloads without Save As, reaches the saved folder unchanged and never requests Explorer (native transfer substituted)");
    await driver.executeAsyncScript("const done=arguments[arguments.length-1];browser.runtime.getBackgroundPage().then(background=>{background.__checkFolderCancelled=true;done(true)})");
    await driver.findElement(By.id("choose-folder")).click();
    await driver.wait(async () => !(await driver.findElement(By.id("choose-folder")).getAttribute("disabled")), 5000);
    assert.equal(await savedPreference(), chosenFolder);
    await driver.findElement(By.id("clear-folder")).sendKeys(Key.SPACE);
    await driver.wait(async () => await savedPreference() === "", 5000);
    await driver.get(inspector);
    await settings(true);
    assert.equal(await driver.findElement(By.id("choose-folder")).getText(), "Choose folder…");
    checks.push("Cancelling folder selection keeps the old folder; Clear removes the preference using the keyboard and survives reload");
    assert.deepEqual(errors.filter((entry) => !externalContexts.has(entry.context)), [], "No extension or fixture console errors");
    checks.push("No extension/local-fixture console errors or unhandled JavaScript exceptions");
    fs.writeFileSync(path.join(results, "browser-check.json"), JSON.stringify({ checks, nativeDialogPolicy: "Save As and Explorer APIs recorded; real download proceeds without interactive OS dialogs in isolated test", externalPageMessages: errors.filter((entry) => externalContexts.has(entry.context)) }, null, 2));
    process.stdout.write(checks.map((check) => "PASS " + check).join("\n") + "\n");
  } catch (error) {
    fs.writeFileSync(path.join(results, "browser-failure.png"), await driver.takeScreenshot(), "base64");
    process.stderr.write("Firefox URL: " + await driver.getCurrentUrl() + "\nCompleted checks: " + checks.length + "\n");
    throw error;
  } finally { await logs.close(); await driver.quit(); server.close(); }
}
run().catch((error) => { process.stderr.write(error.stack + "\n"); server.close(); process.exitCode = 1; });
