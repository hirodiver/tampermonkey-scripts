// page-to-markdown.user.js の X（旧Twitter）ポスト専用処理の検証（ヘッドレスChromium + 模擬DOM）
//
//   NODE_PATH=$(npm root -g) node test/page-to-markdown-x.test.js
//
// 模擬DOMは、Google Drive に実際に保存された X のポストの出力
// （タイトルと本文の重複・返信を本文に取る・絵文字 alt・時刻リンク・反応数の断片）を再現するように組んだ。
// X の実DOMそのものではないので、通ることは実機で動くことを保証しない。

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

    const globalRoot = execSync('npm root -g').toString().trim();

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

function post(options) {

    const {
        name, handle, id, text, iso, label,
        nameEmoji = '', stats = '', extra = ''
    } = options;

    return `
<article role="article" tabindex="0">
  <div>
    <div><a href="/${handle}" role="link"><div><img alt="" src="a.png"></div></a></div>
    <div>
      <div>
        <div><a href="/${handle}" role="link"><span><span>${name}</span>${nameEmoji}</span></a></div>
        <div>
          <a href="/${handle}" role="link"><span>@${handle}</span></a>
          <span>·</span>
          <a href="/${handle}/status/${id}" role="link"><time datetime="${iso}">${label}</time></a>
        </div>
      </div>
      <div lang="ja"><span>${text}</span></div>
      ${extra}
      ${stats}
    </div>
  </div>
</article>`;
}


const STATS = `
<div>
  <span>1.3万</span>
  <span>件の表示</span>
</div>
<div role="group">
  <a href="/rioriost/status/1001/quotes"><span>2 引用</span></a>
  <a href="/rioriost/status/1001/retweets"><span>31 リポスト</span></a>
</div>`;

const EMOJI_NAME =
    '<img alt="🐝" src="e1.png"><img alt="🇺🇦" src="e2.png">';

const TCO_LINK =
    '<a href="https://t.co/Tu4fVjCS0V"><span>http://chatgpt.com/cyber</span></a>';

const REPLY_TEXT =
    'これは返信です。元のポストより長い文章にして、文字数だけで選ぶと返信が選ばれてしまう状況を作ります。'.repeat(6);

const TITLE =
    'Xユーザーのただの養蜂家ださん: 「元のポストの本文です。」 / X';


function page(title, body) {

    return `<!doctype html><html lang="ja"><head><title>${title}</title></head><body>
<header role="banner"><nav role="navigation"><a href="/home">ホーム</a><a href="/explore">話題を検索</a><a href="/notifications">通知</a></nav></header>
<main role="main"><div><h2 role="heading"><span>ポスト</span></h2>${body}</div></main>
</body></html>`;
}


const THREAD_PAGE = page(
    TITLE,
    post({
        name: 'ただの養蜂家だ', handle: 'rioriost', id: '1001',
        text: '元のポストの本文です。<a href="/hashtag/x"><span>#タグ</span></a> ' + TCO_LINK +
            '<img alt="😀" src="e.png">',
        iso: '2026-10-03T08:38:00.000Z', label: '午後5:38 · 2026年10月3日',
        nameEmoji: EMOJI_NAME, stats: STATS,
        extra: '<div><img alt="画像" src="p.jpg"></div>'
    }) +
    '<h2 role="heading"><span>返信</span></h2>' +
    post({
        name: '返信 花子', handle: 'hanako', id: '1002',
        text: REPLY_TEXT,
        iso: '2026-10-03T09:00:00.000Z', label: '午後6:00',
        stats: '<div><span>35</span></div>'
    })
);

const ARTICLE_PAGE = page(
    'Xユーザーのラッキーさん: 「ロードマップ」 / X',
    post({
        name: 'ラッキー', handle: 'lucky_note_lab', id: '2001',
        text: 'ロードマップ',
        iso: '2026-09-30T00:00:00.000Z', label: '2026年9月30日',
        extra: '<div><span>2.2万</span></div>' +
            '<div><h1>全体の地図</h1><p>第1週は頼むことに慣れます。</p><h2>DAY1 最初の依頼</h2><p>やることは3つです。</p></div>'
    })
);


// ------------------------------------------------------------
// 実行
// ------------------------------------------------------------

async function main() {

    const browser =
        await chromium.launch({
            executablePath: process.env.CHROMIUM_PATH || undefined
        });

    const context =
        await browser.newContext({
            permissions: ['clipboard-read', 'clipboard-write']
        });

    let passed = 0;

    async function test(name, fn) {

        const page = await context.newPage();

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


    async function load(page, url, html) {

        await page.route(
            'https://x.com/**',
            route =>
                route.fulfill({
                    contentType: 'text/html; charset=utf-8',
                    body: html
                })
        );

        await page.goto(url);

        await page.addScriptTag({ content: SCRIPT });
    }


    const extract =
        page => page.evaluate(() => window.__tmCopyText.extract());


    // --------------------------------------------------------
    console.log('X のポスト');
    // --------------------------------------------------------

    await test('URL の status ID と一致するポストだけを取り、返信は取らない', async page => {

        await load(page, 'https://x.com/rioriost/status/1001?s=46', THREAD_PAGE);

        const { text, method } = await extract(page);

        assert.equal(method, 'X のポスト');
        assert.match(text, /元のポストの本文です。/);
        assert.doesNotMatch(text, /これは返信です/);
        assert.doesNotMatch(text, /花子/);
    });

    await test('返信のURLなら、返信のほうを取る（長さでは選ばない）', async page => {

        await load(page, 'https://x.com/hanako/status/1002', THREAD_PAGE);

        const { text } = await extract(page);

        assert.match(text, /これは返信です/);
        assert.doesNotMatch(text, /元のポストの本文です/);
    });

    await test('見出しは短く、本文と二重にならない', async page => {

        await load(page, 'https://x.com/rioriost/status/1001', THREAD_PAGE);

        const { text } = await extract(page);

        assert.match(text, /^# ただの養蜂家だ🐝🇺🇦 \(@rioriost\) のポスト\n/);
        assert.match(text, /- 投稿日時: 2026-10-03 17:38/);
        assert.match(text, /- 取得日時: /);

        // 本文は1回だけ
        assert.equal(text.split('元のポストの本文です。').length, 2);

        // 画面上の見出し（「ポスト」「返信」）は入らない
        assert.doesNotMatch(text, /^##? (ポスト|返信)$/m);
    });

    await test('投稿者・日時・「·」・数字の断片が本文に残らない', async page => {

        await load(page, 'https://x.com/rioriost/status/1001', THREAD_PAGE);

        const { text } = await extract(page);

        const body = text.split('\n---\n')[1];

        assert.doesNotMatch(body, /@rioriost/);
        assert.doesNotMatch(body, /^·$/m);
        assert.doesNotMatch(body, /午後5:38/);
        assert.doesNotMatch(body, /^1\.3万$/m);
        assert.doesNotMatch(body, /\]\(https:\/\/x\.com\/rioriost\/status\/1001\/quotes\)/);
        assert.match(body, /反応: 表示 1\.3万 \/ 引用 2 \/ リポスト 31/);
    });

    await test('絵文字・画像 alt・t.co リンクが整う', async page => {

        await load(page, 'https://x.com/rioriost/status/1001', THREAD_PAGE);

        const { text } = await extract(page);

        assert.match(text, /😀/);
        assert.doesNotMatch(text, /\[画像: 😀\]/);
        assert.match(text, /^\[画像\]$/m);
        assert.doesNotMatch(text, /\[画像: 画像\]/);

        // ラベルがURLのリンクは、ラベルだけにする
        assert.match(text, /http:\/\/chatgpt\.com\/cyber/);
        assert.doesNotMatch(text, /https:\/\/t\.co/);

        // 普通のリンクは残る
        assert.match(text, /\[#タグ\]\(https:\/\/x\.com\/hashtag\/x\)/);
    });

    await test('長文記事の見出しは1段下がり、数字だけの行は外れる', async page => {

        await load(page, 'https://x.com/lucky_note_lab/status/2001', ARTICLE_PAGE);

        const { text } = await extract(page);

        assert.match(text, /^# ラッキー \(@lucky_note_lab\) のポスト\n/);
        assert.match(text, /^## 全体の地図$/m);
        assert.match(text, /^### DAY1 最初の依頼$/m);
        assert.doesNotMatch(text, /^# 全体の地図$/m);
        assert.doesNotMatch(text, /^2\.2万$/m);
    });

    await test('Drive のファイル名用タイトルは、投稿者と本文の冒頭になる', async page => {

        await load(page, 'https://x.com/rioriost/status/1001', THREAD_PAGE);

        const { title } = await extract(page);

        assert.match(title, /^ただの養蜂家だ🐝🇺🇦 \(@rioriost\) 元のポストの本文です。/);
        assert.ok(title.length < 80);
    });

    await test('status ID が URL に無い・一致しないときは、通常の本文判定に戻る', async page => {

        await load(page, 'https://x.com/home', THREAD_PAGE);

        const first = await extract(page);

        assert.notEqual(first.method, 'X のポスト');
        assert.match(first.text, /^# Xユーザーの/);

        const other = await page.evaluate(() => {
            history.pushState({}, '', '/rioriost/status/9999');
            return window.__tmCopyText.extract().method;
        });

        assert.notEqual(other, 'X のポスト');
    });

    await test('文字を選択していれば、X でも選択範囲を優先する', async page => {

        await load(page, 'https://x.com/rioriost/status/1001', THREAD_PAGE);

        const result = await page.evaluate(() => {

            const target = document.querySelector('[lang="ja"] span');
            const range = document.createRange();

            range.selectNodeContents(target);

            const selection = getSelection();

            selection.removeAllRanges();
            selection.addRange(range);

            return window.__tmCopyText.extract();
        });

        assert.equal(result.method, '選択範囲');
        assert.match(result.text, /元のポストの本文です/);
    });

    await test('X 以外のサイトの出力は変わらない（# タイトルのまま）', async page => {

        await page.route(
            'https://example.com/**',
            route =>
                route.fulfill({
                    contentType: 'text/html; charset=utf-8',
                    body: '<!doctype html><title>通常記事</title><main><h1>見出し</h1><p>' +
                        '本文です。'.repeat(60) + '</p></main>'
                })
        );

        await page.goto('https://example.com/a/status/1');
        await page.addScriptTag({ content: SCRIPT });

        const { text, method } = await extract(page);

        assert.notEqual(method, 'X のポスト');
        assert.match(text, /^# 通常記事\n/);
        assert.match(text, /^# 見出し$/m);
    });


    await browser.close();

    console.log('\n' + passed + ' 件通過');
}


main().catch(error => {

    console.error(error);

    process.exit(1);
});
