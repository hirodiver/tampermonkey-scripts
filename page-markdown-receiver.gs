// ページ本文コピー用の受け口。経費処理とは別のApps Scriptプロジェクトに置く。
// setupを一度実行して認証し、ウェブアプリとしてデプロイする。
const ARCHIVE_FOLDER_ID = '1WFV1mV24vc2ZwXxBhS2EjhKMhgiRNVRl';
const ARCHIVE_MAX_CHARS = 500000;

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
