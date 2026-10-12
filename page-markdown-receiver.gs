// ページ本文コピー用の受け口。経費処理とは別のApps Scriptプロジェクトに置く。
// setupを一度実行して認証し、ウェブアプリとしてデプロイする。
// 本文の画像は、ここから取りに行って Drive に保存する（外部URLへの接続の権限を使う）。
// 成人向けのサイトのページと画像は保存しない。Cloudflare の家族向け DNS に問い合わせて判定し、
// 判定できないときも保存しない（スクリプト側は、あとで送り直す）。
const ARCHIVE_FOLDER_ID = '1WFV1mV24vc2ZwXxBhS2EjhKMhgiRNVRl';
const ARCHIVE_MAX_CHARS = 500000;
// 1記事あたりの画像の上限
const IMAGE_MAX = 20;
// 画像1枚の上限（バイト）。超えたものは保存しない
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
// 保存する画像の種類と拡張子
// 正式でない別名（image/jpg など）を返すサイトもあるので、それも受け付ける
const IMAGE_TYPES = {
    'image/png': 'png',
    'image/x-png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/pjpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/avif': 'avif'
};
// .md の末尾に付ける画像一覧の見出し。送り直しのとき、この手前までを元の本文として比べる
const IMAGE_SECTION_MARK = '\n\n---\n\n## 画像（Driveに保存）\n';
// 成人向けのサイトを 0.0.0.0 で返す、Cloudflare の家族向け DNS（DNS over HTTPS）
const FAMILY_DNS_URL = 'https://family.cloudflare-dns.com/dns-query';
// 判定結果を使い回す時間（秒）
const SITE_CACHE_SECONDS = 6 * 60 * 60;
// 成人向けとみなすドメインの末尾と語（ページ本文コピーの page-to-markdown.user.js と同じ）
const ADULT_TLD = /\.(xxx|adult|porn|sex)$/i;
const ADULT_HOST_WORDS = /porn|xxx|hentai|xvideos|xhamster|xnxx|redtube|youporn|nsfw|onlyfans|fanza|(^|\.)dmm\.co\.jp$/i;
// 画像のリダイレクトをたどる回数の上限（行き先のサイトも1回ずつ確かめる）
const IMAGE_REDIRECT_MAX = 3;

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

    // 成人向けの判定が働くかを確かめる。nudity.testcategory.com は Cloudflare の確認用のドメイン
    const verdicts = siteVerdicts(['nudity.testcategory.com', 'example.com'], true);
    const label = verdict => ({ adult: '成人向け', ok: '問題なし', unknown: '判定できない' })[verdict];

    console.log('成人向けの判定の確認: nudity.testcategory.com → ' + label(verdicts['nudity.testcategory.com']) + '（「成人向け」なら正常）');
    console.log('成人向けの判定の確認: example.com → ' + label(verdicts['example.com']) + '（「問題なし」なら正常）');
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

        // 記事のサイトを確かめる。成人向け、または判定できないときは保存しない
        const pageHost = hostOf(input.url);
        const verdicts = siteVerdicts(
            [pageHost].concat((input.images || []).map(image => hostOf(image.url)))
        );

        if (verdicts[pageHost] === 'adult') {
            return archiveResponse({ ok: false, message: '成人向けのサイトと判定したので、保存しません' });
        }

        if (verdicts[pageHost] !== 'ok') {
            return archiveResponse({ ok: false, message: 'サイトの判定（家族向けDNS）に失敗しました。時間をおいて送り直してください' });
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
            images = saveImages(folder, name.replace(/\.md$/, ''), requested, input.url, verdicts);
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


// 画像を取りに行き、記事ごとのフォルダ「<記事のファイル名>_画像」に保存する。
// 配信元が成人向け、または判定できない画像は取りに行かない
function saveImages(archive, baseName, images, pageUrl, verdicts) {

    const blocked = images.map(image => siteProblem(verdicts[hostOf(image.url)]));
    const targets = images.filter((image, index) => !blocked[index]);

    const requests = targets.map(image => imageRequest(image.url, pageUrl));

    let fetched;

    try {
        fetched = requests.length ? UrlFetchApp.fetchAll(requests) : [];
    } catch (error) {
        // 1件でも名前解決などで失敗すると全体が例外になるので、1件ずつ取り直す
        fetched = requests.map(request => {
            try {
                return UrlFetchApp.fetch(request.url, request);
            } catch (inner) {
                return null;
            }
        });
    }

    // リダイレクトは自動でたどらず、行き先のサイトを確かめてから取りに行く
    const answers = targets.map((image, index) => followImageRedirects(fetched[index], image.url, pageUrl));

    let folder = null;
    let saved = 0;
    let failed = 0;
    let next = 0;

    const results = images.map((image, index) => {

        if (blocked[index]) {
            failed++;
            return { image: image, error: blocked[index] };
        }

        const answer = answers[next++];
        const response = answer.response;
        const reason = answer.error || imageProblem(response, answer.url);

        if (reason) {
            failed++;
            return { image: image, error: reason };
        }

        const extension = imageExtension(response, answer.url);
        const label = (image.alt || '')
            .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 40);
        const fileName = String(image.n).padStart(2, '0') + (label ? '_' + label : '') + '.' + extension;

        if (!folder) {
            folder = imageFolder(archive, baseName);
        }

        const file = folder.createFile(response.getBlob().setName(fileName));
        saved++;

        return { image: image, file: file };
    });

    return { results: results, saved: saved, failed: failed };
}


function imageRequest(url, pageUrl) {

    return {
        url: url,
        muteHttpExceptions: true,
        followRedirects: false,
        // 直リンクを断るサイトのために、元のページから来たことを伝える
        headers: { Referer: pageUrl }
    };
}


// 3xx なら行き先のサイトを確かめてから取りに行く。{ response, url, error }
function followImageRedirects(response, url, pageUrl) {

    let current = response;
    let currentUrl = url;

    for (let hop = 0; current && hop <= IMAGE_REDIRECT_MAX; hop++) {

        const code = current.getResponseCode();

        if (code < 300 || code >= 400) {
            return { response: current, url: currentUrl, error: '' };
        }

        if (hop === IMAGE_REDIRECT_MAX) {
            break;
        }

        const headers = current.getHeaders();
        const location = String(headers.Location || headers.location || '');
        const nextUrl = resolveUrl(currentUrl, location);

        if (!nextUrl) {
            return { response: null, url: currentUrl, error: '転送先が不正です' };
        }

        const problem = siteProblem(siteVerdicts([hostOf(nextUrl)])[hostOf(nextUrl)]);

        if (problem) {
            return { response: null, url: nextUrl, error: problem };
        }

        try {
            current = UrlFetchApp.fetch(nextUrl, imageRequest(nextUrl, pageUrl));
        } catch (error) {
            current = null;
        }

        currentUrl = nextUrl;
    }

    return { response: null, url: currentUrl, error: current ? '転送が多すぎます' : '取得できませんでした' };
}


// 相対の転送先を絶対URLにする。http(s) 以外は空文字
function resolveUrl(base, location) {

    if (/^https?:\/\//i.test(location)) {
        return location;
    }

    const origin = /^(https?:\/\/[^\/?#]+)/i.exec(base);

    if (!origin || !location) {
        return '';
    }

    if (location.startsWith('//')) {
        return base.split(':')[0] + ':' + location;
    }

    if (location.startsWith('/')) {
        return origin[1] + location;
    }

    return base.replace(/[?#].*$/, '').replace(/[^\/]*$/, '') + location;
}


// ============================================================
// 成人向けのサイトの判定
// ============================================================

function hostOf(url) {

    const match = /^https?:\/\/([^\/?#]+)/i.exec(String(url));

    if (!match) {
        return '';
    }

    // ユーザー名・ポート・末尾の点を除く
    return match[1]
        .replace(/^.*@/, '')
        .replace(/:\d+$/, '')
        .replace(/\.$/, '')
        .toLowerCase();
}


// 画像を保存しない理由。保存してよいなら空文字
function siteProblem(verdict) {

    if (verdict === 'ok') {
        return '';
    }

    return verdict === 'adult'
        ? '成人向けのサイトの画像なので保存しません'
        : '配信元を判定できませんでした';
}


/*
 * ホスト名ごとの判定。{ ホスト名: 'adult' | 'ok' | 'unknown' }。
 * ドメイン名で分かるものはそこで決め、残りを家族向け DNS にまとめて問い合わせる。
 * 家族向け DNS は、成人向けのサイトを 0.0.0.0 で返す
 */
function siteVerdicts(hosts, skipCache) {

    const result = {};
    const unique = hosts.filter((host, index) => host && hosts.indexOf(host) === index);
    const cache = CacheService.getScriptCache();
    const cached = skipCache ? {} : cache.getAll(unique.map(host => 'site:' + host));
    const asking = [];

    unique.forEach(host => {

        const name = host.replace(/^www\./, '');

        if (ADULT_TLD.test(name) || ADULT_HOST_WORDS.test(name)) {
            result[host] = 'adult';
        } else if (!name.includes('.') || name.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(name)) {
            // IPアドレスや名前のないホストは、記事のサイトとしては扱わない
            result[host] = 'unknown';
        } else if (cached['site:' + host]) {
            result[host] = cached['site:' + host];
        } else {
            asking.push(host);
        }
    });

    if (!asking.length) {
        return result;
    }

    const requests = asking.map(host => ({
        url: FAMILY_DNS_URL + '?name=' + encodeURIComponent(host) + '&type=A',
        muteHttpExceptions: true,
        headers: { accept: 'application/dns-json' }
    }));

    let responses;

    try {
        responses = UrlFetchApp.fetchAll(requests);
    } catch (error) {
        responses = requests.map(request => {
            try {
                return UrlFetchApp.fetch(request.url, request);
            } catch (inner) {
                return null;
            }
        });
    }

    const store = {};

    asking.forEach((host, index) => {

        const verdict = dnsVerdict(responses[index]);

        result[host] = verdict;

        if (verdict !== 'unknown') {
            store['site:' + host] = verdict;
        }
    });

    if (Object.keys(store).length) {
        cache.putAll(store, SITE_CACHE_SECONDS);
    }

    return result;
}


function dnsVerdict(response) {

    if (!response || response.getResponseCode() !== 200) {
        return 'unknown';
    }

    let data;

    try {
        data = JSON.parse(response.getContentText());
    } catch (error) {
        return 'unknown';
    }

    // 0: 名前が引けた、3: 存在しない名前。それ以外は判定できない
    if (!data || (data.Status !== 0 && data.Status !== 3)) {
        return 'unknown';
    }

    const adult =
        Array.isArray(data.Answer) &&
        data.Answer.some(answer => answer && answer.data === '0.0.0.0');

    return adult ? 'adult' : 'ok';
}


// 保存できない理由。保存できるなら空文字
function imageProblem(response, url) {

    if (!response) {
        return '取得できませんでした';
    }

    const code = response.getResponseCode();

    if (code !== 200) {
        return 'HTTP ' + code;
    }

    if (!imageExtension(response, url)) {
        return '画像ではありません（' + (contentType(response) || '種類不明') + '）';
    }

    if (response.getContent().length > IMAGE_MAX_BYTES) {
        return '大きすぎます';
    }

    return '';
}


function contentType(response) {

    const headers = response.getHeaders();

    return String(headers['Content-Type'] || headers['content-type'] || '')
        .split(';')[0].trim().toLowerCase();
}


// 保存するときの拡張子。種類名で決め、種類名が汎用（octet-stream など）のときだけURLの拡張子を見る
function imageExtension(response, url) {

    const type = contentType(response);

    if (IMAGE_TYPES[type]) {
        return IMAGE_TYPES[type];
    }

    if (type && type !== 'application/octet-stream' && type !== 'binary/octet-stream') {
        return '';
    }

    const match = /\.(png|jpe?g|gif|webp|avif)(?:[?#]|$)/i.exec(String(url).split('#')[0]);

    return match ? match[1].toLowerCase().replace('jpeg', 'jpg') : '';
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
