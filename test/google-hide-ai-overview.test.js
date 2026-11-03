const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// google-hide-ai-overview.user.js の検証用ハーネス。
//
// Google 検索結果ページの構造を模したDOMを組み、ヘッドレスChromium に
// document-start 相当（addInitScript）でスクリプトを流し込んで確認する。
//
//   NODE_PATH=$(npm root -g) node test/google-hide-ai-overview.test.js
//
// クラス名・属性は uBlock Origin 用の公開フィルタ（Stevo's AI Blocklist）にあるもの。
// Google の実DOMそのものではないので、これに通ることは実機で動くことを保証しない。

const SCRIPT = fs.readFileSync(
  process.env.SCRIPT_PATH ||
    path.join(__dirname, '..', 'google-hide-ai-overview.user.js'),
  'utf8'
);

// 読み込み時点では AI による概要は無く、あとから差し込まれる（実際も非同期で届く）
const HTML = `<!doctype html><meta charset="utf-8"><title>google-mock</title>
<body>
<div id="main">
  <div id="rcnt">
    <div id="center_col">
      <div id="search">
        <div id="rso">
          <div class="MjjYud" id="org1">
            <div><a href="https://example.com/1"><h3>AI Overview とは何か - 解説サイト</h3></a></div>
            <div>AI による概要 という機能についての記事です。</div>
          </div>
          <div class="ULSxyf" id="paa">
            <div class="MjjYud">
              <div role="heading" aria-level="2">他の人はこちらも質問</div>
              <div>質問1</div>
            </div>
          </div>
          <div class="MjjYud" id="org2">
            <div><a href="https://example.com/2"><h3>普通の検索結果</h3></a></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
</body>`;

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra && !cond ? '  -> ' + JSON.stringify(extra) : ''));
}

async function run(viewport, label) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport });

  await page.route('https://www.google.com/**', (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML })
  );
  await page.addInitScript(SCRIPT);
  await page.goto('https://www.google.com/search?q=test');

  const shown = (sel) =>
    page.evaluate((s) => {
      const el = document.querySelector(s);
      return !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none';
    }, sel);
  const wait = (ms) => page.waitForTimeout(ms);

  check(`${label}: style が注入される`, await page.evaluate(() => !!document.getElementById('tm-google-hide-aio-style')));

  // --- 1. 目印（data-attnms）付きの概要が上部に差し込まれる ---
  await page.evaluate(() => {
    const wrap = document.createElement('div');
    wrap.className = 'Kevs9 SLPe5b';
    wrap.id = 'aioWrap';
    const header = document.createElement('div');
    header.id = 'aioHeader';
    const h = document.createElement('h1');
    h.textContent = 'AI による概要';
    header.appendChild(h);
    const body = document.createElement('div');
    body.setAttribute('data-attnms', '');
    body.id = 'aioBody';
    body.textContent = 'これは AI が生成した概要の本文です。';
    wrap.append(header, body);
    document.getElementById('rso').prepend(wrap);
  });
  await wait(400);

  check(`${label}: 目印付きの本体が消える`, !(await shown('#aioBody')));
  check(`${label}: 目印付きの入れ物ごと消える（空白が残らない）`, !(await shown('#aioWrap')));
  check(`${label}: 通常の検索結果は残る`, await shown('#org2'));
  check(`${label}: 「AI Overview とは」の検索結果は残る`, await shown('#org1'));
  check(`${label}: 他の人はこちらも質問は残る`, await shown('#paa'));

  // --- 2. 目印もクラス名も無い、見出しだけで分かる概要 ---
  await page.evaluate(() => {
    const block = document.createElement('div');
    block.id = 'aio2';
    const inner = document.createElement('div');
    inner.id = 'aio2Inner';
    const head = document.createElement('div');
    const span = document.createElement('span');
    span.id = 'aio2Label';
    span.textContent = 'AI Overview';
    head.appendChild(span);
    const text = document.createElement('div');
    text.id = 'aio2Text';
    text.textContent = '属性もクラス名も変わった後の AI 概要の本文。';
    inner.append(head, text);
    block.appendChild(inner);
    document.getElementById('org2').before(block);
  });
  await wait(400);

  check(`${label}: 見出しだけで分かる概要が消える`, !(await shown('#aio2Text')));
  check(`${label}: 見出しから検索結果の区切りまで遡って消す`, await page.evaluate(() =>
    document.getElementById('aio2').getAttribute('data-tm-aio') === 'hidden'));
  check(`${label}: 見出しの概要の後でも通常の検索結果は残る`, await shown('#org2'));
  check(`${label}: 見出しの概要の後でも他の人はこちらも質問は残る`, await shown('#paa'));

  // --- 3. 要素の使い回しで戻る ---
  await page.evaluate(() => {
    document.getElementById('aio2Label').textContent = 'ニュース';
  });
  await wait(400);
  check(`${label}: 使い回されて中身が変わったら表示に戻る`, await shown('#aio2Text'));

  // --- 4. 診断 ---
  const report = await page.evaluate(() => window.__tmGoogleAio.dump());
  check(`${label}: dump() がレポートを返す`, typeof report === 'string' && report.includes('CSS ルールごとの一致数'));

  await page.evaluate(() => { location.hash = 'tmaio'; });
  await wait(300);
  check(`${label}: #tmaio で診断パネルが出る`, await shown('#tm-google-hide-aio-panel'));

  await browser.close();
}

(async () => {
  await run({ width: 1280, height: 900 }, 'パソコン');
  await run({ width: 393, height: 852 }, 'iPhone幅');

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
