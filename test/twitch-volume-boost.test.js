const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// twitch-volume-boost.user.js の検証用ハーネス。
//
// Twitch のプレイヤーの入れ物を模したDOMへスクリプトを流し込み、
// ヘッドレスChromiumで次を確認する。
//   - 増幅（AnalyserNode で実際の振幅を測る）
//   - 自動再生ポリシー下で、操作前に経路へつながず無音にしないこと
//   - ホバーでスライダーが出る / Alt+↑↓0 / プレイヤーの作り直し / フルスクリーン
//
//   NODE_PATH=$(npm root -g) node test/twitch-volume-boost.test.js
//
// Twitch の実DOMや実際の配信（MSE）は再現していないため、
// これに通ることは実機で動くことを保証しない。

const SCRIPT = fs.readFileSync(
  process.env.SCRIPT_PATH || path.join(__dirname, '..', 'twitch-volume-boost.user.js'),
  'utf8'
);

// 実際の Twitch に近い入れ子（クラス名は既知のもの）
const HTML = `<!doctype html><meta charset="utf-8"><title>twitch-mock</title>
<style>
  body { margin: 0; background: #0e0e10; }
  .video-player { width: 640px; height: 360px; }
  .video-player__container { position: relative; width: 100%; height: 100%; }
  video { width: 100%; height: 100%; display: block; }
  .video-player__overlay { position: absolute; inset: 0; }
  #nameless { width: 640px; height: 360px; margin-top: 20px; }
  #nameless > div { position: relative; width: 100%; height: 100%; }
  .preview video { width: 200px; height: 112px; }
</style>
<body>
<div id="root">
  <div class="video-player" data-a-target="video-player">
    <div class="video-player__container" id="container">
      <video id="main" playsinline></video>
      <div class="video-player__overlay" id="overlay"></div>
    </div>
  </div>
  <div class="preview"><video id="preview" muted></video></div>
</div>
</body>`;

// 正弦波（振幅 AMP）の WAV を blob: URL にする。blob: なので MSE と同じ扱いになる
const PAGE_HELPERS = `
  window.__makeToneUrl = (amp) => {
    const rate = 48000, sec = 30, n = rate * sec;
    const buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
    const w = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true);
    dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * amp * 32767), true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  };

  // destination へつなぐ直前に AnalyserNode を挟み、出力の振幅を測れるようにする
  window.__analysers = [];
  window.__contexts = [];
  const OrigAC = window.AudioContext;
  window.AudioContext = class extends OrigAC {
    constructor(...a) { super(...a); window.__contexts.push(this); }
  };
  const origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (dest instanceof AudioDestinationNode) {
      const an = this.context.createAnalyser();
      an.fftSize = 2048;
      origConnect.call(this, an);
      window.__analysers.push(an);
    }
    return origConnect.call(this, dest, ...rest);
  };
  window.__peak = () => {
    const an = window.__analysers[window.__analysers.length - 1];
    if (!an) return null;
    const d = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(d);
    return d.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  };

  // GM_* の代役
  const store = {};
  window.__menu = {};
  window.GM_getValue = (k, d) => (k in store ? store[k] : d);
  window.GM_setValue = (k, v) => { store[k] = v; };
  window.GM_addValueChangeListener = () => {};
  window.GM_registerMenuCommand = (name, fn) => { window.__menu[name] = fn; };
  window.GM_info = { script: { version: 'test' } };
  window.GM_addStyle = (css) => { const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); };
  window.__store = store;
`;

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (!cond && extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newPage(browser, { storedBoost } = {}) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.route('https://www.twitch.tv/**', (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML })
  );
  await page.addInitScript(PAGE_HELPERS);
  await page.goto('https://www.twitch.tv/somechannel');
  if (storedBoost) {
    await page.evaluate((v) => { window.__store.twitchBoost = v; }, storedBoost);
  }
  await page.evaluate(() => {
    const v = document.getElementById('main');
    v.src = window.__makeToneUrl(0.1);
    v.loop = true;
    // 音付きの自動再生が拒まれたら、Twitch と同じくミュートで再生する
    return v.play().catch(() => { v.muted = true; return v.play(); });
  });
  await page.evaluate(SCRIPT);
  await sleep(500);
  return page;
}

const state = (page) =>
  page.evaluate(() => ({
    ctx: window.__contexts.map((c) => c.state),
    analysers: window.__analysers.length,
    peak: window.__peak(),
    label: document.querySelector('.tvb-label') && document.querySelector('.tvb-label').textContent,
    stored: window.__store.twitchBoost,
  }));

(async () => {
  const browser = await chromium.launch();

  // ===== 1. 保存値 ×2.00、操作前（自動再生ポリシーで AudioContext が止まっている） =====
  // 旧ヘッドレス（既定）は自動再生の制限が無いため、実際の Chrome と同じ制限がかかる
  // 新ヘッドレス（channel: 'chromium'）で起動する。
  // page.evaluate はユーザー操作として扱われるため、スクリプトの投入まで初期化スクリプトで行う
  {
    const strict = await chromium.launch({ channel: 'chromium' });
    const page = await strict.newPage({ viewport: { width: 1000, height: 900 } });
    page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
    await page.route('https://www.twitch.tv/**', (route) =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML })
    );
    await page.addInitScript(PAGE_HELPERS);
    await page.addInitScript(`
      window.__store.twitchBoost = 2;
      document.addEventListener('DOMContentLoaded', () => {
        const v = document.getElementById('main');
        v.src = window.__makeToneUrl(0.1);
        v.loop = true;
        v.muted = true; // Twitch と同じく、操作前はミュートで自動再生
        v.play();
        setTimeout(() => { (0, eval)(${JSON.stringify(SCRIPT)}); }, 300);
        // page.evaluate で読むと操作扱いになるので、操作前の様子はここで記録しておく
        setTimeout(() => {
          window.__pre = {
            ctx: window.__contexts.map((c) => c.state),
            analysers: window.__analysers.length,
            active: navigator.userActivation.hasBeenActive,
            playing: !v.paused,
          };
        }, 1200);
      });
    `);
    await page.goto('https://www.twitch.tv/somechannel');
    await sleep(1600);
    const pre = await page.evaluate(() => window.__pre);
    check('前提: 記録の時点でユーザー操作が無い', pre && pre.active === false, pre);
    let s = pre;
    check('操作前: video は再生している（素の経路のまま）', pre.playing, pre);
    check('操作前: 経路へつながない（無音にしない）', s.analysers === 0, s);
    check('操作前: AudioContext は suspended', s.ctx[0] === 'suspended', s);

    await page.mouse.click(900, 800); // プレイヤー外を押す（ユーザー操作）
    await page.evaluate(() => { document.getElementById('main').muted = false; }); // 操作後にミュート解除
    await sleep(800);
    s = await state(page);
    check('操作後: AudioContext が running', s.ctx[0] === 'running', s);
    check('操作後: 経路へつながる', s.analysers === 1, s);
    check('×2.00 で振幅がおよそ0.2（元0.1）', s.peak > 0.18 && s.peak < 0.22, s.peak);
    await strict.close();
  }

  // ===== 2. 既定値 ×1.00 から操作 =====
  const page = await newPage(browser);
  let s = await state(page);
  check('×1.00 のときは AudioContext を作らない', s.ctx.length === 0, s);
  check('メイン video にスライダーが付く', await page.evaluate(() => !!document.querySelector('#container > .tvb-panel')));
  check('小さいプレビュー video にはスライダーを付けない', await page.evaluate(() => document.querySelectorAll('.tvb-panel').length === 1));

  const opacity = () => page.evaluate(() => getComputedStyle(document.querySelector('.tvb-panel')).opacity);
  await page.mouse.move(900, 850);
  await sleep(300);
  check('ホバー外ではスライダーが見えない', (await opacity()) === '0');
  check('ホバー外ではスライダーがクリックを拾わない', await page.evaluate(() => getComputedStyle(document.querySelector('.tvb-panel')).pointerEvents === 'none'));
  await page.mouse.move(320, 200);
  await sleep(300);
  check('プレイヤー上のホバーでスライダーが見える', (await opacity()) === '1');

  // Alt+↑（操作なので AudioContext も起きる）
  await page.mouse.move(900, 850);
  await sleep(300);
  await page.keyboard.press('Alt+ArrowUp');
  await sleep(800);
  s = await state(page);
  check('Alt+↑ で ×1.25', s.label === '×1.25' && s.stored === 1.25, s);
  check('Alt+↑ で経路へつながる', s.analysers === 1 && s.ctx[0] === 'running', s);
  check('Alt+↑ の直後はホバー無しでもスライダーが見える', (await opacity()) === '1');
  await sleep(1400);
  check('しばらくすると隠れる', (await opacity()) === '0');

  for (let i = 0; i < 7; i++) await page.keyboard.press('Alt+ArrowUp');
  await sleep(500);
  s = await state(page);
  check('Alt+↑ を重ねて ×3.00', s.label === '×3.00', s);
  check('×3.00 で振幅がおよそ0.3', s.peak > 0.27 && s.peak < 0.33, s.peak);

  for (let i = 0; i < 20; i++) await page.keyboard.press('Alt+ArrowUp');
  s = await state(page);
  check('上限 ×5.00 で止まる', s.label === '×5.00', s);
  await sleep(500);
  s = await state(page);
  check('×5.00（振幅0.5）でもリミッターで1.0を超えない', s.peak > 0.3 && s.peak <= 1.0, s.peak);

  await page.keyboard.press('Alt+ArrowDown');
  s = await state(page);
  check('Alt+↓ で ×4.75', s.label === '×4.75', s);

  // macOS の Option+0 は key が「º」。code で判定していることを確認
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'º', code: 'Digit0', altKey: true, bubbles: true }));
  });
  s = await state(page);
  check('Alt+0（mac の Option+0 = key「º」）で ×1.00', s.label === '×1.00', s);
  for (let i = 0; i < 4; i++) await page.keyboard.press('Alt+ArrowUp');

  // 文字入力欄では効かない
  await page.evaluate(() => {
    const t = document.createElement('textarea');
    t.id = 'chat';
    document.body.appendChild(t);
  });
  await page.focus('#chat');
  await page.keyboard.press('Alt+ArrowUp');
  s = await state(page);
  check('チャット欄では Alt+↑ が効かない', s.label === '×2.00', s);
  await page.evaluate(() => document.activeElement.blur());

  // スライダーを押した後もキーが効く
  await page.mouse.move(320, 200);
  await sleep(300);
  await page.focus('.tvb-panel input');
  await page.keyboard.press('Alt+ArrowUp');
  s = await state(page);
  check('スライダーにフォーカスがあっても Alt+↑ が効く', s.label === '×2.25', s);

  // スライダーの操作
  await page.evaluate(() => {
    const r = document.querySelector('.tvb-panel input');
    r.value = '3.5';
    r.dispatchEvent(new Event('input', { bubbles: true }));
  });
  s = await state(page);
  check('スライダーで ×3.50 になり保存される', s.label === '×3.50' && s.stored === 3.5, s);

  // スライダーのクリックが Twitch（一時停止の処理）に届かない
  const leaked = await page.evaluate(() => {
    let n = 0;
    document.getElementById('container').addEventListener('click', () => n++);
    document.querySelector('.tvb-panel input').click();
    return n;
  });
  check('スライダーのクリックがプレイヤーへ伝わらない', leaked === 0, leaked);

  // メニュー
  await page.evaluate(() => window.__menu['音量ブースト リセット']());
  s = await state(page);
  check('メニュー「リセット」で ×1.00', s.label === '×1.00', s);
  await page.evaluate(() => window.__menu['音量ブースト +0.25']());
  s = await state(page);
  check('メニュー「+0.25」で ×1.25', s.label === '×1.25', s);
  await page.evaluate(() => { window.__menu['音量ブースト +0.25'](); window.__menu['音量ブースト +0.25'](); window.__menu['音量ブースト -0.25'](); });
  s = await state(page);
  check('メニュー「-0.25」で ×1.50', s.label === '×1.50', s);

  // 診断
  const diag = await page.evaluate(() => {
    const out = [];
    const orig = console.log;
    console.log = (...a) => out.push(a.join(' '));
    window.__tmTwitchVolumeBoost.dump();
    console.log = orig;
    window.__tmTwitchVolumeBoost.set(2);
    const text = out.find((x) => x.includes('診断')) || '';
    const parsed = JSON.parse(text.slice(text.indexOf('{')));
    return { rows: parsed.videos, report: parsed, label: document.querySelector('.tvb-label').textContent };
  });
  const mainRow = diag.rows && diag.rows.find((r) => r.size === '640x360');
  check('__tmTwitchVolumeBoost.dump() が video ごとの状態を文字（JSON）で出す',
    mainRow && mainRow.hooked === 'yes' && mainRow.matchedSelector === '.video-player__container' &&
    typeof mainRow.gain === 'number' && mainRow.ancestors[0].startsWith('div.video-player__container'), diag.rows);
  check('__tmTwitchVolumeBoost.set(2) で ×2.00', diag.label === '×2.00', diag.label);
  await page.evaluate(() => window.__tmTwitchVolumeBoost.set(1.5));

  // ===== プレイヤーの作り直し（配信の切り替え） =====
  await page.evaluate(() => {
    const old = document.querySelector('.video-player');
    const wrap = document.createElement('div');
    wrap.className = 'video-player';
    wrap.innerHTML = '<div class="video-player__container" id="container2"><video id="main2"></video></div>';
    old.replaceWith(wrap);
    const v = document.getElementById('main2');
    v.src = window.__makeToneUrl(0.1);
    v.loop = true;
    return v.play();
  });
  await sleep(1000);
  s = await state(page);
  check('作り直した video にもスライダーが付く', await page.evaluate(() => !!document.querySelector('#container2 > .tvb-panel')));
  check('作り直した video も経路へつながる', s.analysers === 2, s);
  check('作り直した video も ×1.50 で振幅およそ0.15', s.peak > 0.135 && s.peak < 0.165, s.peak);

  // 同じ video を別の入れ物へ移す（Twitch が video を使い回す場合）
  await page.evaluate(() => {
    const v = document.getElementById('main2');
    const wrap = document.createElement('div');
    wrap.className = 'video-player__container';
    wrap.id = 'container3';
    wrap.style.cssText = 'position:relative;width:640px;height:360px';
    document.getElementById('root').appendChild(wrap);
    wrap.appendChild(v);
    return v.play();
  });
  await sleep(800);
  check('video を別の入れ物へ移すとスライダーも付いてくる', await page.evaluate(() => !!document.querySelector('#container3 > .tvb-panel')));

  // ===== 既知のクラス名が無いプレイヤー（大きさで推定） =====
  await page.evaluate(() => {
    const box = document.createElement('div');
    box.id = 'nameless';
    box.innerHTML = '<div id="inner"><video id="v3"></video></div>';
    document.getElementById('root').appendChild(box);
  });
  await sleep(800);
  check('クラス名が無くても video と同じ大きさの入れ物に付く', await page.evaluate(() => !!document.querySelector('#nameless > .tvb-panel, #inner > .tvb-panel')));
  await page.evaluate(() => document.getElementById('nameless').remove());

  // ===== フルスクリーン =====
  // Twitch はプレイヤー全体（入れ物より外側）を全画面にすることがあるため、外側で試す
  await page.evaluate(() => {
    const outer = document.createElement('div');
    outer.id = 'fsouter';
    outer.style.cssText = 'width:640px;height:360px';
    const v = document.getElementById('main2');
    outer.appendChild(v); // 入れ物クラスを持たない外側に video を直接置く
    document.getElementById('root').appendChild(outer);
  });
  await sleep(600);
  await page.click('#fsouter', { position: { x: 10, y: 350 } }).catch(() => {});
  await page.evaluate(() => document.getElementById('fsouter').requestFullscreen());
  await sleep(800);
  const fsInfo = await page.evaluate(() => {
    const fs = document.fullscreenElement;
    const p = document.querySelector('#main2') && [...document.querySelectorAll('.tvb-panel')].find((x) => fs && fs.contains(x));
    return { fs: fs && fs.id, panelInside: !!p };
  });
  check('フルスクリーン中、全画面の要素の中にスライダーがある', fsInfo.fs === 'fsouter' && fsInfo.panelInside, fsInfo);
  await page.mouse.move(400, 300);
  await sleep(300);
  check('フルスクリーン中もホバーで見える', await page.evaluate(() => {
    const p = [...document.querySelectorAll('.tvb-panel')].find((x) => document.fullscreenElement.contains(x));
    return getComputedStyle(p).opacity === '1';
  }));
  await page.evaluate(() => document.exitFullscreen());
  await sleep(300);

  await page.close();

  // ===== 3. blob: でない src（iOS のネイティブHLS相当）はつながない =====
  {
    const p = await browser.newPage();
    await p.route('https://www.twitch.tv/**', (route) => {
      if (route.request().url().endsWith('.wav')) {
        return route.fulfill({ status: 404, body: '' });
      }
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML });
    });
    await p.addInitScript(PAGE_HELPERS);
    await p.goto('https://www.twitch.tv/x');
    await p.evaluate(() => {
      window.__store.twitchBoost = 2;
      document.getElementById('main').src = 'https://cdn.example.invalid/stream.m3u8';
    });
    await p.evaluate(SCRIPT);
    await p.mouse.click(900, 800);
    await sleep(800);
    const r = await p.evaluate(() => window.__analysers.length);
    check('blob: でない src の video は経路へつながない', r === 0, r);
    await p.close();
  }

  // ===== 4. 現行の Twitch と同じく、src が空で srcObject で再生している =====
  // Amazon IVS Player はワーカーの MediaSource を srcObject（MediaSourceHandle）で渡すため、
  // src / currentSrc は空になる（実機の診断で確認）
  {
    const p = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
    await p.route('https://www.twitch.tv/**', (route) =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML })
    );
    await p.addInitScript(PAGE_HELPERS);
    await p.goto('https://www.twitch.tv/somechannel');
    await p.evaluate(async () => {
      const v = document.getElementById('main');
      v.src = window.__makeToneUrl(0.1);
      v.loop = true;
      await v.play();
      class MediaSourceHandle {}
      const handle = new MediaSourceHandle();
      Object.defineProperty(v, 'currentSrc', { get: () => '' });
      Object.defineProperty(v, 'src', { get: () => '', set: () => {} });
      Object.defineProperty(v, 'srcObject', { get: () => handle, set: () => {} });
    });
    await p.evaluate(SCRIPT);
    await sleep(400);
    for (let i = 0; i < 4; i++) await p.keyboard.press('Alt+ArrowUp');
    await sleep(800);
    const r = await state(p);
    check('src が空で srcObject 再生の video もつながる（現行 Twitch）', r.analysers === 1 && r.label === '×2.00', r);
    check('srcObject 再生の video も ×2.00 で振幅およそ0.2', r.peak > 0.18 && r.peak < 0.22, r.peak);
    await p.close();
  }

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
