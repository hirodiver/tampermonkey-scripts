const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// gemini-dictation-shortcut.user.js の検証用ハーネス。
//
//   NODE_PATH=$(npm root -g) node test/gemini-dictation-shortcut.test.js
//
// Gemini の画面構造は公開の説明が無いので、スクリプトが狙う形（音声入力の部品・
// aria-label・mat-icon）と、押してはいけないもの（サイドバーの履歴・Live・回答の停止）を
// 作り物で並べて確かめる。実機の Gemini で効くかは、Chrome で確かめる。

const SCRIPT = fs.readFileSync(
  process.env.SCRIPT_PATH ||
    path.join(__dirname, '..', 'gemini-dictation-shortcut.user.js'),
  'utf8'
);

// 押されたボタンを記録する。ページ側のキー処理（Ctrl+Shift+D を受けたか）も記録する
const RECORDER = `
  window.pressed = [];
  window.pageKeys = [];
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) window.pressed.push(b.id);
  });
  document.addEventListener('keydown', (e) => {
    if (/^(Control|Shift|Alt|Meta)/.test(e.code)) return;
    const name = (e.ctrlKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + e.code;
    window.pageKeys.push({ name, trusted: e.isTrusted });
  });
`;

// 1. 音声入力の部品があるページ
const HTML_DIRECT = `<!doctype html><meta charset="utf-8"><body>
<bard-sidenav>
  <button id="side-mic" aria-label="音声入力のメモ のメニュー"><mat-icon fonticon="mic"></mat-icon></button>
</bard-sidenav>
<main>
  <div contenteditable="true" id="editor"></div>
  <button id="live" aria-label="Gemini Live を使用"><mat-icon fonticon="mic"></mat-icon></button>
  <speech-dictation-mic-button><button id="mic" aria-label="マイクを使用"></button></speech-dictation-mic-button>
</main>
<script>${RECORDER}</script>
</body>`;

// 2. 部品は無く、aria-label だけで分かるページ
const HTML_LABEL = `<!doctype html><meta charset="utf-8"><body>
<nav><button id="side-mic" aria-label="マイクの設定"></button></nav>
<main>
  <button id="other" aria-label="ファイルを追加"></button>
  <button id="mic" aria-label="Use microphone"></button>
</main>
<script>${RECORDER}</script>
</body>`;

// 3. ラベルが無く、マイクの絵だけのページ。回答の停止ボタンもある
const HTML_ICON = `<!doctype html><meta charset="utf-8"><body>
<main>
  <button id="stop" aria-label="Stop response"><mat-icon fonticon="stop_circle"></mat-icon></button>
  <button id="mic"><mat-icon data-mat-icon-name="mic"></mat-icon></button>
</main>
<script>${RECORDER}</script>
</body>`;

// 4. マイクボタンが見当たらないページ（サイドバーにだけ「音声入力」がある）
const HTML_NONE = `<!doctype html><meta charset="utf-8"><body>
<div role="navigation"><button id="side-mic" aria-label="音声入力 について話したチャット"></button></div>
<main><textarea id="field"></textarea></main>
<script>${RECORDER}</script>
</body>`;

const PAGES = {
  '/direct': HTML_DIRECT,
  '/label': HTML_LABEL,
  '/icon': HTML_ICON,
  '/none': HTML_NONE
};

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra && !cond ? '  -> ' + JSON.stringify(extra) : ''));
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.route('https://gemini.google.com/**', (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGES[url.pathname] || HTML_DIRECT });
  });
  await page.addInitScript(SCRIPT);

  const pressed = () => page.evaluate(() => window.pressed.slice());
  const pageKeys = () => page.evaluate(() => window.pageKeys.slice());

  // --- 1. 音声入力の部品 ---
  await page.goto('https://gemini.google.com/direct');

  check('起動: 診断の口が出る', await page.evaluate(() =>
    typeof window.__tmGeminiDictation?.dump === 'function' && window.__tmGeminiDictation.version === '1.0.0'));

  await page.click('#editor');
  await page.keyboard.press('Control+KeyD');
  let p = await pressed();
  check('部品: Ctrl+D で音声入力の部品のボタンを押す', p.length === 1 && p[0] === 'mic', p);
  check('部品: サイドバーの履歴メニューは押さない', !p.includes('side-mic'), p);
  check('部品: Gemini Live は押さない', !p.includes('live'), p);

  let k = await pageKeys();
  check('部品: Ctrl+D はページに渡さない', !k.some(x => x.name === 'Ctrl+KeyD'), k);

  await page.keyboard.press('Control+KeyD');
  p = await pressed();
  check('部品: もう一度 Ctrl+D でもう一度押す（止める）', p.length === 2 && p[1] === 'mic', p);

  // 押しっぱなし（repeat）は1回だけ
  await page.keyboard.down('Control');
  await page.keyboard.down('KeyD');
  await page.keyboard.down('KeyD');
  await page.keyboard.down('KeyD');
  await page.keyboard.up('KeyD');
  await page.keyboard.up('Control');
  p = await pressed();
  check('連打: 押しっぱなしでは1回だけ押す', p.length === 3, p);

  // Ctrl+D の既定動作（ブックマーク）は打ち消す
  const prevented = await page.evaluate(() => {
    const ev = new KeyboardEvent('keydown', { code: 'KeyD', key: 'd', ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  check('既定動作: Ctrl+D の既定動作を打ち消す', prevented === true);

  // 日本語の変換中は打ち消すが、押さない
  const before = (await pressed()).length;
  const composing = await page.evaluate(() => {
    const ev = new KeyboardEvent('keydown', { code: 'KeyD', key: 'Process', keyCode: 229, ctrlKey: true, isComposing: true, bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  p = await pressed();
  check('変換中: 打ち消すが押さない', composing === true && p.length === before, { composing, p });

  // ほかのキーは素通し
  await page.evaluate(() => { window.pageKeys = []; });
  await page.keyboard.press('Control+Shift+KeyD');
  await page.keyboard.press('Control+KeyS');
  await page.keyboard.press('Control+Alt+KeyD');
  k = await pageKeys();
  p = await pressed();
  check('素通し: Ctrl+Shift+D・Ctrl+S・Ctrl+Alt+D はページに届く',
    k.some(x => x.name === 'Ctrl+Shift+KeyD') && k.some(x => x.name === 'Ctrl+KeyS') && k.some(x => x.name === 'Ctrl+Alt+KeyD') && k.length === 3, k);
  check('素通し: ほかのキーではマイクを押さない', p.length === before, p);

  // 診断
  const dumped = await page.evaluate(() => {
    const orig = { log: console.log, table: console.table };
    console.log = () => {}; console.table = () => {};
    try { return window.__tmGeminiDictation.dump(); } finally { Object.assign(console, orig); }
  });
  check('診断: dump() が候補と外したボタンを返す',
    dumped.candidates.length >= 1 && dumped.candidates[0]['押す'] === '★' &&
    dumped.rejected.some(r => String(r['判定']).includes('サイドバー')) &&
    dumped.rejected.some(r => String(r['判定']).includes('Live')), dumped);

  // --- 2. aria-label ---
  await page.goto('https://gemini.google.com/label');
  await page.keyboard.press('Control+KeyD');
  p = await pressed();
  check('ラベル: aria-label「Use microphone」のボタンを押す', p.length === 1 && p[0] === 'mic', p);

  // 録音中にラベルが変わっても、直前に押したボタンを押せる
  await page.evaluate(() => document.getElementById('mic').setAttribute('aria-label', '終了'));
  await page.keyboard.press('Control+KeyD');
  p = await pressed();
  check('ラベル: ラベルが変わっても直前に押したボタンを押す', p.length === 2 && p[1] === 'mic', p);

  // --- 3. マイクの絵 ---
  await page.goto('https://gemini.google.com/icon');
  await page.keyboard.press('Control+KeyD');
  p = await pressed();
  check('絵: マイクの絵のボタンを押す', p.length === 1 && p[0] === 'mic', p);
  check('絵: 回答の停止ボタンは押さない', !p.includes('stop'), p);

  // --- 4. 見つからない ---
  await page.goto('https://gemini.google.com/none');
  await page.click('#field');
  await page.evaluate(() => { window.pageKeys = []; });
  await page.keyboard.press('Control+KeyD');
  p = await pressed();
  k = await pageKeys();
  check('見つからない: サイドバーの「音声入力」は押さない', p.length === 0, p);
  check('見つからない: Ctrl+Shift+D をページに送る',
    k.length === 1 && k[0].name === 'Ctrl+Shift+KeyD' && k[0].trusted === false, k);
  const toast = await page.evaluate(() => document.getElementById('tm-gemini-dictation-shortcut-toast')?.textContent || '');
  check('見つからない: 知らせを出す', toast.includes('見つかりません'), toast);

  await browser.close();

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exit(failed.length ? 1 : 0);
})();
