const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { Builder, By } = require("selenium-webdriver");
const firefox = require("selenium-webdriver/firefox");
const root = path.resolve(__dirname, "..");
let latest = {};
let command = { id: 0 };
let handled = 0;

function harness(bridge) {
  let running = false;
  let last = 0;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const command = await (await fetch(bridge)).json();
      const popup = browser.extension.getViews({ type: "popup" })[0];
      if (popup && command.id !== last) {
        last = command.id;
        if (command.action === "click") {
          const elements = [...popup.document.querySelectorAll(command.selector)];
          const target = command.text ? elements.find(el => el.textContent === command.text) : elements[0];
          target?.click();
        } else if (command.action === "resize") {
          popup.dispatchEvent(new popup.Event("resize"));
          popup.document.dispatchEvent(new popup.Event("scroll"));
        }
      }
      const doc = popup?.document;
      await fetch(bridge, {
        method: "POST",
        body: JSON.stringify({
          commandId: last, hasPopup: !!popup, width: popup?.innerWidth, height: popup?.innerHeight,
          notice: doc?.querySelector("#notice")?.textContent,
          rows: doc?.querySelectorAll(".video-row").length,
          menu: doc ? !doc.querySelector("#menu").hidden : false,
          options: doc ? !doc.querySelector("#options-view").hidden && !doc.querySelector("#panel").hidden : false
        })
      });
    } catch (error) {
      await fetch(bridge, { method: "POST", body: JSON.stringify({ error: error.message }) }).catch(() => {});
    } finally { running = false; }
  }, 100);
}

const server = http.createServer((req, res) => {
  if (req.url === "/bridge") {
    if (req.method === "POST") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => { latest = JSON.parse(body); res.end("ok"); });
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(command));
    }
  } else if (req.url === "/fixture.mp4") {
    res.setHeader("Content-Type", "video/mp4");
    fs.createReadStream(path.join(root, "test-results/fixture.mp4")).pipe(res);
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end('<!doctype html><title>Toolbar fixture</title>' + (req.url === "/video"
      ? '<video title="Toolbar playback test" src="/fixture.mp4" autoplay muted loop controls></video>'
      : '<p>No loaded media on this page.</p><video></video>'));
  }
});

async function run() {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "video-lens-toolbar-"));
  const source = path.join(temporary, "extension");
  fs.cpSync(path.join(root, "extension"), source, { recursive: true });
  const manifestPath = path.join(source, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.background.scripts.push("toolbar-harness.js");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  fs.writeFileSync(path.join(source, "toolbar-harness.js"), "(" + harness.toString() + ")(" + JSON.stringify(origin + "/bridge") + ");");
  const archive = path.join(temporary, "test.zip");
  const python = [path.join(root, "native/.venv/Scripts/python.exe"), path.resolve(root, "../native/.venv/Scripts/python.exe")].find(candidate => fs.existsSync(candidate)) || "python";
  const packed = spawnSync(python, ["-c", "from pathlib import Path\nfrom zipfile import ZipFile\nimport sys\nroot=Path(sys.argv[1])\nwith ZipFile(sys.argv[2], 'w') as z:\n for p in root.rglob('*'):\n  if p.is_file(): z.write(p, p.relative_to(root).as_posix())", source, archive], { encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  const options = new firefox.Options().setBinary("C:/Program Files/Mozilla Firefox/firefox.exe").addArguments("-headless").setPreference("media.autoplay.default", 0);
  const driver = await new Builder().forBrowser("firefox").setFirefoxOptions(options).setFirefoxService(new firefox.ServiceBuilder().addArguments("--allow-system-access")).build();
  const checks = [];
  async function act(action, selector, text) {
    command = { id: ++handled, action, selector, text };
    await driver.wait(() => latest.commandId === handled || latest.error, 8000);
    assert.equal(latest.error, undefined, latest.error);
  }
  async function open(url) {
    await driver.setContext("content");
    await driver.get(origin + url);
    if (url === "/video") await driver.executeScript("return document.querySelector('video').play()");
    await driver.setContext("chrome");
    await driver.findElement(By.id("video-lens_local-BAP")).click();
    await driver.wait(() => latest.hasPopup && latest.notice !== "Looking for videos in this tab..." || latest.error, 10000);
    assert.equal(latest.error, undefined, latest.error);
  }
  async function screenshot(name) {
    const data = await driver.executeAsyncScript(function () {
      const done = arguments[arguments.length - 1];
      const frame = document.querySelector(".webextension-popup-browser");
      frame.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "rgb(255,255,255)").then(bitmap => {
        const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d").drawImage(bitmap, 0, 0);
        done({ image: canvas.toDataURL("image/png").split(",")[1] });
        bitmap.close();
      }).catch(error => done({ error: error.message }));
    });
    assert.ok(data.image, data.error);
    fs.writeFileSync(path.join(root, "test-results/" + name), data.image, "base64");
  }
  try {
    const fixtureHandle = await driver.getWindowHandle();
    await driver.installAddon(archive, true);
    await driver.wait(async () => (await driver.getAllWindowHandles()).length === 2, 10000);
    await driver.switchTo().window(fixtureHandle);
    await driver.setContext("chrome");
    await driver.executeScript('window.CustomizableUI.addWidgetToArea("video-lens_local-browser-action", "nav-bar")');
    await open("/empty");
    await driver.wait(() => latest.notice === "No video." && latest.rows === 0, 10000);
    assert.ok(latest.width >= 320 && latest.height >= 100, JSON.stringify(latest));
    await screenshot("toolbar-empty.png");
    checks.push("Actual toolbar popup has usable width and shows No video for a page with only an unloaded placeholder");
    await driver.executeScript('document.querySelector("#customizationui-widget-panel").hidePopup()');
    await driver.wait(() => !latest.hasPopup, 5000);
    await open("/video");
    await driver.wait(() => latest.rows === 1, 10000);
    await act("click", ".row-more");
    const opened = Date.now();
    await driver.wait(() => latest.menu && Date.now() - opened > 700, 5000);
    await act("resize");
    assert.equal(latest.menu, true, JSON.stringify(latest));
    await screenshot("toolbar-menu.png");
    checks.push("Arrow opens the menu inside the real toolbar popup; it stays open through popup resizing and scrolling");
    await act("click", "#menu button", "Quality and options");
    assert.equal(latest.options, true, JSON.stringify(latest));
    assert.equal(latest.menu, false);
    await act("click", "#close-panel");
    await act("click", ".row-more");
    assert.equal(latest.menu, true);
    await act("click", ".row-more");
    assert.equal(latest.menu, false);
    checks.push("Toolbar menu opens download options and can be toggled repeatedly");
    fs.writeFileSync(path.join(root, "test-results/toolbar-check.json"), JSON.stringify({ checks, harness: "A temporary extension copy adds a local test bridge; production scripts and real Firefox toolbar layout are used unchanged." }, null, 2));
    console.log(checks.map(check => "PASS " + check).join("\n"));
  } catch (error) {
    console.error("Last popup state:", latest);
    throw error;
  } finally {
    await driver.quit();
    server.close();
    const resolved = path.resolve(temporary);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith("video-lens-toolbar-")) fs.rmSync(resolved, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); server.close(); process.exitCode=1; });
