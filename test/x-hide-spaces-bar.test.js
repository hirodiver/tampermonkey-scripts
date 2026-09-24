const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// x-hide-spaces-bar.user.js の検証用ハーネス。
//
// iPhone の実機診断で確認したヘッダの入れ子をそのまま組み、
// ヘッドレスChromium（iPhone相当の幅）にスクリプトを流し込んで確認する。
//
//   NODE_PATH=$(npm root -g) node test/x-hide-spaces-bar.test.js
//
// Xの実DOMそのものではないので、これに通ることは実機で動くことを保証しない。
// 帯を消す経路は実機で効くことを確認済み（v1.6.0以降）。

const SCRIPT = fs.readFileSync(
  process.env.SCRIPT_PATH ||
    path.join(__dirname, '..', 'x-hide-spaces-bar.user.js'),
  'utf8'
);

// 実機診断の値を再現する:
//   depth4: absolute, 56px
//   depth3: relative, 56px
//   depth2: absolute, padding-top 56px, クラス指定で 112px
//   depth1: div
//   depth0: nav
//   帯:     nav > div > SwipeableList > List > placementTracking > button > div > pill
const HTML = `<!doctype html><meta charset="utf-8"><title>x-mock</title>
<style>
  body { margin: 0; }
  #header { position: fixed; top: 0; left: 0; right: 0; background: #fff; }
  #tabs { height: 51px; }
  .d4 { position: relative; height: 56px; }
  .d3 { position: relative; height: 56px; }
  .d2 { position: absolute; top: 0; left: 0; right: 0; height: 112px; padding-top: 56px; box-sizing: border-box; }
  .row { width: 100%; height: 52px; }
  .track { width: 386px; height: 36px; }
  #timeline { padding-top: 163px; }
  [data-testid="cellInnerDiv"] { height: 120px; }
</style>
<body>
<div id="header">
  <div id="tabs">フォロー中 リポスト 最推し達</div>
  <div class="d4" id="d4"><div class="d3" id="d3"><div class="d2" id="d2" role="grid"><div id="d1">
    <nav id="headerNav"></nav>
  </div></div></div></div>
</div>
<section role="region" id="timeline"></section>
</body>`;

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra && !cond ? '  -> ' + JSON.stringify(extra) : ''));
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

  await page.route('https://x.com/**', (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML })
  );
  await page.goto('https://x.com/home');

  // --- フィクスチャ ---
  await page.evaluate(() => {
    // ピル1枚を組む
    window.mkPill = (parent, id, label, opts = {}) => {
      const row = document.createElement('div');
      row.id = id;
      row.className = 'row';

      const swipeable = document.createElement('div');
      swipeable.setAttribute('data-testid', 'ScrollSnap-SwipeableList');

      const list = document.createElement('div');
      list.setAttribute('data-testid', 'ScrollSnap-List');
      list.setAttribute('role', 'tablist');

      const track = document.createElement('div');
      track.setAttribute('data-testid', 'placementTracking');
      track.className = 'track';
      track.id = id + 'Track';

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
      row.appendChild(swipeable);

      if (opts.keeperArrow) {
        const arrow = document.createElement('div');
        arrow.setAttribute('aria-label', '新しいポストを表示');
        arrow.setAttribute('style', 'width: 24px; height: 24px;');
        swipeable.appendChild(arrow);
      }

      parent.appendChild(row);
      return row;
    };

    window.mkCell = (id, text) => {
      const cell = document.createElement('div');
      cell.setAttribute('data-testid', 'cellInnerDiv');
      cell.id = id;
      const art = document.createElement('article');
      art.setAttribute('data-testid', 'tweet');
      art.textContent = text;
      cell.appendChild(art);
      document.getElementById('timeline').appendChild(cell);
      return cell;
    };

    const nav = document.getElementById('headerNav');
    window.mkPill(nav, 'spacePill', '+23・ライトノベル雑談（このラノとか）');
    window.mkCell('tweet1', 'ふつうの投稿');
  });

  const display = (id) =>
    page.evaluate((id) => {
      const el = document.getElementById(id);
      return el ? getComputedStyle(el).display : null;
    }, id);

  // --- スクリプト投入 ---
  await page.evaluate(SCRIPT);

  // CSS だけで消しているので、待たずに効いているはず
  check('CSS: スタイルが注入される', await page.evaluate(() => !!document.getElementById('tm-hide-spaces-bar-style')));
  check('CSS: 帯が待たずに消える（一瞬も見せない）', (await display('spacePill')) === 'none');
  check('CSS: タブは消えない', (await display('tabs')) !== 'none');
  check('CSS: 投稿は消えない', (await display('tweet1')) !== 'none');

  // --- 実機と同じ条件（nav に帯1本だけ）での診断 ---
  // 帯専用の範囲は nav を越え、タブを含むヘッダ本体の手前まで伸びるはず
  //   pill0 > div1 > button2 > track3 > list4 > swipeable5 > row6 > nav7 > d1 8 > d2 9 > d3 10 > d4 11 > header12
  await page.evaluate(() => { location.hash = '#tmspaces'; });
  await page.waitForTimeout(300);
  const aloneReport = await page.evaluate(() =>
    document.querySelector('#tm-hide-spaces-bar-panel textarea')?.value || '');
  const aloneDepth = /帯専用の一番外側: 深さ (\d+)/.exec(aloneReport);
  check('診断: 帯が1本だけなら、帯専用の範囲はヘッダ本体の手前（深さ11）まで伸びる',
    aloneDepth && aloneDepth[1] === '11', aloneDepth && aloneDepth[1]);
  await page.evaluate(() => {
    document.getElementById('tm-hide-spaces-bar-panel')?.remove();
    location.hash = '';
  });
  await page.waitForTimeout(100);

  check('枠: 帯専用の枠（深さ12）の高さが0になる', await page.evaluate(() =>
    document.getElementById('d4').getBoundingClientRect().height === 0));
  check('枠: タブ行は残る', await page.evaluate(() =>
    document.getElementById('tabs').getBoundingClientRect().height === 51));
  check('枠: タブを含むヘッダ本体は潰さない', await page.evaluate(() =>
    document.getElementById('header').getBoundingClientRect().height === 51 &&
    getComputedStyle(document.getElementById('header')).overflow !== 'hidden'));

  // --- 後から現れた帯 ---
  await page.evaluate(() => window.mkPill(document.getElementById('headerNav'), 'laterPill', '+5・雑談'));
  check('CSS: 後から現れた帯も待たずに消える', (await display('laterPill')) === 'none');

  // --- 残すもの ---
  await page.evaluate(() => {
    window.mkPill(document.getElementById('headerNav'), 'newPostsPill', '新しいポストを表示', { keep: true });
  });
  check('残す: 「新しいポストを表示」（pillLabel）は消えない', (await display('newPostsPill')) !== 'none');

  await page.evaluate(() => {
    window.mkPill(document.getElementById('headerNav'), 'sharedPill', '+3・雑談', { keeperArrow: true });
  });
  check('残す: 「新しいポストを表示」と同居する入れ物は残す', (await display('sharedPill')) !== 'none');
  check('残す: 同居していても帯そのものは消える', (await display('sharedPillTrack')) === 'none');

  // --- nav の外は触らない（広告セルも placementTracking を使う） ---
  await page.evaluate(() => {
    const cell = window.mkCell('adCell', '広告');
    window.mkPill(cell, 'pillInCell', '+1・セル内');
  });
  check('範囲: nav の外のピルには触らない', (await display('pillInCell')) !== 'none');
  check('範囲: 広告セルは消えない', (await display('adCell')) !== 'none');

  // --- 診断 ---
  await page.evaluate(() => { location.hash = '#tmspaces'; });
  await page.waitForTimeout(300);

  const report = await page.evaluate(() => {
    const area = document.querySelector('#tm-hide-spaces-bar-panel textarea');
    return area ? area.value : '';
  });

  check('診断: #tmspaces でパネルが出る', report.length > 0);
  check('診断: 計算後の height を出す（クラス指定の高さを取りこぼさない）', report.includes('"height":"112px"'));
  check('診断: padding を出す', report.includes('"padding":"56px / 0px"'));
  check('診断: 帯専用の祖先を見分ける', report.includes('"帯専用":true') && report.includes('"帯専用":false'));
  check('診断: 帯専用の一番外側の深さを出す', /帯専用の一番外側: 深さ \d+/.test(report));
  check('診断: 帯専用を越えた先（ヘッダ本体）も出す', report.includes('フォロー中') || report.includes('"帯専用":false'));
  check('診断: 画面中央の縦一列を出す', report.includes('■ 画面中央の縦一列'));
  check('診断: 最初の投稿セルの位置を出す', report.includes('最初の投稿セルの上端'));

  // nav に帯が複数並ぶと、帯専用は nav 直下の行（深さ6）で止まる
  const depthMatch = /\[0\][^\n]*\n([\s\S]*?)→ 帯専用の一番外側: 深さ (\d+)/.exec(report);
  check('診断: nav を共有していれば帯専用は nav 直下の行（深さ6）で止まる',
    depthMatch && depthMatch[2] === '6', depthMatch && depthMatch[2]);

  check('診断: dump() が同じものを返す', await page.evaluate(() => window.__tmSpacesBar.dump().includes('■ 帯')));

  // 定期更新してもパネルは作り直さない（コピー表示が消えないように）
  await page.evaluate(() => { window.__area = document.querySelector('#tm-hide-spaces-bar-panel textarea'); });
  await page.waitForTimeout(1700);
  check('診断: 定期更新で本文だけ差し替える', await page.evaluate(() =>
    document.querySelector('#tm-hide-spaces-bar-panel textarea') === window.__area));

  check('診断: 閉じられる', await page.evaluate(() => {
    [...document.querySelectorAll('#tm-hide-spaces-bar-panel button')]
      .find((b) => b.textContent === '閉じる').click();
    return !document.getElementById('tm-hide-spaces-bar-panel');
  }));

  await page.evaluate(() => { location.hash = ''; });
  await page.waitForTimeout(100);
  check('診断: ハッシュを外すと出ない', await page.evaluate(() => !document.getElementById('tm-hide-spaces-bar-panel')));

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通過');
  process.exit(failed.length ? 1 : 0);
})();
