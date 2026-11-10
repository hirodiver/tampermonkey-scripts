const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// youtube-watch-chat-fit.user.js の検証用ハーネス。
//
// YouTube の再生ページ（上の固定ヘッダー・映像・その下のチャット枠）と、
// チャットの iframe（見出し・スーパーチャットの帯・流れるチャット・入力欄）を模したDOMを
// 組み、スクリプトを流し込んで、上の帯が消えるか・チャット枠の高さ・入力欄の位置を測る。
// iframe には「YouTube チャット強調」「YouTube チャット非表示」も流し、
// ボタンが細い帯の中に入るかも見る。
//
//   NODE_PATH=$(npm root -g) node test/youtube-watch-chat-fit.test.js
//
// YouTube の実DOMそのものは再現できないため、
// これに通ることは実機で動くことを保証しない。

const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

const SCRIPT = read('youtube-watch-chat-fit.user.js');
const HIGHLIGHT = read('youtube-chat-highlight.user.js');
const HIDE_USERS = read('youtube-hide-chat-users.user.js');

const MASTHEAD = 56;
const PLAYER = 400;
const CHAT_TOP_GAP = 24;   // 映像とチャット枠のあいだ
const NATURAL = 900;       // YouTube が付けるチャット枠の高さ
const STRIP = 40;          // 見出しを細くしたときの帯の高さ

// iframe の中（見出し・スーパーチャットの帯・流れるチャット・一番下の入力欄）
const CHAT_HTML = `<!doctype html><html><meta charset="utf-8"><body style="margin:0;height:100vh;display:flex;flex-direction:column;">
<style>
  yt-live-chat-header-renderer { display: flex; height: 62px; align-items: center; }
  yt-live-chat-ticker-renderer { display: block; height: 72px; }
</style>
<yt-live-chat-header-renderer><span>チャット ∨</span><button>⋮</button><button>×</button></yt-live-chat-header-renderer>
<div id="ticker"><yt-live-chat-ticker-renderer>@配信者のスーパーチャット</yt-live-chat-ticker-renderer></div>
<div style="flex:1;overflow:auto;">${'<div>コメント</div>'.repeat(80)}</div>
<div id="input" style="height:64px;background:#eee;">チャット... ¥ ♡</div>
</body></html>`;

function pageHtml(options) {
    const twoColumns = options.twoColumns;

    return `<!doctype html><html><meta charset="utf-8"><title>yt-mock</title>
<style>
  body { margin: 0; }
  #masthead-container { position: fixed; top: 0; left: 0; right: 0; height: ${MASTHEAD}px; background: #fff; z-index: 2; }
  ytd-app { display: block; }
  ytd-page-manager { display: block; margin-top: var(--ytd-masthead-height, ${MASTHEAD}px); }
  ytd-watch-flexy { display: ${twoColumns ? 'flex' : 'block'}; }
  #player-full-bleed-container { display: block; height: ${PLAYER}px; background: #000; ${twoColumns ? 'width: 60%;' : ''} }
  #chat-container { display: block; margin-top: ${twoColumns ? 0 : CHAT_TOP_GAP}px; ${twoColumns ? 'width: 40%;' : ''} }
  ytd-live-chat-frame { display: flex; flex-direction: column; height: ${NATURAL}px; min-height: 400px; border: 1px solid #ccc; }
  ytd-live-chat-frame iframe { flex: 1; border: 0; width: 100%; }
  #below { display: block; height: 2000px; }
</style>
<body>
<ytd-app>
  <div id="masthead-container"><ytd-masthead id="masthead">YouTube</ytd-masthead></div>
  <ytd-page-manager id="page-manager">
    <ytd-watch-flexy ${twoColumns ? 'is-two-columns_' : ''}>
      <div id="player-full-bleed-container"><div id="movie_player" class="html5-video-player" style="height:100%;"></div></div>
      <div id="chat-container">
        <ytd-live-chat-frame id="chat"><iframe id="chatframe" src="https://www.youtube.com/live_chat?v=abc"></iframe></ytd-live-chat-frame>
      </div>
      <div id="below">タイトル・説明</div>
    </ytd-watch-flexy>
  </ytd-page-manager>
</ytd-app>
</body></html>`;
}

let failures = 0;

function check(label, ok, detail) {
    console.log(`${ok ? 'OK  ' : 'NG  '}${label}${detail ? '  ' + detail : ''}`);

    if (!ok) {
        failures++;
    }
}

function chatFrame(page) {
    return page.frames().find((f) => f.url().includes('live_chat'));
}

async function openPage(browser, options) {
    const page = await browser.newPage({
        viewport: { width: options.width || 754, height: options.height || 1100 }
    });

    await page.route('https://www.youtube.com/**', (route) => route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: route.request().url().includes('live_chat') ? CHAT_HTML : pageHtml(options)
    }));

    await page.goto('https://www.youtube.com/watch?v=abc');
    await page.waitForTimeout(200);

    // チャットの中のスクリプト（強調ワード・非表示リスト）
    if (options.buttons !== false) {
        const frame = chatFrame(page);

        await frame.evaluate(HIGHLIGHT);
        await frame.evaluate(HIDE_USERS);
    }

    await page.evaluate(SCRIPT);
    await page.waitForTimeout(1300);

    return page;
}

async function chatBox(page) {
    return page.evaluate(() => {
        const chat = document.querySelector('ytd-live-chat-frame');
        const rect = chat.getBoundingClientRect();

        return {
            top: Math.round(rect.top),
            bottom: Math.round(rect.bottom),
            height: Math.round(rect.height),
            mark: chat.dataset.tmChatFit || '',
            viewport: document.documentElement.clientHeight
        };
    });
}

async function pageTop(page) {
    return page.evaluate(() => ({
        mastheadShown: getComputedStyle(document.getElementById('masthead-container')).display !== 'none',
        playerTop: Math.round(document.getElementById('player-full-bleed-container').getBoundingClientRect().top)
    }));
}

// iframe の中の上部
async function chatTop(page) {
    return chatFrame(page).evaluate(() => {
        const rectOf = (selector) => {
            const el = document.querySelector(selector);

            if (!el) {
                return null;
            }

            const r = el.getBoundingClientRect();

            return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
        };

        return {
            header: rectOf('yt-live-chat-header-renderer'),
            ticker: rectOf('yt-live-chat-ticker-renderer'),
            highlightBtn: rectOf('.tm-ychl-open'),
            hideBtn: rectOf('.tm-ychide-open'),
            menuVisible: getComputedStyle(document.querySelector('yt-live-chat-header-renderer button')).visibility !== 'hidden'
        };
    });
}

// 入力欄（iframe の中の一番下）が画面内にあるか
async function inputBottom(page) {
    const inner = await chatFrame(page).evaluate(() => document.getElementById('input').getBoundingClientRect().bottom);
    const outer = await page.evaluate(() => document.getElementById('chatframe').getBoundingClientRect().top);

    return Math.round(outer + inner);
}

(async () => {
    const browser = await chromium.launch();

    // 1. 狭い窓（チャットが映像の下）
    {
        const page = await openPage(browser, {});
        const top = await pageTop(page);
        const box = await chatBox(page);
        const input = await inputBottom(page);
        const inner = await chatTop(page);

        check('上の帯（ロゴ・検索）が消える', !top.mastheadShown, JSON.stringify(top));
        check('映像がページの一番上に来る', top.playerTop === 0, JSON.stringify(top));
        check('縦並びでチャットが縮む', box.height < NATURAL, JSON.stringify(box));
        check('チャットの下端が画面下端の 8px 上', box.viewport - box.bottom === 8, `${box.viewport - box.bottom}px あき`);
        check('入力欄が画面内', input <= box.viewport, `${input} <= ${box.viewport}`);
        check('チャットの見出しが細い帯になる', inner.header && inner.header.height === STRIP, JSON.stringify(inner.header));
        check('見出しの「⋮」「×」は見えない', !inner.menuVisible);
        check('スーパーチャットの帯が消える', inner.ticker === null || inner.ticker.height === 0, JSON.stringify(inner.ticker));
        check('強調ワードのボタンが細い帯の中',
            inner.highlightBtn && inner.highlightBtn.top >= 0 && inner.highlightBtn.bottom <= STRIP,
            JSON.stringify(inner.highlightBtn));
        check('非表示リストのボタンが細い帯の中',
            inner.hideBtn && inner.hideBtn.top >= 0 && inner.hideBtn.bottom <= STRIP,
            JSON.stringify(inner.hideBtn));

        // 2. 映像が大きくなったら（シアターモード等）計算し直す
        await page.evaluate(() => {
            document.getElementById('player-full-bleed-container').style.height = '500px';
        });
        await page.waitForTimeout(300);

        const box2 = await chatBox(page);

        check('映像が伸びたら追従して縮む', box2.bottom <= box2.viewport && box2.height < box.height, JSON.stringify(box2));

        // 3. YouTube がスタイルを書き直しても付け直す
        await page.evaluate(() => {
            document.querySelector('ytd-live-chat-frame').setAttribute('style', 'height: 900px;');
        });
        await page.waitForTimeout(300);

        const box3 = await chatBox(page);

        check('スタイルを書き直されても戻る', box3.height === box2.height, JSON.stringify(box3));

        // 4. 窓を広げて横並びになったら、全部元に戻す
        await page.evaluate(() => {
            document.querySelector('ytd-watch-flexy').style.display = 'flex';
            document.getElementById('player-full-bleed-container').style.width = '60%';
            document.getElementById('chat-container').style.width = '40%';
            document.getElementById('chat-container').style.marginTop = '0';
        });
        await page.setViewportSize({ width: 1400, height: 800 });
        await page.waitForTimeout(1300);

        const top4 = await pageTop(page);
        const box4 = await chatBox(page);
        const inner4 = await chatTop(page);

        check('横並びに戻すと上の帯が出る', top4.mastheadShown && top4.playerTop === MASTHEAD, JSON.stringify(top4));
        check('横並びに戻すとチャットの高さも戻る', box4.height === NATURAL + 2 && box4.mark === '', JSON.stringify(box4));
        check('横並びに戻すと見出しも戻る', inner4.header.height === 62 && inner4.menuVisible && inner4.ticker.height === 72,
            JSON.stringify(inner4));
        check('横並びに戻すとボタンは見出しの下へ戻る', inner4.hideBtn.top >= 62, JSON.stringify(inner4.hideBtn));

        // 5. 診断
        const dump = await page.evaluate(() => window.__tmWatchChatFit.dump());

        check('dump() が判定を返す', dump.state.includes('横'), dump.state);

        await page.close();
    }

    // 6. 縦並びでも、もともと収まる高さの窓: 帯は減らすが高さは触らない
    {
        const page = await openPage(browser, { height: 1600 });
        const top = await pageTop(page);
        const box = await chatBox(page);

        check('高い窓でも上の帯は消える', !top.mastheadShown, JSON.stringify(top));
        check('収まっているときは高さを触らない', box.height === NATURAL + 2 && box.mark === '', JSON.stringify(box));

        await page.close();
    }

    // 7. ボタンのスクリプトが無いときは、細い帯も消す
    {
        const page = await openPage(browser, { buttons: false });
        const inner = await chatTop(page);
        const box = await chatBox(page);

        check('ボタンが無ければ見出しは帯ごと消える', inner.header.height === 0, JSON.stringify(inner.header));
        check('ボタンが無くても入力欄までの高さは収まる', box.viewport - box.bottom === 8, JSON.stringify(box));

        await page.close();
    }

    // 8. 画面がとても低い: 最小の高さで止まる
    {
        const page = await openPage(browser, { height: 500 });
        const box = await chatBox(page);

        check('最小の高さ（240px）で止まる', box.height === 240, JSON.stringify(box));

        await page.close();
    }

    // 9. チャット枠が作り直されたら、新しい方に付ける
    {
        const page = await openPage(browser, {});

        await page.evaluate(() => {
            const old = document.querySelector('ytd-live-chat-frame');
            const fresh = old.cloneNode(true);

            fresh.removeAttribute('style');
            delete fresh.dataset.tmChatFit;
            old.replaceWith(fresh);
        });
        await page.waitForTimeout(1500);

        const box = await chatBox(page);
        const inner = await chatTop(page);

        check('作り直されたチャット枠にも高さが効く', box.mark !== '' && box.viewport - box.bottom === 8, JSON.stringify(box));
        check('作り直された iframe にも細い帯が効く', inner.header.height <= STRIP && inner.ticker.height === 0,
            JSON.stringify(inner));

        await page.close();
    }

    await browser.close();

    console.log(failures === 0 ? '\nすべて通過' : `\n${failures} 件失敗`);
    process.exit(failures === 0 ? 0 : 1);
})();
