// page-to-markdown.user.js の検証用ハーネス（ヘッドレスChromium + 模擬DOM）
//
//   NODE_PATH=$(npm root -g) node test/page-to-markdown.test.js
//
// 実際のサイトの代わりに、article / main / 周辺メニュー / 広告 / 折りたたみを
// 模したDOMへスクリプトを流し込み、本文の取得・除外・展開・選択範囲・コピー操作を確認する。
// 実サイトのDOMそのものは再現できないため、これに通ることは実機で動くことを保証しない。
//
// Playwright は npm 依存としてリポジトリに持ち込まない。
// グローバル導入済みのものを使う。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execSync } = require('node:child_process');


function loadPlaywright() {

    try {
        return require('playwright');
    } catch (error) {
        // 続けてグローバルを探す
    }

    const globalRoot =
        execSync('npm root -g').toString().trim();

    return createRequire(globalRoot + '/')('playwright');
}


const { chromium } = loadPlaywright();

const SCRIPT =
    fs.readFileSync(
        path.join(__dirname, '..', 'page-to-markdown.user.js'),
        'utf8'
    );


// ------------------------------------------------------------
// 模擬ページ
// ------------------------------------------------------------

const LONG =
    'これは本文の段落です。文字量を十分に確保するため、同じような文章を繰り返し書いています。'.repeat(6);

const ARTICLE_PAGE = `
<!doctype html>
<html lang="ja">
<head><title>テスト記事 - サンプルサイト</title></head>
<body>
  <header class="site-header">
    <div class="logo">サイトロゴ</div>
    <nav><a href="/a">メニューA</a><a href="/b">メニューB</a><a href="/c">メニューC</a></nav>
  </header>

  <div class="sidebar">
    <p>サイドバーの文章です。${LONG}</p>
  </div>

  <div class="ad-slot" style="display:none !important">広告ブロッカーが消した広告テキスト</div>

  <main>
    <article>
      <h1>テスト記事</h1>
      <p>導入の段落。<strong>太字</strong>と<em>斜体</em>と<code>inline()</code>と
         <a href="https://example.com/x">リンク</a>を含みます。</p>
      <p>${LONG}</p>
      <ul>
        <li>項目1</li>
        <li>項目2
          <ul><li>入れ子A</li></ul>
        </li>
      </ul>
      <ol start="3"><li>三番</li><li>四番</li></ol>
      <pre class="language-js"><code>const a = 1;\nconsole.log(a);</code></pre>
      <table>
        <tr><th>名前</th><th>値</th></tr>
        <tr><td>foo</td><td>1</td></tr>
        <tr><td>bar</td><td>2</td></tr>
      </table>
      <blockquote><p>引用文</p></blockquote>

      <div class="share-buttons"><a href="#">Xで共有</a></div>

      <div class="tag-links">
        <a href="/t1">タグ甲</a><a href="/t2">タグ乙</a><a href="/t3">タグ丙</a>
      </div>

      <div class="related-posts">
        <a href="/r1">関連記事1</a><a href="/r2">関連記事2</a><a href="/r3">関連記事3</a>
      </div>

      <details>
        <summary>閉じたdetails</summary>
        <p>detailsの中身</p>
      </details>

      <div role="tablist"><button role="tab" aria-selected="true">タブ1</button><button role="tab">タブ2</button></div>
      <div role="tabpanel">タブ1の中身</div>
      <div role="tabpanel" hidden>タブ2の中身（非選択）</div>

      <div class="faq-item">
        <button aria-expanded="false" aria-controls="faq1">質問1</button>
        <div id="faq1" style="display:none">回答1（aria-controls で指されている）</div>
      </div>

      <div class="accordion">
        <div class="accordion-body" style="max-height:0; overflow:hidden">CSSで畳まれた回答</div>
      </div>

      <div class="accordion">
        <div class="accordion-body ad-banner" style="display:none">折りたたみ内の広告</div>
      </div>

      <div id="unrelated-modal-template" style="display:none">無関係な非表示モーダルの雛形</div>

      <div style="height:6000px"></div>
      <p id="far">画面外の一番下の段落。</p>
    </article>
  </main>

  <aside><p>アサイドの文章</p></aside>
  <footer><p>フッターの著作権表示</p></footer>
</body>
</html>`;


// div だけで組んだ、article/main のないページ（文字量スコアの確認用）
const PLAIN_PAGE = `
<!doctype html>
<html lang="ja">
<head><title>素朴なページ</title></head>
<body>
  <div id="wrap">
    <div id="menu">
      <a href="/1">メニュー1</a><a href="/2">メニュー2</a><a href="/3">メニュー3</a><a href="/4">メニュー4</a>
    </div>
    <div id="text">
      <p>${LONG}</p>
      <p>${LONG}</p>
      <p>${LONG}</p>
    </div>
  </div>
</body>
</html>`;


// ------------------------------------------------------------
// 実行
// ------------------------------------------------------------

async function main() {

    const browser =
        await chromium.launch({
            executablePath:
                process.env.CHROMIUM_PATH || undefined
        });

    const context =
        await browser.newContext({
            permissions: ['clipboard-read', 'clipboard-write']
        });

    // route は newPage ごとに張るので、ここでは何もしない

    // 指の操作（タッチ）を確かめる用。スマホ相当の画面サイズ
    const touchContext =
        await browser.newContext({
            hasTouch: true,
            viewport: { width: 390, height: 780 },
            permissions: ['clipboard-read', 'clipboard-write']
        });

    let passed = 0;

    async function test(name, fn, ctx = context) {

        const page = await ctx.newPage();

        try {

            await fn(page);

            passed++;

            console.log('  ok   ' + name);

        } catch (error) {

            console.log('  FAIL ' + name);
            console.log(error);

            process.exitCode = 1;

        } finally {

            await page.close();
        }
    }


    // クリップボードAPIは安全なコンテキストでしか使えないため、
    // about:blank ではなく https のURLに模擬HTMLを返して開く
    async function load(page, html) {

        await page.route(
            'https://example.test/**',
            route =>
                route.fulfill({
                    contentType: 'text/html; charset=utf-8',
                    body: html
                })
        );

        await page.goto('https://example.test/page');

        await page.addScriptTag({ content: SCRIPT });
    }


    const extract =
        page =>
            page.evaluate(
                () => window.__tmCopyText.extract()
            );


    // --------------------------------------------------------
    console.log('本文の取得');
    // --------------------------------------------------------

    await test('本文・装飾・リスト・コード・表が Markdown になる', async page => {

        await load(page, ARTICLE_PAGE);

        const { text, method } = await extract(page);

        assert.match(method, /article|main/);

        assert.match(text, /^# テスト記事 - サンプルサイト/);
        assert.match(text, /- URL: /);
        assert.match(text, /- 取得日時: /);

        assert.match(text, /\*\*太字\*\*/);
        assert.match(text, /\*斜体\*/);
        assert.match(text, /`inline\(\)`/);
        assert.match(text, /\[リンク\]\(https:\/\/example\.com\/x\)/);

        assert.match(text, /- 項目1/);
        assert.match(text, /- 項目2\n {2}- 入れ子A/);
        assert.match(text, /3\. 三番\n4\. 四番/);

        assert.match(text, /```js\nconst a = 1;\nconsole\.log\(a\);\n```/);

        assert.match(text, /\| 名前 \| 値 \|\n\| --- \| --- \|\n\| foo \| 1 \|\n\| bar \| 2 \|/);

        assert.match(text, /> 引用文/);
    });


    await test('タイトルと同じ h1 は二重に出ない', async page => {

        await load(page, ARTICLE_PAGE);

        const { text } = await extract(page);

        assert.equal(
            (text.match(/テスト記事/g) || []).length,
            1
        );
    });


    await test('article/main が無いページは文字量スコアで本文を選ぶ', async page => {

        await load(page, PLAIN_PAGE);

        const { text, method } = await extract(page);

        assert.match(method, /文字量スコア/);
        assert.match(text, /これは本文の段落です/);
        assert.doesNotMatch(text, /メニュー1/);
    });


    // --------------------------------------------------------
    console.log('周辺メニュー・広告の除外');
    // --------------------------------------------------------

    await test('メニュー・サイドバー・フッター・共有・関連記事が消える', async page => {

        await load(page, ARTICLE_PAGE);

        const { text } = await extract(page);

        for (const noise of [
            'サイトロゴ',
            'メニューA',
            'サイドバーの文章',
            'アサイドの文章',
            'フッターの著作権表示',
            'Xで共有',
            '関連記事1',
            'タグ甲'
        ]) {
            assert.ok(
                !text.includes(noise),
                noise + ' が残っている'
            );
        }
    });


    await test('広告ブロッカーが display:none にしたものは含まれない', async page => {

        await load(page, ARTICLE_PAGE);

        const { text } = await extract(page);

        assert.ok(!text.includes('広告ブロッカーが消した広告テキスト'));
        assert.ok(!text.includes('無関係な非表示モーダルの雛形'));
    });


    // --------------------------------------------------------
    console.log('画面外・折りたたみ');
    // --------------------------------------------------------

    await test('画面外（スクロールしないと見えない部分）も含まれる', async page => {

        await load(page, ARTICLE_PAGE);

        const { text } = await extract(page);

        assert.match(text, /画面外の一番下の段落/);
    });


    await test('閉じた折りたたみの中身が、開いた状態として含まれる', async page => {

        await load(page, ARTICLE_PAGE);

        const { text } = await extract(page);

        assert.match(text, /\*\*閉じたdetails\*\*/);
        assert.match(text, /detailsの中身/);
        assert.match(text, /タブ1の中身/);
        assert.match(text, /タブ2の中身（非選択）/);
        assert.match(text, /回答1（aria-controls で指されている）/);
        assert.match(text, /CSSで畳まれた回答/);
    });


    await test('折りたたみの中でも、広告らしいものは含まれない', async page => {

        await load(page, ARTICLE_PAGE);

        const { text } = await extract(page);

        assert.ok(!text.includes('折りたたみ内の広告'));
    });


    await test('要素の使い回し: 隠す→出す→隠すで、その時点の状態に追従する', async page => {

        await load(
            page,
            ARTICLE_PAGE.replace(
                '<p id="far">',
                '<p id="toggle">切り替え対象</p><p id="far">'
            )
        );

        const visible1 = (await extract(page)).text;

        await page.evaluate(() => {
            document.getElementById('toggle').style.display = 'none';
        });

        const hidden = (await extract(page)).text;

        await page.evaluate(() => {
            document.getElementById('toggle').style.display = '';
        });

        const visible2 = (await extract(page)).text;

        assert.match(visible1, /切り替え対象/);
        assert.ok(!hidden.includes('切り替え対象'));
        assert.match(visible2, /切り替え対象/);
    });


    // --------------------------------------------------------
    console.log('選択範囲');
    // --------------------------------------------------------

    await test('選択範囲があれば、その部分だけをコピーする', async page => {

        await load(page, ARTICLE_PAGE);

        await page.evaluate(() => {

            const p = document.querySelector('article p');

            const range = document.createRange();

            range.selectNodeContents(p);

            const selection = getSelection();

            selection.removeAllRanges();

            selection.addRange(range);
        });

        const { text, method } = await extract(page);

        assert.equal(method, '選択範囲');
        assert.match(text, /導入の段落/);
        assert.match(text, /\*\*太字\*\*/);
        assert.doesNotMatch(text, /項目1/);
        assert.doesNotMatch(text, /画面外/);
    });


    await test('選択範囲は周辺メニューの除外をせずそのまま渡す', async page => {

        await load(page, ARTICLE_PAGE);

        await page.evaluate(() => {

            const range = document.createRange();

            range.selectNodeContents(document.querySelector('aside'));

            const selection = getSelection();

            selection.removeAllRanges();

            selection.addRange(range);
        });

        const { text } = await extract(page);

        assert.match(text, /アサイドの文章/);
    });


    await test('文の途中からの選択は、選んだ文字だけになる', async page => {

        await load(
            page,
            '<!doctype html><title>t</title><body><p id="p">あいうえおかきくけこ</p></body>'
        );

        await page.evaluate(() => {

            const node = document.getElementById('p').firstChild;

            const range = document.createRange();

            range.setStart(node, 2);
            range.setEnd(node, 5);

            const selection = getSelection();

            selection.removeAllRanges();

            selection.addRange(range);
        });

        const { text } = await extract(page);

        assert.match(text, /\n\nうえお\n$/);
        assert.doesNotMatch(text, /あい/);
        assert.doesNotMatch(text, /かき/);
    });


    // --------------------------------------------------------
    console.log('コピー操作・診断');
    // --------------------------------------------------------

    await test('Alt+Shift+C でクリップボードに入る', async page => {

        await load(page, ARTICLE_PAGE);

        await page.keyboard.press('Alt+Shift+KeyC');

        await page.waitForFunction(
            () => window.__tmCopyText.last
        );

        const clip =
            await page.evaluate(
                () => navigator.clipboard.readText()
            );

        assert.match(clip, /^# テスト記事/);
        assert.match(clip, /導入の段落/);
        assert.ok(!clip.includes('メニューA'));
    });


    await test('ボタンを押しても選択範囲が解除されない', async page => {

        await load(page, ARTICLE_PAGE);

        await page.evaluate(() => {

            const range = document.createRange();

            range.selectNodeContents(document.querySelector('article p'));

            const selection = getSelection();

            selection.removeAllRanges();

            selection.addRange(range);
        });

        // Shadow DOM 内のボタンを座標でクリックする
        const box =
            await page.evaluate(() => {

                const host = document.getElementById('tm-copy-text-host');

                const rect =
                    host.shadowRoot
                        .querySelector('button')
                        .getBoundingClientRect();

                return {
                    x: rect.x + rect.width / 2,
                    y: rect.y + rect.height / 2
                };
            });

        await page.mouse.click(box.x, box.y);

        await page.waitForFunction(
            () => window.__tmCopyText.last
        );

        const clip =
            await page.evaluate(
                () => navigator.clipboard.readText()
            );

        assert.match(clip, /導入の段落/);
        assert.doesNotMatch(clip, /項目1/);
    });


    await test('自作UI（ボタン・トースト）は本文に混ざらない', async page => {

        await load(page, PLAIN_PAGE);

        const { text } = await extract(page);

        assert.doesNotMatch(text, /📋/);
    });


    await test('ボタンが消されても自動で作り直される', async page => {

        await load(page, ARTICLE_PAGE);

        await page.evaluate(() => {
            document.getElementById('tm-copy-text-host').remove();
        });

        await page.waitForFunction(
            () => document.getElementById('tm-copy-text-host')
        );
    });


    await test('dump() が判定理由の表を返す', async page => {

        await load(page, ARTICLE_PAGE);

        const result =
            await page.evaluate(
                () => window.__tmCopyText.dump()
            );

        const kinds = new Set(result.log.map(row => row.判定));

        assert.ok(kinds.has('除外'));
        assert.ok(kinds.has('展開して含めた'));

        assert.ok(
            result.log.some(row => row.理由.includes('リンク密度'))
        );
    });



    // --------------------------------------------------------
    console.log('ボタンの位置・ドラッグ');
    // --------------------------------------------------------

    // ボタンの画面上の矩形（Shadow DOM の中）
    const buttonRect =
        page =>
            page.evaluate(() => {

                const rect =
                    document
                        .getElementById('tm-copy-text-host')
                        .shadowRoot
                        .querySelector('button')
                        .getBoundingClientRect();

                return {
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height,
                    cx: rect.x + rect.width / 2,
                    cy: rect.y + rect.height / 2
                };
            });


    await test('初期位置は、上のほうで中央より右・右端より左（タイトルとメニューを避ける）', async page => {

        await page.setViewportSize({ width: 390, height: 780 });

        await load(page, ARTICLE_PAGE);

        const rect = await buttonRect(page);

        // 上端の近く（ただし最上段そのものではない）
        assert.ok(rect.y >= 60 && rect.y <= 140, 'y=' + rect.y);

        // 中央（195）より右、右端の角より左
        assert.ok(rect.cx > 195 + 40, 'cx=' + rect.cx);
        assert.ok(rect.cx < 390 - 60, 'cx=' + rect.cx);
    });


    await test('マウスでドラッグすると動き、コピーは走らない', async page => {

        await load(page, ARTICLE_PAGE);

        const before = await buttonRect(page);

        await page.mouse.move(before.cx, before.cy);
        await page.mouse.down();
        await page.mouse.move(before.cx - 200, before.cy + 300, { steps: 8 });
        await page.mouse.up();

        const after = await buttonRect(page);

        assert.ok(Math.abs(after.cx - (before.cx - 200)) <= 2, 'cx=' + after.cx);
        assert.ok(Math.abs(after.cy - (before.cy + 300)) <= 2, 'cy=' + after.cy);

        const last =
            await page.evaluate(() => window.__tmCopyText.last);

        assert.equal(last, null, 'ドラッグでコピーが走った');
    });


    await test('ドラッグのあとでも、動かさずに押せばコピーされる', async page => {

        await load(page, ARTICLE_PAGE);

        const before = await buttonRect(page);

        await page.mouse.move(before.cx, before.cy);
        await page.mouse.down();
        await page.mouse.move(before.cx - 100, before.cy + 100, { steps: 5 });
        await page.mouse.up();

        const moved = await buttonRect(page);

        await page.mouse.click(moved.cx, moved.cy);

        await page.waitForFunction(
            () => window.__tmCopyText.last
        );
    });


    await test('画面の外へは出せない', async page => {

        await page.setViewportSize({ width: 390, height: 780 });

        await load(page, ARTICLE_PAGE);

        const start = await buttonRect(page);

        for (const [tx, ty] of [
            [-500, -500],
            [5000, 5000],
            [-500, 5000],
            [5000, -500]
        ]) {

            const from = await buttonRect(page);

            await page.mouse.move(from.cx, from.cy);
            await page.mouse.down();
            await page.mouse.move(tx, ty, { steps: 6 });
            await page.mouse.up();

            const rect = await buttonRect(page);

            assert.ok(rect.x >= 0 && rect.y >= 0, JSON.stringify(rect));
            assert.ok(rect.x + rect.width <= 390, JSON.stringify(rect));
            assert.ok(rect.y + rect.height <= 780, JSON.stringify(rect));
        }

        assert.ok(start.width > 0);
    });


    await test('位置は再読み込みしても覚えている', async page => {

        await load(page, ARTICLE_PAGE);

        const before = await buttonRect(page);

        await page.mouse.move(before.cx, before.cy);
        await page.mouse.down();
        await page.mouse.move(200, 400, { steps: 6 });
        await page.mouse.up();

        const moved = await buttonRect(page);

        await page.reload();

        await page.addScriptTag({ content: SCRIPT });

        const restored = await buttonRect(page);

        assert.ok(Math.abs(restored.x - moved.x) <= 2, JSON.stringify([moved, restored]));
        assert.ok(Math.abs(restored.y - moved.y) <= 2, JSON.stringify([moved, restored]));
    });


    await test('画面サイズが変わっても、ボタンは画面内に残る', async page => {

        await load(page, ARTICLE_PAGE);

        const before = await buttonRect(page);

        await page.mouse.move(before.cx, before.cy);
        await page.mouse.down();
        await page.mouse.move(1200, 700, { steps: 6 });
        await page.mouse.up();

        await page.setViewportSize({ width: 390, height: 500 });

        // resize イベントの処理を待ってから測る
        await page.waitForFunction(
            () => {

                const rect =
                    document
                        .getElementById('tm-copy-text-host')
                        .shadowRoot
                        .querySelector('button')
                        .getBoundingClientRect();

                return (
                    rect.right <= window.innerWidth &&
                    rect.bottom <= window.innerHeight
                );
            },
            null,
            { timeout: 3000 }
        );

        const rect = await buttonRect(page);

        assert.ok(rect.x >= 0 && rect.y >= 0, JSON.stringify(rect));
        assert.ok(rect.x + rect.width <= 390, JSON.stringify(rect));
        assert.ok(rect.y + rect.height <= 500, JSON.stringify(rect));
    });


    await test('トーストは、ボタンが上でも下でも画面内に収まる', async page => {

        await page.setViewportSize({ width: 390, height: 780 });

        await load(page, ARTICLE_PAGE);

        const toastRect =
            () =>
                page.evaluate(() => {

                    const toast =
                        document
                            .getElementById('tm-copy-text-host')
                            .shadowRoot
                            .querySelector('div');

                    const rect = toast.getBoundingClientRect();

                    return {
                        left: rect.left,
                        right: rect.right,
                        top: rect.top,
                        bottom: rect.bottom,
                        opacity: toast.style.opacity
                    };
                });

        // 初期位置（上）
        await page.evaluate(() => window.__tmCopyText.copy());

        await page.waitForFunction(
            () => window.__tmCopyText.last
        );

        let rect = await toastRect();

        assert.equal(rect.opacity, '1');
        assert.ok(rect.left >= 0 && rect.right <= 390, JSON.stringify(rect));
        assert.ok(rect.top >= 0 && rect.bottom <= 780, JSON.stringify(rect));


        // 右下の隅へ動かす
        const from = await buttonRect(page);

        await page.mouse.move(from.cx, from.cy);
        await page.mouse.down();
        await page.mouse.move(5000, 5000, { steps: 6 });
        await page.mouse.up();

        await page.evaluate(() => window.__tmCopyText.copy());

        rect = await toastRect();

        assert.ok(rect.left >= 0 && rect.right <= 390, JSON.stringify(rect));
        assert.ok(rect.top >= 0 && rect.bottom <= 780, JSON.stringify(rect));


        // 左下の隅へ動かす
        const from2 = await buttonRect(page);

        await page.mouse.move(from2.cx, from2.cy);
        await page.mouse.down();
        await page.mouse.move(-5000, 5000, { steps: 6 });
        await page.mouse.up();

        await page.evaluate(() => window.__tmCopyText.copy());

        rect = await toastRect();

        assert.ok(rect.left >= 0 && rect.right <= 390, JSON.stringify(rect));
        assert.ok(rect.top >= 0 && rect.bottom <= 780, JSON.stringify(rect));
    });


    await test('指でドラッグすると動き、ページはスクロールしない', async page => {

        await load(page, ARTICLE_PAGE);

        const client =
            await page.context().newCDPSession(page);

        const before = await buttonRect(page);

        const touch =
            (type, x, y) =>
                client.send(
                    'Input.dispatchTouchEvent',
                    {
                        type,
                        touchPoints:
                            type === 'touchEnd'
                                ? []
                                : [{ x, y }]
                    }
                );

        await touch('touchStart', before.cx, before.cy);

        for (let i = 1; i <= 10; i++) {

            await touch(
                'touchMove',
                before.cx - 12 * i,
                before.cy + 30 * i
            );
        }

        await touch('touchEnd');

        const after = await buttonRect(page);

        assert.ok(Math.abs(after.cx - (before.cx - 120)) <= 3, 'cx=' + after.cx);
        assert.ok(Math.abs(after.cy - (before.cy + 300)) <= 3, 'cy=' + after.cy);

        const scrollY = await page.evaluate(() => window.scrollY);

        assert.equal(scrollY, 0, 'ページがスクロールした');

        const last =
            await page.evaluate(() => window.__tmCopyText.last);

        assert.equal(last, null, 'ドラッグでコピーが走った');
    }, touchContext);


    await test('指でタップするとコピーされる', async page => {

        await load(page, ARTICLE_PAGE);

        const rect = await buttonRect(page);

        await page.touchscreen.tap(rect.cx, rect.cy);

        await page.waitForFunction(
            () => window.__tmCopyText.last
        );

        const clip =
            await page.evaluate(
                () => navigator.clipboard.readText()
            );

        assert.match(clip, /^# テスト記事/);
    }, touchContext);


    await browser.close();

    console.log('\n' + passed + ' 件通過');
}


main().catch(error => {

    console.error(error);

    process.exit(1);
});
