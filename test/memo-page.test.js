// メモの入力・閲覧ページの検証。GASのサービスはモック化し、ページはヘッドレスChromiumで実際に操作する。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright');
const receiver = fs.readFileSync(path.join(__dirname, '../page-markdown-receiver.gs'), 'utf8');
const ARCHIVE_ID = '1WFV1mV24vc2ZwXxBhS2EjhKMhgiRNVRl';
const MEMO_ID = '1yvWkNbkjOaXlLIRok8g17mU740OJKcpc';
const OTHER_ID = 'otherFolderId0000000';
let passed = 0;

// ============================================================
// GASサービスのモック
// ============================================================

function createGas() {
    const folders = new Map();
    const files = new Map();
    const properties = new Map();
    let fileCount = 0;
    let busy = false;
    let failDrive = null;
    let activeEmail = 'owner@example.com';

    function addFile(folderId, name, content, options = {}) {
        fileCount++;
        const id = 'file' + String(fileCount).padStart(10, '0');
        const file = {
            id,
            name,
            content,
            folderId,
            trashed: Boolean(options.trashed),
            getId: () => id,
            getName: () => file.name,
            getUrl: () => 'https://drive.google.com/file/d/' + id + '/view',
            isTrashed: () => file.trashed,
            getBlob: () => ({ getDataAsString: () => file.content }),
            getParents: () => {
                let done = false;
                return { hasNext: () => !done, next: () => { done = true; return { getId: () => file.folderId }; } };
            }
        };
        files.set(id, file);
        return file;
    }

    function iterator(list) {
        let index = 0;
        return { hasNext: () => index < list.length, next: () => list[index++] };
    }

    function folder(id) {
        return {
            getName: () => id === MEMO_ID ? 'メモ' : '参考記事アーカイブ',
            getFilesByName: name => iterator([...files.values()].filter(f => f.folderId === id && f.name === name)),
            createFile: blob => addFile(id, blob.name, blob.content),
            // 検索式から引用部分を取り出し、各語がタイトルか本文に含まれるものを返す
            searchFiles: query => {
                assert.match(query, /^trashed = false/);
                const terms = [...query.matchAll(/title contains '((?:[^'\\]|\\.)*)'/g)]
                    .map(match => match[1].replace(/\\(.)/g, '$1'));
                return iterator([...files.values()].filter(file =>
                    file.folderId === id &&
                    !file.trashed &&
                    terms.every(term => file.name.includes(term) || file.content.includes(term))
                ));
            }
        };
    }

    function formatDate(date, zone, pattern) {
        assert.equal(zone, 'Asia/Tokyo');
        const jst = new Date(date.getTime() + 9 * 3600 * 1000);
        const pad = (value, size = 2) => String(value).padStart(size, '0');
        const parts = {
            yyyy: jst.getUTCFullYear(),
            MM: pad(jst.getUTCMonth() + 1),
            dd: pad(jst.getUTCDate()),
            HH: pad(jst.getUTCHours()),
            mm: pad(jst.getUTCMinutes()),
            ss: pad(jst.getUTCSeconds()),
            SSS: pad(jst.getUTCMilliseconds(), 3)
        };
        return pattern.replace(/yyyy|MM|dd|HH|mm|ss|SSS/g, key => parts[key]);
    }

    const sandbox = {
        console: { log() {} },
        JSON,
        DriveApp: {
            getFolderById: id => {
                if (failDrive) throw new Error(failDrive);
                assert.ok([ARCHIVE_ID, MEMO_ID].includes(id), '想定外のフォルダ: ' + id);
                return folder(id);
            },
            getFileById: id => {
                if (failDrive) throw new Error(failDrive);
                const file = files.get(id);
                if (!file) throw new Error('not found');
                return file;
            }
        },
        PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key), setProperty: (key, value) => properties.set(key, value) }) },
        Utilities: {
            getUuid: () => '12345678-1234-4234-8234-123456789abc',
            formatDate,
            newBlob: (content, type, name) => ({ content, type, name })
        },
        ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ setMimeType: () => JSON.parse(text) }) },
        HtmlService: {
            createHtmlOutput: html => {
                const output = { html, title: '', meta: {} };
                output.setTitle = title => { output.title = title; return output; };
                output.addMetaTag = (name, content) => { output.meta[name] = content; return output; };
                return output;
            }
        },
        LockService: { getScriptLock: () => ({ tryLock: () => !busy, hasLock: () => !busy, releaseLock() {} }) },
        // ウェブアプリは「自分として実行」。見ている人のメールは状況で変える
        Session: {
            getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }),
            getActiveUser: () => ({ getEmail: () => activeEmail })
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(receiver, sandbox);
    vm.runInContext('this.MEMO_PAGE_HTML = MEMO_PAGE_HTML;', sandbox);
    sandbox.setup();

    // vmの中で作った配列は比較で別物扱いになるので、戻り値をJSONで写す
    for (const name of ['memoSave', 'memoList', 'memoGet', 'doPost']) {
        const original = sandbox[name];
        sandbox[name] = (...args) => JSON.parse(JSON.stringify(original(...args)));
    }

    return {
        sandbox,
        files,
        addFile,
        token: properties.get('ARCHIVE_TOKEN'),
        setBusy: value => { busy = value; },
        setActiveEmail: value => { activeEmail = value; },
        setFailDrive: value => { failDrive = value; }
    };
}

function uuid(index) {
    return '00000000-0000-4000-8000-' + String(index).padStart(12, '0');
}

function check(name, fn) {
    fn();
    passed++;
    console.log('ok ' + name);
}

// ============================================================
// サーバー側
// ============================================================

function serverTests() {
    const gas = createGas();
    const { sandbox, token } = gas;
    const save = body => sandbox.memoSave(body);
    const base = { requestId: uuid(1), createdAt: '2026-10-02T03:04:05.678Z', text: '# 買い物\n- 牛乳\n', tags: ['生活', '#買い物', '生活'] };

    check('doGetは未ログイン・他人ではページを出さない', () => {
        for (const email of ['', 'other@example.com']) {
            gas.setActiveEmail(email);
            const output = sandbox.doGet({ parameter: { k: token } });
            assert.match(output.html, /持ち主のGoogleアカウントでログインしたときだけ/);
            assert.ok(!output.html.includes('<script>'));
            assert.ok(!output.html.includes(token));
        }
        gas.setActiveEmail('owner@example.com');
    });

    check('doGetは持ち主のログインでページを出し、トークンを埋め込まない', () => {
        gas.setActiveEmail('OWNER@example.com');
        const output = sandbox.doGet({});
        assert.equal(output.title, 'メモ');
        assert.match(output.meta.viewport, /width=device-width/);
        assert.match(output.html, /<script>/);
        assert.ok(!output.html.includes(token));
        assert.ok(!output.html.includes('memoToken'));
        gas.setActiveEmail('owner@example.com');
    });

    check('未ログイン・他人では保存・一覧・本文のどれも動かない', () => {
        for (const email of ['', 'other@example.com']) {
            gas.setActiveEmail(email);
            assert.equal(sandbox.memoSave(base).ok, false);
            assert.equal(sandbox.memoList({}).ok, false);
            assert.equal(sandbox.memoGet('file0000000001').ok, false);
        }
        gas.setActiveEmail('owner@example.com');
        assert.equal(gas.files.size, 0);
    });

    let saved;
    check('保存でメモフォルダにMarkdownを作り、ファイル名にタグを入れる', () => {
        saved = save(base);
        assert.equal(saved.ok, true);
        const file = gas.files.get(saved.item.id);
        assert.equal(file.folderId, MEMO_ID);
        assert.equal(file.name, '20261002_120405678_買い物_#生活#買い物_' + uuid(1) + '.md');
        assert.equal(file.content, '---\n種類: メモ\ntags: [生活, 買い物]\n作成日時: 2026-10-02 12:04:05\n送信ID: ' + uuid(1) + '\n---\n\n# 買い物\n- 牛乳\n');
        assert.deepEqual(saved.item.tags, ['生活', '買い物']);
        assert.equal(saved.item.date, '2026-10-02 12:04');
    });

    check('同じ送信の送り直しは1ファイルのまま', () => {
        const again = save(base);
        assert.equal(again.ok, true);
        assert.equal(again.item.id, saved.item.id);
        assert.equal(gas.files.size, 1);
    });

    check('同じIDで違う本文は上書きしない', () => {
        assert.equal(save({ ...base, text: '# 買い物\n- 卵\n' }).ok, false);
        assert.equal(gas.files.get(saved.item.id).content.includes('牛乳'), true);
    });

    check('タイトルとタグから、ファイル名やタグの区切りに使う文字を除く', () => {
        const result = save({ requestId: uuid(2), createdAt: '2026-10-02T03:05:00.000Z', text: '\n\n> 見出し: a/b_#c*?\n本文', tags: ['a_b', 'c#d', ' e/f ', '[g]'] });
        assert.equal(result.ok, true);
        assert.equal(result.item.title, '見出し_ a_b_＃c__');
        assert.deepEqual(result.item.tags, ['ab', 'cd', 'ef', 'g']);
        const listed = sandbox.memoList({ kind: 'memo', tag: 'cd' });
        assert.equal(listed.items.length, 1);
        assert.equal(listed.items[0].title, '見出し_ a_b_＃c__');
    });

    check('不正な入力は保存しない', () => {
        const before = gas.files.size;
        for (const change of [
            { text: '' },
            { text: '   \n' },
            { text: 'a'.repeat(100001) },
            { requestId: '../x' },
            { createdAt: 'bad' },
            { tags: 'a' },
            { tags: [1] },
            { tags: Array.from({ length: 11 }, (_, i) => 't' + i) }
        ]) {
            assert.equal(save({ ...base, requestId: uuid(90), ...change }).ok, false, JSON.stringify(change).slice(0, 40));
        }
        assert.equal(sandbox.memoSave(null).ok, false);
        assert.equal(gas.files.size, before);
    });

    check('ロックが取れないときは保存しない', () => {
        gas.setBusy(true);
        assert.equal(save({ ...base, requestId: uuid(3) }).ok, false);
        gas.setBusy(false);
    });

    // 記事（Tampermonkeyが保存したもの）と、一覧に出さないファイルを足す
    gas.addFile(ARCHIVE_ID, '20261001_090000000_税務の記事_' + uuid(10) + '.md', '# 税務\n消費税の話');
    gas.addFile(ARCHIVE_ID, '20260930_090000000_C#入門_#タグではない_' + uuid(11) + '.md', 'C#');
    gas.addFile(ARCHIVE_ID, '参考記事アーカイブ_索引', '');
    gas.addFile(ARCHIVE_ID, '契約書.pdf', '');
    gas.addFile(MEMO_ID, '20261002_130000000_消したメモ_' + uuid(12) + '.md', '削除', { trashed: true });
    const outside = gas.addFile(OTHER_ID, '20261002_130000000_別フォルダ_' + uuid(13) + '.md', '秘密');

    check('一覧は新しい順で、メモと記事を区別し、Markdown以外は出さない', () => {
        const result = sandbox.memoList({ kind: 'all' });
        assert.equal(result.ok, true);
        assert.deepEqual(result.items.map(item => item.title), ['見出し_ a_b_＃c__', '買い物', '税務の記事', 'C#入門_#タグではない']);
        assert.deepEqual(result.items.map(item => item.kind), ['memo', 'memo', 'article', 'article']);
        assert.deepEqual(result.items[2].tags, []);
        assert.equal(result.total, 4);
        assert.equal(result.tags[0].tag, 'ab');
    });

    check('種類・タグ・検索語で絞り込める', () => {
        assert.deepEqual(sandbox.memoList({ kind: 'article' }).items.map(item => item.title), ['税務の記事', 'C#入門_#タグではない']);
        assert.deepEqual(sandbox.memoList({ kind: 'memo', tag: '生活' }).items.map(item => item.title), ['買い物']);
        assert.deepEqual(sandbox.memoList({ text: '消費税' }).items.map(item => item.title), ['税務の記事']);
        assert.deepEqual(sandbox.memoList({ text: '牛乳 買い物' }).items.map(item => item.title), ['買い物']);
        assert.equal(sandbox.memoList({ text: "it's \\ odd" }).ok, true);
    });

    check('件数が多いときは50件ずつ返す', () => {
        for (let index = 0; index < 60; index++) {
            gas.addFile(MEMO_ID, '20250101_0000' + String(index).padStart(2, '0') + '000_古いメモ' + index + '_' + uuid(100 + index) + '.md', '古い');
        }
        const first = sandbox.memoList({ kind: 'memo' });
        assert.equal(first.total, 62);
        assert.equal(first.items.length, 50);
        const second = sandbox.memoList({ kind: 'memo', offset: 50 });
        assert.equal(second.items.length, 12);
        assert.equal(second.items[11].title, '古いメモ0');
    });

    check('本文はメモと記事のフォルダのものだけ返す', () => {
        const memo = sandbox.memoGet(saved.item.id);
        assert.equal(memo.ok, true);
        assert.equal(memo.item.kind, 'memo');
        assert.match(memo.markdown, /牛乳/);
        assert.equal(sandbox.memoGet(outside.id).ok, false);
        assert.equal(sandbox.memoGet('../../etc').ok, false);
        assert.equal(sandbox.memoGet('file9999999999').ok, false);
    });

    check('Driveの例外でもトークンを返さない', () => {
        gas.setFailDrive(token);
        for (const result of [sandbox.memoList({}), sandbox.memoGet(saved.item.id), save({ ...base, requestId: uuid(4) })]) {
            assert.equal(result.ok, false);
            assert.ok(!JSON.stringify(result).includes(token));
        }
        gas.setFailDrive(null);
    });

    check('記事の受け口（doPost）は今までどおり動く', () => {
        const result = sandbox.doPost({ postData: { contents: JSON.stringify({ token, requestId: uuid(5), capturedAt: '2026-10-02T00:00:00.000Z', title: '記事', url: 'https://example.com/', markdown: '# 記事\n' }) } });
        assert.equal(result.ok, true);
        assert.equal(gas.files.get(result.fileId).folderId, ARCHIVE_ID);
    });
}

// ============================================================
// ページ（ヘッドレスChromium）
// ============================================================

async function pageTests() {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

    async function test(name, fn, options = {}) {
        const gas = createGas();
        gas.addFile(ARCHIVE_ID, '20261001_090000000_税務の記事_' + uuid(10) + '.md', [
            '# 税務の見出し',
            '',
            '段落の1行目',
            '段落の2行目 **太字** と `code` と [リンク](https://example.com/a) と [危険](javascript:alert(1))',
            '',
            '- 項目A',
            '- [x] 済み',
            '',
            '| 列1 | 列2 |',
            '|---|---|',
            '| a | b |',
            '',
            '<script>window.xss = 1</script>',
            '<img src=x onerror="window.xss = 2">',
            '',
            '```',
            '<b>コード</b>',
            '```'
        ].join('\n'));
        gas.sandbox.memoSave({ requestId: uuid(20), createdAt: '2026-10-01T00:00:00.000Z', text: '前のメモ\n本文', tags: ['仕事'] });

        const context = await browser.newContext({
            viewport: options.viewport || { width: 1200, height: 800 },
            permissions: ['clipboard-read', 'clipboard-write']
        });
        const page = await context.newPage();
        const calls = [];
        let failNext = 0;
        await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
        await page.exposeFunction('__gasCall', (name, argsJson) => {
            const args = JSON.parse(argsJson);
            calls.push({ name, args });
            if (failNext > 0 && name === 'memoSave') {
                failNext--;
                throw new Error('通信に失敗しました');
            }
            return JSON.stringify(gas.sandbox[name](...args));
        });
        await page.addInitScript(() => {
            const handler = {
                get(target, prop) {
                    if (prop in target) return target[prop];
                    return (...args) => {
                        window.__gasCall(prop, JSON.stringify(args))
                            .then(result => target.ok && target.ok(JSON.parse(result)))
                            .catch(error => target.fail && target.fail(new Error(String(error.message).replace(/^.*?: /, ''))));
                    };
                }
            };
            window.google = { script: {} };
            Object.defineProperty(window.google.script, 'run', {
                get() {
                    const target = {};
                    const proxy = new Proxy(target, handler);
                    target.withSuccessHandler = fn => { target.ok = fn; return proxy; };
                    target.withFailureHandler = fn => { target.fail = fn; return proxy; };
                    return proxy;
                }
            });
        });
        const html = gas.sandbox.doGet({}).html;
        await page.route('https://memo.test/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
        await page.goto('https://memo.test/exec');
        await page.waitForSelector('.result-card');
        try {
            await fn(page, { gas, calls, failOnce: () => { failNext = 1; } });
            passed++;
            console.log('ok ' + name);
        } finally {
            await context.close();
        }
    }

    const titles = page => page.$$eval('.result-card .card-title', cards => cards.map(card => card.textContent));

    await test('開くと記事とメモを新しい順に並べる', async page => {
        assert.deepEqual(await titles(page), ['税務の記事', '前のメモ']);
        assert.deepEqual(await page.$$eval('.result-card .badge', badges => badges.map(badge => badge.textContent)), ['記事', 'メモ']);
        assert.equal(await page.textContent('#listInfo'), '2件');
        assert.equal(await page.isVisible('#moreButton'), false);
        assert.equal(await page.isVisible('#detailScrim'), false);
    });

    await test('保存すると一覧の先頭に出て、入力欄が空になる', async (page, { calls }) => {
        await page.fill('#memoText', '新しい思いつき\n詳しく');
        await page.fill('#memoTags', '#アイデア, 仕事');
        await page.click('#saveButton');
        await page.waitForFunction(() => document.querySelector('.result-card .card-title').textContent === '新しい思いつき');
        assert.equal(await page.inputValue('#memoText'), '');
        assert.equal(await page.inputValue('#memoTags'), '');
        const saveCall = calls.find(call => call.name === 'memoSave');
        assert.deepEqual(saveCall.args[0].tags, ['アイデア', '仕事']);
        assert.match(await page.textContent('#toast'), /保存しました/);
    });

    await test('保存に失敗しても本文を残し、送り直しは同じIDで送る', async (page, { calls, failOnce, gas }) => {
        failOnce();
        await page.fill('#memoText', '失敗するメモ');
        await page.click('#saveButton');
        await page.waitForFunction(() => document.querySelector('#toast').classList.contains('error'));
        assert.equal(await page.inputValue('#memoText'), '失敗するメモ');
        await page.click('#saveButton');
        await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('保存しました'));
        const ids = calls.filter(call => call.name === 'memoSave').map(call => call.args[0].requestId);
        assert.equal(ids.length, 2);
        assert.equal(ids[0], ids[1]);
        assert.equal([...gas.files.values()].filter(file => file.name.includes('失敗するメモ')).length, 1);
    });

    await test('Ctrl+Enterで保存できる', async page => {
        await page.fill('#memoText', 'キーで保存');
        await page.press('#memoText', 'Control+Enter');
        await page.waitForFunction(() => document.querySelector('.result-card .card-title').textContent === 'キーで保存');
    });

    await test('種類・検索・タグで絞り込める', async page => {
        await page.click('[data-kind="article"]');
        await page.waitForFunction(() => document.querySelectorAll('.result-card').length === 1);
        assert.deepEqual(await titles(page), ['税務の記事']);
        assert.equal(await page.$$eval('#tagFilter .chip', chips => chips.length), 0);

        await page.click('[data-kind="all"]');
        await page.fill('#searchInput', '本文');
        await page.waitForFunction(() => document.querySelectorAll('.result-card').length === 1);
        assert.deepEqual(await titles(page), ['前のメモ']);

        await page.fill('#searchInput', '');
        await page.waitForFunction(() => document.querySelectorAll('.result-card').length === 2);
        await page.click('#tagFilter .chip');
        await page.waitForFunction(() => document.querySelectorAll('.result-card').length === 1);
        assert.deepEqual(await titles(page), ['前のメモ']);
        await page.click('#tagFilter .chip.active');
        await page.waitForFunction(() => document.querySelectorAll('.result-card').length === 2);
    });

    await test('よく使うタグを押すとタグ欄に入る', async page => {
        await page.click('#tagSuggest .chip');
        assert.equal(await page.inputValue('#memoTags'), '仕事');
        await page.click('#tagSuggest .chip');
        assert.equal(await page.inputValue('#memoTags'), '仕事');
    });

    await test('本文をMarkdownとして表示し、HTMLや危険なリンクは動かさない', async page => {
        await page.click('.result-card');
        await page.waitForSelector('#detailBody h1');
        assert.equal(await page.textContent('#detailBody h1'), '税務の見出し');
        assert.equal(await page.$eval('#detailBody p', p => p.querySelectorAll('br').length), 1);
        assert.equal(await page.textContent('#detailBody strong'), '太字');
        const links = await page.$$eval('#detailBody a', anchors => anchors.map(a => [a.textContent, a.href, a.target]));
        assert.deepEqual(links, [['リンク', 'https://example.com/a', '_blank']]);
        assert.match(await page.textContent('#detailBody'), /危険/);
        assert.deepEqual(await page.$$eval('#detailBody li', items => items.map(item => item.textContent)), ['項目A', '☑ 済み']);
        assert.equal(await page.$$eval('#detailBody td', cells => cells.length), 2);
        assert.equal(await page.textContent('#detailBody pre code'), '<b>コード</b>');
        assert.equal(await page.$$eval('#detailBody script, #detailBody img, #detailBody b', nodes => nodes.length), 0);
        assert.match(await page.textContent('#detailBody'), /<script>window\.xss = 1<\/script>/);
        await page.waitForTimeout(100);
        assert.equal(await page.evaluate(() => window.xss), undefined);
        assert.match(await page.getAttribute('#driveLink', 'href'), /^https:\/\/drive\.google\.com\/file\/d\//);
    });

    await test('メモの詳細はメタ情報を小さく出し、閉じられる', async page => {
        await page.click('.result-card:nth-child(2)');
        await page.waitForSelector('#detailBody .md-meta');
        assert.match(await page.textContent('#detailBody .md-meta'), /種類: メモ/);
        assert.match(await page.textContent('#detailMeta'), /#仕事/);
        await page.click('#copyButton');
        await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('コピー'));
        await page.keyboard.press('Escape');
        assert.equal(await page.isHidden('#detailScrim'), true);
        await page.click('.result-card:nth-child(2)');
        await page.waitForSelector('#detailBody .md-meta');
        await page.mouse.click(50, 400);
        assert.equal(await page.isHidden('#detailScrim'), true);
    });

    await test('スマホ幅で横にはみ出さず、入力欄は16px（自動拡大しない）', async page => {
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        for (const selector of ['#memoText', '#memoTags', '#searchInput']) {
            assert.equal(await page.$eval(selector, el => getComputedStyle(el).fontSize), '16px');
        }
        await page.click('.result-card');
        await page.waitForSelector('#detailBody h1');
        assert.equal(await page.$eval('#detailPanel', el => Math.round(el.getBoundingClientRect().width)), 390);
    }, { viewport: { width: 390, height: 844 } });

    await test('書きかけは残り、開き直すと戻る', async page => {
        await page.fill('#memoText', '書きかけ');
        await page.fill('#memoTags', 'あとで');
        assert.match(await page.evaluate(() => localStorage.getItem('memo-page-draft')), /書きかけ/);
        await page.reload();
        await page.waitForSelector('.result-card');
        assert.equal(await page.inputValue('#memoText'), '書きかけ');
        assert.equal(await page.inputValue('#memoTags'), 'あとで');
    });

    await browser.close();
}

async function main() {
    serverTests();
    await pageTests();
    console.log('\n' + passed + ' 件通過');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
