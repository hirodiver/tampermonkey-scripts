const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// youtube-volume-boost.user.js の検証用ハーネス。
//
// YouTube の再生ページ（プレーヤーの操作バー・音量欄・プレーヤーAPI）を模したDOMに
// 正弦波の音を流す <video> を置き、スクリプトを流し込んで
// 「バーの長さ・つまみの位置」と「実際に出ていく音の大きさ」（AnalyserNode）を測る。
//
//   NODE_PATH=$(npm root -g) node test/youtube-volume-boost.test.js
//
// YouTube の実DOMそのものは再現できないため、
// これに通ることは実機で動くことを保証しない。

const SCRIPT = fs.readFileSync(
  process.env.SCRIPT_PATH ||
    path.join(__dirname, '..', 'youtube-volume-boost.user.js'),
  'utf8'
);

// YouTube の音量バーと同じく、ふだんは幅 0 で、音量欄にマウスを乗せると 52px に開く
const PLAYER_HTML = (width) => `
<style>
  .ytp-volume-panel { width: 0; height: 100%; transition: width .1s; }
  .ytp-volume-area:hover .ytp-volume-panel { width: 52px; }
</style>
<div id="movie_player" class="html5-video-player" tabindex="-1"
     style="position:relative;width:${width}px;height:360px;background:#000;">
  <div class="html5-video-container"><video class="html5-main-video" loop></video></div>
  <div class="ytp-chrome-bottom" style="position:absolute;left:0;right:0;bottom:0;height:48px;">
    <div class="ytp-chrome-controls" style="display:flex;height:48px;font-size:12px;">
      <div class="ytp-left-controls" style="display:flex;height:48px;">
        <button class="ytp-play-button ytp-button" style="width:48px;">再生</button>
        <span class="ytp-volume-area" style="display:inline-flex;height:48px;align-items:center;">
          <button class="ytp-mute-button ytp-button" style="width:48px;">音</button>
          <div class="ytp-volume-panel" role="slider" aria-valuemin="0" aria-valuemax="100"
               aria-valuenow="100" tabindex="0">
            <div class="ytp-volume-slider"><div class="ytp-volume-slider-handle"></div></div>
          </div>
        </span>
        <div class="ytp-time-display" style="color:#fff;line-height:48px;">0:00 / 0:02</div>
      </div>
    </div>
  </div>
</div>`;

function pageHtml(options) {
  return `<!doctype html><html><meta charset="utf-8"><title>yt-mock</title>
<body style="margin:0;">
${PLAYER_HTML(options.width || 1000)}
${options.inline ? '<script>' + SCRIPT + '</script>' : ''}
</body></html>`;
}

// AudioContext を見張り、スピーカーへ出ていく音を横取りして測れるようにする。
// ユーザースクリプトより先に入れる（addInitScript）。
const TAP = () => {
  window.__ctxCount = 0;
  window.__mesCount = 0;

  const OrigCtx = window.AudioContext;
  window.AudioContext = class extends OrigCtx {
    constructor(...args) {
      super(...args);
      window.__ctxCount++;
      window.__ctx = this;
    }
  };

  const origMes = OrigCtx.prototype.createMediaElementSource;
  OrigCtx.prototype.createMediaElementSource = function (el) {
    window.__mesCount++;
    return origMes.call(this, el);
  };

  // スピーカー（destination）へつながるものを、すべて測定用の分岐にもつなぐ
  const origConnect = AudioNode.prototype.connect;
  const taps = new WeakMap();
  AudioNode.prototype.connect = function (dest, ...rest) {
    const result = origConnect.call(this, dest, ...rest);
    if (dest instanceof AudioDestinationNode) {
      const ctx = dest.context;
      let tap = taps.get(ctx);
      if (!tap) {
        tap = ctx.createAnalyser();
        tap.fftSize = 2048;
        const silent = ctx.createGain();
        silent.gain.value = 0;
        origConnect.call(tap, silent);
        origConnect.call(silent, ctx.destination);
        taps.set(ctx, tap);
        window.__analyser = tap;
      }
      origConnect.call(this, tap);
    }
    return result;
  };

  // 出ていく音のピーク（振幅）
  window.__peak = async (wait) => {
    await new Promise((r) => setTimeout(r, wait || 400));
    const an = window.__analyser;
    if (!an) return null;
    const data = new Float32Array(an.fftSize);
    let max = 0;
    for (let k = 0; k < 6; k++) {
      an.getFloatTimeDomainData(data);
      for (const x of data) max = Math.max(max, Math.abs(x));
      await new Promise((r) => setTimeout(r, 40));
    }
    return Number(max.toFixed(3));
  };

  // 440Hz・振幅 amp の WAV（blob: URL。YouTube の MediaSource と同じく同一オリジン扱い）
  window.__wavUrl = (amp) => {
    const rate = 44100;
    const n = rate * 2;
    const buf = new ArrayBuffer(44 + n * 2);
    const dv = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true);
    dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    w(36, 'data'); dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      dv.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * amp * 32767), true);
    }
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  };

  // YouTube のプレーヤーAPI（#movie_player に生えている getVolume など）と、
  // YouTube 自身の ↑↓←→ キー操作を模す。window.__noApi なら API を生やさない
  window.__ytKeys = [];
  document.addEventListener('DOMContentLoaded', () => {
    const player = document.getElementById('movie_player');
    const video = player.querySelector('video');
    let volume = 100;
    let muted = false;
    window.__norm = 1;   // 音量の自動調整（ラウドネス）の係数
    const sync = () => {
      video.volume = Math.min(1, (volume / 100) * window.__norm);
      video.muted = muted;
      const panel = document.querySelector('.ytp-volume-panel');
      if (panel) panel.setAttribute('aria-valuenow', String(muted ? 0 : volume));
    };
    window.__ytSync = sync;
    if (window.__noApi) return;

    player.getVolume = () => volume;
    player.setVolume = (v) => { volume = Math.max(0, Math.min(100, v)); sync(); };
    player.isMuted = () => muted;
    player.mute = () => { muted = true; sync(); };
    player.unMute = () => { muted = false; sync(); };

    document.addEventListener('keydown', (e) => {
      if (!player.contains(document.activeElement)) return;
      if (e.key === 'ArrowUp') { player.setVolume(volume + 5); window.__ytKeys.push('up'); }
      if (e.key === 'ArrowDown') { player.setVolume(volume - 5); window.__ytKeys.push('down'); }
      if (e.key === 'ArrowLeft') window.__ytKeys.push('seek-back');
      if (e.key === 'ArrowRight') window.__ytKeys.push('seek-fwd');
    });
  });
};

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra !== undefined && !cond ? '  -> ' + JSON.stringify(extra) : ''));
}

const near = (value, expected, tolerance) =>
  typeof value === 'number' && Math.abs(value - expected) <= Math.abs(expected) * (tolerance || 0.1);

async function openPage(browser, opts) {
  const options = opts || {};
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  if (options.noApi) {
    await page.addInitScript(() => { window.__noApi = true; });
  }
  await page.addInitScript(TAP);
  if (options.storage) {
    await page.addInitScript((value) => localStorage.setItem('tm-yt-volume-boost', value), options.storage);
  }
  await page.route('https://www.youtube.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      headers: { 'content-security-policy': "require-trusted-types-for 'script'" },
      body: pageHtml(options)
    })
  );
  await page.goto('https://www.youtube.com/watch?v=abc');
  return { context, page };
}

const startVideo = (page, amp) =>
  page.evaluate(async (a) => {
    const v = document.querySelector('#movie_player video');
    v.src = window.__wavUrl(a);
    await new Promise((r) => v.addEventListener('loadeddata', r, { once: true }));
    await v.play();
  }, amp);

const state = (page) => page.evaluate(() => window.__tmYtVolumeBoost.state());
const boostOf = async (page) => parseInt((await state(page))['ブースト'], 10);
const valueOf = (page) => page.evaluate(() => Number(document.querySelector('.tm-ytvb').getAttribute('aria-valuenow')));
const ytOf = (page) => page.evaluate(() => {
  const p = document.getElementById('movie_player');
  return { volume: p.getVolume(), muted: p.isMuted() };
});
const peak = (page, wait) => page.evaluate((w) => window.__peak(w), wait);

// つまみの中心の x 座標
const knobX = (page) => page.evaluate(() => {
  const r = document.querySelector('.tm-ytvb-knob').getBoundingClientRect();
  return r.left + r.width / 2;
});

// バーの上で、値 value に当たる x 座標（0〜600）
const xForValue = (page, value) => page.evaluate((v) => {
  const r = document.querySelector('.tm-ytvb-track').getBoundingClientRect();
  return { x: r.left + 6 + (r.width - 12) * (v / 600), y: r.top + r.height / 2 };
}, value);

const openBar = async (page) => {
  await page.hover('.ytp-mute-button');
  await page.waitForTimeout(350);
};

(async () => {
  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required']
  });

  // ============================================================
  // 1. 1本のバー（0〜600%）
  // ============================================================
  {
    const { context, page } = await openPage(browser);
    await startVideo(page, 0.1);
    await page.evaluate(SCRIPT);
    await page.waitForTimeout(100);

    check('設置: バーが YouTube の音量バーの直後（音量欄の中）に付く', await page.evaluate(() => {
      const w = document.querySelector('.tm-ytvb');
      return !!w && w.previousElementSibling === document.querySelector('.ytp-volume-panel') &&
        w.parentElement === document.querySelector('.ytp-volume-area');
    }));
    check('1本化: YouTube 本来の音量バーは見えなくなる', await page.evaluate(() =>
      getComputedStyle(document.querySelector('.ytp-volume-panel')).visibility === 'hidden'));
    check('1本化: バーの範囲は 0〜600', await page.evaluate(() => {
      const w = document.querySelector('.tm-ytvb');
      return w.getAttribute('aria-valuemin') === '0' && w.getAttribute('aria-valuemax') === '600';
    }));
    check('無害: 100% 以下なら AudioContext を作らない', (await page.evaluate(() => window.__ctxCount)) === 0);

    const collapsed = await page.evaluate(() => ({
      track: document.querySelector('.tm-ytvb-track').getBoundingClientRect().width,
      label: getComputedStyle(document.querySelector('.tm-ytvb-label')).display
    }));
    check('見た目: マウスを乗せていなければ閉じている（100% 以下のとき）', collapsed.track === 0 && collapsed.label === 'none', collapsed);

    await openBar(page);
    const opened = await page.evaluate(() => ({
      track: document.querySelector('.tm-ytvb-track').getBoundingClientRect().width,
      label: document.querySelector('.tm-ytvb-label').textContent
    }));
    check('見た目: 音量欄にマウスを乗せるとバーが開く', opened.track > 0 && opened.label === '100%', opened);
    check('長さ: バー全体は 252px（つまみが 0〜100% で 40px × 6 倍 + つまみ）', opened.track === 252, opened.track);

    // --- 0〜100% は YouTube の音量そのもの ---
    let pt = await xForValue(page, 50);
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(50);
    let yt = await ytOf(page);
    check('操作: 0〜100% の部分を押すと YouTube の音量が変わる（50%）', Math.abs(yt.volume - 50) <= 1 && (await boostOf(page)) === 100, yt);
    check('操作: つまみもその位置に来る', Math.abs((await valueOf(page)) - 50) <= 1);
    check('無害: 0〜100% の操作では音声に触らない', (await page.evaluate(() => window.__mesCount)) === 0);

    // つまみの位置で長さを確かめる
    await page.evaluate(() => window.__tmYtVolumeBoost.set(0));
    const x0 = await knobX(page);
    await page.evaluate(() => window.__tmYtVolumeBoost.set(100));
    const x100 = await knobX(page);
    await page.evaluate(() => window.__tmYtVolumeBoost.set(600));
    const x600 = await knobX(page);
    check('長さ: 0〜100% の部分は YouTube の音量バーと同じ 40px', Math.abs((x100 - x0) - 40) < 0.6, x100 - x0);
    check('長さ: 0〜600% 全体はその 6 倍（240px）', Math.abs((x600 - x0) - 240) < 0.6, x600 - x0);
    check('つまみ: 1つだけ', await page.evaluate(() => document.querySelectorAll('.tm-ytvb-knob').length === 1));
    await page.evaluate(() => window.__tmYtVolumeBoost.set(100));

    // --- 右端まで ---
    pt = await xForValue(page, 600);
    await page.mouse.click(pt.x + 5, pt.y);
    await page.waitForTimeout(50);
    yt = await ytOf(page);
    check('操作: 右端を押すと 600%（YouTube 側は 100%）', (await boostOf(page)) === 600 && yt.volume === 100, { yt, boost: await boostOf(page) });
    check('増幅: 100% を超えたら動画を Web Audio につなぐ', (await page.evaluate(() => window.__mesCount)) === 1);

    // --- 1つのつまみで 600 → 300 → 60 とドラッグ ---
    const p600 = await xForValue(page, 600);
    const p300 = await xForValue(page, 300);
    const p60 = await xForValue(page, 60);
    await page.mouse.move(p600.x, p600.y);
    await page.mouse.down();
    await page.mouse.move(p300.x, p300.y, { steps: 5 });
    const mid = await boostOf(page);
    check('ドラッグ: そのまま 300% まで動かせる', mid >= 295 && mid <= 305, mid);
    await page.mouse.move(p60.x, p60.y, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(50);
    yt = await ytOf(page);
    check('ドラッグ: 同じつまみで 100% を割ると YouTube の音量が下がる（60%）', (await boostOf(page)) === 100 && Math.abs(yt.volume - 60) <= 1, { yt, boost: await boostOf(page) });

    // --- 100% に吸い付く ---
    const p101 = await xForValue(page, 101.5);
    await page.mouse.click(p101.x, p101.y);
    await page.waitForTimeout(50);
    check('ドラッグ: 100% の近くでは 100% ちょうどに吸い付く', (await valueOf(page)) === 100 && (await boostOf(page)) === 100);

    // --- 実際の音の大きさ ---
    await page.evaluate(() => window.__tmYtVolumeBoost.set(300));
    const a300 = await peak(page);
    check('増幅: 300% で音が 3 倍になる（0.1 → 0.3）', near(a300, 0.3), a300);
    check('増幅: 100% を超えている間はリミッターを通す', (await state(page))['リミッター'] === '通している');

    await page.evaluate(() => window.__tmYtVolumeBoost.set(100));
    const a100 = await peak(page, 600);
    check('増幅: 100% に戻すと元の大きさ（0.1）', near(a100, 0.1), a100);
    check('増幅: 100% ではリミッターを外す（音を変えない）', (await state(page))['リミッター'] === '通していない');

    await page.evaluate(() => window.__tmYtVolumeBoost.set(40));
    const a40 = await peak(page);
    check('音量: 40% なら 0.04（YouTube の音量がそのまま効く）', near(a40, 0.04), a40);

    // --- YouTube 側の音量の自動調整が掛け合わされる ---
    await page.evaluate(() => window.__tmYtVolumeBoost.set(200));
    await page.evaluate(() => { window.__norm = 0.5; window.__ytSync(); });
    const aNorm = await peak(page);
    check('増幅: YouTube の音量の自動調整（0.5）にも掛かる（0.1×0.5×2）', near(aNorm, 0.1), aNorm);
    await page.evaluate(() => { window.__norm = 1; window.__ytSync(); });

    // --- 色と目盛り ---
    const look = await page.evaluate(() => ({
      fill: document.querySelector('.tm-ytvb-fill').style.background,
      tick: document.querySelector('.tm-ytvb-tick').style.left,
      tickShown: getComputedStyle(document.querySelector('.tm-ytvb-tick')).display !== 'none'
    }));
    check('見た目: 100% までは白、その先はオレンジで塗る', look.fill.includes('rgb(255, 255, 255)') && look.fill.includes('rgb(255, 176, 0)'), look.fill);
    check('見た目: 100% の位置（1/6）に目盛りがある', look.tickShown && look.tick.startsWith('16.66'), look);

    // --- ミュート ---
    await page.evaluate(() => document.getElementById('movie_player').mute());
    await page.waitForTimeout(50);
    const muteLook = await page.evaluate(() => ({
      value: document.querySelector('.tm-ytvb').getAttribute('aria-valuenow'),
      label: document.querySelector('.tm-ytvb-label').textContent
    }));
    check('ミュート: つまみは 0 の位置・「ミュート」と出る', muteLook.value === '0' && muteLook.label === 'ミュート', muteLook);
    const aMute = await peak(page);
    check('ミュート: 無音になる（増幅中でも）', aMute === 0, aMute);
    await page.waitForTimeout(400);
    check('ミュート: 解けば増幅（200%）に戻る', await (async () => {
      await page.evaluate(() => document.getElementById('movie_player').unMute());
      await page.waitForTimeout(50);
      return (await valueOf(page)) === 200;
    })());

    // --- リミッター ---
    await page.evaluate(() => window.__tmYtVolumeBoost.set(600));
    await page.evaluate(async () => {
      const v = document.querySelector('#movie_player video');
      v.src = window.__wavUrl(0.5);
      await new Promise((r) => v.addEventListener('loadeddata', r, { once: true }));
      await v.play();
    });
    const aLoud = await peak(page, 800);
    check('リミッター: 0.5 × 600%（本来 3.0）でも 1 前後に抑える', aLoud > 0.6 && aLoud <= 1.1, aLoud);
    check('使い回し: 同じ <video> で次の動画に替わっても増幅が効いたまま', aLoud > 0.6);

    // --- 閉じていても増幅中は数字が出る ---
    await page.mouse.move(900, 20);
    await page.waitForTimeout(350);
    const boostedLabel = await page.evaluate(() => {
      const label = document.querySelector('.tm-ytvb-label');
      return {
        text: label.textContent,
        shown: getComputedStyle(label).display !== 'none',
        color: getComputedStyle(label).color,
        track: document.querySelector('.tm-ytvb-track').getBoundingClientRect().width
      };
    });
    check('見た目: 増幅中はマウスを離しても「600%」がオレンジで出たまま', boostedLabel.shown && boostedLabel.text === '600%' && boostedLabel.color === 'rgb(255, 176, 0)', boostedLabel);
    check('見た目: バー自体は閉じる', boostedLabel.track === 0, boostedLabel);

    // --- YouTube の音量バーが開いたままの見た目なら、こちらも開いたまま ---
    await page.evaluate(() => { document.querySelector('.ytp-volume-panel').style.width = '52px'; });
    await page.waitForTimeout(350);
    check('連動: YouTube の音量バーが開いているときはこちらも開く', await page.evaluate(() =>
      document.querySelector('.tm-ytvb-track').getBoundingClientRect().width === 252));
    await page.evaluate(() => { document.querySelector('.ytp-volume-panel').style.width = ''; });
    await page.waitForTimeout(350);
    check('連動: YouTube の音量バーが閉じたらこちらも閉じる', await page.evaluate(() =>
      document.querySelector('.tm-ytvb-track').getBoundingClientRect().width === 0));

    await context.close();
  }

  // ============================================================
  // 2. YouTube 側の音量との連動・キー操作
  // ============================================================
  {
    const { context, page } = await openPage(browser);
    await startVideo(page, 0.1);
    await page.evaluate(SCRIPT);
    await page.waitForTimeout(100);

    // 100% より上げたら YouTube 側を 100% にそろえる
    await page.evaluate(() => {
      const p = document.getElementById('movie_player');
      p.setVolume(40);
      p.mute();
    });
    await page.evaluate(() => window.__tmYtVolumeBoost.set(250));
    let yt = await ytOf(page);
    check('連動: 100% より上げると YouTube 側は 100%・ミュート解除になる', yt.volume === 100 && yt.muted === false, yt);
    const a250 = await peak(page);
    check('連動: そのとき実際に 2.5 倍（0.1 → 0.25）', near(a250, 0.25), a250);

    // YouTube 側の音量を下げたら増幅を外す
    await page.evaluate(() => document.getElementById('movie_player').setVolume(60));
    await page.waitForTimeout(500);
    check('連動: YouTube 側の音量が 100% 未満に下がると増幅は外れ、つまみは 60%', (await boostOf(page)) === 100 && (await valueOf(page)) === 60);

    // 一瞬だけ下がってすぐ戻った場合は外さない
    await page.evaluate(() => window.__tmYtVolumeBoost.set(300));
    await page.evaluate(() => {
      const p = document.getElementById('movie_player');
      p.setVolume(80);
      setTimeout(() => p.setVolume(100), 50);
    });
    await page.waitForTimeout(600);
    check('連動: 一瞬だけ下がってすぐ戻った場合は増幅を外さない', (await boostOf(page)) === 300);
    await page.evaluate(() => window.__tmYtVolumeBoost.set(100));

    // --- ↑↓ キー（プレーヤーにフォーカス） ---
    await page.evaluate(() => { window.__ytKeys = []; document.getElementById('movie_player').focus(); });
    await page.keyboard.press('ArrowUp');
    check('キー: 音量 100% で ↑ を押すと 110% に上がる', (await valueOf(page)) === 110 && (await boostOf(page)) === 110);
    check('キー: そのとき YouTube 側には ↑ を渡さない', (await page.evaluate(() => window.__ytKeys.length)) === 0);
    check('キー: 画面に「音量 110%」を出す', await page.evaluate(() => {
      const t = document.querySelector('#movie_player .tm-ytvb-toast');
      return !!t && t.textContent === '音量 110%' && t.classList.contains('tm-ytvb-show');
    }));
    await page.keyboard.press('ArrowUp');
    check('キー: もう一度 ↑ で 120%', (await valueOf(page)) === 120);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    check('キー: ↓ は増幅分から下がる（120 → 100）', (await boostOf(page)) === 100);
    check('キー: 増幅中の ↓ は YouTube 側に渡さない', (await page.evaluate(() => window.__ytKeys.length)) === 0);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(50);   // volumechange は少し遅れて届く
    yt = await ytOf(page);
    check('キー: 100% からの ↓ は YouTube 側がふつうに下げる（95%）', yt.volume === 95 && (await page.evaluate(() => window.__ytKeys.join())) === 'down', yt);
    check('キー: YouTube 側で下げた音量につまみが追いつく', (await valueOf(page)) === 95);
    await page.keyboard.press('ArrowUp');
    yt = await ytOf(page);
    check('キー: YouTube 側が 100% 未満なら ↑ も YouTube に任せる', yt.volume === 100 && (await boostOf(page)) === 100, yt);

    // フォーカスがプレーヤーの外なら触らない（ページのスクロールなど）
    await page.evaluate(() => { document.activeElement.blur(); window.__ytKeys = []; });
    await page.keyboard.press('ArrowUp');
    check('キー: プレーヤーにフォーカスが無いときは ↑ を横取りしない', (await boostOf(page)) === 100);

    // ショートでは ↑↓ が動画の移動なので触らない
    await page.evaluate(() => { history.pushState({}, '', '/shorts/xyz'); document.getElementById('movie_player').focus(); });
    await page.keyboard.press('ArrowUp');
    check('キー: ショートでは ↑ を横取りしない', (await boostOf(page)) === 100);
    await page.evaluate(() => history.pushState({}, '', '/watch?v=abc'));

    // --- バーそのものをキーで操作 ---
    await page.evaluate(() => { window.__ytKeys = []; document.querySelector('.tm-ytvb').focus(); });
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    check('バー: → で 100% から 10% ずつ上がる', (await valueOf(page)) === 120);
    await page.keyboard.press('End');
    check('バー: End で上限 600%', (await valueOf(page)) === 600);
    await page.keyboard.press('Home');
    yt = await ytOf(page);
    check('バー: Home で 0%（YouTube の音量 0）', (await valueOf(page)) === 0 && yt.volume === 0, yt);
    await page.keyboard.press('ArrowRight');
    check('バー: 100% 以下では 5% ずつ（YouTube と同じ）', (await valueOf(page)) === 5);
    await page.keyboard.press('ArrowLeft');
    check('バー: ← で下がる', (await valueOf(page)) === 0);
    check('バー: ←→ は YouTube のシークに渡さない', (await page.evaluate(() => window.__ytKeys.length)) === 0,
      await page.evaluate(() => window.__ytKeys));

    // --- ホイール ---
    await page.evaluate(() => window.__tmYtVolumeBoost.set(100));
    await openBar(page);
    await page.hover('.tm-ytvb-track');
    await page.mouse.wheel(0, -100);
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(50);
    check('ホイール: 上に回すと上がる（100 → 120）', (await valueOf(page)) === 120);
    await page.mouse.wheel(0, 100);
    await page.mouse.wheel(0, 100);
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(50);
    yt = await ytOf(page);
    check('ホイール: 100% を割ると YouTube の音量が 5% ずつ下がる（95%）', (await valueOf(page)) === 95 && yt.volume === 95, yt);
    check('ホイール: ページはスクロールしない', (await page.evaluate(() => window.scrollY)) === 0);

    await page.dblclick('.tm-ytvb-label');
    check('ダブルクリック: 100% に戻る', (await valueOf(page)) === 100 && (await ytOf(page)).volume === 100);

    check('保存: 増幅は localStorage に残る', await page.evaluate(() => {
      window.__tmYtVolumeBoost.set(270);
      return localStorage.getItem('tm-yt-volume-boost') === '270';
    }));

    // --- 安定（書き換えが止まる） ---
    await page.mouse.move(900, 20);
    await page.waitForTimeout(400);
    const loops = await page.evaluate(async () => {
      let n = 0;
      const obs = new MutationObserver(() => n++);
      obs.observe(document.querySelector('.ytp-volume-area'), { childList: true, subtree: true, attributes: true, characterData: true });
      await new Promise((r) => setTimeout(r, 400));
      obs.disconnect();
      return n;
    });
    check('安定: 何も起きていないときバーが書き換わり続けない', loops === 0, loops);

    // --- 操作バーの作り直し（YouTube 側の再描画） ---
    await page.evaluate(() => {
      const area = document.querySelector('.ytp-volume-area');
      const fresh = area.cloneNode(true);
      fresh.querySelectorAll('.tm-ytvb').forEach((el) => el.remove());
      fresh.querySelectorAll('[data-tm-ytvb-replaced]').forEach((el) => el.removeAttribute('data-tm-ytvb-replaced'));
      area.replaceWith(fresh);
    });
    await page.waitForTimeout(500);
    check('再描画: 音量欄が作り直されたらバーを付け直し、新しい音量バーを隠す', await page.evaluate(() => {
      const w = document.querySelector('.tm-ytvb');
      const panel = document.querySelector('.ytp-volume-panel');
      return !!w && w.previousElementSibling === panel && getComputedStyle(panel).visibility === 'hidden';
    }));
    check('再描画: 付け直しても表示は 270% のまま', await page.evaluate(() =>
      document.querySelector('.tm-ytvb-label').textContent === '270%'));

    // --- YouTube の音量バーだけが作り直されたとき ---
    await page.evaluate(() => {
      const panel = document.querySelector('.ytp-volume-panel');
      const fresh = panel.cloneNode(true);
      fresh.removeAttribute('data-tm-ytvb-replaced');
      panel.replaceWith(fresh);
    });
    await page.waitForTimeout(500);
    check('再描画: YouTube の音量バーだけが作り直されても、新しい方を隠す（2本並ばない）', await page.evaluate(() => {
      const panels = document.querySelectorAll('.ytp-volume-panel');
      const w = document.querySelector('.tm-ytvb');
      return panels.length === 1 && getComputedStyle(panels[0]).visibility === 'hidden' &&
        w.previousElementSibling === panels[0];
    }));

    // --- クラス名が変わっても、0〜100 のスライダーを目印に付く ---
    await page.evaluate(() => {
      const area = document.querySelector('.ytp-volume-area');
      const fresh = document.createElement('span');
      fresh.className = 'ytp-volume-area-v2';
      const mute = document.createElement('button');
      mute.className = 'ytp-mute-button-v2';
      const slider = document.createElement('div');
      slider.className = 'ytp-volume-slider-v2';
      slider.setAttribute('role', 'slider');
      slider.setAttribute('aria-valuemax', '100');
      fresh.appendChild(mute);
      fresh.appendChild(slider);
      area.replaceWith(fresh);
    });
    await page.waitForTimeout(500);
    check('保険: クラス名が変わっても 0〜100 のスライダーの直後に付き、それを隠す', await page.evaluate(() => {
      const w = document.querySelector('.tm-ytvb');
      const slider = document.querySelector('.ytp-volume-slider-v2');
      return !!w && w.previousElementSibling === slider && getComputedStyle(slider).visibility === 'hidden';
    }));

    // --- 新しい <video>（ショートなど別のプレーヤー）も増幅する ---
    await page.evaluate(async () => {
      const shorts = document.createElement('div');
      shorts.id = 'shorts-player';
      shorts.className = 'html5-video-player';
      const v = document.createElement('video');
      v.loop = true;
      shorts.appendChild(v);
      document.body.appendChild(shorts);
      document.querySelector('#movie_player video').pause();
      v.src = window.__wavUrl(0.1);
      await new Promise((r) => v.addEventListener('loadeddata', r, { once: true }));
      await v.play();
    });
    const aShorts = await peak(page);
    check('新しい動画: 後から来た <video> も再生時につないで増幅する（0.1 × 2.7）', near(aShorts, 0.27), aShorts);

    // --- 別オリジンの動画はつながない（つなぐと無音になるため） ---
    const foreign = await page.evaluate(() => {
      const v = document.createElement('video');
      v.src = 'https://example.com/movie.mp4';
      document.body.appendChild(v);
      v.dispatchEvent(new Event('play'));
      const row = window.__tmYtVolumeBoost.dump().videos.find((r) => r.src.startsWith('https://example.com'));
      return row && row['つないだ'];
    });
    check('無害: 別オリジン（CORS 無し）の動画は Web Audio につながない', foreign === '未', foreign);

    // --- 診断 ---
    const dumped = await page.evaluate(() => {
      const d = window.__tmYtVolumeBoost.dump();
      return { ok: !!d && !!d.state && Array.isArray(d.videos), state: d.state };
    });
    check('診断: __tmYtVolumeBoost.dump() が動く', dumped.ok && dumped.state['状態'] === 'OK' && dumped.state['形'].startsWith('1本のバー'), dumped.state);

    await context.close();
  }

  // ============================================================
  // 3. 長さの調整（YouTube の音量バーの幅・小さいプレーヤー）
  // ============================================================
  {
    // 幅の上限（プレーヤーの 30%）に掛からないよう、広いプレーヤーで見る
    const { context, page } = await openPage(browser, { width: 1300 });
    await page.addStyleTag({ content: '#movie_player .ytp-volume-area:hover .ytp-volume-panel { width: 72px; }' });
    await page.evaluate(SCRIPT);
    await openBar(page);
    await page.mouse.move(900, 20);
    await page.waitForTimeout(200);
    await openBar(page);
    const width = await page.evaluate(() => document.querySelector('.tm-ytvb-track').getBoundingClientRect().width);
    check('長さ: YouTube の音量バーが広ければ（72px）それに合わせる（60px × 6 + 12 = 372px）', width === 372, width);
    await context.close();
  }
  {
    const { context, page } = await openPage(browser, { width: 500 });
    await page.evaluate(SCRIPT);
    await openBar(page);
    const width = await page.evaluate(() => document.querySelector('.tm-ytvb-track').getBoundingClientRect().width);
    check('長さ: 小さいプレーヤー（幅 500px）では右のボタンにかぶらないよう縮める（150 + 12 = 162px）', width === 162, width);
    await context.close();
  }

  // ============================================================
  // 4. プレーヤーAPI が無いとき（延長部分だけ）
  // ============================================================
  {
    const { context, page } = await openPage(browser, { noApi: true });
    await startVideo(page, 0.1);
    await page.evaluate(SCRIPT);
    await openBar(page);
    const look = await page.evaluate(() => ({
      panel: getComputedStyle(document.querySelector('.ytp-volume-panel')).visibility,
      min: document.querySelector('.tm-ytvb').getAttribute('aria-valuemin'),
      track: document.querySelector('.tm-ytvb-track').getBoundingClientRect().width,
      shape: window.__tmYtVolumeBoost.state()['形']
    }));
    check('API 無し: YouTube の音量バーは残す', look.panel === 'visible', look);
    check('API 無し: 右に 100〜600% の延長部分（64px）だけを付ける', look.min === '100' && look.track === 64 && look.shape.startsWith('延長部分だけ'), look);
    await page.evaluate(() => window.__tmYtVolumeBoost.set(300));
    const a = await peak(page);
    check('API 無し: 増幅はそのまま効く（0.1 → 0.3）', near(a, 0.3), a);
    await context.close();
  }

  // ============================================================
  // 5. 前回の増幅を引き継ぐ（再読み込み）
  // ============================================================
  {
    const { context, page } = await openPage(browser, { storage: '300' });
    await page.evaluate(SCRIPT);
    await startVideo(page, 0.1);
    const a = await peak(page);
    check('引き継ぎ: 再読み込み後も前回の 300% で鳴る', near(a, 0.3), a);
    check('引き継ぎ: バーにも 300% と出る', await page.evaluate(() =>
      document.querySelector('.tm-ytvb-label').textContent === '300%'));
    await context.close();
  }

  // ============================================================
  // 6. ほかの拡張機能などが先に動画をつないでいるとき
  // ============================================================
  {
    const { context, page } = await openPage(browser);
    await startVideo(page, 0.1);
    await page.evaluate(() => {
      // 別の AudioContext で先につないでおく（同じ動画は1度しかつなげない）
      const other = new AudioContext();
      other.createMediaElementSource(document.querySelector('#movie_player video')).connect(other.destination);
    });
    await page.evaluate(SCRIPT);
    await page.evaluate(() => window.__tmYtVolumeBoost.set(200));
    await page.waitForTimeout(100);
    const st = await page.evaluate(() => ({
      error: document.querySelector('.tm-ytvb').classList.contains('tm-ytvb-error'),
      color: getComputedStyle(document.querySelector('.tm-ytvb-label')).color,
      status: window.__tmYtVolumeBoost.state()['状態'],
      title: document.querySelector('.tm-ytvb').title
    }));
    check('先客: 増幅できないときは数字が赤くなる', st.error && st.color === 'rgb(255, 110, 110)', st);
    check('先客: 診断と説明に「増幅できない」理由が出る', st.status.startsWith('増幅できない') && st.title.includes('増幅できません'), st);
    await context.close();
  }

  await browser.close();

  // ============================================================
  // 7. 自動再生の制限で Web Audio が止まっているとき
  // ============================================================
  {
    const strict = await chromium.launch({
      args: ['--autoplay-policy=document-user-activation-required']
    });
    // スクリプトはページ内の <script> として流す（Playwright の evaluate はクリック扱いになるため）
    const { context, page } = await openPage(strict, { storage: '300', inline: true });
    await page.evaluate(() => {
      const v = document.querySelector('#movie_player video');
      v.src = window.__wavUrl(0.1);
      return new Promise((r) => v.addEventListener('loadeddata', r, { once: true }));
    });
    await page.waitForTimeout(200);

    const before = await page.evaluate(() => ({
      ctx: window.__ctx ? window.__ctx.state : null,
      mes: window.__mesCount,
      waiting: document.querySelector('.tm-ytvb').classList.contains('tm-ytvb-waiting'),
      status: window.__tmYtVolumeBoost.state()['状態']
    }));
    check('制限: クリック前は Web Audio が止まっている（前提の確認）', before.ctx === 'suspended', before);
    check('制限: 止まっている間は動画をつながない（つなぐと無音になる）', before.mes === 0, before);
    check('制限: バーに「クリック待ち」が出る', before.waiting && before.status.includes('クリック待ち'), before);

    await page.mouse.click(900, 20);
    await page.waitForTimeout(200);
    await page.evaluate(() => document.querySelector('#movie_player video').play());
    const after = await page.evaluate(() => ({
      ctx: window.__ctx.state,
      mes: window.__mesCount,
      waiting: document.querySelector('.tm-ytvb').classList.contains('tm-ytvb-waiting')
    }));
    check('制限: ページをクリックしたら Web Audio が動き出す', after.ctx === 'running', after);
    check('制限: そのあと動画をつなぐ', after.mes === 1, after);
    check('制限: 「クリック待ち」が消える', !after.waiting, after);
    const a = await peak(page);
    check('制限: クリック後は 300% で鳴る', near(a, 0.3), a);

    await context.close();
    await strict.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通過');
  process.exit(failed.length ? 1 : 0);
})();
