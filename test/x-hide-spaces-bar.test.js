const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// x-hide-spaces-bar.user.js の検証用ハーネス。
//
// 実機（X本体）の代わりに、タイムラインの構造を模したDOMへ
// スクリプトを流し込み、ヘッドレスChromiumで
// 「帯だけが消え、投稿は消えない」ことを確認する。
//
//   NODE_PATH=$(npm root -g) node test/x-hide-spaces-bar.test.js
//
// Xの実DOMそのものは再現できないため、
// これに通ることは実機で動くことを保証しない。

const SCRIPT = fs.readFileSync(
  process.env.SCRIPT_PATH ||
    path.join(__dirname, '..', 'x-hide-spaces-bar.user.js'),
  'utf8'
);

const HTML = `<!doctype html><meta charset="utf-8"><title>x-mock</title><body>
<div id="timeline" role="region"></div>
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

  // --- フィクスチャ生成ヘルパ ---
  await page.evaluate(() => {
    const timeline = document.getElementById('timeline');

    window.mkCell = (id) => {
      const cell = document.createElement('div');
      cell.setAttribute('data-testid', 'cellInnerDiv');
      cell.id = id;
      timeline.appendChild(cell);
      return cell;
    };

    // スペースの帯（投稿ではない。スペースへのリンクを持つ）
    window.fillSpaceBar = (cell) => {
      cell.replaceChildren();
      const track = document.createElement('div');
      track.setAttribute('data-testid', 'placementTracking');
      const link = document.createElement('a');
      link.setAttribute('href', '/i/spaces/1AbCdEfGhIjKl');
      link.textContent = 'スペース  ライブ中  税務のはなし';
      track.appendChild(link);
      cell.appendChild(track);
      return cell;
    };

    // 目印を持たない帯（テキストだけが手がかり）
    window.fillBareBar = (cell) => {
      cell.replaceChildren();
      const label = document.createElement('div');
      label.textContent = 'スペース  ライブ中';
      cell.appendChild(label);
      return cell;
    };

    // 通常の投稿
    window.fillTweet = (cell, text) => {
      cell.replaceChildren();
      const art = document.createElement('article');
      art.setAttribute('data-testid', 'tweet');
      art.setAttribute('role', 'article');
      const body = document.createElement('div');
      body.textContent = text;
      art.appendChild(body);
      cell.appendChild(art);
      return cell;
    };

    // スペースに言及し、スペースへのリンクも持つ投稿
    window.fillTweetWithSpaceLink = (cell) => {
      window.fillTweet(cell, '今夜スペースやります');
      const link = document.createElement('a');
      link.setAttribute('href', '/i/spaces/9ZzYyXxWwVv');
      link.textContent = 'スペースを聞く';
      cell.querySelector('article').appendChild(link);
      return cell;
    };

    // 画面下部の再生バー
    window.mkDock = () => {
      const dock = document.createElement('div');
      dock.setAttribute('data-testid', 'AudioDock');
      dock.id = 'dock';
      dock.textContent = '再生中';
      document.body.appendChild(dock);
      return dock;
    };

    window.fillSpaceBar(window.mkCell('bar'));
    window.fillBareBar(window.mkCell('bare'));
    window.fillTweet(window.mkCell('tweet'), 'ふつうの投稿');
    window.fillTweetWithSpaceLink(window.mkCell('tweetSpace'));
    window.mkDock();
  });

  const shown = (id) =>
    page.evaluate((id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      return getComputedStyle(el).display !== 'none';
    }, id);

  // --- スクリプト投入 ---
  await page.evaluate(SCRIPT);

  // CSS（:has）は注入直後に効くはず
  check('CSS: :has が使える', await page.evaluate(() => CSS.supports('selector(:has(a))')));
  check('CSS: スタイルが注入される', await page.evaluate(() => !!document.getElementById('tm-hide-spaces-bar-style')));
  check('CSS: 帯は即座に消える（JS待ちなし）', (await shown('bar')) === false);
  check('CSS: 投稿は消えない', (await shown('tweet')) === true);
  check('CSS: スペース言及の投稿は消えない', (await shown('tweetSpace')) === true);

  // JS パスの結果を待つ
  await page.waitForTimeout(900);

  check('JS: 目印なしの帯も消える', (await shown('bare')) === false);
  check('JS: 再生バーが消える', (await shown('dock')) === false);
  check('JS: 投稿は消えたままにならない', (await shown('tweet')) === true);
  check('JS: スペース言及の投稿は消えない', (await shown('tweetSpace')) === true);

  // --- セルの使い回し（帯 → 投稿） ---
  await page.evaluate(() => {
    window.fillTweet(document.getElementById('bare'), 'この要素は使い回された');
    document.getElementById('timeline').appendChild(document.createElement('div'));
  });
  await page.waitForTimeout(900);
  check('使い回し: 帯だった要素が投稿になったら表示へ戻る', (await shown('bare')) === true);

  // --- 逆向きの使い回し（投稿 → 帯） ---
  await page.evaluate(() => {
    window.fillSpaceBar(document.getElementById('tweet'));
    document.getElementById('timeline').appendChild(document.createElement('div'));
  });
  await page.waitForTimeout(900);
  check('使い回し: 投稿だった要素が帯になったら消える', (await shown('tweet')) === false);

  // --- スペースのページでは隠さない ---
  await page.evaluate(() => {
    history.pushState({}, '', '/i/spaces/1AbCdEfGhIjKl');
    document.getElementById('timeline').appendChild(document.createElement('div'));
  });
  await page.waitForTimeout(900);
  check('スペースページ: 帯が表示へ戻る', (await shown('bar')) === true);
  check('スペースページ: 再生バーが表示へ戻る', (await shown('dock')) === true);

  // --- タイムラインへ戻る ---
  await page.evaluate(() => {
    history.pushState({}, '', '/home');
    document.getElementById('timeline').appendChild(document.createElement('div'));
  });
  await page.waitForTimeout(900);
  check('復帰: 帯がまた消える', (await shown('bar')) === false);
  check('復帰: 再生バーがまた消える', (await shown('dock')) === false);

  // --- 診断関数 ---
  check('診断: __tmSpacesBar.dump() が動く', await page.evaluate(() => Array.isArray(window.__tmSpacesBar.dump())));

  // --- 後から追加された帯 ---
  await page.evaluate(() => window.fillSpaceBar(window.mkCell('later')));
  await page.waitForTimeout(100);
  check('後入り: 遅れて現れた帯も消える', (await shown('later')) === false);

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通過');
  process.exit(failed.length ? 1 : 0);
})();
