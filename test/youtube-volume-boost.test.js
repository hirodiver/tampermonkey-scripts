const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// youtube-volume-boost.user.js の検証用ハーネス。
//
// YouTube の再生ページ（プレーヤーの操作バー・音量欄・プレーヤーAPI）を模したDOMに
// 正弦波の音を流す <video> を置き、スクリプトを流し込んで
// 「実際に出ていく音の大きさ」を AnalyserNode で測る。
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

const PLAYER_HTML = `
<div id="movie_player" class="html5-video-player" tabindex="-1"
     style="position:relative;width:640px;height:360px;background:#000;">
  <div class="html5-video-container"><video class="html5-main-video" loop></video></div>
  <div class="ytp-chrome-bottom" style="position:absolute;left:0;right:0;bottom:0;height:48px;">
    <div class="ytp-chrome-controls" style="display:flex;height:48px;font-size:12px;">
      <div class="ytp-left-controls" style="display:flex;height:48px;">
        <button class="ytp-play-button ytp-button" style="width:48px;">再生</button>
        <span class="ytp-volume-area" style="display:inline-flex;height:48px;align-items:center;">
          <button class="ytp-mute-button ytp-button" style="width:48px;">音</button>
          <div class="ytp-volume-panel" role="slider" aria-valuemin="0" aria-valuemax="100"
               aria-valuenow="100" tabindex="0" style="width:52px;height:100%;">
            <div class="ytp-volume-slider"><div class="ytp-volume-slider-handle"></div></div>
          </div>
        </span>
        <div class="ytp-time-display" style="color:#fff;line-height:48px;">0:00 / 0:02</div>
      </div>
    </div>
  </div>
</div>`;

function pageHtml(inlineScript) {
  return `<!doctype html><html><meta charset="utf-8"><title>yt-mock</title>
<body style="margin:0;">
${PLAYER_HTML}
${inlineScript ? '<script>' + inlineScript + '</script>' : ''}
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
  // YouTube 自身の ↑↓←→ キー操作を模す
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
    player.getVolume = () => volume;
    player.setVolume = (v) => { volume = Math.max(0, Math.min(100, v)); sync(); };
    player.isMuted = () => muted;
    player.mute = () => { muted = true; sync(); };
    player.unMute = () => { muted = false; sync(); };
    window.__ytSync = sync;

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
  typeof value === 'number' && Math.abs(value - expected) <= expected * (tolerance || 0.1);

async function openPage(browser, opts) {
  const options = opts || {};
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.addInitScript(TAP);
  if (options.storage) {
    await page.addInitScript((value) => localStorage.setItem('tm-yt-volume-boost', value), options.storage);
  }
  await page.route('https://www.youtube.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      headers: { 'content-security-policy': "require-trusted-types-for 'script'" },
      body: pageHtml(options.inline ? SCRIPT : '')
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

const boostOf = (page) => page.evaluate(() => parseInt(window.__tmYtVolumeBoost.state()['ブースト'], 10));
const peak = (page, wait) => page.evaluate((w) => window.__peak(w), wait);

(async () => {
  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required']
  });

  // ============================================================
  // 1. 置き場所と、100% のままなら音声に触らないこと
  // ============================================================
  {
    const { context, page } = await openPage(browser);
    await startVideo(page, 0.1);
    await page.evaluate(SCRIPT);
    await page.waitForTimeout(100);

    check('設置: 延長部分が YouTube の音量バーの直後に付く', await page.evaluate(() => {
      const w = document.querySelector('.tm-ytvb');
      return !!w && w.previousElementSibling === document.querySelector('.ytp-volume-panel') &&
        w.parentElement === document.querySelector('.ytp-volume-area');
    }));
    check('設置: 時間表示より前（音量欄の中）に収まる', await page.evaluate(() =>
      !!document.querySelector('.ytp-volume-area .tm-ytvb')));
    check('無害: 100% のままなら AudioContext を作らない', (await page.evaluate(() => window.__ctxCount)) === 0);
    check('無害: 100% のままなら動画を Web Audio につながない', (await page.evaluate(() => window.__mesCount)) === 0);

    const collapsed = await page.evaluate(() => ({
      track: document.querySelector('.tm-ytvb-track').getBoundingClientRect().width,
      label: getComputedStyle(document.querySelector('.tm-ytvb-label')).display
    }));
    check('見た目: マウスを乗せていなければ閉じている（100% のとき）', collapsed.track === 0 && collapsed.label === 'none', collapsed);

    await page.hover('.ytp-mute-button');
    await page.waitForTimeout(350);
    const opened = await page.evaluate(() => ({
      track: document.querySelector('.tm-ytvb-track').getBoundingClientRect().width,
      label: document.querySelector('.tm-ytvb-label').textContent,
      labelShown: getComputedStyle(document.querySelector('.tm-ytvb-label')).display !== 'none'
    }));
    check('見た目: 音量欄にマウスを乗せると延長部分が開く', opened.track === 64 && opened.labelShown && opened.label === '100%', opened);

    // --- つまみのクリック・ドラッグ ---
    const box = await page.evaluate(() => document.querySelector('.tm-ytvb-track').getBoundingClientRect().toJSON());
    await page.mouse.click(box.x + box.width - 1, box.y + box.height / 2);
    await page.waitForTimeout(50);
    check('操作: 延長部分の右端をクリックすると 600%', (await boostOf(page)) === 600);

    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(50);
    const mid = await boostOf(page);
    check('操作: 真ん中までドラッグすると 350% 前後', mid >= 330 && mid <= 370, mid);

    check('増幅: 100% を超えたら動画を Web Audio につなぐ', (await page.evaluate(() => window.__mesCount)) === 1);

    // --- 実際の音の大きさ ---
    await page.evaluate(() => window.__tmYtVolumeBoost.set(300));
    const p300 = await peak(page);
    check('増幅: 300% で音が 3 倍になる（0.1 → 0.3）', near(p300, 0.3), p300);
    check('増幅: 100% を超えている間はリミッターを通す', await page.evaluate(() =>
      window.__tmYtVolumeBoost.state()['リミッター'] === '通している'));

    await page.evaluate(() => window.__tmYtVolumeBoost.set(100));
    const p100 = await peak(page, 600);
    check('増幅: 100% に戻すと元の大きさ（0.1）', near(p100, 0.1), p100);
    check('増幅: 100% ではリミッターを外す（音を変えない）', await page.evaluate(() =>
      window.__tmYtVolumeBoost.state()['リミッター'] === '通していない'));

    // --- YouTube 側の音量が掛け合わされる ---
    await page.evaluate(() => window.__tmYtVolumeBoost.set(200));
    await page.evaluate(() => { window.__norm = 0.5; window.__ytSync(); });
    const pNorm = await peak(page);
    check('増幅: YouTube 側の音量（自動調整で 0.5）にブーストが掛かる（0.1×0.5×2）', near(pNorm, 0.1), pNorm);
    await page.evaluate(() => { window.__norm = 1; window.__ytSync(); });

    // --- ミュート ---
    await page.evaluate(() => document.getElementById('movie_player').mute());
    const pMute = await peak(page);
    check('増幅: ミュートすれば無音（ブースト中でも）', pMute === 0, pMute);
    check('連動: ミュートしてもブーストは外れない', (await page.waitForTimeout(400), await boostOf(page)) === 200);
    await page.evaluate(() => document.getElementById('movie_player').unMute());

    // --- リミッター ---
    await page.evaluate(() => window.__tmYtVolumeBoost.set(600));
    await page.evaluate(async () => {
      const v = document.querySelector('#movie_player video');
      v.src = window.__wavUrl(0.5);
      await new Promise((r) => v.addEventListener('loadeddata', r, { once: true }));
      await v.play();
    });
    const pLoud = await peak(page, 800);
    check('リミッター: 0.5 × 600%（本来 3.0）でも 1 前後に抑える', pLoud > 0.6 && pLoud <= 1.1, pLoud);
    check('使い回し: 同じ <video> で次の動画に替わってもブーストが効いたまま', pLoud > 0.6);

    // --- 表示 ---
    await page.mouse.move(600, 20);
    await page.waitForTimeout(350);
    const boostedLabel = await page.evaluate(() => {
      const label = document.querySelector('.tm-ytvb-label');
      return { text: label.textContent, shown: getComputedStyle(label).display !== 'none', color: getComputedStyle(label).color };
    });
    check('見た目: ブースト中はマウスを離しても「600%」が出たまま', boostedLabel.shown && boostedLabel.text === '600%', boostedLabel);
    check('見た目: ブースト中の数字は色付き', boostedLabel.color === 'rgb(255, 176, 0)', boostedLabel.color);

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

    // 延長部分を上げたら YouTube 側を 100% にそろえる
    await page.evaluate(() => {
      const p = document.getElementById('movie_player');
      p.setVolume(40);
      p.mute();
    });
    await page.evaluate(() => window.__tmYtVolumeBoost.set(250));
    const yt = await page.evaluate(() => {
      const p = document.getElementById('movie_player');
      return { volume: p.getVolume(), muted: p.isMuted() };
    });
    check('連動: 延長部分を上げると YouTube 側は 100%・ミュート解除になる', yt.volume === 100 && yt.muted === false, yt);
    const p250 = await peak(page);
    check('連動: そのとき実際に 2.5 倍（0.1 → 0.25）', near(p250, 0.25), p250);

    // YouTube 側の音量を下げたらブーストを戻す
    await page.evaluate(() => document.getElementById('movie_player').setVolume(60));
    await page.waitForTimeout(500);
    check('連動: YouTube 側の音量を 100% 未満に下げるとブーストは 100% に戻る', (await boostOf(page)) === 100);

    // 一瞬だけ下がってすぐ戻った場合は外さない
    await page.evaluate(() => document.getElementById('movie_player').setVolume(100));
    await page.evaluate(() => window.__tmYtVolumeBoost.set(300));
    await page.evaluate(() => {
      const p = document.getElementById('movie_player');
      p.setVolume(80);
      setTimeout(() => p.setVolume(100), 50);
    });
    await page.waitForTimeout(600);
    check('連動: 一瞬だけ下がってすぐ戻った場合はブーストを外さない', (await boostOf(page)) === 300);
    await page.evaluate(() => window.__tmYtVolumeBoost.set(100));

    // --- ↑↓ キー（プレーヤーにフォーカス） ---
    await page.evaluate(() => { window.__ytKeys = []; document.getElementById('movie_player').focus(); });
    await page.keyboard.press('ArrowUp');
    check('キー: 音量 100% で ↑ を押すとブーストが 110% に上がる', (await boostOf(page)) === 110);
    check('キー: そのとき YouTube 側には ↑ を渡さない', (await page.evaluate(() => window.__ytKeys.length)) === 0);
    check('キー: 画面に「音量 110%」を出す', await page.evaluate(() => {
      const t = document.querySelector('#movie_player .tm-ytvb-toast');
      return !!t && t.textContent === '音量 110%' && t.classList.contains('tm-ytvb-show');
    }));
    await page.keyboard.press('ArrowUp');
    check('キー: もう一度 ↑ で 120%', (await boostOf(page)) === 120);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    check('キー: ↓ はブースト分から下がる（120 → 100）', (await boostOf(page)) === 100);
    check('キー: ブースト中の ↓ は YouTube 側に渡さない', (await page.evaluate(() => window.__ytKeys.length)) === 0);
    await page.keyboard.press('ArrowDown');
    const afterDown = await page.evaluate(() => ({ keys: window.__ytKeys.slice(), volume: document.getElementById('movie_player').getVolume() }));
    check('キー: ブーストが 100% なら ↓ は YouTube 側がふつうに下げる', afterDown.keys.join() === 'down' && afterDown.volume === 95, afterDown);
    await page.keyboard.press('ArrowUp');
    const afterUp = await page.evaluate(() => ({ keys: window.__ytKeys.slice(), volume: document.getElementById('movie_player').getVolume() }));
    check('キー: YouTube 側が 100% 未満なら ↑ も YouTube に任せる', afterUp.keys.join() === 'down,up' && afterUp.volume === 100, afterUp);
    check('キー: そのときブーストは 100% のまま', (await boostOf(page)) === 100);

    // フォーカスがプレーヤーの外なら触らない（ページのスクロールなど）
    await page.evaluate(() => { document.activeElement.blur(); window.__ytKeys = []; });
    await page.keyboard.press('ArrowUp');
    check('キー: プレーヤーにフォーカスが無いときは ↑ を横取りしない', (await boostOf(page)) === 100);

    // ショートでは ↑↓ が動画の移動なので触らない
    await page.evaluate(() => { history.pushState({}, '', '/shorts/xyz'); document.getElementById('movie_player').focus(); });
    await page.keyboard.press('ArrowUp');
    check('キー: ショートでは ↑ を横取りしない', (await boostOf(page)) === 100);
    await page.evaluate(() => history.pushState({}, '', '/watch?v=abc'));

    // --- 延長部分そのものを操作 ---
    await page.evaluate(() => { window.__ytKeys = []; document.querySelector('.tm-ytvb').focus(); });
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    check('延長部分: → で 10% ずつ上がる', (await boostOf(page)) === 120);
    await page.keyboard.press('ArrowLeft');
    check('延長部分: ← で下がる', (await boostOf(page)) === 110);
    await page.keyboard.press('End');
    check('延長部分: End で上限 600%', (await boostOf(page)) === 600);
    await page.keyboard.press('Home');
    check('延長部分: Home で 100%', (await boostOf(page)) === 100);
    check('延長部分: ←→ は YouTube のシークに渡さない', (await page.evaluate(() => window.__ytKeys.length)) === 0,
      await page.evaluate(() => window.__ytKeys));

    await page.hover('.ytp-mute-button');
    await page.waitForTimeout(300);
    await page.hover('.tm-ytvb-track');
    await page.mouse.wheel(0, -100);
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(50);
    check('延長部分: ホイールを上に回すと上がる', (await boostOf(page)) === 120);
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(50);
    check('延長部分: ホイールを下に回すと下がる', (await boostOf(page)) === 110);
    check('延長部分: ホイールでページがスクロールしない', (await page.evaluate(() => window.scrollY)) === 0);

    await page.dblclick('.tm-ytvb-label');
    check('延長部分: ダブルクリックで 100% に戻る', (await boostOf(page)) === 100);

    check('保存: 設定が localStorage に残る', await page.evaluate(() => {
      window.__tmYtVolumeBoost.set(270);
      return localStorage.getItem('tm-yt-volume-boost') === '270';
    }));

    // --- 安定（書き換えが止まる） ---
    const loops = await page.evaluate(async () => {
      let n = 0;
      const obs = new MutationObserver(() => n++);
      obs.observe(document.querySelector('.tm-ytvb'), { childList: true, subtree: true, attributes: true, characterData: true });
      await new Promise((r) => setTimeout(r, 400));
      obs.disconnect();
      return n;
    });
    check('安定: 何も起きていないとき延長部分が書き換わり続けない', loops === 0, loops);

    // --- 操作バーの作り直し（YouTube 側の再描画） ---
    await page.evaluate(() => {
      const area = document.querySelector('.ytp-volume-area');
      const fresh = area.cloneNode(true);
      fresh.querySelectorAll('.tm-ytvb').forEach((el) => el.remove());
      area.replaceWith(fresh);
    });
    await page.waitForTimeout(500);
    check('再描画: 音量欄が作り直されたら延長部分を付け直す', await page.evaluate(() => {
      const w = document.querySelector('.tm-ytvb');
      return !!w && w.previousElementSibling === document.querySelector('.ytp-volume-panel');
    }));
    check('再描画: 付け直しても表示は 270% のまま', await page.evaluate(() =>
      document.querySelector('.tm-ytvb-label').textContent === '270%'));

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
    check('保険: クラス名が変わっても 0〜100 のスライダーの直後に付く', await page.evaluate(() => {
      const w = document.querySelector('.tm-ytvb');
      return !!w && w.previousElementSibling === document.querySelector('.ytp-volume-slider-v2');
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
    const pShorts = await peak(page);
    check('新しい動画: 後から来た <video> も再生時につないで増幅する（0.1 × 2.7）', near(pShorts, 0.27), pShorts);

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
    check('診断: __tmYtVolumeBoost.dump() が動く', dumped.ok && dumped.state['状態'] === 'OK', dumped.state);

    await context.close();
  }

  // ============================================================
  // 3. 前回のブーストを引き継ぐ（再読み込み）
  // ============================================================
  {
    const { context, page } = await openPage(browser, { storage: '300' });
    await page.evaluate(SCRIPT);
    await startVideo(page, 0.1);
    const p = await peak(page);
    check('引き継ぎ: 再読み込み後も前回の 300% で鳴る', near(p, 0.3), p);
    check('引き継ぎ: 延長部分にも 300% と出る', await page.evaluate(() =>
      document.querySelector('.tm-ytvb-label').textContent === '300%'));
    await context.close();
  }

  // ============================================================
  // 4. ほかの拡張機能などが先に動画をつないでいるとき
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
    const state = await page.evaluate(() => ({
      error: document.querySelector('.tm-ytvb').classList.contains('tm-ytvb-error'),
      color: getComputedStyle(document.querySelector('.tm-ytvb-label')).color,
      status: window.__tmYtVolumeBoost.state()['状態'],
      title: document.querySelector('.tm-ytvb').title
    }));
    check('先客: 増幅できないときは延長部分の数字が赤くなる', state.error && state.color === 'rgb(255, 110, 110)', state);
    check('先客: 診断と説明に「増幅できない」理由が出る', state.status.startsWith('増幅できない') && state.title.includes('増幅できません'), state);
    await context.close();
  }

  await browser.close();

  // ============================================================
  // 5. 自動再生の制限で Web Audio が止まっているとき
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
    check('制限: 延長部分に「クリック待ち」が出る', before.waiting && before.status.includes('クリック待ち'), before);

    await page.mouse.click(600, 20);
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
    const p = await peak(page);
    check('制限: クリック後は 300% で鳴る', near(p, 0.3), p);

    await context.close();
    await strict.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通過');
  process.exit(failed.length ? 1 : 0);
})();
