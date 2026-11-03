// End-to-end tests for index.html (멍뭉이 털을 찾아라).
// Run: node --test   (or GAME_URL=https://your-site node --test to test a deployed site)
// Serves the repo with the Content-Security-Policy from vercel.json so the
// game is checked under the same headers it gets in production.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const HEADERS = Object.fromEntries(vercel.headers[0].headers.map(h => [h.key, h.value]));

let server, base, browser;

before(async () => {
  browser = await chromium.launch();
  if (process.env.GAME_URL) { base = process.env.GAME_URL.replace(/\/$/, ''); return; } // test a deployed site
  server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    let file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    const type = { '.js': 'text/javascript', '.json': 'application/json' }[path.extname(file)] || 'text/html; charset=utf-8';
    res.writeHead(200, { ...HEADERS, 'Content-Type': type });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await browser?.close(); server?.close(); });

async function open(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 780 }, ...opts });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    // Google Fonts may be unreachable in CI; everything else is a real error
    if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.text())) errors.push('console: ' + m.text());
  });
  await page.goto(base + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__mm, null, { timeout: 30000 }); // 3D engine module loaded
  await page.waitForTimeout(400);
  return { page, ctx, errors };
}

// Click a hair through the real pointer path. The game's findHair() projects the 3D
// strands to the screen and returns a point on a strand that faces the camera and has
// no other strand close enough to be grabbed too (맨손 grabs every strand in reach).
async function clickHair(page, white, { touch = false } = {}) {
  // wait until the head has settled after the previous pluck's bounce/shake
  await page.waitForFunction(() => __mm.G.bounce === 0 && __mm.G.shake === 0, null, { timeout: 5000 });
  // a matching strand may be on the back of the head: turn the view like a player would
  let handle = await page.waitForFunction(white => __mm.findHair(white), white, { timeout: 2500 }).catch(() => null);
  for (let k = 0; !handle && k < 6; k++) {
    await page.evaluate(white => __mm.aimAt(white), white);
    handle = await page.waitForFunction(white => __mm.findHair(white), white, { timeout: 2500 }).catch(() => null);
  }
  assert.ok(handle, `found a ${white ? 'white' : 'black'} strand to pluck`);
  await page.waitForTimeout(150); // let the camera settle before the click
  const pt = await page.evaluate(white => __mm.findHair(white), white) || await handle.jsonValue();
  const box = await page.locator('#app').boundingBox();
  if (touch) await page.touchscreen.tap(box.x + pt.x, box.y + pt.y);
  else await page.mouse.click(box.x + pt.x, box.y + pt.y);
}

test('page is served with the production CSP and loads without errors', async () => {
  const { page, ctx, errors } = await open();
  assert.equal(await page.title(), '멍뭉이 털을 찾아라');
  assert.match(await page.locator('#sTitle h1').innerText(), /멍뭉이 털을 찾아라/);
  assert.equal(await page.locator('#stageGrid button').count(), 10);
  assert.equal(await page.locator('#stageGrid button:not([disabled])').count(), 1, 'only stage 1 unlocked at first');
  // the 3D scene actually draws: sample the WebGL canvas for more than one colour
  const colours = await page.evaluate(() => new Promise(r => requestAnimationFrame(() => {
    const c = document.createElement('canvas'), gl = document.getElementById('gl');
    c.width = 40; c.height = 40; const x = c.getContext('2d'); x.drawImage(gl, 0, 0, 40, 40);
    const d = x.getImageData(0, 0, 40, 40).data, s = new Set();
    for (let i = 0; i < d.length; i += 4) s.add(d[i] >> 4 << 8 | d[i + 1] >> 4 << 4 | d[i + 2] >> 4);
    r(s.size);
  })));
  assert.ok(colours > 20, `3D scene rendered (${colours} colours)`);
  const chars = await page.evaluate(() => Object.keys(__mm.chars).map(k => __mm.chars[k].root.visible));
  assert.deepEqual(chars, [true, true], '멍뭉이 and 우기 are in the room');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('stage 1 intro: arrival, single 좋아 answer, tool card, 2:00 timer', async () => {
  const { page, ctx, errors } = await open();
  await page.click('#btnStart');
  await page.waitForSelector('#mmBubble.on', { timeout: 40000 });
  assert.equal(await page.locator('#mmBubble').innerText(), '오늘도 흰머리를 뽑아보자!');
  await page.waitForSelector('#choice.on');
  const answers = page.locator('#choice button');
  assert.equal(await answers.count(), 1);
  assert.equal((await answers.innerText()).trim(), '좋아');
  await answers.click();
  await page.waitForSelector('#toolOv.on', { timeout: 5000 });
  assert.equal(await page.locator('#toolName').innerText(), '맨손');
  await page.click('#btnGo');
  await page.waitForSelector('#sGame.on');
  assert.match(await page.locator('#timeTxt').innerText(), /2:00|1:59/);
  assert.equal(await page.locator('#scoreTxt').innerText(), '0 / 20점');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('scoring: white hair +5 with happy face, black hair -1 with angry face', async () => {
  const { page, ctx, errors } = await open();
  await page.evaluate(() => __mm.startGame(1)); // 족집게: exactly one hair per pluck
  await clickHair(page, true);
  assert.equal(await page.evaluate(() => __mm.G.score), 5);
  assert.equal(await page.evaluate(() => __mm.G.expr), 'happy');
  await page.waitForTimeout(1100);
  await clickHair(page, false);
  assert.equal(await page.evaluate(() => __mm.G.score), 4);
  assert.equal(await page.evaluate(() => __mm.G.expr), 'angry');
  assert.equal(await page.locator('#scoreTxt').innerText(), '4 / 20점');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('reaching 20 points keeps the game going until time is up, then clears and saves', async () => {
  const { page, ctx, errors } = await open();
  await page.evaluate(() => __mm.startGame(1));
  for (let k = 0; k < 4; k++) { await clickHair(page, true); await page.waitForTimeout(50); }
  assert.equal(await page.evaluate(() => __mm.G.score), 20);
  assert.equal(await page.evaluate(() => __mm.G.running), true, 'still playing after the goal');
  assert.match(await page.locator('#scoreTxt').innerText(), /통과 점수 달성/);
  await clickHair(page, true);
  assert.equal(await page.evaluate(() => __mm.G.score), 25, 'can keep plucking past 20');
  assert.equal(await page.locator('#resultOv.on').count(), 0, 'no result before time is up');
  await page.evaluate(() => { __mm.G.timeLeft = 0.3; });
  await page.waitForSelector('#resultOv.on', { timeout: 5000 });
  assert.match(await page.locator('#resultCard').innerText(), /2단계 통과/);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('mmhair_v1')));
  assert.equal(saved.cleared, 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('time running out fails the stage and retry resets it', async () => {
  const { page, ctx, errors } = await open();
  await page.evaluate(() => { __mm.startGame(0); __mm.G.timeLeft = 0.3; });
  await page.waitForSelector('#resultOv.on', { timeout: 3000 });
  assert.match(await page.locator('#resultCard').innerText(), /시간 종료/);
  await page.click('[data-a="retry"]');
  assert.equal(await page.evaluate(() => __mm.G.score), 0);
  assert.equal(await page.evaluate(() => __mm.G.timeLeft > 119), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('10 stages get harder and unlock tools', async () => {
  const { page, ctx } = await open();
  const ps = await page.evaluate(() => Array.from({ length: 10 }, (_, i) => __mm.stageParams(i)));
  assert.equal(ps[0].time, 120);
  for (let i = 1; i < 10; i++) {
    assert.ok(ps[i].time <= ps[i - 1].time, 'time limit never grows');
    assert.ok(ps[i].black > ps[i - 1].black, 'more black hairs each stage');
    assert.ok(ps[i].white <= ps[i - 1].white, 'fewer white hairs at once');
  }
  assert.equal(await page.evaluate(() => __mm.TOOLS.length), 10);
  const trays = {};
  for (const i of [0, 3, 7, 8]) {
    await page.evaluate(i => __mm.startGame(i), i);
    trays[i] = await page.locator('#tray .tbtn').evaluateAll(bs => bs.map(b => b.id));
  }
  assert.deepEqual(trays[0], []);
  assert.deepEqual(trays[3], ['tComb']);
  assert.deepEqual(trays[7], ['tComb', 'tTime']);
  assert.deepEqual(trays[8], ['tComb', 'tTime', 'tRadar']);
  // tool buttons do what they say
  const before = await page.evaluate(() => __mm.G.timeLeft);
  await page.click('#tTime');
  assert.ok(await page.evaluate(b => __mm.G.timeLeft > b + 19, before), '시간+20 adds 20 seconds');
  await page.waitForFunction(() => document.getElementById('tTime').disabled, null, { timeout: 2000 }); // hourglass works only once
  await page.click('#tComb');
  assert.ok(await page.evaluate(() => __mm.G.comb > 0));
  await ctx.close();
});

test('after a clear: dance home, next morning, and DAY 2 at 우기네 집', async () => {
  const { page, ctx, errors } = await open();
  // stage 1, but with tweezers precision: this test is about the day flow, and with
  // bare hands a random layout can leave no white hair without black neighbours
  await page.evaluate(() => { __mm.startGame(0); __mm.G.tool = 1; __mm.G.score = 15; });
  await clickHair(page, true);
  await page.evaluate(() => { __mm.G.timeLeft = 0.3; });
  await page.waitForSelector('[data-a="out"]', { timeout: 5000 });
  await page.click('[data-a="out"]');
  await page.waitForSelector('#sOut.on');
  assert.equal(await page.evaluate(() => __mm.chars.mm.pose), 'dance');
  await page.waitForSelector('#sNext.on', { timeout: 60000 });
  assert.equal(await page.locator('#nextTitle').innerText(), 'DAY 2 아침');
  // 멍뭉이 wakes up alone, talks to himself, and a popup lets you send him to 우기네
  assert.equal(await page.evaluate(() => __mm.chars.wg.root.visible), false, '우기 is not in his room');
  await page.waitForFunction(() => /우기 집으로 가볼까/.test(document.getElementById('sleepBubble').textContent), null, { timeout: 30000 });
  await page.waitForSelector('#goChoice.on', { timeout: 30000 });
  assert.equal((await page.locator('#btnNextDay').innerText()).trim(), '우기 집으로 가기');
  await page.click('#btnNextDay');
  await page.waitForSelector('#sRoom.on', { timeout: 40000 });
  assert.match(await page.locator('#dayTag').innerText(), /DAY 2/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('clearing stage 10 shows the ending', async () => {
  const { page, ctx, errors } = await open();
  // this test is about the ending, not aiming: hold stage 10's fidgeting head still
  await page.evaluate(() => { __mm.startGame(9); __mm.G.score = 15; __mm.G.P.sway = 0; });
  await clickHair(page, true);
  await page.evaluate(() => { __mm.G.timeLeft = 0.3; });
  await page.waitForSelector('[data-a="out"]', { timeout: 5000 });
  await page.click('[data-a="out"]');
  await page.waitForSelector('#sEnd.on', { timeout: 60000 });
  assert.match(await page.locator('#sEnd h1').innerText(), /흰머리 정복 완료/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('tools show up in 3D when you use them', async () => {
  const { page, ctx, errors } = await open();
  const kinds = {};
  for (const i of [0, 1, 6, 9]) { await page.evaluate(i => __mm.startGame(i), i); await page.waitForTimeout(300); kinds[i] = await page.evaluate(() => __mm.toolRig.visible && __mm.toolRig.children[0]?.name); }
  assert.deepEqual(kinds, { 0: 'hand', 1: 'silver', 6: 'electric', 9: 'gold' }, 'hand, tweezers, electric and golden tweezers');
  assert.deepEqual(await page.evaluate(() => __mm.passive), { hairpin: true, lantern: true }, 'hairpin and head lantern are on');
  await page.evaluate(() => __mm.startGame(8));
  for (const [btn, name] of [['#tComb', 'comb'], ['#tTime', 'hourglass'], ['#tRadar', 'radar']]) {
    await page.click(btn);
    assert.ok(await page.evaluate(n => __mm.toolFx.includes(n), name), `${name} appears`);
  }
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('멍뭉이 goes home a different way each stage', async () => {
  const { page, ctx } = await open();
  const home = await page.evaluate(() => __mm.HOME.map(h => h.cap + '|' + h.pose + '|' + (h.face || '')));
  assert.equal(home.length, 10);
  assert.equal(new Set(home).size, 10, 'ten different ways home');
  await page.evaluate(() => { __mm.playOut(6); });
  await page.waitForFunction(() => __mm.chars.mm.pose === 'moonwalk', null, { timeout: 20000 });
  assert.match(await page.locator('#outCap').innerText(), /문워크/);
  await ctx.close();
});

test('dragging rotates the head instead of plucking', async () => {
  const { page, ctx, errors } = await open();
  await page.evaluate(() => __mm.startGame(1));
  const before = await page.evaluate(() => ({ yaw: __mm.G.yawT, n: __mm.G.hairs.length }));
  await page.mouse.move(200, 420); await page.mouse.down(); await page.mouse.move(320, 400, { steps: 8 }); await page.mouse.up();
  const after = await page.evaluate(() => ({ yaw: __mm.G.yawT, n: __mm.G.hairs.length, score: __mm.G.score }));
  assert.ok(Math.abs(after.yaw - before.yaw) > .5, 'camera turned around the head');
  assert.equal(after.n, before.n, 'no strand was plucked by the drag');
  assert.equal(after.score, 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('mobile: plays with touch on a phone-sized screen', async () => {
  const { page, ctx, errors } = await open({ viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, 'no horizontal scroll');
  await page.evaluate(() => __mm.startGame(1));
  await clickHair(page, true, { touch: true });
  assert.equal(await page.evaluate(() => __mm.G.score), 5);
  assert.deepEqual(errors, []);
  await ctx.close();
});
