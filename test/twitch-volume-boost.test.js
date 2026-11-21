const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// twitch-volume-boost.user.js の検証用ハーネス。
//
// Twitch のプレイヤー（操作バー・ミュートボタン・音量バー）を模したDOMに
// 正弦波の音を流す <video> を置き、スクリプトを流し込んで
// 「バーの長さ・つまみの位置・Twitch の音量」と「実際に出ていく音の大きさ」（AnalyserNode）を測る。
//
//   NODE_PATH=$(npm root -g) node test/twitch-volume-boost.test.js
//
// 模擬DOMのうち実機で確認済みなのは、.video-player__container、
// 音量バー input#player-volume-slider-<毎回変わる> と、その入れ物 .volume-slider__slider-container、
// video の src が空で srcObject から再生していること（2026-11 の診断）。
// それ以外（ミュートボタンの data-a-target、音量バーの min/max、開き方）は推測。
// これに通ることは実機で動くことを保証しない。

const SCRIPT = fs.readFileSync(
  process.env.SCRIPT_PATH || path.join(__dirname, '..', 'twitch-volume-boost.user.js'),
  'utf8'
);

// 音量バーの入れ物は、ふだんは幅 0 で、音量欄にマウスを乗せると 100px に開く
const PLAYER_HTML = (id, opts = {}) => `
<div class="video-player" data-a-target="video-player" id="vp-${id}" style="width:1000px;height:562px;">
  <div class="Layout video-player__container" id="pc-${id}" style="position:relative;width:100%;height:100%;background:#000;">
    <video id="v-${id}" style="width:100%;height:100%;display:block;"></video>
    <div class="player-controls" style="position:absolute;left:0;right:0;bottom:0;height:40px;">
      <div class="player-controls__left-control-group" id="left-${id}" style="display:flex;align-items:center;height:40px;">
        <button data-a-target="player-play-pause-button" style="width:30px;height:30px;">▶</button>
        <div class="volume-group" id="vg-${id}" style="display:flex;align-items:center;height:30px;">
          <button data-a-target="player-mute-unmute-button" id="mute-${id}" style="width:30px;height:30px;">🔊</button>
          ${opts.noSlider ? '' : `<div class="volume-slider__slider-container" id="sc-${id}">
            <input type="range" class="tw-range" id="player-volume-slider-${id}-6b45" min="0" max="1" step="0.01" value="1"
                   style="width:100%;margin:0;">
          </div>`}
        </div>
      </div>
    </div>
  </div>
</div>`;

const HTML = `<!doctype html><meta charset="utf-8"><title>twitch-mock</title>
<style>
  body { margin: 0; background: #0e0e10; }
  .volume-slider__slider-container { width: 0; overflow: hidden; transition: width .05s; }
  .volume-group:hover .volume-slider__slider-container { width: 100px; }
  .preview video { width: 200px; height: 112px; }
</style>
<body>
<div id="root">
  ${PLAYER_HTML('a')}
  <div class="preview"><div class="video-player__container"><video id="preview" muted></video></div></div>
  <textarea id="chat" style="width:300px;height:40px;"></textarea>
</div>
</body>`;

// Twitch の動き（React）を真似る: 音量バーの input で video.volume を変え、
// ミュートボタンで video.muted を切り替え、video 側の変化で音量バーを描き直す
const TWITCH_BEHAVIOR = `
  window.__wireTwitch = (id) => {
    const input = document.getElementById('player-volume-slider-' + id + '-6b45');
    const video = document.getElementById('v-' + id);
    const mute = document.getElementById('mute-' + id);
    window.__twitchInputEvents = window.__twitchInputEvents || 0;
    if (input) {
      input.addEventListener('input', () => {
        window.__twitchInputEvents++;
        video.volume = Number(input.value);
      });
      video.addEventListener('volumechange', () => {
        if (Math.abs(Number(input.value) - video.volume) > 1e-6) input.value = String(video.volume);
      });
    }
    mute.addEventListener('click', () => { video.muted = !video.muted; });
  };
`;

// 正弦波（振幅 amp）の WAV を blob: URL にする
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

  // 現行の Twitch と同じく、src を空に見せ、srcObject（MediaSourceHandle）から再生しているように見せる
  window.__startTone = (id, amp) => {
    const v = document.getElementById(id);
    v.src = window.__makeToneUrl(amp);
    v.loop = true;
    class MediaSourceHandle {}
    const handle = new MediaSourceHandle();
    Object.defineProperty(v, 'currentSrc', { get: () => '' });
    Object.defineProperty(v, 'src', { get: () => '', set: () => {} });
    Object.defineProperty(v, 'srcObject', { get: () => handle, set: () => {} });
    return v.play().catch(() => { v.muted = true; return v.play(); });
  };

  // スピーカー（destination）へつなぐ直前に AnalyserNode を挟み、出ていく音を測る
  window.__contexts = [];
  window.__mesCount = 0;
  const OrigAC = window.AudioContext;
  window.AudioContext = class extends OrigAC {
    constructor(...a) { super(...a); window.__contexts.push(this); }
  };
  const origMes = OrigAC.prototype.createMediaElementSource;
  OrigAC.prototype.createMediaElementSource = function (el) { window.__mesCount++; return origMes.call(this, el); };
  const origConnect = AudioNode.prototype.connect;
  window.__analysers = [];
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (dest instanceof AudioDestinationNode) {
      const an = this.context.createAnalyser();
      an.fftSize = 2048;
      origConnect.call(this, an);
      window.__analysers.push(an);
    }
    return origConnect.call(this, dest, ...rest);
  };
  // いまつながっている出口（リミッター経由か直接か）の和を測る
  window.__peak = () => {
    let peak = 0;
    for (const an of window.__analysers) {
      const d = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(d);
      for (const v of d) peak = Math.max(peak, Math.abs(v));
    }
    return peak;
  };

  // GM_* の代役
  window.__store = window.__store || {};
  window.__menu = {};
  window.GM_getValue = (k, d) => (k in window.__store ? window.__store[k] : d);
  window.GM_setValue = (k, v) => { window.__store[k] = v; };
  window.GM_addValueChangeListener = () => {};
  window.GM_registerMenuCommand = (name, fn) => { window.__menu[name] = fn; };
  window.GM_addStyle = (css) => { const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); };
  window.GM_info = { script: { version: 'test' } };
`;

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (!cond && extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openPage(browser, { store, html, amp = 0.1 } = {}) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.route('https://www.twitch.tv/**', (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: html || HTML })
  );
  if (store) {
    await page.addInitScript((s) => { window.__store = s; }, store);
  }
  await page.addInitScript(PAGE_HELPERS + TWITCH_BEHAVIOR);
  await page.goto('https://www.twitch.tv/somechannel');
  await page.evaluate((amp) => { window.__wireTwitch('a'); return window.__startTone('v-a', amp); }, amp);
  await page.evaluate(SCRIPT);
  await sleep(400);
  return page;
}

const st = (page) =>
  page.evaluate(() => {
    const w = document.querySelector('.tm-twvb');
    const v = document.getElementById('v-a') || document.querySelector('video');
    const input = document.querySelector('input[id^="player-volume-slider"]');
    return {
      label: w && w.querySelector('.tm-twvb-label').textContent,
      knob: w && parseFloat(w.querySelector('.tm-twvb-knob').style.left),
      volume: v && Math.round(v.volume * 100) / 100,
      muted: v && v.muted,
      input: input && Number(input.value),
      ctx: window.__contexts.map((c) => c.state),
      mes: window.__mesCount,
      peak: window.__peak(),
      store: window.__store,
    };
  });

(async () => {
  const browser = await chromium.launch();

  // ===== 1. 設置と見た目 =====
  let page = await openPage(browser);
  let s;

  const layout = await page.evaluate(() => {
    const w = document.querySelector('.tm-twvb');
    const sc = document.getElementById('sc-a');
    return {
      afterSlider: !!w && sc.nextElementSibling === w,
      hidden: sc.hasAttribute('data-tm-twvb-replaced'),
      hiddenVisibility: getComputedStyle(sc).visibility,
      host: w && w.parentElement.hasAttribute('data-tm-twvb-host'),
      count: document.querySelectorAll('.tm-twvb').length,
      oldPanel: document.querySelectorAll('.tvb-panel').length,
    };
  });
  check('バーが Twitch の音量バー（.volume-slider__slider-container）の直後に付く', layout.afterSlider, layout);
  check('Twitch の音量バーは隠す（消さずに visibility: hidden）', layout.hidden && layout.hiddenVisibility === 'hidden', layout);
  check('バーは1本だけ（プレビューのプレイヤーには付けない）', layout.count === 1, layout);
  check('v1.0 の左上のスライダーは出さない', layout.oldPanel === 0, layout);

  const trackWidth = () => page.evaluate(() => document.querySelector('.tm-twvb-track').getBoundingClientRect().width);
  await page.mouse.move(600, 100);
  await sleep(300);
  check('ふだんはバーが閉じている（幅 0）', (await trackWidth()) === 0);
  await page.hover('#mute-a');
  await sleep(500);
  const openWidth = await trackWidth();
  // 音量バーの実測 100px → つまみの動く長さ 88px × 6 = 528px。プレイヤー幅 1000px の 30% = 300px に縮む → 300 + 12
  check('音量欄にマウスを乗せるとバーが開き、プレイヤー幅の30%（+つまみ）に収まる', Math.abs(openWidth - 312) <= 1, openWidth);
  s = await st(page);
  check('初期は 100%（Twitch の音量 100%）', s.label === '100%', s);

  const scale = await page.evaluate(() => {
    const knob = (v) => { window.__tmTwitchVolumeBoost.set(v); return parseFloat(document.querySelector('.tm-twvb-knob').style.left); };
    const r = { p25: knob(25), p50: knob(50), p100: knob(100) };
    return r;
  });
  check('目盛りは対数: 0〜100% がバーの約 2/3', scale.p100 > 63 && scale.p100 < 70, scale);
  check('目盛りは対数: 25→50 と 50→100 が同じ長さ', Math.abs((scale.p50 - scale.p25) - (scale.p100 - scale.p50)) < 0.5, scale);

  // ===== 2. 0〜100% は Twitch の音量、音声に触らない =====
  await page.evaluate(() => window.__tmTwitchVolumeBoost.set(40));
  await sleep(200);
  s = await st(page);
  check('40% で Twitch の音量バーが 0.4 になり、video.volume も 0.4', s.input === 0.4 && s.volume === 0.4, s);
  check('Twitch の音量バーへ input イベントを送っている（React に伝わる）', await page.evaluate(() => window.__twitchInputEvents > 0));
  check('100% 以下では AudioContext を作らない・動画をつながない', s.ctx.length === 0 && s.mes === 0, s);
  check('ラベルは 40%', s.label === '40%', s);

  // ===== 3. 100% 超で増幅 =====
  await page.evaluate(() => window.__tmTwitchVolumeBoost.set(300));
  await sleep(700);
  s = await st(page);
  check('300% で Twitch の音量は 100% にそろう', s.input === 1 && s.volume === 1, s);
  check('300% で動画をつなぐ（src が空の srcObject 再生でも）', s.mes === 1 && s.ctx[0] === 'running', s);
  check('300% で振幅およそ 0.3（元 0.1、実際に 3 倍）', s.peak > 0.28 && s.peak < 0.32, s.peak);
  check('300% は保存される（GM_setValue）', s.store.boostPercent === 300, s.store);
  check('100% 超はラベルがオレンジ', await page.evaluate(() => document.querySelector('.tm-twvb').classList.contains('tm-twvb-boosted')));

  await page.evaluate(() => window.__tmTwitchVolumeBoost.set(100));
  await sleep(700);
  s = await st(page);
  check('100% に戻すと振幅も元どおり 0.1', s.peak > 0.09 && s.peak < 0.11, s.peak);
  await page.evaluate(() => window.__tmTwitchVolumeBoost.set(40));
  await sleep(700);
  s = await st(page);
  check('つないだ後の 40% は Twitch の音量で 0.4 倍', s.peak > 0.035 && s.peak < 0.045, s.peak);

  // ===== 4. ドラッグ =====
  await page.hover('#mute-a');
  await sleep(300);
  const box = await page.evaluate(() => {
    const r = document.querySelector('.tm-twvb-track').getBoundingClientRect();
    return { x: r.left, y: r.top + r.height / 2, w: r.width };
  });
  const xOf = (pos) => box.x + 6 + (box.w - 12) * pos;
  await page.mouse.move(xOf(1), box.y);
  await page.mouse.down();
  await sleep(100);
  s = await st(page);
  check('右端を押すと 600%', s.label === '600%', s);
  await page.mouse.move(xOf(0.85), box.y, { steps: 5 });
  await sleep(100);
  s = await st(page);
  const mid = s.label;
  await page.mouse.move(xOf(0.4), box.y, { steps: 5 });
  await page.mouse.up();
  await sleep(300);
  s = await st(page);
  check('つまみ1つのまま 600% → 300% 前後 → 100% 未満へドラッグできる',
    parseInt(mid) > 200 && parseInt(mid) < 400 && parseInt(s.label) < 100, { mid, end: s.label });
  check('ドラッグで 100% 未満に戻すと Twitch の音量が下がる', s.input < 1 && s.input > 0, s);

  // 100% への吸い付き
  await page.mouse.move(xOf(0.665), box.y);
  await page.mouse.down();
  await page.mouse.up();
  await sleep(200);
  s = await st(page);
  check('100% の近くを押すと 100% に吸い付く', s.label === '100%', s);

  // ===== 5. ホイール・←→・Home/End・ダブルクリック =====
  await page.mouse.move(xOf(0.5), box.y);
  await page.mouse.wheel(0, -100);
  await sleep(100);
  s = await st(page);
  check('ホイール上で 100% → 110%', s.label === '110%', s);
  await page.mouse.wheel(0, 100);
  await page.mouse.wheel(0, 100);
  await sleep(100);
  s = await st(page);
  check('ホイール下で 110% → 100% → 95%（100% 以下は 5% 刻み）', s.label === '95%', s);

  await page.focus('.tm-twvb');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  s = await st(page);
  check('バーにフォーカスして → で 95 → 100 → 110%', s.label === '110%', s);
  await page.keyboard.press('End');
  s = await st(page);
  check('End で 600%', s.label === '600%', s);
  await page.keyboard.press('Home');
  s = await st(page);
  check('Home で 0%', s.label === '0%' && s.input === 0, s);
  await page.evaluate(() => document.activeElement.blur());

  await page.hover('#mute-a');
  await sleep(200);
  await page.mouse.dblclick(xOf(0.2), box.y);
  await sleep(200);
  s = await st(page);
  check('バーのダブルクリックで 100% に戻る', s.label === '100%', s);
  check('バーのクリックはプレイヤー（一時停止）へ伝わらない', await page.evaluate(() => {
    let n = 0;
    const c = document.getElementById('pc-a');
    const f = () => n++;
    c.addEventListener('click', f);
    document.querySelector('.tm-twvb-track').click();
    c.removeEventListener('click', f);
    return n === 0;
  }));

  // ===== 6. ↑↓ キー（YouTube 版と同じ: プレイヤーを操作しているとき） =====
  await page.mouse.move(500, 200); // プレイヤーの上
  await sleep(200);
  await page.keyboard.press('ArrowUp');
  await sleep(100);
  s = await st(page);
  check('プレイヤーの上で ↑ を押すと 100% → 110%', s.label === '110%', s);
  check('↑ で画面に「音量 110%」が出る', await page.evaluate(() => {
    const t = document.querySelector('.tm-twvb-toast');
    return !!t && t.textContent === '音量 110%' && t.classList.contains('tm-twvb-show');
  }));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await sleep(100);
  s = await st(page);
  check('↓ で 110 → 100 → 95%（Twitch の音量が下がる）', s.label === '95%' && s.input === 0.95, s);
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowUp');
  s = await st(page);
  check('↑ で 95 → 100 → 110 → 120%', s.label === '120%', s);

  await page.mouse.move(1100, 800); // プレイヤーの外
  await sleep(100);
  await page.keyboard.press('ArrowUp');
  s = await st(page);
  check('プレイヤーの外では ↑ を横取りしない（ページのスクロールに任せる）', s.label === '120%', s);

  await page.focus('#chat');
  await page.mouse.move(500, 200);
  await page.keyboard.press('ArrowUp');
  s = await st(page);
  check('チャット欄に入力中は ↑ を横取りしない', s.label === '120%', s);
  await page.evaluate(() => document.activeElement.blur());

  await page.keyboard.press('Alt+ArrowUp');
  s = await st(page);
  check('Alt+↑ は使わない（v1.0 のキーは廃止）', s.label === '120%', s);

  // ===== 7. Twitch 側の操作との連動 =====
  await page.evaluate(() => {
    const input = document.querySelector('input[id^="player-volume-slider"]');
    input.value = '0.5';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(700);
  s = await st(page);
  check('増幅中に Twitch 側で音量を 50% に下げると、増幅を外して 50%', s.label === '50%' && s.store.boostPercent === 100, s);

  await page.click('#mute-a');
  await sleep(200);
  s = await st(page);
  check('Twitch 側でミュートすると、つまみが 0 で「ミュート」', s.label === 'ミュート' && s.knob === 0, s);
  await page.evaluate(() => window.__tmTwitchVolumeBoost.set(200));
  await sleep(500);
  s = await st(page);
  check('ミュート中に 200% にすると、ミュートを解いて増幅', !s.muted && s.label === '200%' && s.input === 1, s);

  // ===== 8. きれい／大きく =====
  await page.close();
  page = await openPage(browser, { amp: 0.5 });
  await page.evaluate(() => window.__tmTwitchVolumeBoost.set(600));
  await sleep(800);
  s = await st(page);
  check('きれい（リミッターあり）: 振幅 0.5 × 600% でも 1 前後に収まる', s.peak > 0.8 && s.peak < 1.15, s.peak);
  await page.hover('#mute-a');
  await sleep(300);
  await page.click('.tm-twvb-track', { button: 'right' });
  await sleep(800);
  s = await st(page);
  check('バーの右クリックで「大きく」になり、数字に ! が付く', s.label === '600%!' && s.store.limiterOn === false, s);
  check('大きく（リミッターなし）: 振幅 0.5 × 600% が 3.0 まで出る', s.peak > 2.8 && s.peak < 3.2, s.peak);
  check('右クリックで「大きく」の説明が出る', await page.evaluate(() => document.querySelector('.tm-twvb-toast').textContent.startsWith('大きく')));
  await page.click('.tm-twvb-label');
  await sleep(300);
  s = await st(page);
  check('数字のクリックで「きれい」に戻る', s.label === '600%' && s.store.limiterOn === true, s);

  // ===== 9. 配信の切り替え（プレイヤーの作り直し）・音量バーだけの作り直し =====
  await page.evaluate(() => window.__tmTwitchVolumeBoost.set(200));
  await page.evaluate(() => document.getElementById('vp-a').remove());
  await page.evaluate((html) => {
    const t = document.createElement('template');
    t.innerHTML = html;
    document.getElementById('root').prepend(t.content);
    window.__wireTwitch('b');
    return window.__startTone('v-b', 0.1);
  }, PLAYER_HTML('b'));
  await sleep(900);
  const sw = await page.evaluate(() => ({
    mounted: document.getElementById('sc-b').nextElementSibling === document.querySelector('.tm-twvb'),
    hidden: document.getElementById('sc-b').hasAttribute('data-tm-twvb-replaced'),
    mes: window.__mesCount,
    peak: window.__peak(),
  }));
  check('作り直したプレイヤーにバーが付き直し、新しい音量バーを隠す', sw.mounted && sw.hidden, sw);
  check('作り直したプレイヤーの動画もつなぎ、200% で振幅およそ 0.2', sw.mes === 2 && sw.peak > 0.18 && sw.peak < 0.22, sw);

  await page.evaluate(() => {
    const old = document.getElementById('sc-b');
    const neu = old.cloneNode(true);
    neu.removeAttribute('data-tm-twvb-replaced');
    neu.id = 'sc-b2';
    old.replaceWith(neu);
  });
  await sleep(600);
  const re = await page.evaluate(() => ({
    mounted: document.getElementById('sc-b2').nextElementSibling === document.querySelector('.tm-twvb'),
    hidden: document.getElementById('sc-b2').hasAttribute('data-tm-twvb-replaced'),
  }));
  check('Twitch の音量バーだけ作り直されても、隣に付き直して隠し直す', re.mounted && re.hidden, re);

  // ===== 10. フルスクリーン =====
  await page.evaluate(() => document.getElementById('pc-b').requestFullscreen());
  await sleep(500);
  check('フルスクリーン中もバーは全画面の要素の中にある', await page.evaluate(() =>
    document.fullscreenElement && document.fullscreenElement.contains(document.querySelector('.tm-twvb'))));
  await page.mouse.move(600, 400);
  await page.keyboard.press('ArrowUp');
  await sleep(100);
  check('フルスクリーン中も ↑ が効き、「音量」表示が全画面の中に出る', await page.evaluate(() => {
    const t = document.querySelector('.tm-twvb-toast');
    return document.fullscreenElement.contains(t) && t.textContent === '音量 210%';
  }));
  await page.evaluate(() => document.exitFullscreen());
  await sleep(300);

  // ===== 11. 診断 =====
  const diag = await page.evaluate(() => {
    const out = [];
    const orig = console.log;
    console.log = (...a) => out.push(a.join(' '));
    window.__tmTwitchVolumeBoost.dump();
    console.log = orig;
    const text = out.find((x) => x.includes('診断')) || '';
    return JSON.parse(text.slice(text.indexOf('{')));
  });
  check('dump() が文字（JSON）で状態を出す（コピーして貼れる）',
    diag.state.形.startsWith('1本のバー') && diag.state.Twitchの音量バー.includes('player-volume-slider') &&
    diag.videos.some((v) => v.再生元 === 'srcObject:MediaSourceHandle' && v.つないだ === 'はい'), diag);
  await page.close();

  // ===== 12. Twitch の音量バーが見つからない → 延長部分（100〜600%）だけ =====
  page = await openPage(browser, { html: HTML.replace(PLAYER_HTML('a'), PLAYER_HTML('a', { noSlider: true })) });
  const ext = await page.evaluate(() => {
    const w = document.querySelector('.tm-twvb');
    return {
      afterMute: !!w && document.getElementById('mute-a').nextElementSibling === w,
      unified: w && w.classList.contains('tm-twvb-unified'),
    };
  });
  check('音量バーが無ければミュートボタンの直後に延長部分（100〜600%）だけ付く', ext.afterMute && ext.unified === false, ext);
  await page.evaluate(() => window.__tmTwitchVolumeBoost.set(250));
  await sleep(700);
  s = await st(page);
  check('延長部分だけでも 250% で振幅およそ 0.25', s.peak > 0.23 && s.peak < 0.27, s.peak);
  await page.close();

  // ===== 13. v1.0.x の保存値（倍率）を引き継ぐ =====
  page = await openPage(browser, { store: { twitchBoost: 2.5 } });
  s = await st(page);
  check('v1.0.x の保存値（×2.5）を 250% として引き継ぐ', s.label === '250%', s);
  await page.close();

  await browser.close();

  // ===== 14. 自動再生の制限（新ヘッドレスは実際の Chrome と同じく、操作前は AudioContext が止まる） =====
  // page.evaluate はユーザー操作として扱われるため、スクリプトの投入まで初期化スクリプトで行う
  {
    const strict = await chromium.launch({ channel: 'chromium' });
    const p = await strict.newPage({ viewport: { width: 1200, height: 900 } });
    p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
    await p.route('https://www.twitch.tv/**', (route) =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML })
    );
    await p.addInitScript(`window.__store = { boostPercent: 200 };`);
    await p.addInitScript(PAGE_HELPERS + TWITCH_BEHAVIOR);
    await p.addInitScript(`
      document.addEventListener('DOMContentLoaded', () => {
        window.__wireTwitch('a');
        window.__startTone('v-a', 0.1);
        setTimeout(() => { (0, eval)(${JSON.stringify(SCRIPT)}); }, 300);
        setTimeout(() => {
          window.__pre = {
            active: navigator.userActivation.hasBeenActive,
            ctx: window.__contexts.map((c) => c.state),
            mes: window.__mesCount,
            waiting: document.querySelector('.tm-twvb').classList.contains('tm-twvb-waiting'),
          };
        }, 1200);
      });
    `);
    await p.goto('https://www.twitch.tv/somechannel');
    await sleep(1700);
    const pre = await p.evaluate(() => window.__pre);
    check('前提: 記録の時点でユーザー操作が無い', pre && pre.active === false, pre);
    check('操作前: AudioContext が止まっている間は動画をつながない（無音にしない）', pre.ctx[0] === 'suspended' && pre.mes === 0, pre);
    check('操作前: 数字を薄くしてクリック待ちを示す', pre.waiting, pre);
    await p.mouse.click(1100, 800);
    await p.evaluate(() => { document.getElementById('v-a').muted = false; });
    await sleep(800);
    s = await st(p);
    check('クリック後: つないで 200% で振幅およそ 0.2', s.ctx[0] === 'running' && s.mes === 1 && s.peak > 0.18 && s.peak < 0.22, s);
    await strict.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
