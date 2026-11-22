const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// youtube-full-dates-jst.user.js の検証用ハーネス。
//
// YouTube のホーム（動画カード）、コメント、コミュニティ投稿、再生ページを模したDOMを組み、
// ヘッドレスChromium に document-start 相当（addInitScript）でスクリプトを流し込んで、
// 「相対表示（3日前 など）が JST の絶対日付に置き換わる／今週・今年・昨年以前の色分け／
//   タイトルや視聴回数は書き換えない／API の失敗は永久に残さない／要素の使い回しと SPA 遷移で戻る／
//   書式の設定（年は常に4桁）」を確認する。
//
//   NODE_PATH=$(npm root -g) node test/youtube-full-dates-jst.test.js
//
// 現在時刻は 2026-11-22 12:00 JST に固定し、ブラウザのタイムゾーンは
// America/Los_Angeles にしてある（JST 換算が端末のタイムゾーンに左右されないことを見るため）。
// 投稿日を返す youtubei/v1/player は作り物の応答に差し替えている。
// YouTube の実DOMそのものではないので、これに通ることは実機で動くことを保証しない。

const SCRIPT = fs.readFileSync(
    process.env.SCRIPT_PATH ||
        path.join(__dirname, '..', 'youtube-full-dates-jst.user.js'),
    'utf8'
);

const NOW = '2026-11-22T03:00:00Z';     // = 2026-11-22 12:00 JST

// videoId → player API の microformat（null は 500 を返す）
const PLAYER = {
    vidWeek001: { publishDate: '2026-11-20T10:00:00-08:00' },                     // JST 11/21 03:00（今週）
    vidLive0001: {
        publishDate: '2026-02-28T00:00:00-08:00',
        liveBroadcastDetails: { startTimestamp: '2026-03-01T12:00:00+00:00' }     // JST 3/1 21:00（今年）
    },
    vidNewYear1: { publishDate: '2025-12-31T16:30:00Z' },                          // JST 2026/1/1 01:30（今年）
    vidOld00001: { publishDate: '2024-06-15' },                                    // 昨年以前
    vidFail0001: null
};

// GM_* の代役（document-start で走るので、<html> がまだ無ければ DOM の準備を待って足す）
const GM_MOCK = `
    window.__store = window.__store || {};
    window.__menu = {};
    window.GM_getValue = (k, d) => (k in window.__store ? window.__store[k] : d);
    window.GM_setValue = (k, v) => { window.__store[k] = v; };
    window.GM_registerMenuCommand = (name, fn) => { window.__menu[name] = fn; };
    window.GM_addStyle = (css) => {
        const s = document.createElement('style');
        s.id = 'ytfd-style';
        s.textContent = css;
        const add = () => (document.head || document.documentElement).appendChild(s);
        if (document.documentElement) {
            add();
        } else {
            document.addEventListener('DOMContentLoaded', add, { once: true });
        }
    };
`;

function videoCard(id, videoId, dateText, opts = {}) {
    return `
<ytd-rich-item-renderer id="${id}">
  <yt-lockup-view-model>
    <a class="yt-lockup-view-model__content-image" href="/watch?v=${videoId}">サムネイル</a>
    <h3 class="ytLockupMetadataViewModelTitle"><span id="${id}Title">${opts.title || 'テスト動画 1年前の振り返り'}</span></h3>
    <yt-content-metadata-view-model>
      <div class="ytContentMetadataViewModelMetadataRow"><span id="${id}Channel">${opts.channel || 'テストチャンネル'}</span></div>
      <div class="ytContentMetadataViewModelMetadataRow"><span id="${id}Views">1.2万 回視聴</span><span id="${id}Date">${dateText}</span></div>
    </yt-content-metadata-view-model>
  </yt-lockup-view-model>
</ytd-rich-item-renderer>`;
}

const HOME_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>youtube-mock</title></head>
<body>
<ytd-app>
  <div id="contents">
    ${videoCard('cardWeek', 'vidWeek001', '1 日前')}
    ${videoCard('cardLive', 'vidLive0001', '8 か月前に配信済み')}
    ${videoCard('cardNewYear', 'vidNewYear1', '10 か月前')}
    ${videoCard('cardOld', 'vidOld00001', '2 年前')}
    ${videoCard('cardFail', 'vidFail0001', '5 年前')}
    ${videoCard('cardEn', 'vidEnglish1', 'Premiered Jan 5, 2024')}
    ${videoCard('cardChan', 'vidWeek001', '1 日前', { channel: '毎日の前向き日記' })}
  </div>
  <ytd-comments id="comments">
    <ytd-comment-view-model id="comment1">
      <span id="published-time-text"><a class="yt-simple-endpoint" href="/watch?v=vidWeek001&lc=abc">2 日前</a></span>
    </ytd-comment-view-model>
    <ytd-comment-view-model id="comment2">
      <span id="published-time-text"><a class="yt-simple-endpoint" href="/watch?v=vidWeek001&lc=def">1 年前（編集済み）</a></span>
    </ytd-comment-view-model>
  </ytd-comments>
  <ytd-backstage-post-renderer id="post1">
    <div id="published-time-text"><a href="/post/xyz">3 か月前</a></div>
  </ytd-backstage-post-renderer>
</ytd-app>
</body></html>`;

const WATCH_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>youtube-watch-mock</title></head>
<body>
<ytd-app>
  <ytd-watch-metadata>
    <div id="info-strings"><yt-formatted-string id="watchDate">1 日前に公開</yt-formatted-string></div>
  </ytd-watch-metadata>
</ytd-app>
</body></html>`;

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

async function openPage(browser, url, html, store, player) {
    const context = await browser.newContext({
        timezoneId: 'America/Los_Angeles',
        viewport: { width: 1280, height: 900 }
    });
    const page = await context.newPage();
    const fetched = [];

    await page.clock.setFixedTime(new Date(NOW));

    await page.route('https://www.youtube.com/**', async (route) => {
        const req = route.request();
        if (req.url().includes('/youtubei/v1/player')) {
            const videoId = JSON.parse(req.postData() || '{}').videoId;
            fetched.push(videoId);
            const info = player[videoId];
            if (!info) {
                return route.fulfill({ status: 500, body: 'error' });
            }
            return route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({ microformat: { playerMicroformatRenderer: info } })
            });
        }
        if (req.resourceType() === 'document') {
            return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
        }
        return route.fulfill({ status: 204, body: '' });
    });

    await page.addInitScript(`window.__store = ${JSON.stringify(store || {})};`);
    await page.addInitScript(GM_MOCK);
    await page.addInitScript(SCRIPT);
    await page.goto(url);

    return {
        page,
        fetched,
        wait: (ms) => page.waitForTimeout(ms),
        text: (id) => page.evaluate((id) => document.getElementById(id)?.textContent, id),
        cls: (id) => page.evaluate((id) => document.getElementById(id)?.className || '', id),
        close: () => context.close()
    };
}

(async () => {
    const browser = await chromium.launch();

    // 同じ設定のまま、player の応答だけ後から直すために参照を持つ
    const player = { ...PLAYER };

    // --- 1. ホーム（既定の書式 yyyy年MM月dd日） ---
    {
        const t = await openPage(browser, 'https://www.youtube.com/', HOME_HTML, {}, player);
        await t.wait(1200);

        check('準備: スタイルが注入される', await t.page.evaluate(() => !!document.getElementById('ytfd-style')));
        check('準備: 設定メニューが登録される', await t.page.evaluate(() => typeof window.__menu['⚙️ 設定'] === 'function'));

        // 動画カード（API から取った投稿日を JST で）
        check('動画: 今週は 🆕 付きの JST 日付になる', (await t.text('cardWeekDate')) === '🆕 2026年11月21日', await t.text('cardWeekDate'));
        check('動画: 今週は緑（ytfd-this-week）', (await t.cls('cardWeekDate')).includes('ytfd-this-week'));
        check('動画: ライブは開始時刻（startTimestamp）を使う', (await t.text('cardLiveDate')) === '2026年03月01日', await t.text('cardLiveDate'));
        check('動画: 今年は紫（ytfd-this-year）', (await t.cls('cardLiveDate')).includes('ytfd-this-year'));
        check('JST: UTC 12/31 16:30 は JST の 2026年01月01日（端末が米国時間でも）',
            (await t.text('cardNewYearDate')) === '2026年01月01日', await t.text('cardNewYearDate'));
        check('JST: 年をまたいだ投稿も今年の扱い', (await t.cls('cardNewYearDate')).includes('ytfd-this-year'));
        check('動画: 昨年以前は西暦4桁の日付', (await t.text('cardOldDate')) === '2024年06月15日', await t.text('cardOldDate'));
        check('動画: 昨年以前は黄色（ytfd-old-video）', (await t.cls('cardOldDate')).includes('ytfd-old-video'));
        check('動画: 処理済みの目印が付く', await t.page.evaluate(() =>
            document.getElementById('cardOldDate').getAttribute('data-ytfd-done') === 'true'));

        // 英語の絶対日付は API を呼ばずに読み取る
        check('英語表記: 「Premiered Jan 5, 2024」を読み取って置き換える', (await t.text('cardEnDate')) === '2024年01月05日', await t.text('cardEnDate'));
        check('英語表記: API は呼ばない', !t.fetched.includes('vidEnglish1'), t.fetched);

        // 書き換えないもの
        check('残す: タイトル（h3 内の「1年前」）は書き換えない', (await t.text('cardWeekTitle')) === 'テスト動画 1年前の振り返り');
        check('残す: 視聴回数は書き換えない', (await t.text('cardWeekViews')) === '1.2万 回視聴');
        check('残す: チャンネル名は書き換えない', (await t.text('cardWeekChannel')) === 'テストチャンネル');

        // チャンネル名が「前」と「日」などを含んでも、日付欄（数字＋単位）だけを置き換える
        check('残す: チャンネル名「毎日の前向き日記」は書き換えない',
            (await t.text('cardChanChannel')) === '毎日の前向き日記',
            { channel: await t.text('cardChanChannel'), date: await t.text('cardChanDate') });
        check('日付欄: チャンネル名に「前」「日」があっても日付欄は置き換わる',
            (await t.text('cardChanDate')) === '🆕 2026年11月21日', await t.text('cardChanDate'));

        // API の失敗
        check('失敗: API が失敗したら元の表示のまま', (await t.text('cardFailDate')) === '5 年前');
        check('失敗: 失敗は目印を残さない（再試行できる）', await t.page.evaluate(() =>
            !document.getElementById('cardFailDate').hasAttribute('data-ytfd-done')));

        // コメント・コミュニティ投稿（相対表記から計算）
        check('コメント: 「2 日前」が今週の日付になる', (await t.text('comment1').then((s) => s.trim())) === '🆕 2026年11月20日',
            await t.text('comment1'));
        check('コメント: 「1 年前（編集済み）」が昨年の日付になる', (await t.text('comment2').then((s) => s.trim())) === '2025年11月22日',
            await t.text('comment2'));
        check('投稿: 「3 か月前」が今年の日付になる', (await t.text('post1').then((s) => s.trim())) === '2026年08月22日',
            await t.text('post1'));

        // 失敗していた API が直れば、定期実行（3秒ごと）で置き換わる
        player.vidFail0001 = { publishDate: '2021-04-01T09:00:00+09:00' };
        await t.wait(3500);
        check('失敗: API が直れば次の定期実行で置き換わる', (await t.text('cardFailDate')) === '2021年04月01日', await t.text('cardFailDate'));

        // 要素の使い回し（新しいカード要素に差し替え）
        await t.page.evaluate(() => {
            const old = document.getElementById('cardOld');
            const tpl = document.createElement('template');
            // YouTube が作る新しい要素には、スクリプトの目印（data-ytfd-*）は付いていない
            tpl.innerHTML = old.outerHTML
                .replace(/ data-ytfd-[a-z]+="[^"]*"/g, '')
                .replace(/ class="ytfd-[^"]*"/g, '')
                .replace(/cardOld/g, 'cardSwap')
                .replace('vidOld00001', 'vidWeek001')
                .replace('2024年06月15日', '1 日前');
            old.replaceWith(tpl.content.firstElementChild);
        });
        await t.wait(800);
        check('使い回し: 差し替えられたカードも置き換わる', (await t.text('cardSwapDate')) === '🆕 2026年11月21日', await t.text('cardSwapDate'));

        // 同じ span の文字だけ書き換わっても、目印に持たせた文字と違えば処理し直す
        await t.page.evaluate(() => {
            const card = document.getElementById('cardLive');
            card.querySelector('a').setAttribute('href', '/watch?v=vidOld00001');
            document.getElementById('cardLiveDate').textContent = '2 年前';
        });
        await t.wait(3500);
        check('書き換え: 同じ要素の文字だけが書き換わっても、SPA 遷移を待たずに置き換わる',
            (await t.text('cardLiveDate')) === '2024年06月15日', await t.text('cardLiveDate'));
        check('書き換え: 色分けも新しい日付に合わせる（今年の紫を外して黄色）',
            (await t.cls('cardLiveDate')).includes('ytfd-old-video') && !(await t.cls('cardLiveDate')).includes('ytfd-this-year'),
            await t.cls('cardLiveDate'));
        check('書き換え: 目印に置き換え前の文字を持つ', await t.page.evaluate(() =>
            document.getElementById('cardLiveDate').getAttribute('data-ytfd-original') === '2 年前'));

        // SPA 遷移（yt-navigate-finish）で目印を消して全部見直す
        await t.page.evaluate(() => window.dispatchEvent(new Event('yt-navigate-finish')));
        await t.wait(800);
        check('SPA: 遷移後は書き換わった要素も置き換わる', (await t.text('cardLiveDate')) === '2024年06月15日', await t.text('cardLiveDate'));
        check('SPA: 置き換え済みの日付はそのまま（二重に置き換えない）', (await t.text('cardWeekDate')) === '🆕 2026年11月21日', await t.text('cardWeekDate'));

        // 設定パネル（メニューから開く。innerHTML を使わずに組む）
        await t.page.evaluate(() => window.__menu['⚙️ 設定']());
        check('設定: メニューからパネルが開く', await t.page.evaluate(() =>
            document.querySelector('.ytfd-panel')?.classList.contains('visible')));
        await t.page.evaluate(() => {
            window.alert = () => {};
            document.getElementById('ytfd-format').value = 'yy/MM/dd';
            document.getElementById('ytfd-save').click();
        });
        check('設定: 保存すると yy は yyyy に直して保存される', await t.page.evaluate(() =>
            window.__store.settings && window.__store.settings.dateFormat === 'yyyy/MM/dd'),
            await t.page.evaluate(() => window.__store.settings));
        check('設定: 保存後にパネルが閉じる', await t.page.evaluate(() =>
            !document.querySelector('.ytfd-panel').classList.contains('visible')));

        await t.close();
    }

    // --- 2. 書式の設定（年トークン2桁・時刻あり） ---
    {
        const store = { settings: { dateFormat: 'yy/MM/dd HH:mm', thisWeekEmoji: false } };
        const t = await openPage(browser, 'https://www.youtube.com/', HOME_HTML, store, player);
        await t.wait(1200);
        check('書式: yy でも西暦4桁、時刻は JST', (await t.text('cardLiveDate')) === '2026/03/01 21:00', await t.text('cardLiveDate'));
        check('書式: 絵文字を切ると 🆕 を付けない', (await t.text('cardWeekDate')) === '2026/11/21 03:00', await t.text('cardWeekDate'));
        check('書式: 絵文字を切っても今週の色は付く', (await t.cls('cardWeekDate')).includes('ytfd-this-week'));
        await t.close();
    }

    {
        const store = { settings: { dateFormat: 'MM月dd日(ww)' } };
        const t = await openPage(browser, 'https://www.youtube.com/', HOME_HTML, store, player);
        await t.wait(1200);
        check('書式: 年が無い書式には先頭に yyyy年 を足す（曜日付き）', (await t.text('cardOldDate')) === '2024年06月15日(土)', await t.text('cardOldDate'));
        await t.close();
    }

    // --- 3. 再生ページの説明欄 ---
    {
        const t = await openPage(browser, 'https://www.youtube.com/watch?v=vidWeek001', WATCH_HTML, {}, player);
        await t.wait(1200);
        check('再生ページ: 説明欄の「1 日前に公開」を URL の動画の日付にする', (await t.text('watchDate')) === '🆕 2026年11月21日', await t.text('watchDate'));
        await t.close();
    }

    {
        const store = { settings: { processDescription: false } };
        const t = await openPage(browser, 'https://www.youtube.com/watch?v=vidWeek001', WATCH_HTML, store, player);
        await t.wait(1200);
        check('再生ページ: 説明欄の処理を切ると置き換えない', (await t.text('watchDate')) === '1 日前に公開', await t.text('watchDate'));
        await t.close();
    }

    await browser.close();

    const failed = results.filter((r) => !r.ok);
    console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通過' +
        (knowns.length ? '（ほかに現状の挙動の記録 ' + knowns.length + ' 件）' : ''));
    process.exit(failed.length ? 1 : 0);
})();
