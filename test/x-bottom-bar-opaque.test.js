const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// x-bottom-bar-opaque.user.js の検証用ハーネス。
//
// 実機（X本体）の代わりに、下部メニュー帯の構造を模したDOMへ
// スクリプトを流し込み、ヘッドレスChromiumで
// 「常にopacity 1を保つ」ことを確認する。
//
//   NODE_PATH=$(npm root -g) node test/x-bottom-bar-opaque.test.js
//
// Xの実DOMそのものは再現できないため、
// これに通ることは実機で動くことを保証しない。

const SCRIPT = fs.readFileSync(
  process.env.SCRIPT_PATH ||
    path.join(__dirname, '..', 'x-bottom-bar-opaque.user.js'),
  'utf8'
);

const HTML = `<!doctype html><meta charset="utf-8"><title>x-mock</title><body>
<div id="react-root">
  <div id="bottomBar" data-testid="BottomBar"
       style="position:fixed;bottom:0;left:0;width:100%;height:53px;background:rgba(0,0,0,.85);">
    <a href="/home" role="link">ホーム</a>
    <a href="/explore" role="link">検索</a>
    <a href="/notifications" role="link">通知</a>
    <a href="/messages" role="link">メッセージ</a>
  </div>
  <div id="timeline"></div>
</div>
</body>`;

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra && !cond ? '  -> ' + JSON.stringify(extra) : ''));
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // x.com のパス判定を効かせるため、実URLとして配信する
  await page.route('https://x.com/**', (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML })
  );
  await page.goto('https://x.com/home');

  const opacityOf = (id) =>
    page.evaluate((id) => {
      const el = document.getElementById(id);
      return el ? getComputedStyle(el).opacity : null;
    }, id);

  // --- スクリプト投入 ---
  await page.evaluate(SCRIPT);

  check('CSS: スタイルが注入される', await page.evaluate(() => !!document.getElementById('tm-bottombar-opaque-style')));
  check('初期状態でopacityが1', (await opacityOf('bottomBar')) === '1');

  // --- スクロール中の連続したinline opacity書き換えでも常に1 ---
  const samples = await page.evaluate(() => {
    const el = document.getElementById('bottomBar');
    const out = [];
    [0.85, 0.6, 0.3, 0.6, 1].forEach((v) => {
      el.style.opacity = String(v); // !important無し（Xの通常想定挙動）
      out.push(getComputedStyle(el).opacity);
    });
    return out;
  });
  check('連続したinline opacity書き換えでも常にopacity 1', samples.every((v) => v === '1'), samples);

  // --- data-testidが変わっても構造検出で見つかる ---
  await page.evaluate(() => {
    const root = document.getElementById('react-root');
    const old = document.getElementById('bottomBar');

    const el = document.createElement('div');
    el.id = 'bottomBar';
    Object.assign(el.style, {
      position: 'fixed',
      bottom: '0',
      left: '0',
      width: '100%',
      height: '53px',
      background: 'rgba(0,0,0,.85)',
      opacity: '0.5' // testidを失った状態でも半透明化が起きている想定
    });
    ['ホーム', '検索', '通知', 'メッセージ'].forEach((label) => {
      const a = document.createElement('a');
      a.href = '/' + label;
      a.setAttribute('role', 'link');
      a.textContent = label;
      el.appendChild(a);
    });

    old.remove();
    root.appendChild(el);
  });
  await page.waitForTimeout(400); // SCAN_DELAY(200ms)を跨ぐ

  const dump = await page.evaluate(() => {
    const rows = window.__tmBottomBar.dump();
    return rows;
  });
  const structureRow = dump.find((r) => r.検出方式.startsWith('構造'));
  check('testid除去後も構造検出で見つかる', structureRow && structureRow.検出 === true, dump);
  check('構造検出でのマーク付与によりopacity 1に復元', (await opacityOf('bottomBar')) === '1');

  // --- SPA再描画: testid付きのまま丸ごと差し替わっても追従する ---
  await page.evaluate(() => {
    const root = document.getElementById('react-root');
    document.getElementById('bottomBar').remove();

    const fresh = document.createElement('div');
    fresh.id = 'bottomBar2';
    fresh.setAttribute('data-testid', 'BottomBar');
    Object.assign(fresh.style, {
      position: 'fixed',
      bottom: '0',
      left: '0',
      width: '100%',
      height: '53px',
      background: 'rgba(0,0,0,.85)',
      opacity: '0.5'
    });
    ['ホーム', '検索', '通知', 'メッセージ'].forEach((label) => {
      const a = document.createElement('a');
      a.href = '/' + label;
      a.setAttribute('role', 'link');
      a.textContent = label;
      fresh.appendChild(a);
    });
    root.appendChild(fresh);
  });
  await page.waitForTimeout(400);
  check('SPA再描画で差し替わった新要素にも追従してopacity 1', (await opacityOf('bottomBar2')) === '1');

  // --- 対象外要素には影響しない ---
  const timelineOpacity = await page.evaluate(() => {
    const t = document.getElementById('timeline');
    t.style.opacity = '0.5';
    return getComputedStyle(t).opacity;
  });
  check('対象外要素(timeline)のopacityは変更されない', timelineOpacity === '0.5');

  // --- 診断関数 ---
  check('診断: __tmBottomBar.dump() が配列を返す', Array.isArray(dump));

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通過');
  process.exit(failed.length ? 1 : 0);
})();
