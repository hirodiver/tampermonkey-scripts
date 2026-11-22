const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// x-following-tab.user.js の検証用ハーネス。
//
// X ホームのタブ列（[role="tablist"] > [role="tab"]）を模したDOMを組み、
// ヘッドレスChromium に document-idle 相当（読み込み後の evaluate）でスクリプトを流し込んで、
// 「おすすめが消える／フォロー中は残る／おすすめ選択中ならフォロー中へ切り替える／
//   連打しない／ホーム以外のおすすめタブは消さない／SPA遷移で戻ってきても効く／
//   タブが作り直されても再び消える」を確認する。
//
//   NODE_PATH=$(npm root -g) node test/x-following-tab.test.js
//
// X の実DOMそのものではないので、これに通ることは実機で動くことを保証しない。

const SCRIPT = fs.readFileSync(
    process.env.SCRIPT_PATH ||
        path.join(__dirname, '..', 'x-following-tab.user.js'),
    'utf8'
);

const HTML = `<!doctype html><meta charset="utf-8"><title>x-mock</title>
<body>
<main id="primary"></main>
<script>
  window.tabClicks = [];

  // タブ列を組む。tabs: [{ id, label, selected }]
  // X と同じく、クリックされたタブが選択状態になる
  window.mkTabs = function (tabs) {
    const primary = document.getElementById('primary');
    primary.replaceChildren();
    const nav = document.createElement('nav');
    nav.setAttribute('role', 'navigation');
    const list = document.createElement('div');
    list.setAttribute('role', 'tablist');
    for (const t of tabs) {
      const tab = document.createElement('div');
      tab.setAttribute('role', 'tab');
      tab.id = t.id;
      tab.setAttribute('aria-selected', t.selected ? 'true' : 'false');
      const span = document.createElement('span');
      span.textContent = ' ' + t.label + ' ';
      tab.appendChild(span);
      tab.addEventListener('click', () => {
        window.tabClicks.push(t.id);
        list.querySelectorAll('[role="tab"]').forEach((x) => x.setAttribute('aria-selected', 'false'));
        tab.setAttribute('aria-selected', 'true');
      });
      list.appendChild(tab);
    }
    nav.appendChild(list);
    primary.appendChild(nav);
    const timeline = document.createElement('section');
    timeline.id = 'timeline';
    primary.appendChild(timeline);
  };

  window.homeTabs = (selectForYou) => window.mkTabs([
    { id: 'forYou', label: 'おすすめ', selected: selectForYou },
    { id: 'following', label: 'フォロー中', selected: !selectForYou },
    { id: 'list1', label: '最推し達', selected: false }
  ]);

  // X 側がおすすめを選び直す（タブの選択だけを書き換える）
  window.reselectForYou = () => {
    document.getElementById('following').setAttribute('aria-selected', 'false');
    document.getElementById('forYou').setAttribute('aria-selected', 'true');
  };

  // タイムラインにセルを1つ足す（DOM変化を起こすため）
  window.addCell = () => {
    const cell = document.createElement('div');
    cell.setAttribute('data-testid', 'cellInnerDiv');
    cell.textContent = '投稿';
    document.getElementById('timeline').appendChild(cell);
  };
</script>
</body>`;

const results = [];
function check(name, cond, extra) {
    results.push({ name, ok: !!cond });
    console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra && !cond ? '  -> ' + JSON.stringify(extra) : ''));
}

// 本体の現状の挙動を記録するだけの項目（通過数には数えない）
const knowns = [];
function known(name, cond, extra) {
    knowns.push({ name, ok: !!cond });
    console.log((cond ? 'KNOWN ' : 'KNOWN(変化あり) ') + name + (extra ? '  -> ' + JSON.stringify(extra) : ''));
}

async function openPage(browser, url, setup) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.route('https://x.com/**', (route) =>
        route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML })
    );
    await page.goto(url);
    await page.evaluate(setup);
    await page.evaluate(SCRIPT);
    return page;
}

(async () => {
    const browser = await chromium.launch();

    const display = (page, id) => page.evaluate((id) => {
        const el = document.getElementById(id);
        return el ? getComputedStyle(el).display : null;
    }, id);
    const selected = (page, id) => page.evaluate((id) =>
        document.getElementById(id)?.getAttribute('aria-selected'), id);
    const tabClicks = (page) => page.evaluate(() => window.tabClicks.slice());

    // --- 1. ホームでおすすめが選択されている ---
    {
        const page = await openPage(browser, 'https://x.com/home', () => window.homeTabs(true));
        const wait = (ms) => page.waitForTimeout(ms);

        await wait(700);
        check('非表示: 「おすすめ」タブが消える', (await display(page, 'forYou')) === 'none');
        check('非表示: 目印の属性が付く', await page.evaluate(() =>
            document.getElementById('forYou').hasAttribute('data-tm-following-hidden')));
        check('残す: 「フォロー中」タブは消えない', (await display(page, 'following')) !== 'none');
        check('残す: リストのタブは消えない', (await display(page, 'list1')) !== 'none');
        check('切替: おすすめ選択中ならフォロー中をクリックする', (await selected(page, 'following')) === 'true',
            await tabClicks(page));
        check('切替: クリックは1回だけ', (await tabClicks(page)).length === 1, await tabClicks(page));

        // X 側がすぐにおすすめへ戻した場合、1.5秒以内は押し直さない（連打防止）
        await page.evaluate(() => {
            window.reselectForYou();
            window.addCell();
        });
        await wait(400);
        check('連打防止: 1.5秒以内は押し直さない', (await tabClicks(page)).length === 1, await tabClicks(page));

        await wait(1200);
        await page.evaluate(() => window.addCell());
        await wait(400);
        check('連打防止: 間隔が空けば再びフォロー中へ切り替える', (await tabClicks(page)).length === 2 &&
            (await selected(page, 'following')) === 'true', await tabClicks(page));

        // React の再描画でタブ列が作り直された（別要素になった）場合も、また消える
        await page.evaluate(() => window.homeTabs(false));
        await wait(400);
        check('作り直し: 新しい「おすすめ」タブも消える', (await display(page, 'forYou')) === 'none');
        check('作り直し: フォロー中が選択済みならクリックしない', (await tabClicks(page)).length === 2, await tabClicks(page));

        // 現状の挙動: 隠した要素がそのまま別ラベルに使い回されても、表示に戻さない
        await page.evaluate(() => {
            document.querySelector('#forYou span').textContent = '話題';
            window.addCell();
        });
        await wait(400);
        known('隠した要素が別ラベルに使い回されても表示へ戻さない（目印を外す処理が無い）',
            (await display(page, 'forYou')) === 'none');

        await page.close();
    }

    // --- 2. 英語表示 ---
    {
        const page = await openPage(browser, 'https://x.com/home', () => window.mkTabs([
            { id: 'forYou', label: 'For you', selected: true },
            { id: 'following', label: 'Following', selected: false }
        ]));
        await page.waitForTimeout(700);
        check('英語: 「For you」が消える', (await display(page, 'forYou')) === 'none');
        check('英語: 「Following」へ切り替える', (await selected(page, 'following')) === 'true');
        await page.close();
    }

    // --- 3. フォロー中タブが見つからない ---
    {
        const page = await openPage(browser, 'https://x.com/home', () => window.mkTabs([
            { id: 'forYou', label: 'おすすめ', selected: true },
            { id: 'other', label: '新しいタブ', selected: false }
        ]));
        await page.waitForTimeout(700);
        check('保険: フォロー中が無いときはおすすめを隠さない', (await display(page, 'forYou')) !== 'none');
        check('保険: フォロー中が無いときは何もクリックしない', (await tabClicks(page)).length === 0);
        await page.close();
    }

    // --- 4. ホーム以外 ---
    {
        // 「話題を検索」にも「おすすめ」タブがある
        const page = await openPage(browser, 'https://x.com/explore', () => window.mkTabs([
            { id: 'forYou', label: 'おすすめ', selected: true },
            { id: 'following', label: 'フォロー中', selected: false },
            { id: 'trend', label: 'トレンド', selected: false }
        ]));
        const wait = (ms) => page.waitForTimeout(ms);

        await wait(700);
        check('範囲外: ホーム以外の「おすすめ」タブは消さない', (await display(page, 'forYou')) !== 'none');
        check('範囲外: ホーム以外ではタブを切り替えない', (await tabClicks(page)).length === 0);

        // SPA遷移でホームへ来た（history API。スクリプトは DOM 変化のついでに URL を見る）
        await page.evaluate(() => {
            history.pushState({}, '', '/home');
            window.homeTabs(true);
        });
        await wait(900);
        check('SPA: ホームへ遷移すると「おすすめ」が消える', (await display(page, 'forYou')) === 'none');
        check('SPA: ホームへ遷移するとフォロー中へ切り替える', (await selected(page, 'following')) === 'true');

        // 話題へ移り、そこのタブ列が描画される
        await page.evaluate(() => {
            history.pushState({}, '', '/explore');
            window.mkTabs([
                { id: 'forYou2', label: 'おすすめ', selected: true },
                { id: 'trend', label: 'トレンド', selected: false }
            ]);
        });
        await wait(900);
        check('SPA: ホームから離れた先の「おすすめ」は消さない', (await display(page, 'forYou2')) !== 'none');

        await page.close();
    }

    await browser.close();

    const failed = results.filter((r) => !r.ok);
    console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通過' +
        (knowns.length ? '（ほかに現状の挙動の記録 ' + knowns.length + ' 件）' : ''));
    process.exit(failed.length ? 1 : 0);
})();
