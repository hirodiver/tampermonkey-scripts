const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// x-hex-decode.user.js の検証用ハーネス。
//
// 投稿本文を模した要素に16進数文字列を置き、マウスのドラッグで選択して
// パネルの表示内容を確かめる。
//
//   NODE_PATH=$(npm root -g) node test/x-hex-decode.test.js
//
// Xの実DOMそのものではないので、これに通ることは実機で動くことを保証しない。

const SCRIPT = fs.readFileSync(
  process.env.SCRIPT_PATH ||
    path.join(__dirname, '..', 'x-hex-decode.user.js'),
  'utf8'
);

const URL_HEX = '68747470733a2f2f782e636f6d2f6761727562696c752f7374617475732f32303935343136393337393735323637363935';
const URL_TEXT = 'https://x.com/garubilu/status/2095416937975267695';

const HTML = `<!doctype html><meta charset="utf-8"><title>x-mock</title>
<style>
  body { margin: 0; background: #000; color: #e7e9ea; font: 15px sans-serif; }
  article { padding: 12px; width: 600px; }
  span { display: inline-block; word-break: break-all; }
</style>
<body>
<article><div data-testid="tweetText"><span id="urlHex">${URL_HEX}</span></div></article>
<article><div data-testid="tweetText"><span id="jaHex">e38182e38184e38186</span></div></article>
<article><div data-testid="tweetText"><span id="spaced">E3 81 82 E3 81 84</span></div></article>
<article><div data-testid="tweetText"><span id="escaped">\\xe3\\x81\\x82</span></div></article>
<article><div data-testid="tweetText"><span id="mixed">これを読んで 68656c6c6f20776f726c64 だって</span></div></article>
<article><div data-testid="tweetText"><span id="plain">ふつうの投稿です</span></div></article>
<article><div data-testid="tweetText"><span id="date">20261115</span></div></article>
<article><div data-testid="tweetText"><span id="badUtf8">ffffffff</span></div></article>
</body>`;

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra !== undefined && !cond ? '  -> ' + JSON.stringify(extra) : ''));
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
  await page.setContent(HTML);
  await page.addScriptTag({ content: SCRIPT });

  // 要素の左端から右端までマウスでドラッグする
  async function drag(id) {
    const box = await page.locator('#' + id).boundingBox();
    const y = box.y + Math.min(box.height / 2, 9);
    await page.mouse.move(box.x + 1, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
    await page.mouse.move(box.x + box.width - 1, box.y + box.height - 4, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(500);
  }

  // 要素の中身をそっくり選択する（ドラッグの端の誤差を避けたいとき）
  async function selectAll(id) {
    await page.mouse.click(5, 880);
    await page.evaluate((id) => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById(id));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }, id);
    await page.waitForTimeout(500);
  }

  const panelTexts = () => page.evaluate(() =>
    [...document.querySelectorAll('#tm-x-hex-decode-panel .tm-hex-decoded')].map((e) => e.textContent));

  // --- 例の URL をドラッグで ---
  await drag('urlHex');
  const sel = await page.evaluate(() => window.getSelection().toString());
  check('ドラッグ: 16進数全体が選択できている', sel === URL_HEX, sel);
  let texts = await panelTexts();
  check('ドラッグ: URL にデコードされる', texts.length === 1 && texts[0] === URL_TEXT, texts);
  check('ドラッグ: URL なら「開く」が出る', await page.evaluate((u) => {
    const a = document.querySelector('#tm-x-hex-decode-panel a.tm-hex-open');
    return a && a.href === u && a.target === '_blank';
  }, URL_TEXT));
  check('パネル: 選択範囲より下に出る', await page.evaluate(() => {
    const p = document.getElementById('tm-x-hex-decode-panel').getBoundingClientRect();
    const s = document.getElementById('urlHex').getBoundingClientRect();
    return p.top >= s.bottom;
  }));

  // --- パネル内のボタンを押してもパネルは消えない ---
  await page.locator('#tm-x-hex-decode-panel button').first().click();
  await page.waitForTimeout(400);
  check('パネル: コピーを押しても消えない', (await panelTexts()).length === 1);

  // --- 外をクリックで閉じる ---
  await page.mouse.click(5, 880);
  await page.waitForTimeout(400);
  check('パネル: 外をクリックすると閉じる', (await panelTexts()).length === 0);

  // --- 日本語 ---
  await selectAll('jaHex');
  texts = await panelTexts();
  check('日本語: e38182e38184e38186 → あいう', texts[0] === 'あいう', texts);
  check('日本語: 「開く」は出ない', await page.evaluate(() => !document.querySelector('#tm-x-hex-decode-panel a')));

  // --- 区切り付き ---
  await selectAll('spaced');
  texts = await panelTexts();
  check('空白区切り: E3 81 82 E3 81 84 → あい', texts[0] === 'あい', texts);

  await selectAll('escaped');
  texts = await panelTexts();
  check('\\x 付き: \\xe3\\x81\\x82 → あ', texts[0] === 'あ', texts);

  // --- 文中に混ざっている ---
  await selectAll('mixed');
  texts = await panelTexts();
  check('文中: 16進数の部分だけ拾う', texts.length === 1 && texts[0] === 'hello world', texts);

  // --- Esc ---
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  check('パネル: Esc で閉じる', (await panelTexts()).length === 0);

  // --- 出さないもの ---
  await selectAll('plain');
  check('対象外: ふつうの文章では出ない', (await panelTexts()).length === 0);

  await selectAll('date');
  check('対象外: 日付の数字（制御文字になる）では出ない', (await panelTexts()).length === 0);

  await selectAll('badUtf8');
  check('対象外: UTF-8 として不正なバイト列では出ない', (await panelTexts()).length === 0);

  // --- 診断 ---
  check('診断: decode() が使える', await page.evaluate((h) =>
    window.__tmHexDecode.decode(h)[0].text, URL_HEX) === URL_TEXT);
  await selectAll('jaHex');
  check('診断: dump() が選択の判定を返す', await page.evaluate(() =>
    window.__tmHexDecode.dump()[0]['結果'] === 'あいう'));

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通過');
  process.exit(failed.length ? 1 : 0);
})();
