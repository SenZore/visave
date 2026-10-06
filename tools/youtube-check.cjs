const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { Builder } = require("selenium-webdriver");
const firefox = require("selenium-webdriver/firefox");

async function run() {
  const root = path.resolve(__dirname, "..");
  const version = JSON.parse(fs.readFileSync(path.join(root, "extension/manifest.json"), "utf8")).version;
  const uuid = "e4e7ea8a-6086-4e3a-928d-76c1e0d6bc26";
  const options = new firefox.Options().setBinary("C:/Program Files/Mozilla Firefox/firefox.exe").addArguments("-headless").enableBidi()
    .setPreference("media.autoplay.default", 0)
    .setPreference("extensions.webextensions.uuids", JSON.stringify({ "video-lens@local": uuid }));
  const driver = await new Builder().forBrowser("firefox").setFirefoxOptions(options).setFirefoxService(new firefox.ServiceBuilder().addArguments("--allow-system-access")).build();
  try {
    await driver.installAddon(path.join(root, "dist", "senzdev_visave-" + version + ".zip"), true);
    const url = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
    await driver.get(url);
    await driver.wait(() => driver.executeScript("return !!document.querySelector('#movie_player video')"), 20000);
    await driver.executeScript("const v=document.querySelector('#movie_player video');v.muted=true;return v.play().catch(error=>error.message)");
    await driver.wait(() => driver.executeScript("const v=document.querySelector('#movie_player video');if(!v)return false;const r=v.getBoundingClientRect();return !!v.currentSrc&&r.width>0&&r.top>=0&&r.bottom>r.top"), 30000);
    const geometry = await driver.executeScript("const v=document.querySelector('#movie_player video'),r=v.getBoundingClientRect();return {bodyHeight:document.body.getBoundingClientRect().height,bodyOverflow:getComputedStyle(document.body).overflowY,video:{left:r.left,top:r.top,width:r.width,height:r.height},source:v.currentSrc}");
    await driver.switchTo().newWindow("tab");
    await driver.get("moz-extension://" + uuid + "/guide.html");
    const tabId = await driver.executeAsyncScript(function (url) {
      const done = arguments[arguments.length - 1];
      browser.tabs.query({}).then(tabs => done(tabs.find(tab => {
        try {
          const actual = new URL(tab.url);
          const expected = new URL(url);
          return actual.hostname === expected.hostname && actual.pathname === expected.pathname && actual.searchParams.get("v") === expected.searchParams.get("v");
        } catch { return false; }
      })?.id));
    }, url);
    assert.ok(tabId);
    let state;
    await driver.wait(async () => {
      const reply = await driver.executeAsyncScript(function (tabId) {
        const done = arguments[arguments.length - 1];
        browser.runtime.sendMessage({ type: "REFRESH", tabId }).then(done);
      }, tabId);
      state = reply.result;
      return reply.ok && state.videos.some(video => video.sourceUrl === geometry.source && video.visibleScore > 0);
    }, 10000);
    const current = state.videos.filter(video => video.visibleScore > 0).sort((a, b) => Number(b.paused === false) - Number(a.paused === false) || b.visibleScore - a.visibleScore)[0];
    assert.equal(current.sourceUrl, geometry.source);
    assert.equal(current.paused, false);
    const result = { url, geometry, current: { title: current.title, visibleScore: current.visibleScore, paused: current.paused }, checks: ["Public YouTube main player has positive visible area and is selected as current in production extension state"] };
    fs.mkdirSync(path.join(root, "test-results"), { recursive: true });
    fs.writeFileSync(path.join(root, "test-results/youtube-check.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const diagnostic = await driver.executeScript("const v=document.querySelector('video');return {title:document.title,playerText:document.querySelector('#movie_player')?.innerText,source:v?.currentSrc,readyState:v?.readyState,error:v?.error?.code,paused:v?.paused,time:v?.currentTime,style:v?.getAttribute('style'),bodyHeight:document.body.getBoundingClientRect().height}");
    console.error(JSON.stringify(diagnostic, null, 2));
    throw error;
  } finally { await driver.quit(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
