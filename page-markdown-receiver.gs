// ページ本文コピー用の受け口。経費処理とは別のApps Scriptプロジェクトに置く。
// setupを一度実行して認証し、ウェブアプリとしてデプロイする。
// 本文の画像は、ここから取りに行って Drive に保存する（外部URLへの接続の権限を使う）。
const ARCHIVE_FOLDER_ID = '1WFV1mV24vc2ZwXxBhS2EjhKMhgiRNVRl';
const ARCHIVE_MAX_CHARS = 500000;
// 1記事あたりの画像の上限
const IMAGE_MAX = 20;
// 画像1枚の上限（バイト）。超えたものは保存しない
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
// 保存する画像の種類と拡張子
const IMAGE_TYPES = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/avif': 'avif'
};
// .md の末尾に付ける画像一覧の見出し。送り直しのとき、この手前までを元の本文として比べる
const IMAGE_SECTION_MARK = '\n\n---\n\n## 画像（Driveに保存）\n';

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
            !Number.isFinite(Date.parse(input.capturedAt)) ||
            !validImageList(input.images)
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
        let stored = '';

        if (matches.hasNext()) {
            file = matches.next();
            stored = file.getBlob().getDataAsString('UTF-8');
            // 同じIDで異なる本文を上書きしない（末尾の画像一覧は、こちらで足したもの）
            if (stored !== input.markdown && !stored.startsWith(input.markdown + IMAGE_SECTION_MARK)) {
                return archiveResponse({ ok: false, message: '送信IDが重複しています。ページを再読み込みしてください' });
            }
        } else {
            file = folder.createFile(
                Utilities.newBlob(input.markdown, 'text/markdown', name)
            );
            stored = input.markdown;
        }

        // 画像は、まだ一覧を付けていないときだけ取りに行く（送り直しで二重に保存しない）
        let images = null;
        const requested = Array.isArray(input.images) ? input.images : [];

        if (requested.length && stored === input.markdown) {
            images = saveImages(folder, name.replace(/\.md$/, ''), requested, input.url);
            file.setContent(input.markdown + imageSection(images.results));
        }

        return archiveResponse({
            ok: true,
            fileId: file.getId(),
            name: file.getName(),
            url: file.getUrl(),
            ...(images ? { images: { saved: images.saved, failed: images.failed } } : {})
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
// 本文の画像
// ============================================================

// 画像の一覧は省略可。あるときは番号・http(s)のURL・説明文だけを受け付ける
function validImageList(images) {

    if (images === undefined) {
        return true;
    }

    if (!Array.isArray(images) || images.length > IMAGE_MAX) {
        return false;
    }

    return images.every(image =>
        image &&
        Number.isInteger(image.n) && image.n >= 1 && image.n <= 1000 &&
        typeof image.url === 'string' && image.url.length <= 2000 &&
        /^https?:\/\//.test(image.url) &&
        (image.alt === undefined || (typeof image.alt === 'string' && image.alt.length <= 200))
    );
}


// 画像を取りに行き、記事ごとのフォルダ「<記事のファイル名>_画像」に保存する
function saveImages(archive, baseName, images, pageUrl) {

    const requests = images.map(image => ({
        url: image.url,
        muteHttpExceptions: true,
        followRedirects: true,
        // 直リンクを断るサイトのために、元のページから来たことを伝える
        headers: { Referer: pageUrl }
    }));

    let responses;

    try {
        responses = UrlFetchApp.fetchAll(requests);
    } catch (error) {
        // 1件でも名前解決などで失敗すると全体が例外になるので、1件ずつ取り直す
        responses = requests.map(request => {
            try {
                return UrlFetchApp.fetch(request.url, request);
            } catch (inner) {
                return null;
            }
        });
    }

    let folder = null;
    let saved = 0;
    let failed = 0;

    const results = images.map((image, index) => {

        const response = responses[index];
        const reason = imageProblem(response);

        if (reason) {
            failed++;
            return { image: image, error: reason };
        }

        const type = String(response.getHeaders()['Content-Type'] || response.getHeaders()['content-type'] || '')
            .split(';')[0].trim().toLowerCase();
        const label = (image.alt || '')
            .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 40);
        const fileName = String(image.n).padStart(2, '0') + (label ? '_' + label : '') + '.' + IMAGE_TYPES[type];

        if (!folder) {
            folder = imageFolder(archive, baseName);
        }

        const file = folder.createFile(response.getBlob().setName(fileName));
        saved++;

        return { image: image, file: file };
    });

    return { results: results, saved: saved, failed: failed };
}


// 保存できない理由。保存できるなら空文字
function imageProblem(response) {

    if (!response) {
        return '取得できませんでした';
    }

    const code = response.getResponseCode();

    if (code !== 200) {
        return 'HTTP ' + code;
    }

    const headers = response.getHeaders();
    const type = String(headers['Content-Type'] || headers['content-type'] || '')
        .split(';')[0].trim().toLowerCase();

    if (!IMAGE_TYPES[type]) {
        return '画像ではありません（' + (type || '種類不明') + '）';
    }

    if (response.getContent().length > IMAGE_MAX_BYTES) {
        return '大きすぎます';
    }

    return '';
}


function imageFolder(archive, baseName) {

    const name = baseName + '_画像';
    const existing = archive.getFoldersByName(name);

    return existing.hasNext() ? existing.next() : archive.createFolder(name);
}


// .md の末尾に付ける一覧。本文の「画像N」と番号で対応する
function imageSection(results) {

    const lines = results.map(result => {

        const label = '画像' + result.image.n + (result.image.alt ? ': ' + result.image.alt : '');

        return result.file
            ? '- ' + label + ' → ' + result.file.getUrl() + '（元: ' + result.image.url + '）'
            : '- ' + label + ' → 保存できませんでした（' + result.error + '）（元: ' + result.image.url + '）';
    });

    return IMAGE_SECTION_MARK + '\n' + lines.join('\n') + '\n';
}
