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

const HTML = `<!doctype html><meta charset="utf-8"><title>x-mock</title>
<style>
  body { margin: 0; }
  #timeline { width: 100%; }
  [data-testid="cellInnerDiv"] { width: 100%; }
  .bar { width: 100%; height: 60px; }
  article { width: 100%; min-height: 120px; }
</style>
<body>
<div id="timeline" role="region"></div>
</body>`;

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra && !cond ? '  -> ' + JSON.stringify(extra) : ''));
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

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

    // iPhone版のX を模した帯（href が無く role=button で描かれる）
    window.fillButtonBar = (cell) => {
      cell.replaceChildren();
      const wrap = document.createElement('div');
      wrap.className = 'bar';
      wrap.setAttribute('role', 'button');
      wrap.setAttribute('aria-label', 'スペース');
      const label = document.createElement('span');
      label.textContent = 'スペース  ライブ中  税務のはなし';
      wrap.appendChild(label);
      cell.appendChild(wrap);
      return cell;
    };

    // 実機（iPhone）で確認された帯そのもの。
    // 紫の角丸、横長で低い、文中に「スペース」の語が無い
    window.fillRealBar = (cell) => {
      cell.replaceChildren();
      const bar = document.createElement('div');
      bar.id = 'realInner';
      bar.setAttribute('style', 'background-color: rgb(120, 86, 255); border-radius: 28px; height: 56px; width: 100%; display: flex; align-items: center;');
      const avatar = document.createElement('img');
      const label = document.createElement('span');
      label.textContent = '+25 ・ ライトノベル雑談（このラノとか）';
      bar.append(avatar, label);
      cell.appendChild(bar);
      return cell;
    };

    // 紫だが小さいボタン（消してはいけない）
    window.mkPurpleButton = () => {
      const button = document.createElement('div');
      button.id = 'purpleButton';
      button.setAttribute('role', 'button');
      button.setAttribute('style', 'background-color: rgb(120, 86, 255); width: 80px; height: 36px;');
      button.textContent = 'フォロー';
      document.body.appendChild(button);
      return button;
    };

    // 紫の帯を含む「投稿」（消してはいけない）
    window.fillPurpleTweet = (cell) => {
      window.fillTweet(cell, 'スペースの告知です');
      const bar = document.createElement('div');
      bar.setAttribute('style', 'background-color: rgb(120, 86, 255); height: 56px; width: 100%;');
      bar.textContent = '+3 ・ 告知カード';
      cell.querySelector('article').appendChild(bar);
      return cell;
    };

    // 実機レポートのとおりの構造を組む。
    // nav > div > [ScrollSnap-SwipeableList] > [ScrollSnap-List]
    //   > [placementTracking] > button > div > [pill-contents-container]
    window.mkHeaderNav = () => {
      const nav = document.createElement('nav');
      nav.id = 'headerNav';
      document.body.insertBefore(nav, document.body.firstChild);
      return nav;
    };

    window.mkPill = (nav, id, label, opts = {}) => {
      const outer = document.createElement('div');
      outer.id = id;
      // 実機と同じく入れ物が高さを持つ（帯を消しても空白が残る作り）
      outer.setAttribute('style', 'width: 100%; height: 52px;');

      const swipeable = document.createElement('div');
      swipeable.setAttribute('data-testid', 'ScrollSnap-SwipeableList');

      const list = document.createElement('div');
      list.setAttribute('data-testid', 'ScrollSnap-List');

      const track = document.createElement('div');
      track.setAttribute('data-testid', 'placementTracking');
      track.setAttribute('style', 'width: 386px; height: 36px;');

      const button = document.createElement('button');
      const inner = document.createElement('div');

      const contents = document.createElement('div');
      contents.setAttribute('data-testid', opts.keep ? 'pillLabel' : 'pill-contents-container');
      contents.textContent = label;

      inner.appendChild(contents);
      button.appendChild(inner);
      track.appendChild(button);
      list.appendChild(track);
      swipeable.appendChild(list);
      outer.appendChild(swipeable);
      nav.appendChild(outer);
      return outer;
    };

    // 帯を消したあと、入れ物に矢印アイコンだけが残る実機の状況
    window.mkPillWithArrow = (nav, id, opts = {}) => {
      const outer = window.mkPill(nav, id, '+23・ライトノベル雑談（このラノとか）');
      const arrow = document.createElement('div');
      arrow.setAttribute('style', 'width: 24px; height: 24px;');
      if (opts.keeper) {
        arrow.setAttribute('aria-label', '新しいポストを表示');
      }
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '24');
      svg.setAttribute('height', '24');
      arrow.appendChild(svg);
      outer.querySelector('[data-testid="ScrollSnap-SwipeableList"]').appendChild(arrow);
      return outer;
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
    window.fillButtonBar(window.mkCell('buttonBar'));
    window.fillRealBar(window.mkCell('realBar'));
    window.fillPurpleTweet(window.mkCell('purpleTweet'));
    window.mkPurpleButton();

    const nav = window.mkHeaderNav();
    window.mkPill(nav, 'spacePill', '+23・ライトノベル雑談（このラノとか）');
    window.mkPill(nav, 'newPostsPill', '新しいポストを表示', { keep: true });
    window.mkPillWithArrow(nav, 'arrowPill');
    window.mkPillWithArrow(nav, 'keeperPill', { keeper: true });
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
  check('CSS: スペースピルが即座に消える（一瞬も見せない）', (await shown('spacePill')) === false);
  check('CSS: 「新しいポストを表示」は即座には消さない', (await shown('newPostsPill')) === true);

  // JS パスの結果を待つ
  await page.waitForTimeout(900);

  check('JS: 目印なしの帯も消える', (await shown('bare')) === false);
  check('JS: リンクの無い帯（iPhone版想定）も消える', (await shown('buttonBar')) === false);
  check('色: 実機の紫バー（「スペース」の語なし）が消える', (await shown('realBar')) === false);
  check('色: 紫でも小さいボタンは消えない', (await shown('purpleButton')) === true);
  check('色: 紫の帯を含む投稿は消えない', (await shown('purpleTweet')) === true);
  check('ピル: 実機構造のスペースピルが消える', (await shown('spacePill')) === false);
  check('ピル: 「新しいポストを表示」は残る', (await shown('newPostsPill')) === true);
  check('ピル: 「新しいポストを表示」が同居する入れ物は帯だけ消す', await page.evaluate(() => {
    const outer = document.getElementById('keeperPill');
    return outer.getBoundingClientRect().height > 0 &&
      getComputedStyle(outer.querySelector('[data-testid="placementTracking"]')).display === 'none';
  }));
  check('ピル: 矢印だけの入れ物も帯ごと消える', (await shown('arrowPill')) === false);
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
  check('診断: __tmSpacesBar.dump() が動く', await page.evaluate(() => (window.__tmSpacesBar.dump() || '').includes('帯として検出')));

  // --- 診断パネル（iPhone ではコンソールが使えないため） ---
  await page.evaluate(() => { location.hash = '#tmspaces'; });
  await page.waitForTimeout(700);
  check('診断パネル: #tmspaces で画面に出る', await page.evaluate(() => !!document.getElementById('tm-hide-spaces-bar-panel')));
  check('診断パネル: レポートに帯の情報が載る', await page.evaluate(() => {
    const area = document.querySelector('#tm-hide-spaces-bar-panel textarea');
    return !!area && area.value.includes('帯として検出');
  }));
  check('診断パネル: 閉じられる', await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('#tm-hide-spaces-bar-panel button')];
    buttons.find((b) => b.textContent === '閉じる').click();
    return !document.getElementById('tm-hide-spaces-bar-panel');
  }));
  await page.evaluate(() => { location.hash = ''; });
  await page.waitForTimeout(400);

  // --- 診断に空白の出どころが載る ---
  await page.evaluate(() => { location.hash = '#tmspaces'; });
  await page.waitForTimeout(700);
  check('診断: 消した帯の親の高さが載る', await page.evaluate(() => {
    const area = document.querySelector('#tm-hide-spaces-bar-panel textarea');
    return !!area && area.value.includes('消した帯の親の高さ') && area.value.includes('子の高さ');
  }));
  await page.evaluate(() => {
    document.getElementById('tm-hide-spaces-bar-panel')?.remove();
    location.hash = '';
  });
  await page.waitForTimeout(400);

  // --- 後から追加された帯 ---
  await page.evaluate(() => window.fillSpaceBar(window.mkCell('later')));
  await page.waitForTimeout(100);
  check('後入り: 遅れて現れた帯も消える', (await shown('later')) === false);

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通過');
  process.exit(failed.length ? 1 : 0);
})();
