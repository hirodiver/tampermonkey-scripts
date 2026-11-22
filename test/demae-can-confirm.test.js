const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// demae-can-confirm.user.js の検証用ハーネス。
//
// 出前館のカート画面と「お届け時間に変更があります」確認モーダルを模したDOMを組み、
// ヘッドレスChromium に document-idle 相当（読み込み後の evaluate）でスクリプトを流し込んで、
// 「利用者が自分で押すまでは何も押さない／カート本体のボタンは押さない／
//   モーダルの『注文を完了する』だけを1回押す／同じモーダルの別ボタンは押さない／
//   押す前に閉じたら押さない／出し直しで再び押す／後から表示されたモーダルも押す」を確認する。
//
// 利用者のクリックは Playwright の page.click（isTrusted が true）で再現する。
// 記録するのはスクリプトが押したクリック（isTrusted が false）だけ。
//
//   NODE_PATH=$(npm root -g) node test/demae-can-confirm.test.js
//
// 出前館の実DOMそのものではないので、これに通ることは実機で動くことを保証しない。

const SCRIPT = fs.readFileSync(
    process.env.SCRIPT_PATH ||
        path.join(__dirname, '..', 'demae-can-confirm.user.js'),
    'utf8'
);

// カート画面。最初の「注文を完了する」はユーザーが手で押すもの
function cartHtml(extraSummary) {
    return `<!doctype html><meta charset="utf-8"><title>demae-mock</title>
<body>
<div id="app">
  <main>
    <section id="items"><div>からあげ弁当 ×1</div></section>
    ${extraSummary || ''}
    <div id="footer"><button id="cartButton" type="button">注文を完了する</button></div>
  </main>
  <div id="modalRoot"></div>
</div>
</body>`;
}

const results = [];
function check(name, cond, extra) {
    results.push({ name, ok: !!cond });
    console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra && !cond ? '  -> ' + JSON.stringify(extra) : ''));
}

async function openCart(browser, extraSummary) {
    const page = await browser.newPage();

    await page.route('https://demae-can.com/**', (route) =>
        route.fulfill({ contentType: 'text/html; charset=utf-8', body: cartHtml(extraSummary) })
    );
    await page.goto('https://demae-can.com/cart');

    // --- フィクスチャ ---
    await page.evaluate(() => {
        window.clicks = [];

        // どのボタンが押されたかを記録する
        document.addEventListener('click', (event) => {
            if (event.isTrusted) {
                return;
            }
            const target = event.target.closest('button, [role="button"], a');
            if (target) {
                window.clicks.push(target.id || target.textContent.trim());
            }
        }, true);

        // 確認モーダルを差し込む（出前館は押下後に React で生成する）
        window.mkModal = (id, opts = {}) => {
            const overlay = document.createElement('div');
            overlay.id = id;
            if (opts.fixedOnly) {
                Object.assign(overlay.style, { position: 'fixed', inset: '0' });
            } else {
                overlay.setAttribute('role', 'dialog');
            }
            if (opts.hidden) {
                overlay.style.display = 'none';
            }

            const box = document.createElement('div');
            const title = document.createElement('h2');
            title.textContent = opts.title || 'お届け時間に変更があります';
            const body = document.createElement('p');
            body.textContent = 'お届け予定時刻: 19:40〜19:55';

            const actions = document.createElement('div');
            const cancel = document.createElement('button');
            cancel.id = id + 'Cancel';
            cancel.textContent = '戻る';
            const confirm = document.createElement('button');
            confirm.id = id + 'Confirm';
            confirm.textContent = '注文を完了する';
            actions.appendChild(cancel);
            actions.appendChild(confirm);

            box.appendChild(title);
            box.appendChild(body);
            box.appendChild(actions);
            overlay.appendChild(box);
            document.getElementById('modalRoot').appendChild(overlay);
            return overlay;
        };
    });

    await page.evaluate(SCRIPT);
    return page;
}

(async () => {
    const browser = await chromium.launch();
    const clicks = (page) => page.evaluate(() => window.clicks.slice());

    // --- 1. 基本の流れ ---
    {
        const page = await openCart(browser);
        const wait = (ms) => page.waitForTimeout(ms);

        await wait(300);
        check('カート: 本体の「注文を完了する」は自動で押さない', (await clicks(page)).length === 0, await clicks(page));

        // 利用者が自分で本体のボタンを押す
        await page.click('#cartButton');
        await wait(300);
        check('カート: 利用者が押した後も、本体のボタンを自動で押し直さない', (await clicks(page)).length === 0, await clicks(page));

        await page.evaluate(() => window.mkModal('modal1'));
        await wait(100);
        check('モーダル: 差し込み直後（500ms待つ前）はまだ押さない', (await clicks(page)).length === 0, await clicks(page));

        await wait(700);
        check('モーダル: 中の「注文を完了する」が押される', (await clicks(page)).includes('modal1Confirm'), await clicks(page));
        check('モーダル: 同じモーダルの「戻る」は押さない', !(await clicks(page)).includes('modal1Cancel'), await clicks(page));
        check('モーダル: カート本体のボタンは押さない', !(await clicks(page)).includes('cartButton'), await clicks(page));

        // モーダル内に要素が足されても（再描画）、同じボタンを二度押さない
        await page.evaluate(() => {
            const note = document.createElement('p');
            note.textContent = '混雑のため到着が遅れます';
            document.querySelector('#modal1 > div').appendChild(note);
            document.querySelector('#modal1 > div').appendChild(document.getElementById('modal1Confirm'));
        });
        await wait(800);
        check('重複: 同じボタンは1回しか押さない', (await clicks(page)).filter((c) => c === 'modal1Confirm').length === 1, await clicks(page));

        // モーダル表示中にカート本体のフッタが再描画（要素の作り直し）されても、本体のボタンは押さない
        await page.evaluate(() => {
            const footer = document.getElementById('footer');
            const button = document.getElementById('cartButton');
            const copy = button.cloneNode(true);
            button.remove();
            footer.appendChild(copy);
        });
        await wait(800);
        check('再描画: モーダル表示中に作り直された本体のボタンは押さない', !(await clicks(page)).includes('cartButton'), await clicks(page));
        await page.evaluate(() => { window.clicks.length = 0; });

        // 閉じてから出し直された（新しい要素の）モーダルでは、また押す
        await page.evaluate(() => document.getElementById('modal1').remove());
        await page.evaluate(() => window.mkModal('modal2'));
        await wait(800);
        check('出し直し: 新しく生成されたモーダルでは再び押す', (await clicks(page)).includes('modal2Confirm'), await clicks(page));

        await page.close();
    }

    // --- 2. 押さないもの・後から表示されるもの ---
    {
        const page = await openCart(browser);
        const wait = (ms) => page.waitForTimeout(ms);

        await page.click('#cartButton');

        // 見出しが「お届け時間に変更」でないモーダル
        await page.evaluate(() => window.mkModal('otherModal', { title: 'ご注文内容の確認' }));
        await wait(800);
        check('対象外: 見出しが違うモーダルの「注文を完了する」は押さない', (await clicks(page)).length === 0, await clicks(page));
        await page.evaluate(() => document.getElementById('otherModal').remove());

        // 見えない状態で差し込まれたモーダル
        await page.evaluate(() => window.mkModal('hiddenModal', { hidden: true }));
        await wait(800);
        check('対象外: 非表示のモーダルは押さない', (await clicks(page)).length === 0, await clicks(page));

        // 500ms 待つ間に閉じられたモーダル
        await page.evaluate(() => {
            window.mkModal('closingModal');
            setTimeout(() => {
                document.getElementById('closingModal').style.display = 'none';
            }, 200);
        });
        await wait(800);
        check('対象外: 押す前に閉じられたモーダルは押さない', (await clicks(page)).length === 0, await clicks(page));

        // 非表示で差し込まれ、後から表示に切り替わったモーダルは押す
        await page.evaluate(() => { document.getElementById('hiddenModal').style.display = ''; });
        await wait(800);
        check('表示切替: 非表示から表示に切り替わったモーダルを押す', (await clicks(page)).includes('hiddenModalConfirm'), await clicks(page));

        await page.close();
    }

    // --- 3. 利用者が押していなければ、何も押さない ---
    {
        const page = await openCart(browser);
        await page.evaluate(() => window.mkModal('noUserModal'));
        await page.waitForTimeout(800);
        check('未操作: 利用者が押していなければ、モーダルが出ても押さない', (await clicks(page)).length === 0, await clicks(page));
        await page.close();
    }

    // --- 4. 読み込み時点で既にモーダルが出ている ---
    {
        const page = await browser.newPage();
        await page.route('https://demae-can.com/**', (route) =>
            route.fulfill({
                contentType: 'text/html; charset=utf-8',
                body: cartHtml().replace('<div id="modalRoot"></div>',
                    '<div id="modalRoot"><div role="dialog"><h2>お届け時間に変更があります</h2>' +
                    '<div><button id="preConfirm" type="button">注文を完了する</button></div></div></div>')
            })
        );
        await page.goto('https://demae-can.com/cart');
        await page.evaluate(() => {
            window.clicks = [];
            document.addEventListener('click', (event) => {
                if (!event.isTrusted) {
                    window.clicks.push(event.target.id);
                }
            }, true);
        });
        await page.evaluate(SCRIPT);
        await page.waitForTimeout(800);
        check('起動時: 利用者が押していないので、カート本体のボタンを押さない', !(await clicks(page)).includes('cartButton'), await clicks(page));
        check('起動時: 利用者が押していないので、既に出ているモーダルも押さない', !(await clicks(page)).includes('preConfirm'), await clicks(page));
        await page.close();
    }

    // --- 5. カート本体に「お届け時間」と「変更」が並ぶ場合 ---
    // 実際のカートにはお届け時間の行と「変更」ボタンがあることが多い。
    {
        const page = await openCart(browser,
            '<section id="delivery"><span>お届け時間：最短 30分</span><button id="changeTime" type="button">変更</button></section>');
        await page.click('#cartButton');
        await page.waitForTimeout(800);
        check('お届け時間の行: カートに「お届け時間…変更」の行があっても、本体のボタンは押さない',
            !(await clicks(page)).includes('cartButton'), await clicks(page));

        // 本体のフッタが画面に固定され、その中にお届け時間の行がある場合も押さない
        await page.evaluate(() => {
            const footer = document.getElementById('footer');
            Object.assign(footer.style, { position: 'fixed', bottom: '0', left: '0', right: '0' });
            footer.prepend(document.getElementById('delivery'));
        });
        await page.waitForTimeout(800);
        check('お届け時間の行: 固定フッタの中にあっても、本体のボタンは押さない',
            !(await clicks(page)).includes('cartButton'), await clicks(page));

        // その状態でモーダルが出れば、モーダルのボタンだけを押す
        await page.evaluate(() => window.mkModal('modal5'));
        await page.waitForTimeout(800);
        check('お届け時間の行: モーダルのボタンだけを押す',
            JSON.stringify(await clicks(page)) === JSON.stringify(['modal5Confirm']), await clicks(page));
        await page.close();
    }

    // --- 6. role の無い重ね表示のモーダル ---
    {
        const page = await openCart(browser);
        await page.click('#cartButton');
        await page.evaluate(() => window.mkModal('fixedModal', { fixedOnly: true }));
        await page.waitForTimeout(800);
        check('重ね表示: role が無くても、画面に固定されたモーダルなら押す', (await clicks(page)).includes('fixedModalConfirm'), await clicks(page));
        await page.close();
    }

    // --- 7. 診断 ---
    {
        const page = await openCart(browser);
        const rows = await page.evaluate(() => window.__tmDemaeConfirm.dump());
        check('診断: dump() が本体のボタンを「ダイアログなし」として出す',
            rows.length === 1 && rows[0].id === 'cartButton' && rows[0].dialog === '（なし）', rows);
        await page.close();
    }

    await browser.close();

    const failed = results.filter((r) => !r.ok);
    console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通過');
    process.exit(failed.length ? 1 : 0);
})();
