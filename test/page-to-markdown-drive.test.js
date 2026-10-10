// Drive通信はモック化し、実際のDOM・クリック・クリップボード処理を検証する。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright');
const script = fs.readFileSync(path.join(__dirname, '../page-to-markdown.user.js'), 'utf8');
const receiver = fs.readFileSync(path.join(__dirname, '../page-markdown-receiver.gs'), 'utf8');
const token = 'a'.repeat(64);
const url = 'https://script.google.com/macros/s/test-deployment/exec';
let passed = 0;

async function main() {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    async function test(name, fn, options = {}) {
        const page = await context.newPage();
        try {
            await page.route('https://example.com/**', route => route.fulfill({
                contentType: 'text/html; charset=utf-8',
                body: '<title>保存テスト</title><article><p id="text">' + '本文のテストです。'.repeat(100) + '</p></article>'
            }));
            await page.goto('https://example.com/article');
            await page.evaluate(({ token, url, options }) => {
                window.sent = [];
                window.menus = {};
                window.settings = options.unconfigured ? null : { token, url };
                // 拡張機能の保存領域。設定以外（未保存の控え）は store に入る
                window.store = options.store ? JSON.parse(JSON.stringify(options.store)) : {};
                const configKey = 'tm-copy-text-drive-config';
                window.GM_getValue = (key, fallback) => key === configKey
                    ? window.settings
                    : (key in window.store ? JSON.parse(JSON.stringify(window.store[key])) : fallback);
                window.GM_setValue = (key, value) => {
                    if (key === configKey) window.settings = value;
                    else window.store[key] = JSON.parse(JSON.stringify(value));
                };
                window.GM_listValues = () => [configKey, ...Object.keys(window.store)];
                window.GM_deleteValue = key => { delete window.store[key]; };
                window.GM_registerMenuCommand = (name, fn) => { window.menus[name] = fn; };
                window.GM_xmlhttpRequest = request => {
                    window.sent.push({ ...request, payload: JSON.parse(request.data) });
                    if (window.mode === 'hold') { window.pending = request; return; }
                    if (window.mode === 'error') { request.onerror(); return; }
                    if (window.mode === 'timeout') { request.ontimeout(); return; }
                    // 受け口の答えを送信内容ごとに決める（断る・保存済みのものと比べる など）
                    if (window.respond) { request.onload({ status: 200, responseText: JSON.stringify(window.respond(JSON.parse(request.data))) }); return; }
                    request.onload({ status: 200, responseText: window.mode === 'html'
                        ? '<html>login</html>'
                        : JSON.stringify({ ok: true, fileId: 'test-file' }) });
                };
                window.mode = options.mode || 'success';
                if (options.copyFail) {
                    Object.defineProperty(navigator, 'clipboard', { value: {
                        writeText: () => Promise.reject(new Error('denied'))
                    } });
                    document.execCommand = () => false;
                }
            }, { token, url, options });
            await page.addScriptTag({ content: script });
            await fn(page);
            passed++;
            console.log('ok ' + name);
        } finally { await page.close(); }
    }
    const toast = page => page.evaluate(() => document.getElementById('tm-copy-text-host').shadowRoot.querySelector('div').textContent);
    await test('初期表示・診断で送信しない', async page => {
        await page.evaluate(() => window.__tmCopyText.extract());
        assert.equal(await page.evaluate(() => window.sent.length), 0);
        assert.equal(await page.evaluate(() => Object.keys(window.menus).length), 4);
    });
    await test('ボタンで保存とコピー・限定URLと匿名送信', async page => {
        await page.locator('#tm-copy-text-host button').click();
        await page.waitForFunction(() => window.sent.length === 1);
        assert.match(await toast(page), /Driveに保存し、コピー/);
        const data = await page.evaluate(() => ({ r: window.sent[0] }));
        const request = data.r;
        assert.equal(request.url, url);
        assert.equal(request.anonymous, true);
        assert.equal(request.payload.token, token);
        assert.match(request.payload.markdown, /^# 保存テスト/);
        assert.match(request.payload.requestId, /^[a-f0-9-]{36}$/);
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), request.payload.markdown);
        assert.equal(await page.evaluate(() => localStorage.getItem('tm-copy-text-drive-config')), null);
    });
    for (const mode of ['error', 'timeout', 'html']) {
        await test(mode + 'でもコピーを残し保存成功と表示しない', async page => {
            await page.evaluate(() => window.__tmCopyText.copy());
            assert.match(await toast(page), /コピー済み/);
            assert.doesNotMatch(await toast(page), /Driveに保存し/);
            assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^# 保存テスト/);
        }, { mode });
    }
    await test('コピー失敗でもDrive保存を実行', async page => {
        await page.evaluate(() => window.__tmCopyText.copy());
        assert.equal(await page.evaluate(() => window.sent.length), 1);
        assert.match(await toast(page), /Driveに保存しました。コピーは失敗/);
    }, { copyFail: true });
    await test('未設定ではコピーだけ', async page => {
        await page.evaluate(() => window.__tmCopyText.copy());
        assert.equal(await page.evaluate(() => window.sent.length), 0);
        assert.match(await toast(page), /文字をコピー/);
    }, { unconfigured: true });
    await test('通信中の連打は送信1回・再送IDを再利用', async page => {
        await page.evaluate(() => { window.first = window.__tmCopyText.copy(); });
        await page.evaluate(() => window.__tmCopyText.copy());
        assert.equal(await page.evaluate(() => window.sent.length), 1);
        await page.evaluate(async () => { window.pending.onerror(); await window.first; window.mode = 'success'; await window.__tmCopyText.copy(); });
        const ids = await page.evaluate(() => window.sent.map(x => x.payload.requestId));
        assert.equal(ids[0], ids[1]);
    }, { mode: 'hold' });
    await test('Google以外のURLへは送信しない', async page => {
        await page.evaluate(async () => { window.settings.url = 'https://example.com/receiver'; await window.__tmCopyText.copy(); });
        assert.equal(await page.evaluate(() => window.sent.length), 0);
        assert.match(await toast(page), /設定をやり直し/);
    });
    await test('設定のキャンセル・登録・停止', async page => {
        await page.evaluate(({ url, token }) => {
            window.prompt = () => null;
            window.menus['Drive保存を設定／停止']();
            if (window.settings !== null) throw new Error('キャンセルで設定が変わった');
            const answers = [url, token];
            window.prompt = () => answers.shift();
            window.menus['Drive保存を設定／停止']();
        }, { url, token });
        assert.deepEqual(await page.evaluate(() => window.settings), { url, token });
        await page.evaluate(() => { window.prompt = () => ''; window.menus['Drive保存を設定／停止'](); });
        assert.equal(await page.evaluate(() => window.settings), null);
        assert.equal(await page.evaluate(() => window.sent.length), 0);
    }, { unconfigured: true });

    // ---- 届かなかった保存の控えと再送 ----
    const badge = page => page.evaluate(() => {
        const el = document.getElementById('tm-copy-text-host').shadowRoot.querySelectorAll('div')[1];
        return el.style.display === 'none' ? '' : el.textContent;
    });
    const pendingKeys = page => page.evaluate(() => Object.keys(window.store).filter(key => key.startsWith('tm-copy-text-pending:')));
    const mapStore = (store, change) => Object.fromEntries(Object.entries(store).map(([key, value]) => [key, { ...value, ...change(value) }]));
    let leftBehind = null;
    await test('送信中は控えを持ち、コピー完了をDrive応答前に知らせる', async page => {
        await page.locator('#tm-copy-text-host button').click();
        await page.waitForFunction(() => window.sent.length === 1);
        await page.waitForFunction(() => /コピーしました。Driveへ送信中/.test(
            document.getElementById('tm-copy-text-host').shadowRoot.querySelector('div').textContent));
        assert.match(await toast(page), /移動して大丈夫/);
        assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^# 保存テスト/);
        assert.equal((await pendingKeys(page)).length, 1);
        assert.equal(await badge(page), '1');
        leftBehind = await page.evaluate(() => window.store);
    }, { mode: 'hold' });
    await test('移動先では待ち時間の前に送らず、件数だけ出す', async page => {
        await page.waitForTimeout(800);
        assert.equal(await page.evaluate(() => window.sent.length), 0);
        assert.equal(await badge(page), '1');
    }, { store: leftBehind });
    await test('移動先で待ち時間を過ぎたら同じIDで送り直し、控えを消す', async page => {
        await page.waitForFunction(() => window.sent.length === 1, null, { timeout: 3000 });
        await page.waitForFunction(() => Object.keys(window.store).length === 0);
        const payload = await page.evaluate(() => window.sent[0].payload);
        assert.equal(payload.requestId, Object.values(leftBehind)[0].requestId);
        assert.deepEqual(Object.keys(payload).sort(), ['capturedAt', 'markdown', 'requestId', 'title', 'token', 'url']);
        assert.match(await toast(page), /未保存だった1件をDriveに保存/);
        assert.equal(await badge(page), '');
    }, { store: mapStore(leftBehind, value => ({ lastTriedAt: value.lastTriedAt - 20000 })) });
    await test('失敗は理由つきで控え、次の成功でまとめて送る', async page => {
        await page.evaluate(() => window.__tmCopyText.copy());
        assert.match(await toast(page), /控えたので、あとで自動で送り直します/);
        assert.equal(await page.evaluate(() => Object.values(window.store)[0].lastError), '通信に失敗しました');
        assert.equal(await badge(page), '1');
        await page.evaluate(async () => {
            window.mode = 'success';
            document.getElementById('text').textContent = '別の本文です。'.repeat(100);
            await window.__tmCopyText.copy();
        });
        await page.waitForFunction(() => Object.keys(window.store).length === 0);
        const ids = await page.evaluate(() => window.sent.map(x => x.payload.requestId));
        assert.equal(ids.length, 3);
        assert.notEqual(ids[1], ids[0]);
        assert.equal(ids[2], ids[0]);
        assert.match(await toast(page), /未保存だった1件をDriveに保存/);
        assert.equal(await badge(page), '');
    }, { mode: 'error' });
    await test('メニューで一覧を確かめて手動で送り直す・キャンセルでは送らない', async page => {
        await page.evaluate(() => { window.confirm = text => { window.confirmText = text; return false; }; });
        await page.evaluate(() => window.menus['未保存を一覧・再送']());
        assert.match(await page.evaluate(() => window.confirmText),
            /未保存 1件[\s\S]*保存テスト[\s\S]*https:\/\/example\.com\/article[\s\S]*理由: 通信に失敗しました/);
        assert.equal(await page.evaluate(() => window.sent.length), 0);
        await page.evaluate(async () => { window.confirm = () => true; await window.menus['未保存を一覧・再送'](); });
        assert.equal(await page.evaluate(() => window.sent.length), 1);
        assert.equal((await pendingKeys(page)).length, 0);
        assert.match(await toast(page), /未保存だった1件をDriveに保存/);
    }, { store: mapStore(leftBehind, () => ({ lastError: '通信に失敗しました' })) });
    await test('手動の送り直しが失敗したら理由を出し、控えは残す', async page => {
        await page.evaluate(async () => { window.confirm = () => true; window.mode = 'error'; await window.menus['未保存を一覧・再送'](); });
        assert.match(await toast(page), /送り直せませんでした: 通信に失敗しました/);
        assert.equal((await pendingKeys(page)).length, 1);
        assert.equal(await page.evaluate(() => Object.values(window.store)[0].attempts), 2);
        assert.equal(await badge(page), '1');
    }, { store: leftBehind });
    await test('未保存がないときの手動送り直し', async page => {
        await page.evaluate(() => window.menus['未保存を一覧・再送']());
        assert.match(await toast(page), /未保存はありません/);
        assert.equal(await page.evaluate(() => window.sent.length), 0);
    });
    await test('メニューで控えを削除', async page => {
        await page.evaluate(() => { window.confirm = () => true; window.menus['未保存の控えを削除'](); });
        assert.equal((await pendingKeys(page)).length, 0);
        assert.equal(await badge(page), '');
        assert.equal(await page.evaluate(() => window.sent.length), 0);
    }, { store: leftBehind });
    const full = {};
    for (let i = 0; i < 20; i++) {
        const record = { ...Object.values(leftBehind)[0], requestId: '00000000-0000-4000-8000-' + String(i).padStart(12, '0') };
        full['tm-copy-text-pending:' + record.requestId] = record;
    }
    await test('控えが上限なら新しい分は控えず、コピーは残す', async page => {
        await page.evaluate(() => window.__tmCopyText.copy());
        assert.equal((await pendingKeys(page)).length, 20);
        assert.match(await toast(page), /コピー済み/);
        assert.doesNotMatch(await toast(page), /控えた/);
        assert.equal(await badge(page), '20');
    }, { mode: 'error', store: full });
    await test('未設定では控えを送らない', async page => {
        await page.waitForTimeout(800);
        assert.equal(await page.evaluate(() => window.sent.length), 0);
        assert.equal(await badge(page), '1');
    }, { unconfigured: true, store: mapStore(leftBehind, value => ({ lastTriedAt: value.lastTriedAt - 20000 })) });

    // ---- 受け口に断られた控え ----
    const stuck = mapStore(leftBehind, value => ({ lastTriedAt: value.lastTriedAt - 3600000, attempts: 3, lastError: 'Drive保存を確認できません。URL・公開設定・トークンを確認してください' }));
    const dupReceiver = () => {
        // 1回目の送信IDは保存済み（中身違い）として断り、新しいIDなら保存する
        window.respond = payload => window.seenIds && window.seenIds.includes(payload.requestId)
            ? { ok: false, message: '送信IDが重複しています。ページを再読み込みしてください' }
            : { ok: true, fileId: 'saved-' + payload.requestId };
    };
    await test('同じIDで断られた控えは新しいIDで送り直し、バッジを消す', async page => {
        await page.evaluate(ids => { window.seenIds = ids; }, Object.values(stuck).map(value => value.requestId));
        await page.evaluate(dupReceiver);
        await page.waitForFunction(() => Object.keys(window.store).length === 0, null, { timeout: 5000 });
        const ids = await page.evaluate(() => window.sent.map(x => x.payload.requestId));
        assert.equal(ids.length, 2);
        assert.equal(ids[0], Object.values(stuck)[0].requestId);
        assert.notEqual(ids[1], ids[0]);
        assert.match(ids[1], /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
        const payloads = await page.evaluate(() => window.sent.map(x => x.payload.markdown));
        assert.equal(payloads[1], payloads[0]);
        assert.match(await toast(page), /未保存だった1件をDriveに保存/);
        assert.equal(await badge(page), '');
    }, { store: stuck });
    await test('押した直後に同じIDで断られても、新しいIDで保存する', async page => {
        await page.evaluate(() => { window.seenIds = []; window.respond = payload => {
            if (!window.seenIds.length) { window.seenIds.push(payload.requestId); return { ok: false, message: '送信IDが重複しています。ページを再読み込みしてください' }; }
            return { ok: true, fileId: 'saved' };
        }; });
        await page.evaluate(() => window.__tmCopyText.copy());
        await page.waitForFunction(() => window.sent.length === 2);
        const ids = await page.evaluate(() => window.sent.map(x => x.payload.requestId));
        assert.notEqual(ids[1], ids[0]);
        assert.match(await toast(page), /Driveに保存し、コピーしました/);
        assert.equal((await pendingKeys(page)).length, 0);
        assert.equal(await badge(page), '');
        // もう一度押しても、断られたIDは使わない
        await page.evaluate(() => window.__tmCopyText.copy());
        assert.equal(await page.evaluate(() => window.sent[2].payload.requestId), ids[1]);
    });
    await test('中身を受け付けないと断られたら理由を出し、自動では送り直さず、ほかの控えは送る', async page => {
        const [first] = Object.values(stuck);
        await page.evaluate(id => { window.respond = payload => payload.requestId === id
            ? { ok: false, message: '本文・タイトル・送信IDが不正です' }
            : { ok: true, fileId: 'saved' }; }, first.requestId);
        await page.waitForFunction(() => window.sent.length === 2, null, { timeout: 5000 });
        await page.waitForFunction(() => /保存できない控えが1件あります: 本文・タイトル・送信IDが不正です/.test(
            document.getElementById('tm-copy-text-host').shadowRoot.querySelector('div').textContent));
        assert.match(await toast(page), /未保存の控えを削除/);
        const left = await page.evaluate(() => Object.values(window.store));
        assert.equal(left.length, 1);
        assert.equal(left[0].requestId, first.requestId);
        assert.equal(left[0].rejected, true);
        assert.equal(await badge(page), '1');
        // 自動では送り直さない（待ち時間を過ぎても送らない）
        await page.evaluate(() => { window.store[Object.keys(window.store)[0]].lastTriedAt -= 3600000; });
        await page.evaluate(() => window.__tmCopyText.copy());
        await page.waitForTimeout(800);
        assert.deepEqual(await page.evaluate(() => window.sent.map(x => x.payload.requestId)).then(ids => ids.filter(id => id === first.requestId).length), 1);
        // メニューの一覧には理由が出る。手動なら送ってみる
        await page.evaluate(() => { window.confirm = text => { window.confirmText = text; return true; }; });
        await page.evaluate(() => window.menus['未保存を一覧・再送']());
        assert.match(await page.evaluate(() => window.confirmText), /理由: 本文・タイトル・送信IDが不正です（自動では送り直しません）/);
        assert.equal(await page.evaluate(id => window.sent.filter(x => x.payload.requestId === id).length, first.requestId), 2);
    }, { store: { ...stuck, ['tm-copy-text-pending:00000000-0000-4000-8000-000000000099']: { ...Object.values(stuck)[0], requestId: '00000000-0000-4000-8000-000000000099', capturedAt: '2099-01-01T00:00:00.000Z' } } });
    await test('受け口の断りの理由を、共通の文言に置き換えずに出す', async page => {
        await page.evaluate(() => { window.respond = () => ({ ok: false, message: '保存処理が混み合っています。再度押してください' }); });
        await page.evaluate(() => window.__tmCopyText.copy());
        assert.match(await toast(page), /混み合っています[\s\S]*あとで自動で送り直します/);
        assert.equal(await page.evaluate(() => Object.values(window.store)[0].rejected), false);
    });
    await test('切れた絵文字は送る前に置き換える', async page => {
        await page.evaluate(() => { document.title = '切れた絵文字\uD83D'; document.getElementById('text').textContent = '本文\uDE00の途中😀正常'.repeat(30); });
        await page.evaluate(() => window.__tmCopyText.copy());
        const payload = await page.evaluate(() => window.sent[0].payload);
        assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(payload.markdown + payload.title));
        assert.match(payload.markdown, /本文�の途中😀正常/);
        assert.match(payload.title, /切れた絵文字�/);
    });
    // ---- 本文の画像 ----
    const addImages = page => page.evaluate(() => {
        const article = document.querySelector('article');
        article.insertAdjacentHTML('beforeend', [
            // 後から読み込む作り（src は仮の画像、本物は data-src）
            '<p><img id="lazy" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/img/chart.png" alt="売上の推移" width="800" height="400"></p>',
            // srcset のいちばん大きいもの
            '<p><img src="https://cdn.example.com/a-small.jpg" srcset="https://cdn.example.com/a-small.jpg 400w, https://cdn.example.com/a-large.jpg 1200w" alt="画像" width="600" height="300"></p>',
            // アイコン（小さい）は保存しない
            '<p>著者 <img src="/icon.png" alt="アイコン" width="24" height="24"> さん</p>',
            // 同じ画像の2回目は同じ番号
            '<p><img src="/img/chart.png" alt="売上の推移" width="800" height="400"></p>'
        ].join(''));
    });
    await test('本文の画像を番号と元のURLで残し、保存対象として送る', async page => {
        await page.route('https://cdn.example.com/**', route => route.abort());
        await addImages(page);
        await page.evaluate(() => { window.respond = () => ({ ok: true, fileId: 'f', images: { saved: 2, failed: 0 } }); });
        await page.evaluate(() => window.__tmCopyText.copy());
        const payload = await page.evaluate(() => window.sent[0].payload);
        assert.deepEqual(payload.images, [
            { n: 1, url: 'https://example.com/img/chart.png', alt: '売上の推移' },
            { n: 2, url: 'https://cdn.example.com/a-large.jpg', alt: '' }
        ]);
        assert.match(payload.markdown, /!\[画像1: 売上の推移\]\(https:\/\/example\.com\/img\/chart\.png\)/);
        assert.match(payload.markdown, /!\[画像2\]\(https:\/\/cdn\.example\.com\/a-large\.jpg\)/);
        assert.match(payload.markdown, /\[画像: アイコン\]/);
        assert.equal((payload.markdown.match(/!\[画像1: /g) || []).length, 2);
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), payload.markdown);
        assert.match(await toast(page), /Driveに保存し、コピーしました（画像2枚）/);
    });
    await test('保存できなかった画像の枚数も出す', async page => {
        await page.route('https://cdn.example.com/**', route => route.abort());
        await addImages(page);
        await page.evaluate(() => { window.respond = () => ({ ok: true, fileId: 'f', images: { saved: 1, failed: 1 } }); });
        await page.evaluate(() => window.__tmCopyText.copy());
        assert.match(await toast(page), /（画像1枚、保存できなかった画像1枚）/);
    });
    await test('画像が20枚を超えたら、21枚目以降は送らずaltだけ残す', async page => {
        await page.evaluate(() => {
            const html = Array.from({ length: 22 }, (_, i) => '<p><img src="/img/p' + i + '.png" alt="図' + i + '" width="300" height="200"></p>').join('');
            document.querySelector('article').insertAdjacentHTML('beforeend', html);
        });
        await page.evaluate(() => window.__tmCopyText.copy());
        const payload = await page.evaluate(() => window.sent[0].payload);
        assert.equal(payload.images.length, 20);
        assert.match(payload.markdown, /!\[画像20: 図19\]/);
        assert.match(payload.markdown, /\[画像: 図20\]/);
    });
    await test('リンクの先が画像なら、その大きい画像を使う（読み込み前で src が無い画像も拾う）', async page => {
        await page.evaluate(() => {
            document.querySelector('article').insertAdjacentHTML('beforeend', [
                '<p><a href="/img/big.png?width=4000&format=jpg"><img src="/img/small.png?width=1200" alt="画像" width="600" height="400"></a></p>',
                '<p><a href="https://cdn.example.com/full.jpeg"><img alt="画像" width="600" height="400"></a></p>',
                // 画像でないページへのリンクは使わない
                '<p><a href="/article/next"><img src="/img/thumb.png" alt="次の記事" width="300" height="200"></a></p>'
            ].join(''));
        });
        await page.evaluate(() => window.__tmCopyText.copy());
        const payload = await page.evaluate(() => window.sent[0].payload);
        assert.deepEqual(payload.images.map(image => image.url), [
            'https://example.com/img/big.png?width=4000&format=jpg',
            'https://cdn.example.com/full.jpeg',
            'https://example.com/img/thumb.png'
        ]);
        assert.doesNotMatch(payload.markdown, /\[画像: 画像\]/);
    });
    await test('画像のないページでは画像の一覧を送らない', async page => {
        await page.evaluate(() => window.__tmCopyText.copy());
        const payload = await page.evaluate(() => window.sent[0].payload);
        assert.equal('images' in payload, false);
    });
    await browser.close();

    // GASのサービス境界をモック化し、認証・作成・再送・例外時ロック解放を確認する。
    const files = new Map();
    const properties = new Map();
    let creations = 0;
    let released = 0;
    let busy = false;
    const folder = {
        getName: () => '参考記事アーカイブ',
        getFilesByName: name => ({ hasNext: () => files.has(name), next: () => files.get(name) }),
        createFile: blob => {
            creations++;
            let content = blob.content;
            const file = { getId: () => String(creations), getName: () => blob.name, getUrl: () => 'https://drive.google.com/file/d/test', getBlob: () => ({ getDataAsString: () => content }), setContent: value => { content = value; } };
            files.set(blob.name, file);
            return file;
        },
        // 記事ごとの画像フォルダ
        getFoldersByName: name => ({ hasNext: () => imageFolders.has(name), next: () => imageFolders.get(name) }),
        createFolder: name => {
            const saved = [];
            const created = { name, saved, createFile: blob => { saved.push(blob.name); return { getUrl: () => 'https://drive.google.com/file/d/img-' + saved.length + '/view' }; } };
            imageFolders.set(name, created);
            return created;
        }
    };
    const imageFolders = new Map();
    // 画像の取得。URLごとに応答を決め、取得した回数と送ったヘッダーを記録する
    const fetched = [];
    let fetchAllThrows = false;
    const imageResponse = url => {
        const route = {
            'https://img.test/a.png': [200, 'image/png'],
            'https://img.test/b.html': [200, 'text/html; charset=utf-8'],
            'https://img.test/d.jpg': [200, 'image/jpeg'],
            // 正式でない種類名・汎用の種類名
            'https://img.test/alias.jpg': [200, 'image/jpg'],
            'https://img.test/raw.png?w=1': [200, 'application/octet-stream'],
            'https://img.test/raw-noext': [200, 'application/octet-stream']
        }[url] || [404, 'text/html'];
        return {
            getResponseCode: () => route[0],
            getHeaders: () => ({ 'Content-Type': route[1] }),
            getContent: () => [1, 2, 3],
            getBlob: () => ({ setName(name) { this.name = name; return this; } })
        };
    };
    const sandbox = {
        console: { log() {} },
        DriveApp: { getFolderById: id => { assert.equal(id, '1WFV1mV24vc2ZwXxBhS2EjhKMhgiRNVRl'); return folder; } },
        PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key), setProperty: (key, value) => properties.set(key, value) }) },
        Utilities: { getUuid: () => '12345678-1234-4234-8234-123456789abc', formatDate: () => '20260930_050000000', newBlob: (content, type, name) => ({ content, type, name }) },
        ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ setMimeType: () => JSON.parse(text) }) },
        LockService: { getScriptLock: () => ({ tryLock: () => !busy, hasLock: () => !busy, releaseLock: () => { released++; } }) },
        UrlFetchApp: {
            fetchAll: requests => {
                if (fetchAllThrows) throw new Error('DNS error');
                return requests.map(request => { fetched.push(request); return imageResponse(request.url); });
            },
            fetch: (url, request) => {
                if (url === 'https://img.test/dns-fail.png') throw new Error('DNS error');
                fetched.push(request);
                return imageResponse(url);
            }
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(receiver, sandbox);
    function check(name, fn) { fn(); passed++; console.log('ok ' + name); }
    sandbox.setup();
    const originalToken = properties.get('ARCHIVE_TOKEN');
    check('setup再実行でトークンを変えない', () => { sandbox.setup(); assert.equal(properties.get('ARCHIVE_TOKEN'), originalToken); assert.match(originalToken, /^[a-f0-9]{64}$/); });
    const input = { token: originalToken, requestId: '12345678-1234-4234-8234-123456789abc', capturedAt: '2026-09-29T20:00:00.000Z', title: '記事:/タイトル', url: 'https://example.com/article', markdown: '# 記事\n\n本文\n' };
    const send = body => sandbox.doPost({ postData: { contents: JSON.stringify(body) } });
    check('トークン不一致でファイル作成なし', () => { assert.equal(send({ ...input, token: 'bad' }).ok, false); assert.equal(creations, 0); });
    check('正しい入力でmd作成・危険なファイル名文字を除去', () => { const r = send(input); assert.equal(r.ok, true); assert.match(r.name, /^20260930_050000000_記事__タイトル_/); assert.match(r.name, /\.md$/); assert.equal(creations, 1); assert.equal(released, 1); });
    check('同じリクエスト再送は1ファイル', () => { assert.equal(send(input).fileId, '1'); assert.equal(creations, 1); });
    check('同じIDの異なる内容は上書きしない', () => { assert.equal(send({ ...input, markdown: '異なる本文' }).ok, false); assert.equal(creations, 1); });
    check('不正・巨大データは作成しない', () => {
        for (const change of [{ markdown: '' }, { markdown: 'a'.repeat(500001) }, { requestId: '../id' }, { capturedAt: 'bad' }, { url: 'javascript:alert(1)' }]) assert.equal(send({ ...input, ...change }).ok, false);
        assert.equal(sandbox.doPost({ postData: { contents: 'not json' } }).ok, false);
        assert.equal(send(null).ok, false);
        assert.equal(creations, 1);
    });
    check('ロック取得失敗時に作成しない', () => { busy = true; assert.equal(send(input).ok, false); busy = false; assert.equal(creations, 1); });
    const withImages = { ...input, requestId: 'aaaaaaaa-1234-4234-8234-123456789abc', markdown: '# 図表\n\n![画像1: 売上の推移](https://img.test/a.png)\n', images: [
        { n: 1, url: 'https://img.test/a.png', alt: '売上の推移' },
        { n: 2, url: 'https://img.test/b.html', alt: '' },
        { n: 3, url: 'https://img.test/missing.png', alt: '' }
    ] };
    let imageFile = null;
    check('画像を取りに行き、記事ごとのフォルダに保存して.mdの末尾に一覧を付ける', () => {
        const r = send(withImages);
        assert.equal(r.ok, true);
        assert.deepEqual({ ...r.images }, { saved: 1, failed: 2 });
        imageFile = files.get(r.name);
        const content = imageFile.getBlob().getDataAsString();
        assert.ok(content.startsWith(withImages.markdown + '\n\n---\n\n## 画像（Driveに保存）\n'));
        assert.match(content, /- 画像1: 売上の推移 → https:\/\/drive\.google\.com\/file\/d\/img-1\/view（元: https:\/\/img\.test\/a\.png）/);
        assert.match(content, /- 画像2 → 保存できませんでした（画像ではありません（text\/html））/);
        assert.match(content, /- 画像3 → 保存できませんでした（HTTP 404）/);
        const imageFolder = imageFolders.get(r.name.replace(/\.md$/, '') + '_画像');
        assert.deepEqual([...imageFolder.saved], ['01_売上の推移.png']);
        assert.equal(fetched.length, 3);
        assert.equal(fetched[0].headers.Referer, input.url);
    });
    check('送り直しでは画像を取り直さず、一覧つきの.mdを同じ送信として扱う', () => {
        const r = send(withImages);
        assert.equal(r.ok, true);
        assert.equal(r.images, undefined);
        assert.equal(fetched.length, 3);
        assert.equal(send({ ...withImages, markdown: '# 別の本文\n' }).ok, false);
    });
    check('名前解決の失敗で一括取得が止まっても、1枚ずつ取り直す', () => {
        fetchAllThrows = true;
        const r = send({ ...withImages, requestId: 'bbbbbbbb-1234-4234-8234-123456789abc', images: [
            { n: 1, url: 'https://img.test/dns-fail.png', alt: '' },
            { n: 2, url: 'https://img.test/d.jpg', alt: '図/2' }
        ] });
        fetchAllThrows = false;
        assert.deepEqual({ ...r.images }, { saved: 1, failed: 1 });
        const imageFolder = imageFolders.get(r.name.replace(/\.md$/, '') + '_画像');
        assert.deepEqual([...imageFolder.saved], ['02_図_2.jpg']);
        assert.match(files.get(r.name).getBlob().getDataAsString(), /- 画像1 → 保存できませんでした（取得できませんでした）/);
    });
    check('image/jpg などの別名や、汎用の種類名でもURLが画像なら保存する', () => {
        const r = send({ ...withImages, requestId: 'eeeeeeee-1234-4234-8234-123456789abc', images: [
            { n: 1, url: 'https://img.test/alias.jpg', alt: '' },
            { n: 2, url: 'https://img.test/raw.png?w=1', alt: '' },
            { n: 3, url: 'https://img.test/raw-noext', alt: '' }
        ] });
        assert.deepEqual({ ...r.images }, { saved: 2, failed: 1 });
        const imageFolder = imageFolders.get(r.name.replace(/\.md$/, '') + '_画像');
        assert.deepEqual([...imageFolder.saved], ['01.jpg', '02.png']);
        assert.match(files.get(r.name).getBlob().getDataAsString(), /- 画像3 → 保存できませんでした（画像ではありません（application\/octet-stream））/);
    });
    check('画像のない送信は今までどおり（一覧もフォルダも作らない）', () => {
        const before = imageFolders.size;
        const r = send({ ...input, requestId: 'cccccccc-1234-4234-8234-123456789abc' });
        assert.equal(r.ok, true);
        assert.equal(r.images, undefined);
        assert.equal(files.get(r.name).getBlob().getDataAsString(), input.markdown);
        assert.equal(imageFolders.size, before);
    });
    check('画像の一覧が不正なら保存しない', () => {
        const before = creations;
        for (const images of [
            'x',
            [{ n: 1, url: 'javascript:alert(1)' }],
            [{ n: '1', url: 'https://img.test/a.png' }],
            [{ n: 1, url: 'https://img.test/a.png', alt: 3 }],
            Array.from({ length: 21 }, (_, i) => ({ n: i + 1, url: 'https://img.test/a.png' }))
        ]) {
            assert.equal(send({ ...input, requestId: 'dddddddd-1234-4234-8234-123456789abc', images }).ok, false);
        }
        assert.equal(creations, before);
    });
    check('Drive例外でもロックを解放し秘密を返さない', () => {
        const previous = sandbox.DriveApp.getFolderById;
        sandbox.DriveApp.getFolderById = () => { throw new Error(originalToken); };
        const before = released;
        const r = send(input);
        assert.equal(r.ok, false);
        assert.equal(released, before + 1);
        assert.ok(!JSON.stringify(r).includes(originalToken));
        sandbox.DriveApp.getFolderById = previous;
    });
    console.log('\n' + passed + ' 件通過');
}
main().catch(error => { console.error(error); process.exit(1); });
