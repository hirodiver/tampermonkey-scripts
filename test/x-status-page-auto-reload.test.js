const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// x-status-page-auto-reload.user.js の検証用ハーネス。
//
// X のタイムラインと個別ポストページを模したDOMを組み、
// ヘッドレスChromium に document-start 相当でスクリプトを流し込んで、
// 「本文が出れば再読み込みしない／DOMが止まったら早め（約0.7秒）に再読み込み／
//   DOMは動くが本文が出なければ約2.5秒で再読み込み／同じポストでは1回で諦める／
//   個別ポスト以外では何もしない／途中で離れたら何もしない」を確認する。
//
//   NODE_PATH=$(npm root -g) node test/x-status-page-auto-reload.test.js
//
// 再読み込みは、ページの文書リクエストの回数で数える。
//
// 流し込みは <head> 先頭のインライン <script> で行う（<html> はあるが <body> はまだ無い時点）。
// Playwright の addInitScript は document.documentElement が null の時点で走り、
// このスクリプトの observe(document.documentElement) が例外になるため使わない
// （その場合の挙動は最後の項目で記録している）。
// X の実DOMそのものではないので、これに通ることは実機で動くことを保証しない。

const SCRIPT = fs.readFileSync(
    process.env.SCRIPT_PATH ||
        path.join(__dirname, '..', 'x-status-page-auto-reload.user.js'),
    'utf8'
);

const STATUS_PATH = '/example_user/status/1234567890';

// mode: 'timeline' はタイムライン、'loaded' は本文あり、'stuck' は読み込み中のまま止まった個別ポスト
function pageHtml(mode, inline) {
    let main = '';
    if (mode === 'timeline') {
        main = '<section id="timeline">' +
            '<div data-testid="cellInnerDiv"><article data-testid="tweet">タイムラインの投稿1</article></div>' +
            '<div data-testid="cellInnerDiv"><article data-testid="tweet">タイムラインの投稿2</article></div>' +
            '</section>';
    } else if (mode === 'loaded') {
        main = '<section id="conversation"><article data-testid="tweet">個別ポストの本文</article></section>';
    } else {
        main = '<div id="spinner" role="progressbar">読み込み中</div>';
    }
    return `<!doctype html><html><head><script>${inline ? SCRIPT : ''}</script>
<meta charset="utf-8"><title>x-mock</title></head>
<body><main id="primary">${main}</main>
<script>
  // タイムライン → 個別ポストの SPA 遷移。X と同じく history.pushState で URL を変える
  window.goStatus = (path) => {
    document.getElementById('primary').replaceChildren();
    history.pushState({}, '', path);
  };
  window.showTweet = () => {
    const a = document.createElement('article');
    a.setAttribute('data-testid', 'tweet');
    a.textContent = '個別ポストの本文';
    document.getElementById('primary').appendChild(a);
  };
  // 読み込み中の兆候（スピナーの更新など）として DOM を動かし続ける
  window.keepBusy = () => setInterval(() => {
    const s = document.createElement('span');
    s.textContent = '.';
    document.getElementById('primary').replaceChildren(s);
  }, 200);
</script>
</body>`;
}

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

// 新しい文脈（sessionStorage を分ける）でページを開く。
// modeFor(path, n): n 回目の文書リクエストに返す画面
async function openPage(browser, url, modeFor, opts = {}) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const loads = [];

    await page.route('https://x.com/**', (route) => {
        const req = route.request();
        if (req.resourceType() !== 'document') {
            return route.fulfill({ status: 204, body: '' });
        }
        const urlPath = new URL(req.url()).pathname;
        loads.push(urlPath);
        const n = loads.filter((p) => p === urlPath).length;
        return route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: pageHtml(modeFor(urlPath, n), !opts.initScript)
        });
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    if (opts.initScript) {
        await page.addInitScript(SCRIPT);
    }
    await page.goto(url);

    return {
        page,
        loads,
        errors,
        wait: (ms) => page.waitForTimeout(ms),
        close: () => context.close()
    };
}

const statusLoads = (loads) => loads.filter((p) => p === STATUS_PATH).length;

(async () => {
    const browser = await chromium.launch();

    // --- 1. 個別ポストを直接開き、本文が出る ---
    {
        const t = await openPage(browser, 'https://x.com' + STATUS_PATH, () => 'loaded');
        await t.wait(3000);
        check('直接: 本文が出ていれば再読み込みしない', statusLoads(t.loads) === 1, t.loads);
        check('直接: 本文が出たら再読み込みの記録を残さない', await t.page.evaluate((p) =>
            sessionStorage.getItem('hiroStatusAutoReload:' + p) === null, STATUS_PATH));
        await t.close();
    }

    // --- 2. 個別ポストを直接開き、固まったまま ---
    {
        const t = await openPage(browser, 'https://x.com' + STATUS_PATH, () => 'stuck');
        await t.wait(1500);
        check('直接・固まる: 読み込み直後の DOM 構築は「動きあり」とみなし、早期の再読み込みはしない',
            statusLoads(t.loads) === 1, t.loads);
        await t.wait(1600);
        check('直接・固まる: 約2.5秒で1回再読み込みする', statusLoads(t.loads) === 2, t.loads);
        await t.wait(3500);
        check('直接・固まる: 再読み込み後も固まっていれば諦める（無限に再読み込みしない）',
            statusLoads(t.loads) === 2, t.loads);
        await t.close();
    }

    // --- 3. 直接開いて固まったが、再読み込みで本文が出る ---
    {
        const t = await openPage(browser, 'https://x.com' + STATUS_PATH, (p, n) => (n === 1 ? 'stuck' : 'loaded'));
        await t.wait(5500);
        check('直接・復帰: 再読み込み後に本文が出れば、それ以上再読み込みしない', statusLoads(t.loads) === 2, t.loads);
        check('直接・復帰: 本文が出たら記録を消す（次に開いたとき再び監視できる）', await t.page.evaluate((p) =>
            sessionStorage.getItem('hiroStatusAutoReload:' + p) === null, STATUS_PATH));
        await t.close();
    }

    // --- 4. タイムライン → 個別ポスト（SPA）で、DOM が止まる ---
    {
        const t = await openPage(browser, 'https://x.com/home', (p, n) => (p === '/home' ? 'timeline' : 'loaded'));
        await t.wait(1000);
        check('タイムライン: 個別ポスト以外では再読み込みしない', t.loads.length === 1, t.loads);

        await t.page.evaluate((p) => window.goStatus(p), STATUS_PATH);
        await t.wait(1300);
        check('SPA・無反応: 約0.7秒で早めに再読み込みする', statusLoads(t.loads) === 1, t.loads);
        check('SPA・無反応: 再読み込み先は個別ポストの URL', t.loads[t.loads.length - 1] === STATUS_PATH, t.loads);
        await t.wait(3000);
        check('SPA・無反応: 再読み込み後に本文が出れば、それ以上再読み込みしない', statusLoads(t.loads) === 1, t.loads);
        await t.close();
    }

    // --- 5. SPA で、DOM は動くが本文が出ない ---
    {
        const t = await openPage(browser, 'https://x.com/home', (p) => (p === '/home' ? 'timeline' : 'loaded'));
        await t.wait(500);
        await t.page.evaluate((p) => {
            window.goStatus(p);
            window.keepBusy();
        }, STATUS_PATH);
        await t.wait(1500);
        check('SPA・動きあり: 0.7秒の段階では再読み込みしない', t.loads.length === 1, t.loads);
        await t.wait(1500);
        check('SPA・動きあり: 約2.5秒で再読み込みする', statusLoads(t.loads) === 1, t.loads);
        await t.close();
    }

    // --- 6. SPA で、少し遅れて本文が出る ---
    {
        const t = await openPage(browser, 'https://x.com/home', (p) => (p === '/home' ? 'timeline' : 'loaded'));
        await t.wait(500);
        await t.page.evaluate((p) => {
            window.goStatus(p);
            setTimeout(() => {
                const s = document.createElement('div');
                s.textContent = '読み込み中';
                document.getElementById('primary').appendChild(s);
            }, 300);
            setTimeout(window.showTweet, 1200);
        }, STATUS_PATH);
        await t.wait(3500);
        check('SPA・遅れて表示: 本文が出れば再読み込みしない', t.loads.length === 1, t.loads);
        await t.close();
    }

    // --- 7. SPA で個別ポストへ行き、すぐ離れる ---
    {
        const t = await openPage(browser, 'https://x.com/home', (p) => (p === '/home' ? 'timeline' : 'loaded'));
        await t.wait(500);
        await t.page.evaluate((p) => {
            window.goStatus(p);
            setTimeout(() => history.pushState({}, '', '/home'), 300);
        }, STATUS_PATH);
        await t.wait(3500);
        check('離脱: 判定前に個別ポスト以外へ移れば再読み込みしない', t.loads.length === 1, t.loads);
        await t.close();
    }

    // --- 8. 個別ポスト以外への SPA 遷移 ---
    {
        const t = await openPage(browser, 'https://x.com/home', (p) => (p === '/home' ? 'timeline' : 'loaded'));
        await t.wait(500);
        await t.page.evaluate(() => {
            document.getElementById('primary').replaceChildren();
            history.pushState({}, '', '/explore');
        });
        await t.wait(3500);
        check('範囲外: 個別ポスト以外の URL では空のままでも再読み込みしない', t.loads.length === 1, t.loads);
        await t.close();
    }

    // --- 9. documentElement がまだ無い時点で走った場合 ---
    // 現状の挙動: 初回の observe(document.documentElement) が TypeError になり、
    // 直接開いた個別ポストは監視されない（SPA遷移の監視は pushState のラップが先に済んでいるので動く）
    {
        const t = await openPage(browser, 'https://x.com' + STATUS_PATH, () => 'stuck', { initScript: true });
        await t.wait(3500);
        known('documentElement が null の時点で走ると例外になり、直接開いた個別ポストを再読み込みしない',
            t.errors.some((e) => /observe/.test(e)) && statusLoads(t.loads) === 1, { errors: t.errors, loads: t.loads });
        await t.close();
    }

    await browser.close();

    const failed = results.filter((r) => !r.ok);
    console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通過' +
        (knowns.length ? '（ほかに現状の挙動の記録 ' + knowns.length + ' 件）' : ''));
    process.exit(failed.length ? 1 : 0);
})();
