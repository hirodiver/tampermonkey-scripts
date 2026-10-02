// ページ本文コピー用の受け口と、メモの入力・閲覧ページ。経費処理とは別のApps Scriptプロジェクトに置く。
// setupを一度実行して認証し、ウェブアプリとしてデプロイする。
// 記事はTampermonkeyからdoPostで受け、メモはdoGetのページから保存する。どちらもDriveの権限だけで動く。
const ARCHIVE_FOLDER_ID = '1WFV1mV24vc2ZwXxBhS2EjhKMhgiRNVRl';
const ARCHIVE_MAX_CHARS = 500000;
// メモの保存先（Driveの「メモ」フォルダ）
const MEMO_FOLDER_ID = '1yvWkNbkjOaXlLIRok8g17mU740OJKcpc';
// メモ本文の上限文字数
const MEMO_MAX_CHARS = 100000;
// 1件のメモに付けられるタグの数と、タグ1つの長さ
const MEMO_MAX_TAGS = 10;
const MEMO_TAG_MAX_CHARS = 30;
// 一覧を1回に返す件数
const MEMO_PAGE_SIZE = 50;

function setup() {

    const folder = DriveApp.getFolderById(ARCHIVE_FOLDER_ID);
    const properties = PropertiesService.getScriptProperties();
    let token = properties.getProperty('ARCHIVE_TOKEN');

    if (!token) {
        token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
        properties.setProperty('ARCHIVE_TOKEN', token);
    }

    console.log('保存先: ' + folder.getName());
    console.log('Tampermonkeyに登録するトークン: ' + token);
}


function archiveResponse(value) {

    return ContentService
        .createTextOutput(JSON.stringify(value))
        .setMimeType(ContentService.MimeType.JSON);
}


function doPost(event) {

    let lock = null;

    try {
        if (!event || !event.postData || event.postData.contents.length > 4000000) {
            return archiveResponse({ ok: false, message: '送信データが不正です' });
        }

        const input = JSON.parse(event.postData.contents);
        const token = PropertiesService.getScriptProperties().getProperty('ARCHIVE_TOKEN');

        if (!input || !token || input.token !== token) {
            return archiveResponse({ ok: false, message: 'トークンが一致しません' });
        }

        if (
            typeof input.markdown !== 'string' ||
            !input.markdown.trim() ||
            input.markdown.length > ARCHIVE_MAX_CHARS ||
            typeof input.title !== 'string' || input.title.length > 300 ||
            typeof input.url !== 'string' || input.url.length > 10000 ||
            !/^https?:\/\//.test(input.url) ||
            typeof input.requestId !== 'string' ||
            !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.requestId) ||
            typeof input.capturedAt !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.capturedAt) ||
            !Number.isFinite(Date.parse(input.capturedAt))
        ) {
            return archiveResponse({ ok: false, message: '本文・タイトル・送信IDが不正です' });
        }

        const title = input.title
            .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120) || 'タイトル不明';
        const stamp = Utilities.formatDate(
            new Date(input.capturedAt),
            'Asia/Tokyo',
            'yyyyMMdd_HHmmssSSS'
        );
        // 同時刻・同名の記事も区別し、同じ送信の再試行は同じ名前になる
        const name = stamp + '_' + title + '_' + input.requestId + '.md';

        lock = LockService.getScriptLock();
        if (!lock.tryLock(10000)) {
            return archiveResponse({ ok: false, message: '保存処理が混み合っています。再度押してください' });
        }

        const folder = DriveApp.getFolderById(ARCHIVE_FOLDER_ID);
        const matches = folder.getFilesByName(name);
        let file;

        if (matches.hasNext()) {
            file = matches.next();
            // 同じIDで異なる本文を上書きしない
            if (file.getBlob().getDataAsString('UTF-8') !== input.markdown) {
                return archiveResponse({ ok: false, message: '送信IDが重複しています。ページを再読み込みしてください' });
            }
        } else {
            file = folder.createFile(
                Utilities.newBlob(input.markdown, 'text/markdown', name)
            );
        }

        return archiveResponse({
            ok: true,
            fileId: file.getId(),
            name: file.getName(),
            url: file.getUrl()
        });

    } catch (error) {
        // トークンや本文をログ・エラーレスポンスへ出さない
        return archiveResponse({ ok: false, message: 'Drive保存に失敗しました。GASの認証・保存先を確認してください' });

    } finally {
        if (lock && lock.hasLock()) {
            lock.releaseLock();
        }
    }
}


// ============================================================
// メモの入力・閲覧ページ
// ============================================================

// ページを開くURLの末尾に ?k=トークン を付ける。トークンが違えばページを出さない
function doGet(event) {

    const key = event && event.parameter ? event.parameter.k : '';

    if (!memoTokenValid_(key)) {
        return HtmlService
            .createHtmlOutput(
                '<p style="font-family:sans-serif;padding:24px;line-height:1.7">' +
                'URLが正しくありません。末尾に ?k= の付いたURLから開いてください。' +
                '</p>'
            )
            .setTitle('メモ');
    }

    // トークンは英数字だけだが、念のためJSONにして < を逃がしてから埋め込む
    const tokenLiteral = JSON.stringify(key).replace(/</g, '\\u003c');

    return HtmlService
        .createHtmlOutput(
            MEMO_PAGE_HTML.replace('__MEMO_TOKEN__', () => tokenLiteral)
        )
        .setTitle('メモ')
        .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}


function memoTokenValid_(token) {

    const expected = PropertiesService.getScriptProperties().getProperty('ARCHIVE_TOKEN');

    return Boolean(expected) &&
        typeof token === 'string' &&
        token === expected;
}


// ファイル名に使えない文字を除き、タグの区切り（_#）と紛れないようにする
function memoSafeTitle_(value) {

    return String(value)
        .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
        .replace(/#/g, '＃')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40);
}


// 空白・カンマ・ファイル名に使えない文字を除く。数が多すぎるときは null
function memoNormalizeTags_(tags) {

    if (!Array.isArray(tags)) {
        return null;
    }

    const result = [];

    for (const tag of tags) {

        if (typeof tag !== 'string') {
            return null;
        }

        const clean = tag
            .replace(/[\\/:*?"<>|#_,、，\[\]\s\u0000-\u001f\u007f]/g, '')
            .slice(0, MEMO_TAG_MAX_CHARS);

        if (clean && !result.includes(clean)) {
            result.push(clean);
        }
    }

    return result.length > MEMO_MAX_TAGS ? null : result;
}


// ファイル名「取得日時_タイトル[_#タグ#タグ]_送信ID.md」を分解する。タグはメモだけが持つ
function memoParseName_(name, kind) {

    const match = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})\d{2}\d{3}_(.*)_([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.md$/.exec(name);

    if (!match) {
        return null;
    }

    let title = match[6];
    let tags = [];

    if (kind === 'memo') {
        const tagMatch = /^(.*)_#([^_]*)$/.exec(title);

        if (tagMatch) {
            title = tagMatch[1];
            tags = tagMatch[2].split('#').filter(Boolean);
        }
    }

    return {
        title: title || 'タイトル不明',
        tags: tags,
        date: match[1] + '-' + match[2] + '-' + match[3] + ' ' + match[4] + ':' + match[5]
    };
}


function memoSources_(kind) {

    const sources = [];

    if (kind !== 'article') {
        sources.push({ kind: 'memo', id: MEMO_FOLDER_ID });
    }

    if (kind !== 'memo') {
        sources.push({ kind: 'article', id: ARCHIVE_FOLDER_ID });
    }

    return sources;
}


// Driveの検索式の文字列に入れるため、\ と ' を逃がす
function memoQuote_(value) {

    return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}


// 一覧。kind は all / memo / article。text は空白区切りのすべてを含むもの、tag は完全一致
function memoList(token, request) {

    try {
        if (!memoTokenValid_(token)) {
            return { ok: false, message: 'トークンが一致しません' };
        }

        const input = request && typeof request === 'object' ? request : {};
        const kind = ['all', 'memo', 'article'].includes(input.kind) ? input.kind : 'all';
        const text = typeof input.text === 'string' ? input.text.trim().slice(0, 100) : '';
        const tag = typeof input.tag === 'string' ? input.tag.slice(0, MEMO_TAG_MAX_CHARS) : '';
        const offset = Number.isInteger(input.offset) && input.offset >= 0 ? input.offset : 0;

        let query = 'trashed = false';

        for (const term of text.split(/\s+/).filter(Boolean)) {
            const quoted = memoQuote_(term);
            query += ' and (title contains ' + quoted + ' or fullText contains ' + quoted + ')';
        }

        const items = [];
        const tagCounts = {};

        for (const source of memoSources_(kind)) {

            const files = DriveApp.getFolderById(source.id).searchFiles(query);

            while (files.hasNext()) {

                const file = files.next();
                const name = file.getName();
                const parsed = memoParseName_(name, source.kind);

                // Tampermonkeyやこのページが作ったMarkdown以外（PDFや索引など）は出さない
                if (!parsed) {
                    continue;
                }

                for (const itemTag of parsed.tags) {
                    tagCounts[itemTag] = (tagCounts[itemTag] || 0) + 1;
                }

                if (tag && !parsed.tags.includes(tag)) {
                    continue;
                }

                items.push({
                    id: file.getId(),
                    kind: source.kind,
                    title: parsed.title,
                    tags: parsed.tags,
                    date: parsed.date,
                    sortKey: name
                });
            }
        }

        // ファイル名の先頭が日時なので、名前の逆順が新しい順になる
        items.sort((a, b) => a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0);

        const tags = Object.keys(tagCounts)
            .map(key => ({ tag: key, count: tagCounts[key] }))
            .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : 1));

        return {
            ok: true,
            total: items.length,
            items: items
                .slice(offset, offset + MEMO_PAGE_SIZE)
                .map(item => ({
                    id: item.id,
                    kind: item.kind,
                    title: item.title,
                    tags: item.tags,
                    date: item.date
                })),
            tags: tags
        };

    } catch (error) {
        // トークンや本文をログ・エラーレスポンスへ出さない
        return { ok: false, message: '一覧の読み込みに失敗しました' };
    }
}


// 1件の本文。メモと記事のフォルダにあるファイルだけを返す
function memoGet(token, fileId) {

    try {
        if (!memoTokenValid_(token)) {
            return { ok: false, message: 'トークンが一致しません' };
        }

        if (typeof fileId !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) {
            return { ok: false, message: 'ファイルが見つかりません' };
        }

        const file = DriveApp.getFileById(fileId);
        const parents = file.getParents();
        let kind = null;

        while (parents.hasNext()) {
            const parentId = parents.next().getId();

            if (parentId === MEMO_FOLDER_ID) {
                kind = 'memo';
            } else if (parentId === ARCHIVE_FOLDER_ID && !kind) {
                kind = 'article';
            }
        }

        if (!kind || file.isTrashed()) {
            return { ok: false, message: 'ファイルが見つかりません' };
        }

        const parsed = memoParseName_(file.getName(), kind) || {
            title: file.getName(),
            tags: [],
            date: ''
        };

        return {
            ok: true,
            item: {
                id: file.getId(),
                kind: kind,
                title: parsed.title,
                tags: parsed.tags,
                date: parsed.date
            },
            url: file.getUrl(),
            markdown: file.getBlob().getDataAsString('UTF-8')
        };

    } catch (error) {
        return { ok: false, message: 'ファイルを読み込めませんでした' };
    }
}


// メモの保存。送信IDと作成日時はページ側で決め、送り直しても同じファイル名になる
function memoSave(token, request) {

    let lock = null;

    try {
        if (!memoTokenValid_(token)) {
            return { ok: false, message: 'トークンが一致しません' };
        }

        const input = request && typeof request === 'object' ? request : {};
        const tags = memoNormalizeTags_(input.tags);

        if (
            typeof input.text !== 'string' ||
            !input.text.trim() ||
            input.text.length > MEMO_MAX_CHARS ||
            typeof input.requestId !== 'string' ||
            !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.requestId) ||
            typeof input.createdAt !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.createdAt) ||
            !Number.isFinite(Date.parse(input.createdAt)) ||
            !tags
        ) {
            return { ok: false, message: '本文・タグ・送信IDが不正です' };
        }

        const createdAt = new Date(input.createdAt);
        const body = input.text.replace(/\r\n?/g, '\n');

        // タイトルは本文の最初の行。見出しや箇条書きの記号は除く
        const firstLine = body
            .split('\n')
            .map(line => line.replace(/^[\s#>*+-]+/, '').trim())
            .find(Boolean) || '';
        const title = memoSafeTitle_(firstLine) || 'メモ';

        const stamp = Utilities.formatDate(createdAt, 'Asia/Tokyo', 'yyyyMMdd_HHmmssSSS');
        const name = stamp + '_' +
            title +
            (tags.length ? '_#' + tags.join('#') : '') +
            '_' + input.requestId + '.md';

        // 先頭のメタ情報は、AIでの整理や別アプリへの移行で使う
        const markdown = [
            '---',
            '種類: メモ',
            'tags: [' + tags.join(', ') + ']',
            '作成日時: ' + Utilities.formatDate(createdAt, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss'),
            '送信ID: ' + input.requestId,
            '---',
            '',
            body.replace(/\n+$/, ''),
            ''
        ].join('\n');

        lock = LockService.getScriptLock();
        if (!lock.tryLock(10000)) {
            return { ok: false, message: '保存処理が混み合っています。もう一度押してください' };
        }

        const folder = DriveApp.getFolderById(MEMO_FOLDER_ID);
        const matches = folder.getFilesByName(name);
        let file;

        if (matches.hasNext()) {
            file = matches.next();
            // 同じIDで異なる本文を上書きしない
            if (file.getBlob().getDataAsString('UTF-8') !== markdown) {
                return { ok: false, message: '送信IDが重複しています。ページを再読み込みしてください' };
            }
        } else {
            file = folder.createFile(
                Utilities.newBlob(markdown, 'text/markdown', name)
            );
        }

        return {
            ok: true,
            item: {
                id: file.getId(),
                kind: 'memo',
                title: title,
                tags: tags,
                date: Utilities.formatDate(createdAt, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm')
            },
            url: file.getUrl()
        };

    } catch (error) {
        return { ok: false, message: 'Drive保存に失敗しました。GASの認証・保存先を確認してください' };

    } finally {
        if (lock && lock.hasLock()) {
            lock.releaseLock();
        }
    }
}


// ============================================================
// メモページのHTML
// ============================================================

// GASの画面に1ファイルで貼れるよう、ページはここに文字列で持つ。
// String.raw のため、この中ではバッククォートとドル記号+波かっこを使わない
const MEMO_PAGE_HTML = String.raw`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<style>
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@300;400;500;700&family=JetBrains+Mono:wght@400;500&display=swap');

:root {
    --sans: 'Noto Sans JP', sans-serif;
    --mono: 'JetBrains Mono', monospace;
    --bg: #f2f4f8;
    --surface: #ffffff;
    --surface2: #f0f2f6;
    --border: #dde1ea;
    --border-hover: #b2b9cc;
    --text: #1c2033;
    --text-sub: #555e7a;
    --text-muted: #939ab5;
    /* メモ用のアクセント（緑系） */
    --accent: #0f766e;
    --accent-light: rgba(15,118,110,0.08);
    --accent-hover: #0b5f58;
    --highlight: #92400e;
    --highlight-bg: #fef3c7;
    --red: #c0392b;
    --red-light: rgba(192,57,43,0.08);
    --green: #15803d;
    --shadow-sm: 0 1px 3px rgba(30,40,80,.07), 0 1px 2px rgba(30,40,80,.04);
    --shadow-md: 0 4px 14px rgba(30,40,80,.10), 0 2px 4px rgba(30,40,80,.05);
}

* { box-sizing: border-box; }

/* display を指定した要素でも hidden 属性で確実に隠す */
[hidden] { display: none !important; }

html, body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: var(--sans);
    font-size: 14px;
    line-height: 1.6;
}

button { font-family: inherit; }

.header {
    position: sticky;
    top: 0;
    z-index: 5;
    height: 52px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 24px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
}

.header h1 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
}

.kind-tabs {
    display: flex;
    gap: 4px;
    margin-left: auto;
}

.rh-btn, .hdr-btn {
    font-family: var(--mono);
    font-size: 11px;
    padding: 4px 10px;
    border-radius: 5px;
    border: 1px solid var(--border);
    background: var(--surface2);
    color: var(--text-sub);
    cursor: pointer;
    text-decoration: none;
    white-space: nowrap;
    transition: all .12s;
}

.rh-btn:hover, .hdr-btn:hover {
    border-color: var(--border-hover);
    color: var(--text);
}

.rh-btn.active {
    background: var(--accent-light);
    border-color: var(--accent);
    color: var(--accent);
}

.main {
    max-width: 860px;
    margin: 0 auto;
    padding: 14px 24px 80px;
}

.card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 9px;
    box-shadow: var(--shadow-sm);
}

.composer {
    padding: 12px;
    margin-bottom: 14px;
}

.field {
    width: 100%;
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 8px 12px;
    font-family: var(--sans);
    font-size: 13px;
    color: var(--text);
    outline: none;
    transition: border-color .14s, box-shadow .14s, background .14s;
}

.field:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-light);
    background: var(--surface);
}

textarea.field {
    display: block;
    resize: vertical;
    min-height: 120px;
    line-height: 1.65;
}

.row {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-top: 8px;
}

.row .field { flex: 1; min-width: 0; }

.btn {
    padding: 8px 20px;
    border-radius: 7px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
    white-space: nowrap;
    transition: all .12s;
}

.btn-primary { background: var(--accent); color: #fff; }
.btn-primary:hover { background: var(--accent-hover); }
.btn-primary:disabled { opacity: .6; cursor: default; }

.btn-secondary {
    background: var(--surface2);
    border-color: var(--border);
    color: var(--text-sub);
}

.chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}

.chips:empty { display: none; }

.composer .chips { margin-top: 8px; }

.chip {
    font-family: var(--mono);
    font-size: 11px;
    padding: 2px 9px;
    border-radius: 20px;
    border: 1px solid var(--border);
    background: var(--surface2);
    color: var(--text-sub);
    cursor: pointer;
    transition: all .12s;
}

.chip:hover { border-color: var(--border-hover); }

.chip.active {
    background: var(--accent-light);
    border-color: var(--accent);
    color: var(--accent);
}

.search-row { margin-bottom: 8px; }

#tagFilter { margin-bottom: 8px; }

.section-label {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--text-muted);
    letter-spacing: .1em;
    margin: 6px 0 9px;
}

.result-card {
    display: block;
    width: 100%;
    text-align: left;
    padding: 9px 14px;
    margin-bottom: 8px;
    cursor: pointer;
    color: var(--text);
    transition: border-color .14s, box-shadow .14s, transform .14s;
}

.result-card:hover {
    border-color: var(--border-hover);
    box-shadow: var(--shadow-md);
    transform: translateY(-1px);
}

.card-title {
    font-size: 14px;
    font-weight: 500;
    word-break: break-word;
}

.card-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 3px;
}

.badge {
    font-family: var(--mono);
    font-size: 10px;
    padding: 1px 7px;
    border-radius: 4px;
}

.badge.memo { background: var(--accent-light); color: var(--accent); }

.badge.article {
    background: var(--surface2);
    color: var(--text-sub);
    border: 1px solid var(--border);
}

.empty {
    color: var(--text-muted);
    text-align: center;
    padding: 24px 0;
}

.more { display: block; margin: 8px auto 0; }

.detail-scrim {
    position: fixed;
    inset: 0;
    z-index: 10;
    background: rgba(20,28,60,.28);
    backdrop-filter: blur(2px);
}

.detail {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: 600px;
    max-width: 100vw;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    box-shadow: var(--shadow-md);
}

.detail-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    background: var(--surface2);
    border-bottom: 1px solid var(--border);
}

.detail-head .spacer { flex: 1; }

.detail-title {
    padding: 12px 18px 0;
    font-size: 15px;
    font-weight: 600;
    word-break: break-word;
}

.detail-title + .card-meta { padding: 0 18px; }

.detail-body {
    flex: 1;
    overflow: auto;
    padding: 10px 18px 40px;
    word-break: break-word;
}

.md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { margin: 1.1em 0 .4em; line-height: 1.4; }
.md h1 { font-size: 18px; }
.md h2 { font-size: 16px; }
.md h3, .md h4, .md h5, .md h6 { font-size: 14px; }
.md p { margin: .5em 0; }
.md ul, .md ol { margin: .4em 0; padding-left: 1.4em; }
.md blockquote {
    margin: .6em 0;
    padding: 4px 12px;
    border-left: 2px solid var(--border-hover);
    background: var(--surface2);
    color: var(--text-sub);
}
.md pre {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 10px 12px;
    overflow: auto;
    font-family: var(--mono);
    font-size: 12px;
}
.md code { font-family: var(--mono); font-size: 12px; background: var(--surface2); padding: 1px 4px; border-radius: 4px; }
.md pre code { background: none; padding: 0; }
.md a { color: var(--accent); }
.md hr { border: none; border-top: 1px solid var(--border); margin: 1em 0; }
.md table { border-collapse: collapse; margin: .6em 0; display: block; overflow: auto; }
.md th, .md td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; }
.md th { background: var(--surface2); }
.md-meta {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-muted);
    background: var(--surface2);
    border-radius: 7px;
    padding: 6px 10px;
    margin: 6px 0 10px;
}

.toast {
    position: fixed;
    right: 20px;
    bottom: 20px;
    z-index: 20;
    max-width: calc(100vw - 40px);
    padding: 10px 14px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 7px;
    box-shadow: var(--shadow-md);
    font-size: 13px;
    opacity: 0;
    transform: translateY(10px);
    pointer-events: none;
    transition: opacity .2s, transform .2s;
}

.toast.show { opacity: 1; transform: translateY(0); }
.toast.success { border-color: var(--green); }
.toast.error { border-color: var(--red); }

::-webkit-scrollbar { width: 9px; height: 9px; }
::-webkit-scrollbar-track { background: var(--surface2); }
::-webkit-scrollbar-thumb { background: #a0a8c0; border: 2px solid var(--surface2); border-radius: 5px; }
::-webkit-scrollbar-thumb:hover { background: #6b7499; }

/* スマホ。入力欄が16px未満だとiPhoneが自動で拡大するので16pxにする */
@media (max-width: 640px) {
    .header { padding: 0 16px; }
    .main { padding: 12px 16px 80px; }
    .field, textarea.field { font-size: 16px; }
    .detail { width: 100vw; }
    .toast { left: 16px; right: 16px; bottom: 16px; max-width: none; }
}
</style>
</head>
<body>
<header class="header">
    <h1>メモ</h1>
    <div class="kind-tabs" id="kindTabs">
        <button class="rh-btn active" data-kind="all">全部</button>
        <button class="rh-btn" data-kind="memo">メモ</button>
        <button class="rh-btn" data-kind="article">記事</button>
    </div>
</header>

<main class="main">
    <section class="card composer">
        <textarea id="memoText" class="field" placeholder="思いついたことを書く（Ctrl+Enterで保存）"></textarea>
        <div class="row">
            <input id="memoTags" class="field" placeholder="タグ（空白かカンマで区切る）" autocomplete="off">
            <button id="saveButton" class="btn btn-primary">保存</button>
        </div>
        <div id="tagSuggest" class="chips"></div>
    </section>

    <div class="search-row">
        <input id="searchInput" class="field" type="search" placeholder="検索（タイトル・本文）" autocomplete="off">
    </div>
    <div id="tagFilter" class="chips"></div>
    <div id="listInfo" class="section-label"></div>
    <div id="list"></div>
    <button id="moreButton" class="btn btn-secondary more" hidden>もっと見る</button>
</main>

<div id="detailScrim" class="detail-scrim" hidden>
    <aside class="detail" id="detailPanel">
        <div class="detail-head">
            <button id="closeButton" class="hdr-btn">閉じる</button>
            <span class="spacer"></span>
            <button id="copyButton" class="hdr-btn">本文をコピー</button>
            <a id="driveLink" class="hdr-btn" target="_blank" rel="noopener">Driveで開く</a>
        </div>
        <div id="detailTitle" class="detail-title"></div>
        <div id="detailMeta" class="card-meta"></div>
        <div id="detailBody" class="detail-body md"></div>
    </aside>
</div>

<div id="toast" class="toast" role="status"></div>

<script>
(function () {
    'use strict';

    // ============================================================
    // 設定
    // ============================================================

    // サーバー（doGet）がページを出すときに埋め込む
    const memoToken = __MEMO_TOKEN__;
    // 書きかけの本文を残しておく場所（使えない環境では残さない）
    const DRAFT_KEY = 'memo-page-draft';
    // 検索欄の入力が止まってから検索するまでの待ち時間（ミリ秒）
    const SEARCH_DELAY = 400;
    // 入力欄の下に出すよく使うタグの数
    const SUGGEST_TAG_COUNT = 12;

    const state = {
        kind: 'all',
        text: '',
        tag: '',
        items: [],
        total: 0,
        tags: [],
        listSeq: 0,
        detailSeq: 0,
        detailText: '',
        pendingSave: null,
        saving: false
    };

    function byId(id) {
        return document.getElementById(id);
    }

    function createElement(tag, className, text) {
        const element = document.createElement(tag);

        if (className) {
            element.className = className;
        }

        if (text !== undefined) {
            element.textContent = text;
        }

        return element;
    }

    // ============================================================
    // サーバー呼び出し
    // ============================================================

    function callServer(name) {
        const args = Array.prototype.slice.call(arguments, 1);

        return new Promise((resolve, reject) => {
            const runner = google.script.run
                .withSuccessHandler(resolve)
                .withFailureHandler(reject);

            runner[name].apply(runner, args);
        });
    }

    function newRequestId() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            return window.crypto.randomUUID();
        }

        const bytes = new Uint8Array(16);
        window.crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;

        const hex = Array.prototype.map
            .call(bytes, value => ('0' + value.toString(16)).slice(-2))
            .join('');

        return hex.slice(0, 8) + '-' +
            hex.slice(8, 12) + '-' +
            hex.slice(12, 16) + '-' +
            hex.slice(16, 20) + '-' +
            hex.slice(20);
    }

    // ============================================================
    // 通知・下書き
    // ============================================================

    let toastTimer = 0;

    function showToast(message, type) {
        const toast = byId('toast');

        toast.textContent = message;
        toast.className = 'toast show ' + (type || '');

        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            toast.className = 'toast';
        }, type === 'error' ? 6000 : 2500);
    }

    function readDraft() {
        try {
            const draft = JSON.parse(window.localStorage.getItem(DRAFT_KEY) || 'null');

            if (draft && typeof draft.text === 'string') {
                byId('memoText').value = draft.text;
                byId('memoTags').value = typeof draft.tags === 'string' ? draft.tags : '';
            }
        } catch (error) {
            // 保存領域が使えない環境では下書きを残さない
        }
    }

    function writeDraft() {
        try {
            const text = byId('memoText').value;
            const tags = byId('memoTags').value;

            if (text || tags) {
                window.localStorage.setItem(DRAFT_KEY, JSON.stringify({ text: text, tags: tags }));
            } else {
                window.localStorage.removeItem(DRAFT_KEY);
            }
        } catch (error) {
            // 何もしない
        }
    }

    // ============================================================
    // 保存
    // ============================================================

    function parseTags(value) {
        const result = [];

        for (const tag of value.split(/[\s,、，]+/)) {
            const clean = tag.replace(/^#+/, '');

            if (clean && !result.includes(clean)) {
                result.push(clean);
            }
        }

        return result;
    }

    async function saveMemo() {
        if (state.saving) {
            return;
        }

        const text = byId('memoText').value;
        const tags = parseTags(byId('memoTags').value);

        if (!text.trim()) {
            showToast('本文が空です', 'error');
            return;
        }

        // 同じ内容の送り直しは同じIDで送り、二重に保存しない
        const signature = text + '\u0000' + tags.join('\u0000');

        if (!state.pendingSave || state.pendingSave.signature !== signature) {
            state.pendingSave = {
                signature: signature,
                requestId: newRequestId(),
                createdAt: new Date().toISOString()
            };
        }

        const button = byId('saveButton');
        state.saving = true;
        button.disabled = true;
        button.textContent = '保存中…';

        try {
            const result = await callServer('memoSave', memoToken, {
                requestId: state.pendingSave.requestId,
                createdAt: state.pendingSave.createdAt,
                text: text,
                tags: tags
            });

            if (!result || !result.ok) {
                throw new Error(result && result.message ? result.message : '保存に失敗しました');
            }

            state.pendingSave = null;
            byId('memoText').value = '';
            byId('memoTags').value = '';
            writeDraft();
            showToast('保存しました', 'success');
            loadList(false);

        } catch (error) {
            const message = error && error.message ? error.message : '保存に失敗しました';
            showToast(message + '（本文は残っています。もう一度押すと送り直します）', 'error');

        } finally {
            state.saving = false;
            button.disabled = false;
            button.textContent = '保存';
        }
    }

    // ============================================================
    // 一覧
    // ============================================================

    async function loadList(append) {
        const seq = ++state.listSeq;
        const offset = append ? state.items.length : 0;

        byId('listInfo').textContent = '読み込み中…';
        byId('moreButton').hidden = true;

        try {
            const result = await callServer('memoList', memoToken, {
                kind: state.kind,
                text: state.text,
                tag: state.tag,
                offset: offset
            });

            // 後から出した検索の結果だけを使う
            if (seq !== state.listSeq) {
                return;
            }

            if (!result || !result.ok) {
                throw new Error(result && result.message ? result.message : '一覧の読み込みに失敗しました');
            }

            state.items = append ? state.items.concat(result.items) : result.items;
            state.total = result.total;

            // 絞り込みのない一覧のタグを、入力欄の候補にも使う
            if (!state.text && !state.tag && state.kind !== 'article') {
                state.tags = result.tags;
            }

            renderList();
            renderTagFilter(result.tags);
            renderTagSuggest();

        } catch (error) {
            if (seq !== state.listSeq) {
                return;
            }

            byId('listInfo').textContent = '';
            showToast(error && error.message ? error.message : '一覧の読み込みに失敗しました', 'error');
        }
    }

    function renderList() {
        const list = byId('list');
        list.replaceChildren();

        if (!state.items.length) {
            const filtered = state.text || state.tag;
            list.appendChild(createElement('div', 'empty', filtered ? '見つかりませんでした' : 'まだありません'));
        }

        for (const item of state.items) {
            const card = createElement('button', 'card result-card');
            card.type = 'button';
            card.appendChild(createElement('div', 'card-title', item.title));

            const meta = createElement('div', 'card-meta');
            meta.appendChild(createElement('span', 'badge ' + item.kind, item.kind === 'memo' ? 'メモ' : '記事'));
            meta.appendChild(createElement('span', '', item.date));

            for (const tag of item.tags) {
                meta.appendChild(createElement('span', '', '#' + tag));
            }

            card.appendChild(meta);
            card.addEventListener('click', () => openDetail(item));
            list.appendChild(card);
        }

        byId('listInfo').textContent = state.total + '件';
        byId('moreButton').hidden = state.items.length >= state.total;
    }

    function renderTagFilter(tags) {
        const container = byId('tagFilter');
        container.replaceChildren();

        if (state.kind === 'article') {
            return;
        }

        const shown = tags.slice();

        // 選んだタグが一覧から消えても、外せるように残す
        if (state.tag && !shown.some(entry => entry.tag === state.tag)) {
            shown.unshift({ tag: state.tag, count: 0 });
        }

        for (const entry of shown) {
            const chip = createElement('button', 'chip' + (entry.tag === state.tag ? ' active' : ''), '#' + entry.tag);
            chip.type = 'button';
            chip.addEventListener('click', () => {
                state.tag = state.tag === entry.tag ? '' : entry.tag;
                loadList(false);
            });
            container.appendChild(chip);
        }
    }

    function renderTagSuggest() {
        const container = byId('tagSuggest');
        container.replaceChildren();

        for (const entry of state.tags.slice(0, SUGGEST_TAG_COUNT)) {
            const chip = createElement('button', 'chip', '#' + entry.tag);
            chip.type = 'button';
            chip.addEventListener('click', () => {
                const input = byId('memoTags');
                const tags = parseTags(input.value);

                if (!tags.includes(entry.tag)) {
                    tags.push(entry.tag);
                }

                input.value = tags.join(' ');
                writeDraft();
            });
            container.appendChild(chip);
        }
    }

    // ============================================================
    // 本文表示（Markdownを要素で組み立てる。HTMLとしては解釈しない）
    // ============================================================

    const inlinePattern = /(\x60+)([^\x60]+?)\1|!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*([^*]+)\*\*|(https?:\/\/[^\s<>()]+)/g;

    function appendLink(parent, label, url) {
        if (!/^https?:\/\//i.test(url)) {
            parent.appendChild(document.createTextNode(label));
            return;
        }

        const link = createElement('a', '', label);
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        parent.appendChild(link);
    }

    function appendInline(parent, text) {
        let last = 0;
        let match;

        inlinePattern.lastIndex = 0;

        while ((match = inlinePattern.exec(text))) {
            if (match.index > last) {
                parent.appendChild(document.createTextNode(text.slice(last, match.index)));
            }

            if (match[2] !== undefined) {
                parent.appendChild(createElement('code', '', match[2]));
            } else if (match[4] !== undefined) {
                // 画像は読み込まず、リンクにする
                appendLink(parent, '[画像' + (match[3] ? ': ' + match[3] : '') + ']', match[4]);
            } else if (match[6] !== undefined) {
                appendLink(parent, match[5], match[6]);
            } else if (match[7] !== undefined) {
                parent.appendChild(createElement('strong', '', match[7]));
            } else if (match[8] !== undefined) {
                appendLink(parent, match[8], match[8]);
            }

            last = inlinePattern.lastIndex;
        }

        if (last < text.length) {
            parent.appendChild(document.createTextNode(text.slice(last)));
        }
    }

    function appendLines(parent, lines) {
        lines.forEach((line, index) => {
            if (index > 0) {
                parent.appendChild(document.createElement('br'));
            }

            appendInline(parent, line);
        });
    }

    function splitTableRow(line) {
        return line
            .trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map(cell => cell.trim());
    }

    const listPattern = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

    function isBlockStart(line, next) {
        return /^\s*\x60\x60\x60/.test(line) ||
            /^#{1,6}\s/.test(line) ||
            /^\s*>/.test(line) ||
            listPattern.test(line) ||
            /^\s*([-*_])(\s*\1){2,}\s*$/.test(line) ||
            (/^\s*\|/.test(line) && next !== undefined && /^\s*\|?\s*:?-{3,}/.test(next));
    }

    function renderMarkdown(markdown, container) {
        container.replaceChildren();

        let lines = markdown.replace(/\r\n?/g, '\n').split('\n');

        // 先頭のメタ情報（--- で囲んだ部分）は小さく見せる
        if (lines[0] === '---') {
            const end = lines.indexOf('---', 1);

            if (end > 0) {
                const meta = createElement('div', 'md-meta');
                appendLines(meta, lines.slice(1, end));
                container.appendChild(meta);
                lines = lines.slice(end + 1);
            }
        }

        let index = 0;

        while (index < lines.length) {
            const line = lines[index];

            if (!line.trim()) {
                index++;
                continue;
            }

            if (/^\s*\x60\x60\x60/.test(line)) {
                const code = [];
                index++;

                while (index < lines.length && !/^\s*\x60\x60\x60/.test(lines[index])) {
                    code.push(lines[index]);
                    index++;
                }

                index++;
                const pre = createElement('pre');
                pre.appendChild(createElement('code', '', code.join('\n')));
                container.appendChild(pre);
                continue;
            }

            const heading = /^(#{1,6})\s+(.*)$/.exec(line);

            if (heading) {
                const element = createElement('h' + heading[1].length);
                appendInline(element, heading[2]);
                container.appendChild(element);
                index++;
                continue;
            }

            if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
                container.appendChild(createElement('hr'));
                index++;
                continue;
            }

            if (/^\s*>/.test(line)) {
                const quote = [];

                while (index < lines.length && /^\s*>/.test(lines[index])) {
                    quote.push(lines[index].replace(/^\s*>\s?/, ''));
                    index++;
                }

                const element = createElement('blockquote');
                appendLines(element, quote);
                container.appendChild(element);
                continue;
            }

            if (/^\s*\|/.test(line) && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1])) {
                const table = createElement('table');
                const headRow = createElement('tr');

                for (const cell of splitTableRow(line)) {
                    const th = createElement('th');
                    appendInline(th, cell);
                    headRow.appendChild(th);
                }

                table.appendChild(headRow);
                index += 2;

                while (index < lines.length && /^\s*\|/.test(lines[index])) {
                    const row = createElement('tr');

                    for (const cell of splitTableRow(lines[index])) {
                        const td = createElement('td');
                        appendInline(td, cell);
                        row.appendChild(td);
                    }

                    table.appendChild(row);
                    index++;
                }

                container.appendChild(table);
                continue;
            }

            const listMatch = listPattern.exec(line);

            if (listMatch) {
                const ordered = /\d/.test(listMatch[2]);
                const list = createElement(ordered ? 'ol' : 'ul');

                while (index < lines.length) {
                    const itemMatch = listPattern.exec(lines[index]);

                    if (!itemMatch || /\d/.test(itemMatch[2]) !== ordered) {
                        break;
                    }

                    const item = createElement('li');
                    // 入れ子は字下げで表す
                    item.style.marginLeft = Math.min(itemMatch[1].replace(/\t/g, '    ').length, 12) * 0.5 + 'em';

                    const task = /^\[([ xX])\]\s+(.*)$/.exec(itemMatch[3]);

                    if (task) {
                        appendInline(item, (task[1] === ' ' ? '☐ ' : '☑ ') + task[2]);
                    } else {
                        appendInline(item, itemMatch[3]);
                    }

                    list.appendChild(item);
                    index++;
                }

                container.appendChild(list);
                continue;
            }

            const paragraph = [];

            while (
                index < lines.length &&
                lines[index].trim() &&
                (paragraph.length === 0 || !isBlockStart(lines[index], lines[index + 1]))
            ) {
                paragraph.push(lines[index]);
                index++;
            }

            const element = createElement('p');
            appendLines(element, paragraph);
            container.appendChild(element);
        }
    }

    // ============================================================
    // 詳細パネル
    // ============================================================

    async function openDetail(item) {
        const seq = ++state.detailSeq;

        state.detailText = '';
        byId('detailTitle').textContent = item.title;

        const meta = byId('detailMeta');
        meta.replaceChildren();
        meta.appendChild(createElement('span', 'badge ' + item.kind, item.kind === 'memo' ? 'メモ' : '記事'));
        meta.appendChild(createElement('span', '', item.date));

        for (const tag of item.tags) {
            meta.appendChild(createElement('span', '', '#' + tag));
        }

        const body = byId('detailBody');
        body.replaceChildren(createElement('div', 'empty', '読み込み中…'));
        byId('driveLink').removeAttribute('href');
        byId('detailScrim').hidden = false;

        try {
            const result = await callServer('memoGet', memoToken, item.id);

            if (seq !== state.detailSeq) {
                return;
            }

            if (!result || !result.ok) {
                throw new Error(result && result.message ? result.message : '読み込みに失敗しました');
            }

            state.detailText = result.markdown;
            byId('driveLink').href = result.url;
            renderMarkdown(result.markdown, body);
            body.scrollTop = 0;

        } catch (error) {
            if (seq !== state.detailSeq) {
                return;
            }

            body.replaceChildren(createElement('div', 'empty', error && error.message ? error.message : '読み込みに失敗しました'));
        }
    }

    function closeDetail() {
        state.detailSeq++;
        byId('detailScrim').hidden = true;
    }

    async function copyDetail() {
        const text = state.detailText;

        if (!text) {
            return;
        }

        try {
            await navigator.clipboard.writeText(text);
            showToast('コピーしました', 'success');
            return;
        } catch (error) {
            // GASの枠内では使えないことがあるので、下の方法で試す
        }

        const area = createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.top = '-1000px';
        document.body.appendChild(area);
        area.select();

        let copied = false;

        try {
            copied = document.execCommand('copy');
        } catch (error) {
            copied = false;
        }

        area.remove();
        showToast(copied ? 'コピーしました' : 'コピーできませんでした', copied ? 'success' : 'error');
    }

    // ============================================================
    // 操作
    // ============================================================

    byId('saveButton').addEventListener('click', saveMemo);

    byId('memoText').addEventListener('keydown', event => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            saveMemo();
        }
    });

    byId('memoText').addEventListener('input', writeDraft);
    byId('memoTags').addEventListener('input', writeDraft);

    let searchTimer = 0;

    byId('searchInput').addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            state.text = byId('searchInput').value.trim();
            loadList(false);
        }, SEARCH_DELAY);
    });

    for (const button of byId('kindTabs').querySelectorAll('[data-kind]')) {
        button.addEventListener('click', () => {
            state.kind = button.dataset.kind;

            if (state.kind === 'article') {
                state.tag = '';
            }

            for (const other of byId('kindTabs').querySelectorAll('[data-kind]')) {
                other.classList.toggle('active', other === button);
            }

            loadList(false);
        });
    }

    byId('moreButton').addEventListener('click', () => loadList(true));
    byId('closeButton').addEventListener('click', closeDetail);
    byId('copyButton').addEventListener('click', copyDetail);

    byId('detailScrim').addEventListener('click', event => {
        if (event.target === byId('detailScrim')) {
            closeDetail();
        }
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !byId('detailScrim').hidden) {
            closeDetail();
        }
    });

    // 外れたときの手がかり。コンソールで __memoPage.dump() を呼ぶ
    window.__memoPage = {
        dump: () => console.table({
            kind: state.kind,
            text: state.text,
            tag: state.tag,
            shown: state.items.length,
            total: state.total,
            pendingSave: state.pendingSave ? state.pendingSave.requestId : ''
        })
    };

    readDraft();
    loadList(false);
})();
</script>
</body>
</html>`;
