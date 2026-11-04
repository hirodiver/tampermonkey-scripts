const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// block-ctrl-d-bookmark.user.js の検証用ハーネス。
//
//   NODE_PATH=$(npm root -g) node test/block-ctrl-d-bookmark.test.js
//
// ヘッドレスではブックマークの画面そのものは出ないので、
// 「Ctrl+D の既定動作が打ち消されているか（defaultPrevented）」で確かめる。
// 実際にブックマークの画面が出ないことは、Chrome の実機で確かめる。

const SCRIPT = fs.readFileSync(
  process.env.SCRIPT_PATH ||
    path.join(__dirname, '..', 'block-ctrl-d-bookmark.user.js'),
  'utf8'
);

// ページ側のキー処理（バブリング）。サイトが Ctrl+D を受け取れるかも見る
const PAGE_LISTENER = `
  window.pageKeys = [];
  document.addEventListener('keydown', (e) => {
    const name = (e.ctrlKey ? 'Ctrl+' : '') + (e.shiftKey ? 'Shift+' : '') + e.code;
    window.pageKeys.push({ name, prevented: e.defaultPrevented });
  });
`;

const FRAME_HTML = `<!doctype html><meta charset="utf-8"><body>
<textarea id="inner"></textarea>
<script>${PAGE_LISTENER}</script>
</body>`;

const HTML = `<!doctype html><meta charset="utf-8"><title>mock</title>
<body>
<input id="field">
<div id="editor" contenteditable="true"></div>
<iframe id="frame" src="https://example.com/frame.html"></iframe>
<script>${PAGE_LISTENER}</script>
</body>`;

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra && !cond ? '  -> ' + JSON.stringify(extra) : ''));
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.route('https://example.com/**', (route) => {
    const body = route.request().url().endsWith('/frame.html') ? FRAME_HTML : HTML;
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body });
  });
  await page.addInitScript(SCRIPT);
  await page.goto('https://example.com/');

  const lastKey = (frame = page) => frame.evaluate(() => window.pageKeys[window.pageKeys.length - 1]);

  check('起動: 診断の口が出る', await page.evaluate(() =>
    typeof window.__tmBlockCtrlD?.dump === 'function' && window.__tmBlockCtrlD.version === '1.0.0'));

  // --- 1. Ctrl+D は打ち消す ---
  await page.click('#field');
  await page.keyboard.press('Control+KeyD');
  let key = await lastKey();
  check('Ctrl+D: 入力欄で既定動作（ブックマーク）が打ち消される', key?.name === 'Ctrl+KeyD' && key.prevented === true, key);
  check('Ctrl+D: サイト側のキー処理には届く', key?.name === 'Ctrl+KeyD');

  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Control+KeyD');
  key = await lastKey();
  check('Ctrl+D: 何も選んでいないときも打ち消される', key?.prevented === true, key);

  await page.click('#editor');
  await page.keyboard.press('Control+KeyD');
  key = await lastKey();
  check('Ctrl+D: contenteditable でも打ち消される', key?.prevented === true, key);

  // --- 2. 日本語の変換中 ---
  const composing = await page.evaluate(() => {
    const ev = new KeyboardEvent('keydown', {
      code: 'KeyD', key: 'Process', keyCode: 229, ctrlKey: true, isComposing: true, bubbles: true, cancelable: true
    });
    document.getElementById('field').dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  check('変換中: Ctrl+D も打ち消される', composing === true);

  // --- 3. ほかのキーは触らない ---
  await page.click('#field');
  await page.keyboard.press('Control+Shift+KeyD');
  key = await lastKey();
  check('素通し: Ctrl+Shift+D は打ち消さない', key?.name === 'Ctrl+Shift+KeyD' && key.prevented === false, key);

  await page.keyboard.press('Control+KeyS');
  key = await lastKey();
  check('素通し: Ctrl+S は打ち消さない', key?.name === 'Ctrl+KeyS' && key.prevented === false, key);

  await page.keyboard.press('Control+Alt+KeyD');
  key = await lastKey();
  check('素通し: Ctrl+Alt+D は打ち消さない', key?.prevented === false, key);

  await page.fill('#field', '');
  await page.keyboard.type('dD');
  check('素通し: D を普通に打てる', (await page.inputValue('#field')) === 'dD');

  // --- 4. 埋め込みの枠（iframe）の中 ---
  const frame = page.frame({ url: /frame\.html$/ });
  check('枠: 枠の中でもスクリプトが動く', await frame.evaluate(() =>
    typeof window.__tmBlockCtrlD?.dump === 'function'));
  await frame.click('#inner');
  await page.keyboard.press('Control+KeyD');
  key = await lastKey(frame);
  check('枠: 枠の中の入力欄でも打ち消される', key?.name === 'Ctrl+KeyD' && key.prevented === true, key);

  // --- 5. 診断 ---
  const row = await page.evaluate(() => window.__tmBlockCtrlD.dump());
  check('診断: 打ち消した回数を数える', row['打ち消した回数'] === 4, row);

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.reload();
  await page.keyboard.press('Control+KeyD');
  check('エラーなし', errors.length === 0, errors);

  await browser.close();

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
