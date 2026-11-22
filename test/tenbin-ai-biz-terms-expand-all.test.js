const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// tenbin-ai-biz-terms-expand-all.user.js の検証用ハーネス。
//
// 天秤AI Biz「主要AI約款比較」ページのアコーディオン
// （.detail-card > .detail-card-header[onclick="toggleAcc(this.parentElement)"]）を模したDOMを組み、
// ヘッドレスChromium に document-idle 相当（読み込み後の evaluate）でスクリプトを流し込んで、
// 「閉じた項目が全部開く／開いていた項目は閉じない／手で閉じた項目を開き直さない／
//   全部開く・全部閉じるボタン／一覧が遅れて描画されても開く」を確認する。
//
//   NODE_PATH=$(npm root -g) node test/tenbin-ai-biz-terms-expand-all.test.js
//
// 天秤AI の実DOMそのものではないので、これに通ることは実機で動くことを保証しない。

const SCRIPT = fs.readFileSync(
    process.env.SCRIPT_PATH ||
        path.join(__dirname, '..', 'tenbin-ai-biz-terms-expand-all.user.js'),
    'utf8'
);

// ページ側のトグル関数と、カードを組む関数。
// cards: [{ id, open }]、delay: 一覧を描画するまでの待ち時間（null なら最初から描画済み）
function pageHtml(cards, delay) {
    return `<!doctype html><meta charset="utf-8"><title>tenbin-mock</title>
<style>
  .detail-card-body { display: none; }
  .detail-card.open .detail-card-body { display: block; }
</style>
<body>
<h1>主要AI約款比較</h1>
<div id="list"></div>
<script>
  window.toggleCount = {};
  function toggleAcc(card) {
    card.classList.toggle('open');
    window.toggleCount[card.id] = (window.toggleCount[card.id] || 0) + 1;
  }
  window.mkCard = function (id, open, noHeader) {
    const card = document.createElement('div');
    card.className = 'detail-card' + (open ? ' open' : '');
    card.id = id;
    if (!noHeader) {
      const header = document.createElement('div');
      header.className = 'detail-card-header';
      header.setAttribute('onclick', 'toggleAcc(this.parentElement)');
      header.textContent = id + ' 学習への利用';
      card.appendChild(header);
    }
    const body = document.createElement('div');
    body.className = 'detail-card-body';
    body.textContent = id + ' の本文';
    card.appendChild(body);
    document.getElementById('list').appendChild(card);
    return card;
  };
  const cards = ${JSON.stringify(cards)};
  const render = () => cards.forEach((c) => window.mkCard(c.id, c.open, c.noHeader));
  ${delay === null ? 'render();' : `setTimeout(render, ${delay});`}
</script>
</body>`;
}

const results = [];
function check(name, cond, extra) {
    results.push({ name, ok: !!cond });
    console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra && !cond ? '  -> ' + JSON.stringify(extra) : ''));
}

async function openPage(browser, cards, delay) {
    const page = await browser.newPage();
    await page.route('https://biz.tenbin.ai/**', (route) =>
        route.fulfill({ contentType: 'text/html; charset=utf-8', body: pageHtml(cards, delay) })
    );
    await page.goto('https://biz.tenbin.ai/trust');
    await page.evaluate(SCRIPT);
    return page;
}

(async () => {
    const browser = await chromium.launch();

    const openStates = (page) => page.evaluate(() =>
        Object.fromEntries([...document.querySelectorAll('.detail-card')]
            .map((c) => [c.id, c.classList.contains('open')])));
    const bodyShown = (page, id) => page.evaluate((id) =>
        getComputedStyle(document.querySelector('#' + id + ' .detail-card-body')).display !== 'none', id);
    const clickPanel = (page, label) => page.evaluate((label) => {
        [...document.querySelectorAll('#tm-tenbin-expand-panel button')]
            .find((b) => b.textContent === label).click();
    }, label);

    // --- 1. 描画済みの一覧 ---
    {
        const page = await openPage(browser, [
            { id: 'B10', open: false },
            { id: 'B11', open: true },
            { id: 'B12', open: false },
            { id: 'B13', open: false, noHeader: true }
        ], null);
        const wait = (ms) => page.waitForTimeout(ms);

        check('パネル: 右下に操作パネルが出る', await page.evaluate(() => !!document.getElementById('tm-tenbin-expand-panel')));
        check('パネル: 「全部開く」「全部閉じる」の2つ', await page.evaluate(() =>
            [...document.querySelectorAll('#tm-tenbin-expand-panel button')].map((b) => b.textContent).join(',') === '全部開く,全部閉じる'));

        await wait(200);
        check('自動展開: 起動直後（500ms前）はまだ触らない', (await openStates(page)).B10 === false);

        await wait(600);
        const states = await openStates(page);
        check('自動展開: 閉じていた項目が開く', states.B10 && states.B12, states);
        check('自動展開: 開いた項目の本文が見える（ページ側の onclick 経由）', await bodyShown(page, 'B10'));
        check('自動展開: 最初から開いていた項目は閉じない（クリックしない）', states.B11 &&
            (await page.evaluate(() => !window.toggleCount.B11)), await page.evaluate(() => window.toggleCount));
        check('自動展開: 各項目のクリックは1回だけ', await page.evaluate(() =>
            window.toggleCount.B10 === 1 && window.toggleCount.B12 === 1), await page.evaluate(() => window.toggleCount));
        check('自動展開: 見出しの無い項目は飛ばし、エラーにならない', states.B13 === false, states);

        // 手で1つ閉じたあと、ページ側がDOMを足しても開き直さない
        await page.evaluate(() => {
            document.querySelector('#B10 .detail-card-header').click();
            const note = document.createElement('p');
            note.textContent = '注記を追加';
            document.body.appendChild(note);
        });
        await wait(600);
        check('手動: 手で閉じた項目は開き直さない', (await openStates(page)).B10 === false);

        await clickPanel(page, '全部閉じる');
        const closed = await openStates(page);
        check('ボタン: 「全部閉じる」で全部閉じる', !closed.B10 && !closed.B11 && !closed.B12, closed);
        check('ボタン: 閉じたあと本文が隠れる', !(await bodyShown(page, 'B11')));

        await clickPanel(page, '全部開く');
        const reopened = await openStates(page);
        check('ボタン: 「全部開く」で全部開く', reopened.B10 && reopened.B11 && reopened.B12, reopened);

        await clickPanel(page, '全部開く');
        check('ボタン: 開いている状態で「全部開く」を押しても閉じない', Object.entries(await openStates(page))
            .filter(([id]) => id !== 'B13').every(([, open]) => open), await openStates(page));

        // 一通り出そろって監視を止めたあとに足された項目は、自動では開かない（手で閉じた項目を守るための仕様）
        await page.evaluate(() => window.mkCard('B20', false));
        await wait(600);
        check('監視停止後: 後から足された項目は自動では開かない（仕様）', (await openStates(page)).B20 === false);
        await clickPanel(page, '全部開く');
        check('監視停止後: 「全部開く」を押せば後から足された項目も開く', (await openStates(page)).B20 === true);

        await page.evaluate(SCRIPT);
        check('多重起動: パネルは1つだけ', await page.evaluate(() =>
            document.querySelectorAll('#tm-tenbin-expand-panel').length === 1));

        await page.close();
    }

    // --- 2. 一覧の描画が遅れる ---
    {
        const page = await openPage(browser, [
            { id: 'B10', open: false },
            { id: 'B11', open: false }
        ], 1200);
        const wait = (ms) => page.waitForTimeout(ms);

        await wait(800);
        check('遅延描画: 一覧が無いうちは何もしない', await page.evaluate(() =>
            document.querySelectorAll('.detail-card').length === 0));

        await wait(900);
        const states = await openStates(page);
        check('遅延描画: 一覧が後から描画されても全部開く', states.B10 && states.B11, states);

        await page.close();
    }

    await browser.close();

    const failed = results.filter((r) => !r.ok);
    console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通過');
    process.exit(failed.length ? 1 : 0);
})();
