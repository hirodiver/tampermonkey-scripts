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
            const file = { getId: () => String(creations), getName: () => blob.name, getUrl: () => 'https://drive.google.com/file/d/test', getBlob: () => ({ getDataAsString: () => blob.content }) };
            files.set(blob.name, file);
            return file;
        }
    };
    const sandbox = {
        console: { log() {} },
        DriveApp: { getFolderById: id => { assert.equal(id, '1WFV1mV24vc2ZwXxBhS2EjhKMhgiRNVRl'); return folder; } },
        PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key), setProperty: (key, value) => properties.set(key, value) }) },
        Utilities: { getUuid: () => '12345678-1234-4234-8234-123456789abc', formatDate: () => '20260930_050000000', newBlob: (content, type, name) => ({ content, type, name }) },
        ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ setMimeType: () => JSON.parse(text) }) },
        LockService: { getScriptLock: () => ({ tryLock: () => !busy, hasLock: () => !busy, releaseLock: () => { released++; } }) },
        Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }), getActiveUser: () => ({ getEmail: () => '' }) }
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
