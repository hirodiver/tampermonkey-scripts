const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// x-hide-note-notice.user.js の検証用ハーネス。
//
// X の通知タブ（section[role="region"] 内の div[data-testid="cellInnerDiv"]）を模したDOMを組み、
// ヘッドレスChromium に document-idle 相当（読み込み後の evaluate）でスクリプトを流し込んで、
// 「コミュニティノートの通知が消える／ほかの通知は残る／要素の使い回しで戻る／
//   通知ページから離れたら戻す／通知ページ以外では消さない」を確認する。
//
//   NODE_PATH=$(npm root -g) node test/x-hide-note-notice.test.js
//
// X の実DOMそのものではないので、これに通ることは実機で動くことを保証しない。

const SCRIPT = fs.readFileSync(
    process.env.SCRIPT_PATH ||
        path.join(__dirname, '..', 'x-hide-note-notice.user.js'),
    'utf8'
);

const HTML = `<!doctype html><meta charset="utf-8"><title>x-mock</title>
<body>
<main>
  <section role="region" id="timeline"><div id="list"></div></section>
</main>
<script>
  // 通知セルを1つ足す
  window.mkCell = function (id, text) {
    const cell = document.createElement('div');
    cell.setAttribute('data-testid', 'cellInnerDiv');
    cell.id = id;
    const article = document.createElement('article');
    article.textContent = text;
    cell.appendChild(article);
    document.getElementById('list').appendChild(cell);
    return cell;
  };

  // X の仮想スクロールと同じく、セル要素はそのままで中身だけ差し替える
  window.reuseCell = function (id, text) {
    const cell = document.getElementById(id);
    const article = document.createElement('article');
    article.textContent = text;
    cell.replaceChildren(article);
  };
</script>
</body>`;

const NOTE_JA = 'あなたが評価したポストにコミュニティノートが表示されました';
const NOTE_EN = 'A Community Note was added to a post you rated';
const NORMAL = 'テストユーザーさんがあなたのポストをいいねしました';

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
    await page.evaluate(setup, { ja: NOTE_JA, en: NOTE_EN, normal: NORMAL });
    await page.evaluate(SCRIPT);
    return page;
}

(async () => {
    const browser = await chromium.launch();

    const display = (page, id) => page.evaluate((id) => {
        const el = document.getElementById(id);
        return el ? getComputedStyle(el).display : null;
    }, id);

    // --- 1. 通知ページ ---
    {
        const page = await openPage(browser, 'https://x.com/notifications', ({ ja, en, normal }) => {
            window.mkCell('note1', ja);
            window.mkCell('like1', normal);
            window.mkCell('note2', en);
        });
        const wait = (ms) => page.waitForTimeout(ms);

        await wait(700);
        check('非表示: 日本語のノート通知が消える', (await display(page, 'note1')) === 'none');
        check('非表示: 英語のノート通知が消える', (await display(page, 'note2')) === 'none');
        check('非表示: 目印の属性が付く（削除ではなく display:none）', await page.evaluate(() =>
            document.getElementById('note1').getAttribute('data-tm-note-hidden') === '1'));
        check('残す: ほかの通知は消えない', (await display(page, 'like1')) !== 'none');

        // スクロールで後から読み込まれた通知
        await page.evaluate(({ ja, normal }) => {
            window.mkCell('note3', ja);
            window.mkCell('like2', normal);
        }, { ja: NOTE_JA, normal: NORMAL });
        await wait(400);
        check('追加分: 後から来たノート通知も消える', (await display(page, 'note3')) === 'none');
        check('追加分: 後から来たほかの通知は残る', (await display(page, 'like2')) !== 'none');

        // 要素の使い回し: 通常 → ノート
        await page.evaluate(({ ja }) => window.reuseCell('like1', ja), { ja: NOTE_JA });
        await wait(400);
        check('使い回し: 通常の通知だった要素にノートが入ると消える', (await display(page, 'like1')) === 'none');

        // 要素の使い回し: ノート → 通常（同時にほかのセルも足される、スクロール時のふつうの形）
        await page.evaluate(({ normal }) => {
            window.reuseCell('note1', normal);
            window.mkCell('like3', normal);
        }, { normal: NORMAL });
        await wait(400);
        check('使い回し: 隠した要素に通常の通知が入ると表示へ戻る', (await display(page, 'note1')) !== 'none');
        check('使い回し: 戻したら目印も外れる', await page.evaluate(() =>
            !document.getElementById('note1').hasAttribute('data-tm-note-hidden')));

        // 現状の挙動: 隠した要素の中身だけが差し替わり、ほかにDOM変化が無いと戻らない
        // （隠した要素の中の変更は、無限ループ防止のため監視で無視している）
        await page.evaluate(({ normal }) => window.reuseCell('note2', normal), { normal: NORMAL });
        await wait(600);
        known('隠した要素の中身だけが通常の通知に差し替わると、次のDOM変化まで隠れたまま',
            (await display(page, 'note2')) === 'none');
        await page.evaluate(({ normal }) => window.mkCell('like4', normal), { normal: NORMAL });
        await wait(400);
        check('使い回し: ほかのDOM変化があれば、隠れていた通常の通知も戻る', (await display(page, 'note2')) !== 'none');

        // 通知ページから離れる（SPA。スクリプトは DOM 変化のついでに URL を見る）
        await page.evaluate(({ ja }) => {
            history.pushState({}, '', '/home');
            window.mkCell('homeCell', ja);
        }, { ja: NOTE_JA });
        await wait(800);
        check('離脱: 通知ページ以外へ移ると隠した要素を表示へ戻す', (await display(page, 'note3')) !== 'none' &&
            (await display(page, 'like1')) !== 'none');
        check('離脱: 移った先のノートを含む投稿は消さない', (await display(page, 'homeCell')) !== 'none');

        // 通知ページへ戻る（popstate）
        await page.evaluate(() => history.back());
        await wait(800);
        check('復帰: 通知ページへ戻るとノート通知を再び消す', (await display(page, 'note3')) === 'none');

        await page.close();
    }

    // --- 2. 通知ページ以外で開いた ---
    {
        const page = await openPage(browser, 'https://x.com/home', ({ ja, normal }) => {
            window.mkCell('noteTweet', ja);
            window.mkCell('tweet', normal);
        });
        await page.waitForTimeout(700);
        check('範囲外: ホームのノートを含む投稿は消さない', (await display(page, 'noteTweet')) !== 'none');
        await page.close();
    }

    // --- 3. 「すべて」以外の通知タブ（/notifications/mentions）も対象 ---
    {
        const page = await openPage(browser, 'https://x.com/notifications/mentions', ({ ja }) => {
            window.mkCell('mentionNote', ja);
        });
        await page.waitForTimeout(700);
        check('範囲: /notifications 配下のタブでもノート通知を消す', (await display(page, 'mentionNote')) === 'none');
        await page.close();
    }

    await browser.close();

    const failed = results.filter((r) => !r.ok);
    console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通過' +
        (knowns.length ? '（ほかに現状の挙動の記録 ' + knowns.length + ' 件）' : ''));
    process.exit(failed.length ? 1 : 0);
})();
