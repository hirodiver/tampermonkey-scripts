const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// youtube-watch-chat-fit.user.js の検証用ハーネス。
//
// YouTube の再生ページ（上の固定ヘッダー・映像・その下のチャット枠）を模したDOMを
// 組み、スクリプトを流し込んで、チャット枠の高さと入力欄の位置を測る。
//
//   NODE_PATH=$(npm root -g) node test/youtube-watch-chat-fit.test.js
//
// YouTube の実DOMそのものは再現できないため、
// これに通ることは実機で動くことを保証しない。

const SCRIPT = fs.readFileSync(
    path.join(__dirname, '..', 'youtube-watch-chat-fit.user.js'),
    'utf8'
);

const MASTHEAD = 56;
const PLAYER = 400;
const CHAT_TOP_GAP = 24;   // 映像とチャット枠のあいだ
const NATURAL = 900;       // YouTube が付けるチャット枠の高さ

// iframe の中（流れるチャットと、一番下の入力欄）
const CHAT_DOC = `<body style="margin:0;height:100vh;display:flex;flex-direction:column;">
<div style="height:48px;">チャット</div>
<div style="flex:1;overflow:auto;">${'<div>コメント</div>'.repeat(80)}</div>
<div id="input" style="height:64px;background:#eee;">チャット... ¥ ♡</div>
</body>`;

function pageHtml(options) {
    const twoColumns = options.twoColumns;

    return `<!doctype html><html><meta charset="utf-8"><title>yt-mock</title>
<style>
  body { margin: 0; }
  #masthead { position: fixed; top: 0; left: 0; right: 0; height: ${MASTHEAD}px; background: #fff; z-index: 2; }
  ytd-app { display: block; padding-top: ${MASTHEAD}px; }
  ytd-watch-flexy { display: ${twoColumns ? 'flex' : 'block'}; }
  #player-full-bleed-container { display: block; height: ${PLAYER}px; background: #000; ${twoColumns ? 'width: 60%;' : ''} }
  #chat-container { display: block; margin-top: ${twoColumns ? 0 : CHAT_TOP_GAP}px; ${twoColumns ? 'width: 40%;' : ''} }
  ytd-live-chat-frame { display: flex; flex-direction: column; height: ${NATURAL}px; min-height: 400px; border: 1px solid #ccc; }
  ytd-live-chat-frame iframe { flex: 1; border: 0; width: 100%; }
  #below { display: block; height: 2000px; }
</style>
<body>
<div id="masthead">YouTube</div>
<ytd-app>
  <ytd-watch-flexy ${twoColumns ? 'is-two-columns_' : ''}>
    <div id="player-full-bleed-container"><div id="movie_player" class="html5-video-player" style="height:100%;"></div></div>
    <div id="chat-container">
      <ytd-live-chat-frame id="chat"><iframe id="chatframe" srcdoc="${CHAT_DOC.replace(/"/g, '&quot;')}"></iframe></ytd-live-chat-frame>
    </div>
    <div id="below">タイトル・説明</div>
  </ytd-watch-flexy>
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

async function openPage(browser, options) {
    const page = await browser.newPage({
        viewport: { width: options.width || 754, height: options.height || 1100 }
    });

    await page.setContent(pageHtml(options));
    await page.addScriptTag({ content: SCRIPT });
    await page.waitForTimeout(300);

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

// 入力欄（iframe の中の一番下）が画面内にあるか
async function inputBottom(page) {
    const frame = page.frames().find((f) => f !== page.mainFrame());
    const inner = await frame.evaluate(() => document.getElementById('input').getBoundingClientRect().bottom);
    const outer = await page.evaluate(() => document.getElementById('chatframe').getBoundingClientRect().top);

    return Math.round(outer + inner);
}

(async () => {
    const browser = await chromium.launch();

    // 1. 狭い窓（チャットが映像の下）: 画面に収まるまで縮み、入力欄が見える
    {
        const page = await openPage(browser, {});
        const box = await chatBox(page);
        const input = await inputBottom(page);

        check('縦並びでチャットが縮む', box.height < NATURAL, JSON.stringify(box));
        check('チャットの下端が画面内', box.bottom <= box.viewport, `${box.bottom} <= ${box.viewport}`);
        check('チャットの下端が画面下端の近く（余白 8px）', box.viewport - box.bottom === 8, `${box.viewport - box.bottom}px あき`);
        check('入力欄が画面内', input <= box.viewport, `${input} <= ${box.viewport}`);

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

        // 4. チャット枠が作り直されたら、新しい方に付ける
        await page.evaluate(() => {
            const old = document.querySelector('ytd-live-chat-frame');
            const fresh = old.cloneNode(true);

            fresh.removeAttribute('style');
            delete fresh.dataset.tmChatFit;
            old.replaceWith(fresh);
        });
        await page.waitForTimeout(300);

        const box4 = await chatBox(page);

        check('作り直されたチャット枠にも効く', box4.height === box2.height && box4.mark !== '', JSON.stringify(box4));

        // 5. 窓を高くして収まるようになったら、YouTube の高さに戻す
        await page.setViewportSize({ width: 754, height: 2000 });
        await page.waitForTimeout(300);

        const box5 = await chatBox(page);

        check('収まる高さになったら元に戻る', box5.height === NATURAL + 2 && box5.mark === '', JSON.stringify(box5));

        // 6. 診断
        const dump = await page.evaluate(() => window.__tmWatchChatFit.dump());

        check('dump() が判定を返す', typeof dump.state === 'string' && dump.state.includes('収まっている'), dump.state);

        await page.close();
    }

    // 7. 広い窓（チャットが映像の横）: 触らない
    {
        const page = await openPage(browser, { twoColumns: true, width: 1400, height: 800 });
        const box = await chatBox(page);

        check('横並びでは触らない', box.height === NATURAL + 2 && box.mark === '', JSON.stringify(box));

        await page.close();
    }

    // 8. もともと収まっている: 触らない
    {
        const page = await openPage(browser, { height: 1600 });
        const box = await chatBox(page);

        check('収まっているときは触らない', box.height === NATURAL + 2 && box.mark === '', JSON.stringify(box));

        await page.close();
    }

    // 9. 画面がとても低い: 最小の高さで止まる
    {
        const page = await openPage(browser, { height: 600 });
        const box = await chatBox(page);

        check('最小の高さ（240px）で止まる', box.height === 240, JSON.stringify(box));

        await page.close();
    }

    await browser.close();

    console.log(failures === 0 ? '\nすべて通過' : `\n${failures} 件失敗`);
    process.exit(failures === 0 ? 0 : 1);
})();
