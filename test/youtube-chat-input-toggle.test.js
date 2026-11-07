const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// youtube-chat-input-toggle.user.js の検証用ハーネス。
//
// ライブチャット下部の入力帯を模したDOMにスクリプトを流し込み、
// 「文字の枠と絵文字は消える／¥・ハート・発言は残る／戻せる／
//   作り直されても効く／再読み込み後も覚えている」を確認する。
//
//   NODE_PATH=$(npm root -g) node test/youtube-chat-input-toggle.test.js
//
// YouTube の実DOMそのものではないため、実機確認の代わりにはならない。

const SCRIPT = fs.readFileSync(
    path.join(__dirname, '..', 'youtube-chat-input-toggle.user.js'),
    'utf8'
);

// 型A: 絵文字が枠の中、¥ とハートは別の入れ物
const BAR_A = `
<yt-live-chat-message-input-renderer id="input-renderer" style="display:block">
  <div id="container" style="display:flex">
    <div id="top" style="display:flex;flex:1">
      <div id="input-container" style="display:flex;flex:1">
        <yt-live-chat-text-input-field-renderer id="input" style="display:block;flex:1">
          <div id="input" contenteditable="true" aria-label="有料ユーザーとしてチャット">x</div>
        </yt-live-chat-text-input-field-renderer>
        <yt-live-chat-icon-toggle-button-renderer id="emoji"><yt-icon-button><button>😊</button></yt-icon-button></yt-live-chat-icon-toggle-button-renderer>
      </div>
      <div id="buttons" style="display:flex">
        <yt-live-chat-icon-toggle-button-renderer id="product-picker"><yt-icon-button><button aria-label="Super Chat">¥</button></yt-icon-button></yt-live-chat-icon-toggle-button-renderer>
        <yt-reaction-control-panel-overlay-view-model id="heart"><button>♡</button></yt-reaction-control-panel-overlay-view-model>
      </div>
    </div>
  </div>
</yt-live-chat-message-input-renderer>`;

// 型B: id の手がかりが無い。枠・絵文字・¥・ハートが同じ帯に横並び
const BAR_B = `
<yt-live-chat-message-input-renderer id="input-renderer" style="display:block">
  <div class="row" style="display:flex">
    <div class="pill" style="display:flex;flex:1">
      <div class="field"><div contenteditable="true">x</div></div>
      <div class="smile"><button aria-label="絵文字">😊</button></div>
    </div>
    <div class="yen"><button aria-label="スーパーサンクス">¥</button></div>
    <div class="like"><button aria-label="ハート">♡</button></div>
  </div>
</yt-live-chat-message-input-renderer>`;

function html(bar) {
    return `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="items"><yt-live-chat-text-message-renderer id="msg1">こんにちは</yt-live-chat-text-message-renderer></div>
${bar}
</body></html>`;
}

const results = [];

function check(name, cond, extra) {
    results.push({ name, ok: !!cond });
    console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (!cond && extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
}

async function visible(page, selector) {
    return page.evaluate((s) => {
        const el = document.querySelector(s);
        return !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none';
    }, selector);
}

async function openPage(context, bar) {
    const page = await context.newPage();
    await page.route('https://www.youtube.com/**', (route) =>
        route.fulfill({ contentType: 'text/html; charset=utf-8', body: html(bar) })
    );
    await page.addInitScript(SCRIPT);
    await page.goto('https://www.youtube.com/live_chat?v=abc');
    await page.waitForTimeout(400);
    return page;
}

(async () => {
    const browser = await chromium.launch();

    // ---------------- 型A
    {
        const context = await browser.newContext();
        const page = await openPage(context, BAR_A);

        check('A: 初期状態は入力欄が見えている', await visible(page, 'div[contenteditable]'));
        check('A: 切替ボタンが出る', await visible(page, '#tm-ycin-toggle'));
        check('A: 枠として #input-container を選ぶ', await page.evaluate(() =>
            document.querySelector('#input-container').classList.contains('tm-ycin-pill')));

        // YouTube の送信処理の代わり: 枠で Enter を受けたら「送信」を数える
        await page.evaluate(() => {
            window.sent = 0;
            document.querySelector('div[contenteditable]').addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') {
                    window.sent += 1;
                }
            });
        });

        await page.click('#tm-ycin-toggle');
        await page.waitForTimeout(50);

        check('A: クリック後、ボタンにフォーカスが残らない', await page.evaluate(() =>
            document.activeElement === null || document.activeElement.id !== 'tm-ycin-toggle'));

        // Enter・スペースを押しても戻らない（v1.0.0 の不具合）
        await page.keyboard.press('Enter');
        await page.keyboard.press('Space');
        await page.waitForTimeout(50);
        check('A: Enter・スペースを押しても戻らない', !(await visible(page, 'div[contenteditable]')));

        // ボタンにフォーカスを当てて Enter / キーボード由来の click
        await page.evaluate(() => {
            const b = document.getElementById('tm-ycin-toggle');
            b.focus();
            b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            b.click();
        });
        await page.waitForTimeout(50);
        check('A: ボタンへのキーボード操作では切り替わらない', !(await visible(page, 'div[contenteditable]')));
        check('A: ボタンは Tab で来ない（tabindex=-1）', await page.evaluate(() =>
            document.getElementById('tm-ycin-toggle').tabIndex === -1));

        // 隠している間に枠へ Enter が届いても送信されない
        await page.evaluate(() => {
            const ed = document.querySelector('div[contenteditable]');
            ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        });
        check('A: 隠している間は Enter が送信処理に届かない', await page.evaluate(() => window.sent === 0));

        check('A: 押すと文字の枠が消える', !(await visible(page, 'div[contenteditable]')));
        check('A: 絵文字ボタンも消える', !(await visible(page, '#emoji')));
        check('A: ¥ ボタンは残る', await visible(page, '#product-picker button'));
        check('A: ハートは残る', await visible(page, '#heart button'));
        check('A: 発言は残る', await visible(page, '#msg1'));
        check('A: 切替ボタンは残り、文字が「入力欄」になる', await visible(page, '#tm-ycin-toggle') &&
            (await page.textContent('#tm-ycin-toggle')) === '入力欄');

        // YouTube 側の作り直し（入力帯の中身を丸ごと差し替え）
        await page.evaluate((bar) => {
            const old = document.querySelector('yt-live-chat-message-input-renderer');
            const tmp = document.createElement('div');
            tmp.innerHTML = bar;
            old.replaceWith(tmp.firstElementChild);
        }, BAR_A.trim());
        await page.waitForTimeout(400);

        check('A: 作り直されても隠れたまま', !(await visible(page, 'div[contenteditable]')));
        check('A: 作り直し後もボタンが付き直す', await visible(page, '#tm-ycin-toggle'));
        check('A: 作り直し後も ¥ は残る', await visible(page, '#product-picker button'));

        // 再読み込みしても覚えている
        await page.reload();
        await page.waitForTimeout(400);
        check('A: 再読み込み後も隠れたまま', !(await visible(page, 'div[contenteditable]')));
        check('A: 再読み込み後も ¥ は残る', await visible(page, '#product-picker button'));

        await page.click('#tm-ycin-toggle');
        await page.waitForTimeout(50);

        check('A: もう一度押すと戻る', await visible(page, 'div[contenteditable]'));
        check('A: 絵文字も戻る', await visible(page, '#emoji'));
        check('A: 戻したらボタンは「隠す」', (await page.textContent('#tm-ycin-toggle')) === '隠す');
        check('A: 戻しても入力欄に勝手にカーソルは入らない', await page.evaluate(() =>
            !(document.activeElement && document.activeElement.matches('[contenteditable]'))));

        await page.keyboard.press('Enter');
        await page.waitForTimeout(50);
        check('A: 戻した直後の Enter で隠れない', await visible(page, 'div[contenteditable]'));

        // 出している間は普通に送れる（送信処理を止めていない）
        await page.evaluate(() => {
            window.sent = 0;
            document.querySelector('div[contenteditable]').addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') {
                    window.sent += 1;
                }
            });
        });
        await page.click('div[contenteditable]');
        await page.keyboard.press('Enter');
        check('A: 出している間は Enter で送れる', await page.evaluate(() => window.sent === 1));

        const rows = await page.evaluate(() => window.__tmYtChatInput.dump());
        check('A: 診断 dump が表を返す', Array.isArray(rows) && rows.some((r) => r['隠す対象'] === '★'), rows);

        await context.close();
    }

    // ---------------- 型B（id の手がかり無し）
    {
        const context = await browser.newContext();
        const page = await openPage(context, BAR_B);

        check('B: 枠として .pill を選ぶ', await page.evaluate(() =>
            document.querySelector('.pill').classList.contains('tm-ycin-pill')));

        await page.click('#tm-ycin-toggle');
        await page.waitForTimeout(50);

        check('B: 文字の枠が消える', !(await visible(page, '[contenteditable]')));
        check('B: 絵文字も消える', !(await visible(page, '.smile button')));
        check('B: ¥ は残る', await visible(page, '.yen button'));
        check('B: ハートは残る', await visible(page, '.like button'));

        await page.click('#tm-ycin-toggle');
        await page.waitForTimeout(50);
        check('B: 戻せる', await visible(page, '[contenteditable]'));

        await context.close();
    }

    await browser.close();

    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} 件成功`);
    process.exit(failed ? 1 : 0);
})();
