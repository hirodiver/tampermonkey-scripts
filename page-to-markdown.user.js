// ==UserScript==
// @name         ページ本文コピー v1.6.2
// @namespace    local.hiro.tools
// @version      1.6.2
// @description  ページ本文や選択範囲をMarkdownでコピーし、設定済みならGoogle Driveにも保存する。届かなかった保存は控えて送り直す。
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// @noframes
// @homepageURL  https://github.com/hirodiver/tampermonkey-scripts
// @supportURL   https://github.com/hirodiver/tampermonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/page-to-markdown.user.js
// @updateURL    https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/page-to-markdown.user.js
// ==/UserScript==

/*
 * 使い方
 *   - ボタン（ドラッグで好きな位置へ動かせる）、または Alt+Shift+C でコピー
 *   - 文字を選択していれば、選択範囲だけをコピー（周辺メニューの除外はしない）
 *   - 選択していなければ、本文を自動判定してコピー
 *   - X のポストページは専用処理（URL の status ID と一致するポストだけを、
 *     投稿者・投稿日時・本文・反応数に整えてコピー）
 *
 * Drive保存が届かなかったとき
 *   - 送る前に控えを取り、届いたと確認できたら消す。押したらすぐ移動してよい
 *   - 控えが残っていると、ボタン右上に件数が出る。次にページを開いたとき・
 *     次に保存が成功したときに自動で送り直す
 *   - 手動で送るときは、Tampermonkey のメニュー「未保存を一覧・再送」
 *
 * 外したとき
 *   - DevTools コンソールで window.__tmCopyText.dump() を実行すると、
 *     どの要素を含めた・除外したか、その理由が表で出る
 *   - window.__tmCopyText.pending() で、未保存の控えが表で出る
 */

(function () {
    'use strict';

    // ============================================================
    // 設定
    // ============================================================

    // 自作UIのホスト要素ID（本文抽出からも除外する）
    const HOST_ID = 'tm-copy-text-host';

    // ショートカット（Alt + Shift + この物理キー）
    const HOTKEY_CODE = 'KeyC';

    // URL・トークンはサイトのlocalStorageではなく、拡張機能の専用領域に保存する
    const DRIVE_CONFIG_KEY = 'tm-copy-text-drive-config';
    const DRIVE_TIMEOUT_MS = 30000;
    const DRIVE_MAX_CHARS = 500000;

    // 届かなかった保存の控え（拡張機能の専用領域。他のタブと競合しないよう1件ずつ別キー）
    const PENDING_PREFIX = 'tm-copy-text-pending:';

    // 控えておく最大件数（超えた分は控えず、コピーだけ残る）
    const PENDING_MAX = 20;

    // 自動で送り直すまでの待ち時間（試した回数ごと。最後の値をくり返す）。
    // 最初を少し空けるのは、移動直後は元の送信がまだ届く途中かもしれないため
    const RETRY_DELAYS_MS = [15000, 60000, 300000, 1800000];

    // 一覧の確認ダイアログに出す最大件数
    const PENDING_LIST_LIMIT = 10;

    // リンクのURLを本文に残す（AIに渡すなら残したほうが情報量が多い）
    const INCLUDE_LINK_URL = true;

    // 折りたたみ（details・アコーディオン・非選択タブ）の中身を、開いた状態として含める
    const INCLUDE_COLLAPSED = true;

    // 画像は alt があるものだけ「[画像: alt]」として残す
    const INCLUDE_IMAGE_ALT = true;

    // 本文の画像を Drive にも保存する（受け口 GAS が画像を取りに行く）。
    // 本文には「![画像1: alt](元のURL)」と書き、保存先は記事の .md の末尾に一覧で付く
    const SAVE_IMAGES = true;

    // 1記事あたりの画像の上限
    const IMAGE_MAX = 20;

    // 表示の幅か高さがこれ（px）未満の画像は、アイコンとみなして保存しない
    const IMAGE_MIN_SIZE = 120;

    // 画像があるときの保存の待ち時間（受け口が画像を取りに行くぶん長くする）
    const DRIVE_IMAGE_TIMEOUT_MS = 90000;

    // X（旧Twitter）のポストページでは、URLの status ID と一致するポストだけを取る。
    // true にすると、同じページに出ている前後のポスト・返信もまとめて取る
    const INCLUDE_X_REPLIES = false;

    // X のポスト末尾に「反応: 表示 1.3万 / 引用 2 …」の1行を付ける
    const INCLUDE_X_STATS = true;

    // 本文とみなす最小文字数（空白除く）
    const MIN_BODY_CHARS = 200;

    // リンク密度による除外（メニュー・関連記事・タグ一覧など）
    const LINK_DENSITY_LIMIT = 0.7;
    const LINK_DENSITY_MIN_LINKS = 3;
    const LINK_DENSITY_MAX_CHARS = 1500;

    // この文字数を超えたら、コピー時に注意を出す
    const WARN_CHARS = 60000;

    // トーストの表示時間
    const TOAST_MS = 2800;

    // dump() の表に出す最大行数
    const DUMP_LIMIT = 400;

    // ボタンの大きさ・画面端との余白（px）
    const BUTTON_SIZE = 40;
    const EDGE_MARGIN = 4;

    // ボタンの初期位置。
    // 真ん中の上はタイトル、右上はメニューボタンと重なりやすいので、
    // 上端から少し下がった、中央よりやや右に置く
    const INITIAL_X_RATIO = 0.7;   // ボタン中心の横位置（画面幅に対する割合）
    const INITIAL_TOP = 88;        // 上端からの距離（px）

    // この距離（px）以上動かしたらドラッグ、未満ならタップとみなす
    const DRAG_THRESHOLD = 6;

    // 位置の保存キー（localStorage。サイトごとに別々に覚える）
    const POSITION_KEY = 'tm-copy-text-position';

    // ボタンの透明度（ふだん）
    const IDLE_OPACITY = '0.5';

    // 本文コンテナの候補（上から順に試す。狭いものが先）
    const BODY_SELECTORS = [
        '[itemprop="articleBody"]',
        '.markdown-body',
        '.entry-content',
        '.post-content',
        '.article-body',
        '.article-content',
        '.post-body',
        'article',
        'main',
        '[role="main"]',
        '#main-content',
        '#main',
        '#content'
    ];

    // 出力に含めないタグ
    const SKIP_TAGS = new Set([
        'script', 'style', 'noscript', 'template', 'head', 'meta', 'link',
        'svg', 'canvas', 'iframe', 'object', 'embed', 'video', 'audio',
        'button', 'input', 'select', 'textarea', 'option', 'dialog',
        'source', 'track', 'map', 'area'
    ]);

    // 段落として区切るタグ
    const BLOCK_TAGS = new Set([
        'address', 'article', 'aside', 'blockquote', 'body', 'dd', 'details',
        'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li',
        'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table',
        'tbody', 'thead', 'tfoot', 'tr', 'td', 'th', 'ul', 'caption'
    ]);

    // 周辺メニュー系のタグ・ロール（自動判定時のみ除外）
    const NOISE_TAGS = new Set(['nav', 'aside', 'footer']);

    const NOISE_ROLES = new Set([
        'navigation', 'complementary', 'contentinfo', 'search',
        'dialog', 'alertdialog'
    ]);

    // リンク密度を見るタグ
    const LINK_DENSITY_TAGS = new Set([
        'div', 'section', 'ul', 'ol', 'dl', 'table'
    ]);

    // 広告・SNS・関連記事・スクリーンリーダー専用などの class / id
    const NOISE_CLASS = /(^|[\s_-])(ad|ads|adv|advert|advertisement|adsense|sponsor|sponsored|promo|promotion|banner|share|sharing|sns|social|related|recommend|recommended|breadcrumb|breadcrumbs|cookie|popup|modal|newsletter|comments|comment-list|commentlist|comment-form|comments-area|disqus|disqus_thread|sidebar|pagination|pager|skip-link|sr-only|screen-reader-text|visually-hidden)([\s_-]|$)/i;

    // 折りたたみ領域らしい class
    const COLLAPSE_CLASS = /(^|[\s_-])(accordion|collapse|collapsed|collapsible|collapsing|faq|tab-pane|tabpane|tab-panel|tabpanel|tab-content|tabcontent|spoiler|read-more|readmore|more-content|expandable|expander|foldable|folding)([\s_-]|$)/i;

    // 広告判定の対象外にするタグ
    const KEEP_TAGS = new Set(['html', 'body', 'main', 'article']);


    // ============================================================
    // 状態
    // ============================================================

    // 1回の抽出中だけ使う状態
    let S = null;

    // 最後の抽出結果（診断用）
    let lastResult = null;

    let toastTimer = null;


    // ============================================================
    // 小さな補助
    // ============================================================

    function classOf(el) {

        return (
            (el.id || '') +
            ' ' +
            (el.getAttribute('class') || '')
        );
    }


    function isAdLike(el) {

        if (KEEP_TAGS.has(el.tagName.toLowerCase())) {
            return false;
        }

        return NOISE_CLASS.test(classOf(el));
    }


    function describe(el) {

        let text = el.tagName.toLowerCase();

        if (el.id) {
            text += '#' + el.id;
        }

        const classes =
            (el.getAttribute('class') || '')
                .trim()
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, 3);

        if (classes.length) {
            text += '.' + classes.join('.');
        }

        return text.slice(0, 80);
    }


    function record(kind, reason, el) {

        if (!S || !S.recording) {
            return;
        }

        if (S.log.length >= DUMP_LIMIT) {
            return;
        }

        S.log.push({
            判定: kind,
            理由: reason,
            要素: describe(el),
            文字数: (el.textContent || '').replace(/\s+/g, '').length
        });
    }


    function textLength(el) {

        return (
            (el.innerText || '')
                .replace(/\s+/g, '')
                .length
        );
    }


    /*
     * 描画されているか。
     * checkVisibility は祖先の display:none や、閉じた details の中身も見てくれる
     */
    function isRendered(el, style) {

        // display:contents は箱を持たないが、中身は表示される
        if (style.display === 'contents') {
            return true;
        }

        if (typeof el.checkVisibility === 'function') {

            return el.checkVisibility({
                checkVisibilityCSS: true,
                visibilityProperty: true
            });
        }

        return (
            style.display !== 'none' &&
            style.visibility !== 'hidden'
        );
    }


    function isRenderedSafe(el) {

        return isRendered(
            el,
            getComputedStyle(el)
        );
    }


    // ============================================================
    // 折りたたみ判定
    // ============================================================

    /*
     * 隠れている要素が「折りたたみ」なら理由を返す。違えば null。
     * 広告ブロッカーの display:none と区別するため、
     * 折りたたみの仕組みが確認できたものだけを通す
     */
    function collapsedReason(el) {

        if (!INCLUDE_COLLAPSED) {
            return null;
        }

        if (isAdLike(el)) {
            return null;
        }

        const parent = el.parentElement;


        // 閉じた details
        if (
            parent &&
            parent.tagName === 'DETAILS' &&
            !parent.open &&
            el.tagName !== 'SUMMARY'
        ) {
            return '閉じた details';
        }


        // タブの中身
        if (el.getAttribute('role') === 'tabpanel') {
            return 'tabpanel';
        }


        if (el.getAttribute('hidden') === 'until-found') {
            return 'hidden=until-found';
        }


        // ボタンから aria-controls で指されている領域
        if (el.id) {

            const trigger =
                document.querySelector(
                    '[aria-controls~="' + CSS.escape(el.id) + '"]'
                );

            if (trigger) {
                return 'aria-controls で指されている';
            }
        }


        // 直前の兄弟が開閉ボタン
        const prev = el.previousElementSibling;

        if (
            prev &&
            (
                prev.matches('[aria-expanded]') ||
                prev.querySelector('[aria-expanded]')
            )
        ) {
            return '直前が aria-expanded の開閉ボタン';
        }


        // アコーディオン系の class（自分か親）
        if (
            COLLAPSE_CLASS.test(classOf(el)) ||
            (parent && COLLAPSE_CLASS.test(classOf(parent)))
        ) {
            return '折りたたみ系の class';
        }

        return null;
    }


    // ============================================================
    // ノイズ判定（自動判定時のみ）
    // ============================================================

    function linkRatio(el) {

        const anchors =
            el.querySelectorAll('a[href]');

        if (anchors.length < LINK_DENSITY_MIN_LINKS) {
            return 0;
        }

        const total =
            (el.textContent || '')
                .replace(/\s+/g, '')
                .length;

        if (!total) {
            return 0;
        }

        let linkChars = 0;

        for (const a of anchors) {

            linkChars +=
                (a.textContent || '')
                    .replace(/\s+/g, '')
                    .length;
        }

        return linkChars / total;
    }


    function noiseReason(el, tag) {

        if (NOISE_TAGS.has(tag)) {
            return '<' + tag + '>';
        }


        const role = el.getAttribute('role');

        if (role && NOISE_ROLES.has(role)) {
            return 'role=' + role;
        }


        const inMain =
            el.closest('article, main, [role="main"]');

        if (role === 'banner' && !inMain) {
            return 'role=banner';
        }


        // 記事内の header は見出し・日付が入るので残す。サイトの header は除外
        if (
            tag === 'header' &&
            !inMain &&
            !el.querySelector('h1, h2, h3')
        ) {
            return '<header>';
        }


        if (isAdLike(el)) {
            return '広告・関連・共有などの class/id';
        }


        if (
            LINK_DENSITY_TAGS.has(tag) &&
            !el.querySelector('h1')
        ) {

            const total =
                (el.textContent || '')
                    .replace(/\s+/g, '')
                    .length;

            if (total <= LINK_DENSITY_MAX_CHARS) {

                const ratio = linkRatio(el);

                if (ratio > LINK_DENSITY_LIMIT) {

                    return (
                        'リンク密度 ' +
                        Math.round(ratio * 100) +
                        '%'
                    );
                }
            }
        }

        return null;
    }


    // ============================================================
    // 本文コンテナの特定
    // ============================================================

    function isInsideNoise(el) {

        if (
            el.closest(
                'nav, aside, footer, ' +
                '[role="navigation"], [role="complementary"], [role="contentinfo"]'
            )
        ) {
            return true;
        }

        for (
            let p = el;
            p && p !== document.body;
            p = p.parentElement
        ) {

            if (isAdLike(p)) {
                return true;
            }
        }

        return false;
    }


    function findBySelectors() {

        for (const selector of BODY_SELECTORS) {

            let best = null;
            let bestLength = 0;

            for (const el of document.querySelectorAll(selector)) {

                if (!isRenderedSafe(el)) {
                    continue;
                }

                const length = textLength(el);

                if (length > bestLength) {
                    best = el;
                    bestLength = length;
                }
            }

            if (best && bestLength >= MIN_BODY_CHARS) {

                return {
                    root: best,
                    method: '本文自動判定: ' + selector
                };
            }
        }

        return null;
    }


    /*
     * 段落の文字量を親・祖父に加点して、本文らしいブロックを選ぶ
     * （Readability の考え方の簡易版）
     */
    function findByDensity() {

        const scores = new Map();

        function bump(el, value) {

            if (
                !el ||
                el === document.body ||
                el === document.documentElement
            ) {
                return;
            }

            scores.set(
                el,
                (scores.get(el) || 0) + value
            );
        }


        const nodes =
            document.body.querySelectorAll(
                'p, pre, blockquote, div, td, section, li'
            );

        for (const el of nodes) {

            const length = ownTextLength(el);

            if (length < 25) {
                continue;
            }

            if (!isRenderedSafe(el)) {
                continue;
            }

            if (isInsideNoise(el)) {
                continue;
            }

            const score =
                1 + Math.min(length / 100, 3);

            bump(el.parentElement, score);
            bump(el.parentElement?.parentElement, score / 2);
        }


        let best = null;
        let bestScore = 0;

        for (const [el, score] of scores) {

            const adjusted =
                score * (1 - linkRatio(el));

            if (adjusted > bestScore) {
                best = el;
                bestScore = adjusted;
            }
        }

        if (best && textLength(best) >= MIN_BODY_CHARS) {

            return {
                root: best,
                method: '本文自動判定: 文字量スコア'
            };
        }

        return null;
    }


    function ownTextLength(el) {

        const tag = el.tagName.toLowerCase();

        // 段落系は、リンク以外の文字量
        if (
            tag === 'p' ||
            tag === 'pre' ||
            tag === 'blockquote' ||
            tag === 'li' ||
            tag === 'td'
        ) {

            const total =
                (el.textContent || '').trim().length;

            let linkChars = 0;

            for (const a of el.querySelectorAll('a')) {
                linkChars += (a.textContent || '').trim().length;
            }

            return total - linkChars;
        }

        // div などは、直下のテキストだけ
        let length = 0;

        for (const node of el.childNodes) {

            if (node.nodeType === Node.TEXT_NODE) {
                length += node.nodeValue.trim().length;
            }
        }

        return length;
    }


    function findBodyRoot() {

        return (
            findBySelectors() ||
            findByDensity() ||
            {
                root: document.body,
                method: '本文自動判定: 見つからないため body 全体'
            }
        );
    }


    // ============================================================
    // 選択範囲
    // ============================================================

    function getSelectionRanges() {

        const selection = window.getSelection();

        if (
            !selection ||
            selection.isCollapsed ||
            !selection.toString().trim()
        ) {
            return [];
        }

        const ranges = [];

        for (let i = 0; i < selection.rangeCount; i++) {

            const range = selection.getRangeAt(i);

            if (!range.collapsed) {
                ranges.push(range);
            }
        }

        return ranges;
    }


    function rangeRoot(range) {

        const node = range.commonAncestorContainer;

        return node.nodeType === Node.ELEMENT_NODE
            ? node
            : node.parentElement;
    }


    function sliceByRange(node) {

        const range = S.range;

        if (!range.intersectsNode(node)) {
            return '';
        }

        const text = node.nodeValue;

        let start = 0;
        let end = text.length;

        if (node === range.startContainer) {
            start = range.startOffset;
        }

        if (node === range.endContainer) {
            end = range.endOffset;
        }

        return text.slice(start, end);
    }


    // ============================================================
    // Markdown 変換：スコープ（段落バッファ）
    // ============================================================

    function newScope() {

        return {
            blocks: [],
            buf: '',
            flushId: 0
        };
    }


    /*
     * 行内の余分な空白を整える。
     * 日本語どうしの間の空白（HTMLの改行由来）は消す
     */
    function normalizeInline(text) {

        return text
            .replace(/ /g, ' ')
            .split('\n')
            .map(line =>
                line
                    .replace(/[ \t]+/g, ' ')
                    .replace(
                        /([　-ヿ㐀-鿿＀-￯])\s+(?=[　-ヿ㐀-鿿＀-￯])/g,
                        '$1'
                    )
                    .trim()
            )
            .join('\n')
            .replace(/\n{2,}/g, '\n')
            .trim();
    }


    function flush(scope) {

        const text = normalizeInline(scope.buf);

        scope.buf = '';
        scope.flushId++;

        if (text) {
            scope.blocks.push(text);
        }
    }


    function pushBlock(scope, text) {

        flush(scope);

        if (text) {
            scope.blocks.push(text);
        }
    }


    /*
     * 直近に足した文字列を、装飾記号で包む。
     * 途中で段落が切れていたら（中にブロックがある）何もしない
     */
    function wrapInline(scope, start, left, right) {

        const segment =
            scope.buf.slice(start);

        const body =
            segment
                .trim()
                .replace(/\s*\n\s*/g, ' ');

        if (!body) {
            return;
        }

        const lead =
            segment.slice(
                0,
                segment.length - segment.trimStart().length
            );

        const trail =
            segment.slice(segment.trimEnd().length);

        scope.buf =
            scope.buf.slice(0, start) +
            lead +
            left +
            body +
            right +
            trail;
    }


    function subBlocks(el, forced) {

        const scope = newScope();

        walkChildren(el, scope, forced);

        flush(scope);

        return scope.blocks;
    }


    function inlineText(el, forced) {

        return subBlocks(el, forced).join(' ');
    }


    // ============================================================
    // Markdown 変換：要素の通過判定
    // ============================================================

    /*
     * この要素を出力対象にするか。null なら除外。
     * 返す forced は「折りたたみの中として展開済みか」
     */
    function gate(el, forced) {

        const tag = el.tagName.toLowerCase();

        if (SKIP_TAGS.has(tag)) {
            return null;
        }

        if (el.id === HOST_ID) {
            return null;
        }

        // X のポストでは、投稿者・日時は見出し側へ出すので本文から外す
        if (S.skip && S.skip.has(el)) {
            return null;
        }

        if (S.range && !S.range.intersectsNode(el)) {
            return null;
        }


        // ------------------------------------------------------------
        // 可視性
        // ------------------------------------------------------------

        const style = getComputedStyle(el);

        let nextForced = forced;

        if (forced) {

            // 展開済みの中では、自身が display:none のものだけ見る
            if (style.display === 'none') {

                const reason = collapsedReason(el);

                if (!reason) {

                    record(
                        '除外',
                        '折りたたみ内の非表示要素',
                        el
                    );

                    return null;
                }
            }

        } else if (!isRendered(el, style)) {

            const reason = collapsedReason(el);

            if (!reason) {

                record(
                    '除外',
                    '非表示（display:none 等・折りたたみではない）',
                    el
                );

                return null;
            }

            record(
                '展開して含めた',
                reason,
                el
            );

            nextForced = true;
        }


        // ------------------------------------------------------------
        // 周辺メニュー・広告（自動判定のときだけ）
        // ------------------------------------------------------------

        if (!S.range && !S.xMode && el !== S.root) {

            const why = noiseReason(el, tag);

            if (why) {

                record('除外', why, el);

                return null;
            }
        }

        return { forced: nextForced };
    }


    // ============================================================
    // Markdown 変換：走査
    // ============================================================

    function walkChildren(el, scope, forced) {

        for (const child of el.childNodes) {
            walk(child, scope, forced);
        }
    }


    function walk(node, scope, forced) {

        if (node.nodeType === Node.TEXT_NODE) {

            const text =
                S.range
                    ? sliceByRange(node)
                    : node.nodeValue;

            scope.buf += text.replace(/\s+/g, ' ');

            return;
        }

        if (node.nodeType !== Node.ELEMENT_NODE) {
            return;
        }

        const passed = gate(node, forced);

        if (!passed) {
            return;
        }

        renderElement(node, scope, passed.forced);
    }


    // ------------------------------------------------------------
    // 画像（Drive 保存の対象を集める）
    // ------------------------------------------------------------

    /*
     * 画像の本当のURL。後から読み込む作りのサイトでは、src が仮の画像で、
     * 本物は data-src・srcset などにある。いちばん大きい候補を選ぶ
     */
    function imageUrl(el) {

        const fromSrcset = value => {

            let best = '';
            let bestSize = -1;

            for (const part of String(value || '').split(',')) {

                const [candidate, descriptor] = part.trim().split(/\s+/);

                if (!candidate) {
                    continue;
                }

                const size = parseFloat(descriptor) || 1;

                if (size > bestSize) {
                    best = candidate;
                    bestSize = size;
                }
            }

            return best;
        };

        const candidates = [
            linkedImageUrl(el),
            fromSrcset(el.getAttribute('srcset')),
            fromSrcset(el.getAttribute('data-srcset')),
            el.getAttribute('data-src'),
            el.getAttribute('data-original'),
            el.getAttribute('data-lazy-src'),
            el.currentSrc,
            el.getAttribute('src')
        ];

        for (const candidate of candidates) {

            if (!candidate || /^(data|blob):/i.test(candidate.trim())) {
                continue;
            }

            try {

                const url = new URL(candidate.trim(), location.href);

                if (/^https?:$/.test(url.protocol) && url.href.length <= 2000) {
                    return url.href;
                }

            } catch (error) {

                // 解釈できないURLは次の候補へ
            }
        }

        return '';
    }


    // 画像を包むリンクの先が画像なら、そのURL（note など。読み込み前でまだ src が無い画像も拾える）
    function linkedImageUrl(el) {

        const link = el.closest('a[href]');
        const href = link ? link.getAttribute('href') : '';

        return /\.(png|jpe?g|gif|webp|avif)(?:[?#]|$)/i.test(href) ? href : '';
    }


    /*
     * アイコンほど小さい画像か。確かな大きさ（表示の大きさ・読み込み済みの実寸・width/height 属性）
     * だけで判断する。読み込み前の仮の画像（1px など）の大きさは使わず、分からなければ小さくないとみなす
     */
    function isTinyImage(el) {

        const sizes = [];
        const rect = el.getBoundingClientRect();

        if (rect.width > 1 && rect.height > 1) {
            sizes.push([rect.width, rect.height]);
        }

        if (el.complete && el.naturalWidth > 1 && el.naturalHeight > 1) {
            sizes.push([el.naturalWidth, el.naturalHeight]);
        }

        const attrWidth = Number(el.getAttribute('width')) || 0;
        const attrHeight = Number(el.getAttribute('height')) || 0;

        if (attrWidth > 1 && attrHeight > 1) {
            sizes.push([attrWidth, attrHeight]);
        }

        if (!sizes.length) {
            return false;
        }

        const width = Math.max(...sizes.map(size => size[0]));
        const height = Math.max(...sizes.map(size => size[1]));

        return width < IMAGE_MIN_SIZE || height < IMAGE_MIN_SIZE;
    }


    function collectImage(el, alt) {

        if (!SAVE_IMAGES || !S || !S.images || S.images.length >= IMAGE_MAX) {
            return null;
        }

        // 絵文字の画像（X など）は文字のまま扱う
        if (alt && EMOJI_ONLY.test(alt)) {
            return null;
        }

        // 小さいものはアイコンとみなす。リンクの先が画像なら本文の図なので、大きさは問わない
        if (!linkedImageUrl(el) && isTinyImage(el)) {
            return null;
        }

        const url = imageUrl(el);

        if (!url) {
            return null;
        }

        const existing = S.images.find(image => image.url === url);

        if (existing) {
            return existing;
        }

        const image = {
            n: S.images.length + 1,
            url,
            alt: GENERIC_ALT.test(alt) ? '' : alt.replace(/[\[\]\n]/g, ' ').slice(0, 200)
        };

        S.images.push(image);

        return image;
    }


    function renderElement(el, scope, forced) {

        const tag = el.tagName.toLowerCase();


        if (tag === 'br') {

            scope.buf += '\n';

            return;
        }


        if (tag === 'hr') {

            pushBlock(scope, '---');

            return;
        }


        if (tag === 'img') {

            const alt =
                (el.getAttribute('alt') || '').trim();

            // Drive に保存する画像は、番号と元のURLを本文に残す
            const image = collectImage(el, alt);

            if (image) {
                scope.buf += '![画像' + image.n + (image.alt ? ': ' + image.alt : '') + '](' + image.url + ')';
                return;
            }

            if (S.xMode && alt) {

                // 絵文字は文字としてそのまま、意味のない alt は [画像] だけにする
                if (EMOJI_ONLY.test(alt)) {
                    scope.buf += alt;
                } else if (GENERIC_ALT.test(alt)) {
                    scope.buf += '[画像]';
                } else if (INCLUDE_IMAGE_ALT) {
                    scope.buf += '[画像: ' + alt + ']';
                }

                return;
            }

            if (INCLUDE_IMAGE_ALT && alt) {
                scope.buf += '[画像: ' + alt + ']';
            }

            return;
        }


        // ------------------------------------------------------------
        // 見出し
        // ------------------------------------------------------------

        if (/^h[1-6]$/.test(tag)) {

            flush(scope);

            const text = inlineText(el, forced);

            if (!text) {
                return;
            }

            // X のポストでは、文書の見出しが # なので、本文の見出しは1段下げる
            const level = Math.min(
                6,
                Number(tag[1]) + (S.headingShift || 0)
            );

            // タイトルと同じ最初の h1 は、ヘッダに出すので重複させない
            if (
                tag === 'h1' &&
                !S.range &&
                !S.titleDropped &&
                isSameAsTitle(text)
            ) {

                S.titleDropped = true;

                return;
            }

            scope.blocks.push(
                '#'.repeat(level) + ' ' + text
            );

            return;
        }


        // ------------------------------------------------------------
        // コード
        // ------------------------------------------------------------

        if (tag === 'pre') {

            renderPre(el, scope);

            return;
        }


        if (tag === 'code') {

            const start = scope.buf.length;
            const flushId = scope.flushId;

            walkChildren(el, scope, forced);

            if (flushId === scope.flushId) {

                const body =
                    scope.buf.slice(start);

                const fence =
                    body.includes('`') ? '``' : '`';

                wrapInline(scope, start, fence, fence);
            }

            return;
        }


        // ------------------------------------------------------------
        // リスト・引用・表
        // ------------------------------------------------------------

        if (tag === 'ul' || tag === 'ol') {

            renderList(el, scope, forced);

            return;
        }


        if (tag === 'blockquote') {

            flush(scope);

            const text =
                subBlocks(el, forced).join('\n\n');

            if (text) {

                scope.blocks.push(
                    text
                        .split('\n')
                        .map(line => ('> ' + line).trimEnd())
                        .join('\n')
                );
            }

            return;
        }


        if (tag === 'table') {

            if (renderTable(el, scope, forced)) {
                return;
            }

            // レイアウト用の表は、普通のブロックとして流す
        }


        // ------------------------------------------------------------
        // 定義リスト・summary
        // ------------------------------------------------------------

        if (tag === 'dt' || tag === 'summary') {

            flush(scope);

            const text = inlineText(el, forced);

            if (text) {
                scope.blocks.push('**' + text + '**');
            }

            return;
        }


        // ------------------------------------------------------------
        // 一般のブロック
        // ------------------------------------------------------------

        if (BLOCK_TAGS.has(tag)) {

            flush(scope);

            walkChildren(el, scope, forced);

            flush(scope);

            return;
        }


        // ------------------------------------------------------------
        // インライン
        // ------------------------------------------------------------

        const start = scope.buf.length;
        const flushId = scope.flushId;

        walkChildren(el, scope, forced);

        // 中にブロックがあって段落が切れたなら、装飾はしない
        if (flushId !== scope.flushId) {
            return;
        }

        if (tag === 'a') {

            wrapLink(el, scope, start);

        } else if (tag === 'strong' || tag === 'b') {

            wrapInline(scope, start, '**', '**');

        } else if (tag === 'em' || tag === 'i') {

            wrapInline(scope, start, '*', '*');

        } else if (tag === 'del' || tag === 's') {

            wrapInline(scope, start, '~~', '~~');
        }
    }


    function wrapLink(el, scope, start) {

        if (!INCLUDE_LINK_URL) {
            return;
        }

        const raw = el.getAttribute('href') || '';

        // ページ内リンク・javascript: などは文字だけ残す
        if (
            !raw ||
            raw.startsWith('#') ||
            !/^https?:/i.test(el.href)
        ) {
            return;
        }

        const segment =
            scope.buf.slice(start);

        const text =
            segment.trim();

        // 見出しの ¶ や # のような、リンク用の飾りは消す
        if (/^[#¶§🔗]$/.test(text)) {

            scope.buf = scope.buf.slice(0, start);

            return;
        }

        if (text === el.href) {
            return;
        }

        // X はリンクを t.co で包み、表示文字に本当のURLを出す。表示のほうを残す
        if (S.xMode && /^https?:\/\//i.test(text)) {
            return;
        }

        wrapInline(
            scope,
            start,
            '[',
            '](' + el.href + ')'
        );
    }


    // ============================================================
    // Markdown 変換：コード・リスト・表
    // ============================================================

    function preText(el) {

        if (S.range) {

            const walker =
                document.createTreeWalker(
                    el,
                    NodeFilter.SHOW_TEXT
                );

            let text = '';

            while (walker.nextNode()) {
                text += sliceByRange(walker.currentNode);
            }

            return text;
        }

        return (
            el.innerText ??
            el.textContent ??
            ''
        );
    }


    function renderPre(el, scope) {

        const text =
            preText(el).replace(/\n+$/, '');

        if (!text.trim()) {
            return;
        }

        const match =
            (
                classOf(el) +
                ' ' +
                (el.querySelector('code')
                    ? classOf(el.querySelector('code'))
                    : '')
            ).match(/(?:language|lang)-([\w+#-]+)/);

        const lang = match ? match[1] : '';

        const fence =
            text.includes('```') ? '````' : '```';

        pushBlock(
            scope,
            fence + lang + '\n' + text + '\n' + fence
        );
    }


    function renderList(el, scope, forced) {

        flush(scope);

        const ordered = el.tagName === 'OL';

        let index =
            ordered
                ? (parseInt(el.getAttribute('start'), 10) || 1)
                : 0;

        const items = [];

        for (const child of el.children) {

            if (child.tagName !== 'LI') {

                walk(child, scope, forced);

                continue;
            }

            const passed = gate(child, forced);

            if (!passed) {
                continue;
            }

            const text =
                subBlocks(child, passed.forced).join('\n');

            if (!text) {
                continue;
            }

            const marker =
                ordered
                    ? index + '. '
                    : '- ';

            index++;

            const indent =
                ' '.repeat(marker.length);

            items.push(
                marker +
                text.split('\n').join('\n' + indent)
            );
        }

        if (items.length) {
            scope.blocks.push(items.join('\n'));
        }
    }


    /*
     * データ表だけ Markdown の表にする。
     * レイアウト用の表（入れ子・1列・1行・中にリストや見出し）は false を返す
     */
    function renderTable(table, scope, forced) {

        const rows = [...table.rows];

        const maxCols =
            Math.max(
                0,
                ...rows.map(row => row.cells.length)
            );

        if (
            rows.length < 2 ||
            maxCols < 2 ||
            table.querySelector('table table') ||
            table.querySelector(
                'td ul, td ol, td pre, td blockquote, td h1, td h2, td h3, td h4, td h5, td h6, ' +
                'th ul, th ol, th pre, th blockquote'
            )
        ) {
            return false;
        }


        flush(scope);

        const lines = [];

        for (const row of rows) {

            const passedRow = gate(row, forced);

            if (!passedRow) {
                continue;
            }

            const cells = [];

            for (const cell of row.cells) {

                const passedCell =
                    gate(cell, passedRow.forced);

                if (!passedCell) {
                    continue;
                }

                cells.push(
                    subBlocks(cell, passedCell.forced)
                        .join(' ')
                        .replace(/\s*\n\s*/g, ' ')
                        .replace(/\|/g, '\\|')
                        .trim()
                );

                const span =
                    Math.min(
                        (parseInt(cell.getAttribute('colspan'), 10) || 1),
                        20
                    );

                for (let i = 1; i < span; i++) {
                    cells.push('');
                }
            }

            if (!cells.some(Boolean)) {
                continue;
            }

            while (cells.length < maxCols) {
                cells.push('');
            }

            lines.push('| ' + cells.join(' | ') + ' |');

            if (lines.length === 1) {

                lines.push(
                    '| ' +
                    cells.map(() => '---').join(' | ') +
                    ' |'
                );
            }
        }

        if (lines.length < 3) {
            return lines.length === 0;
        }

        const caption =
            table.caption
                ? table.caption.textContent.trim()
                : '';

        if (caption) {
            scope.blocks.push(caption);
        }

        scope.blocks.push(lines.join('\n'));

        return true;
    }


    // ============================================================
    // X（旧Twitter）のポスト
    // ============================================================

    /*
     * 狙い方は「構造」。data-testid には頼らない。
     *   ポスト   : 中に <time datetime> を持つ article
     *   どのポスト: <time> を包むリンクの /status/<ID> が、URL の ID と一致するもの
     *   投稿者   : 「@ID」だけを文字にもつリンクと、同じ href で名前をもつリンク
     *   反応数   : /quotes /retweets などへのリンクと「N 件の表示」
     */

    const X_HOSTS = /(^|\.)(x|twitter)\.com$/i;

    // 絵文字だけの alt（X は絵文字を img にして alt に文字を入れる）
    const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Regional_Indicator}‍️⃣\s]+$/u;

    // 意味のない alt
    const GENERIC_ALT = /^(画像|写真|image|photo|embedded video|動画)$/i;

    const X_COUNT = '[\\d,.]+(?:万|億|[KkMm])?';

    const X_NUMBER_ONLY = new RegExp('^' + X_COUNT + '$');

    const X_VIEWS_LABEL = /^(件の表示|views?)$/i;

    const X_VIEWS_FULL = new RegExp('^(' + X_COUNT + ')\\s*(?:件の表示|views?)$', 'i');

    const X_STAT_LINK = new RegExp(
        '\\[(' + X_COUNT + ')\\s*(引用|リポスト|いいね|ブックマーク|件の返信|返信|Quotes?|Reposts?|Likes?|Bookmarks?|Repl(?:y|ies))[^\\]]*\\]\\([^)]*\\)',
        'gi'
    );


    function isXPage() {

        return X_HOSTS.test(location.hostname);
    }


    function currentStatusId() {

        const match =
            location.pathname.match(/\/status(?:es)?\/(\d+)/);

        return match ? match[1] : '';
    }


    function compactText(text) {

        return (text || '').replace(/\s+/g, '');
    }


    // 絵文字の img は alt を文字として拾う
    function plainWithAlt(el) {

        let text = '';

        for (const node of el.childNodes) {

            if (node.nodeType === Node.TEXT_NODE) {

                text += node.nodeValue;

            } else if (node.nodeType === Node.ELEMENT_NODE) {

                text += node.tagName.toLowerCase() === 'img'
                    ? (node.getAttribute('alt') || '')
                    : plainWithAlt(node);
            }
        }

        return text.replace(/\s+/g, ' ').trim();
    }


    function formatPostTime(iso) {

        const date = new Date(iso);

        if (!iso || Number.isNaN(date.getTime())) {
            return '';
        }

        const parts = {};

        for (const part of new Intl.DateTimeFormat(
            'ja-JP',
            {
                timeZone: 'Asia/Tokyo',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hourCycle: 'h23'
            }
        ).formatToParts(date)) {
            parts[part.type] = part.value;
        }

        return (
            parts.year + '-' + parts.month + '-' + parts.day +
            ' ' + parts.hour + ':' + parts.minute
        );
    }


    // ポスト本体の <time>（引用ポストの時刻は後に出るので、先頭を取る）
    function postTimeElement(article) {

        return article.querySelector('time[datetime]');
    }


    function postStatusId(article) {

        const time = postTimeElement(article);
        const link = time && time.closest('a');
        const match =
            link &&
            (link.getAttribute('href') || '').match(/\/status(?:es)?\/(\d+)/);

        return match ? match[1] : '';
    }


    function findXPosts() {

        const id = currentStatusId();

        if (!id) {
            return null;
        }

        const posts =
            Array.from(document.querySelectorAll('article'))
                .filter(article =>
                    !article.parentElement.closest('article') &&
                    postTimeElement(article) &&
                    isRenderedSafe(article)
                );

        const focal =
            posts.find(article => postStatusId(article) === id);

        // 見つからない（読み込み前など）ときは、通常の本文判定に任せる
        if (!focal) {
            return null;
        }

        return {
            focal,
            posts: INCLUDE_X_REPLIES ? posts : [focal]
        };
    }


    // 投稿者の名前・ID・日時と、本文から外す要素を調べる
    function readPostMeta(article) {

        const skip = new Set();
        const links = Array.from(article.querySelectorAll('a[href^="/"]'));

        const handleLink =
            links.find(a => /^@\w{1,15}$/.test(a.textContent.trim()));

        const handle =
            handleLink ? handleLink.textContent.trim().slice(1) : '';

        const href =
            handleLink ? handleLink.getAttribute('href') : '';

        const nameLink =
            handleLink &&
            links.find(a =>
                a !== handleLink &&
                a.getAttribute('href') === href &&
                a.textContent.trim() &&
                !a.textContent.trim().startsWith('@')
            );

        const name = nameLink ? plainWithAlt(nameLink) : '';

        const timeEl = postTimeElement(article);
        const timeText = timeEl ? timeEl.textContent : '';
        const timeLink = timeEl && timeEl.closest('a');

        if (timeLink && article.contains(timeLink)) {
            skip.add(timeLink);
        } else if (timeEl) {
            skip.add(timeEl);
        }

        // 名前・@ID・「·」・日時だけを含む、いちばん外側の塊を外す
        if (nameLink) {

            const rest = el =>
                compactText(el.textContent)
                    .split(compactText(nameLink.textContent)).join('')
                    .split('@' + handle).join('')
                    .split('·').join('')
                    .split(compactText(timeText)).join('');

            let block = nameLink;

            while (
                block.parentElement &&
                block.parentElement !== article &&
                rest(block.parentElement) === ''
            ) {
                block = block.parentElement;
            }

            skip.add(block);
            skip.add(handleLink);
        }

        return {
            name,
            handle,
            time: formatPostTime(timeEl && timeEl.getAttribute('datetime')),
            skip
        };
    }


    /*
     * 「·」だけの行・数字だけの行・反応数のリンクを本文から外し、
     * 反応数は1行にまとめる
     */
    function tidyXBlocks(blocks) {

        const stats = [];
        const out = [];

        for (let i = 0; i < blocks.length; i++) {

            const block = blocks[i];
            const next = blocks[i + 1];

            if (block === '·') {
                continue;
            }

            if (
                X_NUMBER_ONLY.test(block) &&
                next &&
                X_VIEWS_LABEL.test(next)
            ) {

                stats.push('表示 ' + block);
                i++;

                continue;
            }

            const views = block.match(X_VIEWS_FULL);

            if (views) {
                stats.push('表示 ' + views[1]);
                continue;
            }

            const found = [];

            const remainder =
                block.replace(
                    X_STAT_LINK,
                    (all, count, label) => {
                        found.push(label + ' ' + count);
                        return '';
                    }
                );

            if (found.length && remainder.trim() === '') {
                stats.push(...found);
                continue;
            }

            out.push(block);
        }

        // 数字だけの行（ラベルの無い反応数）は、ほかに本文があるときだけ外す
        const body =
            out.length > 1
                ? out.filter(block => !X_NUMBER_ONLY.test(block))
                : out;

        return { body, stats };
    }


    function convertXPost(article) {

        const meta = readPostMeta(article);

        S.root = article;
        S.skip = meta.skip;

        record('含めた', 'X のポスト（URL の status ID と一致）', article);

        const scope = newScope();

        walk(article, scope, false);

        flush(scope);

        const tidy = tidyXBlocks(scope.blocks);

        if (INCLUDE_X_STATS && tidy.stats.length) {
            tidy.body.push('反応: ' + tidy.stats.join(' / '));
        }

        return {
            meta,
            text: tidy.body.join('\n\n')
        };
    }


    function postLabel(meta) {

        if (!meta.name && !meta.handle) {
            return '';
        }

        return (
            (meta.name || meta.handle) +
            (meta.name && meta.handle ? ' (@' + meta.handle + ')' : '')
        );
    }


    // ============================================================
    // 抽出（本体）
    // ============================================================

    function getTitle() {

        return (
            document.title ||
            location.hostname
        ).trim();
    }


    function isSameAsTitle(text) {

        const title = getTitle();

        return (
            text === title ||
            title.includes(text)
        );
    }


    function formatNow() {

        return new Intl.DateTimeFormat(
            'ja-JP',
            {
                timeZone: 'Asia/Tokyo',
                year: 'numeric',
                month: 'numeric',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            }
        ).format(new Date());
    }


    function convertRoot(root) {

        const scope = newScope();

        walk(root, scope, false);

        flush(scope);

        return scope.blocks.join('\n\n');
    }


    function extract(options = {}) {

        S = {
            images: [],
            recording: Boolean(options.record),
            log: [],
            range: null,
            root: null,
            titleDropped: false,
            xMode: false,
            skip: null,
            headingShift: 0
        };

        let parts = [];
        let method = '';
        let rootDescription = '';
        let xHeader = null;
        let xTitle = '';

        try {

            const ranges = getSelectionRanges();
            const xFound =
                !ranges.length && isXPage()
                    ? findXPosts()
                    : null;

            if (ranges.length) {

                method = '選択範囲';

                for (const range of ranges) {

                    S.range = range;
                    S.root = rangeRoot(range);

                    rootDescription = describe(S.root);

                    parts.push(convertRoot(S.root));
                }

            } else if (xFound) {

                method = 'X のポスト';

                S.xMode = true;

                // 複数のポストを並べるときは、各ポストの見出しが ## になる
                S.headingShift = xFound.posts.length > 1 ? 2 : 1;

                rootDescription = describe(xFound.focal);

                for (const post of xFound.posts) {

                    const converted = convertXPost(post);

                    if (post === xFound.focal) {

                        xHeader = converted.meta;

                        const label = postLabel(converted.meta);
                        const lead =
                            converted.text.split('\n')[0].slice(0, 40);

                        xTitle =
                            (label ? label + ' ' : '') + lead;
                    }

                    if (xFound.posts.length > 1) {

                        const label = postLabel(converted.meta);

                        parts.push(
                            '## ' +
                            (label || 'ポスト') +
                            (converted.meta.time ? ' · ' + converted.meta.time : '') +
                            '\n\n' +
                            converted.text
                        );

                    } else {

                        parts.push(converted.text);
                    }
                }

            } else {

                const found = findBodyRoot();

                method = found.method;

                S.root = found.root;

                rootDescription = describe(found.root);

                parts.push(convertRoot(found.root));
            }

            const body =
                parts
                    .filter(Boolean)
                    .join('\n\n')
                    .replace(/\n{3,}/g, '\n\n')
                    .trim();

            // X では、タイトルが投稿全文になるので見出しに使わない
            const headline =
                xHeader && postLabel(xHeader)
                    ? postLabel(xHeader) + ' のポスト'
                    : getTitle();

            const header = [
                '# ' + headline,
                '',
                '- URL: ' + location.href,
                ...(xHeader && xHeader.time ? ['- 投稿日時: ' + xHeader.time] : []),
                '- 取得日時: ' + formatNow(),
                '',
                '---',
                ''
            ].join('\n');

            const text =
                body
                    ? header + '\n' + body + '\n'
                    : '';

            return {
                text,
                chars: body.length,
                method,
                rootDescription,
                title: xTitle,
                // 本文に残った画像だけを渡す（空の本文なら画像も送らない）
                images: body ? S.images.slice() : [],
                log: S.log
            };

        } finally {

            S = null;
        }
    }


    // ============================================================
    // クリップボード
    // ============================================================

    function legacyCopy(text) {

        const area =
            document.createElement('textarea');

        area.value = text;

        Object.assign(
            area.style,
            {
                position: 'fixed',
                top: '0',
                left: '0',
                opacity: '0'
            }
        );

        document.body.appendChild(area);

        area.select();

        let ok = false;

        try {

            ok = document.execCommand('copy');

        } catch (error) {

            ok = false;
        }

        area.remove();

        return ok;
    }


    async function writeClipboard(text) {

        try {

            await navigator.clipboard.writeText(text);

            return true;

        } catch (error) {

            return legacyCopy(text);
        }
    }


    // ============================================================
    // UI（Shadow DOM。サイトのCSSに影響されない）
    // ============================================================

    let hostEl = null;
    let toastEl = null;


    // ------------------------------------------------------------
    // 位置
    // ------------------------------------------------------------

    /*
     * 画面の外へ出ないように収める
     */
    function clampPosition(left, top) {

        const maxLeft =
            Math.max(
                EDGE_MARGIN,
                window.innerWidth - BUTTON_SIZE - EDGE_MARGIN
            );

        const maxTop =
            Math.max(
                EDGE_MARGIN,
                window.innerHeight - BUTTON_SIZE - EDGE_MARGIN
            );

        return {
            left:
                Math.min(Math.max(left, EDGE_MARGIN), maxLeft),

            top:
                Math.min(Math.max(top, EDGE_MARGIN), maxTop)
        };
    }


    function applyPosition(left, top) {

        const position =
            clampPosition(left, top);

        hostEl.style.left = position.left + 'px';
        hostEl.style.top = position.top + 'px';
    }


    /*
     * 保存は画面に対する割合で持つ。
     * 縦横の回転や画面サイズの変化があっても、画面内に収まる
     */
    function readSavedPosition() {

        try {

            const raw =
                localStorage.getItem(POSITION_KEY);

            if (!raw) {
                return null;
            }

            const value = JSON.parse(raw);

            if (
                typeof value.x === 'number' &&
                typeof value.y === 'number'
            ) {
                return value;
            }

        } catch (error) {

            // 保存できない環境では初期位置に戻るだけ
        }

        return null;
    }


    function savePosition() {

        const rect =
            hostEl.getBoundingClientRect();

        const value = {
            x:
                rect.left /
                Math.max(1, window.innerWidth - BUTTON_SIZE),

            y:
                rect.top /
                Math.max(1, window.innerHeight - BUTTON_SIZE)
        };

        try {

            localStorage.setItem(
                POSITION_KEY,
                JSON.stringify(value)
            );

        } catch (error) {

            // 保存できなくても動作には影響しない
        }
    }


    function placeButton() {

        if (!hostEl) {
            return;
        }

        const saved = readSavedPosition();

        if (saved) {

            applyPosition(
                saved.x * (window.innerWidth - BUTTON_SIZE),
                saved.y * (window.innerHeight - BUTTON_SIZE)
            );

            return;
        }

        applyPosition(
            window.innerWidth * INITIAL_X_RATIO - BUTTON_SIZE / 2,
            INITIAL_TOP
        );
    }


    // ------------------------------------------------------------
    // トースト
    // ------------------------------------------------------------

    /*
     * ボタンが画面の上半分にあれば下へ、下半分にあれば上へ出す。
     * 横は、余白の広いほうへ伸ばす。どの位置でも画面内に収まる
     */
    function placeToast() {

        const rect =
            hostEl.getBoundingClientRect();

        const below =
            rect.top + BUTTON_SIZE / 2 <
            window.innerHeight / 2;

        const extendRight =
            rect.left + BUTTON_SIZE / 2 <
            window.innerWidth / 2;

        const room =
            extendRight
                ? window.innerWidth - rect.left - EDGE_MARGIN
                : rect.right - EDGE_MARGIN;

        Object.assign(
            toastEl.style,
            {
                top:
                    below ? (BUTTON_SIZE + 8) + 'px' : 'auto',

                bottom:
                    below ? 'auto' : (BUTTON_SIZE + 8) + 'px',

                left:
                    extendRight ? '0' : 'auto',

                right:
                    extendRight ? 'auto' : '0',

                maxWidth:
                    Math.max(120, Math.min(320, room)) + 'px'
            }
        );
    }


    function showToast(message, isError = false) {

        if (!toastEl) {
            return;
        }

        toastEl.textContent = message;

        placeToast();

        Object.assign(
            toastEl.style,
            {
                background:
                    isError ? '#b3261e' : '#1f2933',

                opacity: '1'
            }
        );

        clearTimeout(toastTimer);

        toastTimer =
            setTimeout(
                () => {
                    toastEl.style.opacity = '0';
                },
                TOAST_MS
            );
    }


    // ------------------------------------------------------------
    // コピー
    // ------------------------------------------------------------

    // ============================================================
    // Google Drive 保存（操作したときだけ送信）
    // ============================================================

    let saving = false;
    let lastUpload = null;

    function createRequestId() {

        // HTTPページでも利用できるgetRandomValuesでUUIDを生成する
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

        return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) +
            '-' + hex.slice(16, 20) + '-' + hex.slice(20);
    }

    /*
     * 対になっていないサロゲート（途中で切れた絵文字の片割れ）を U+FFFD にそろえる。
     * そのまま送ると、Drive に書いた時点で別の文字に置き換わり、
     * 送り直したときに「同じIDで中身が違う」と受け口に断られる
     */
    function toWellFormed(text) {

        // 後ろ読みは古いSafariで構文エラーになるので使わない。
        // 正しい組は2文字のまま残し、1文字だけで現れた片割れを置き換える
        return String(text).replace(
            /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g,
            pair => pair.length === 2 ? pair : '\uFFFD'
        );
    }


    function readDriveConfig() {

        if (typeof GM_getValue !== 'function') {
            return null;
        }

        const config = GM_getValue(DRIVE_CONFIG_KEY, null);

        return config && typeof config === 'object' ? config : null;
    }


    function isReceiverUrl(url) {

        return /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url);
    }


    function configureDrive() {

        const current = readDriveConfig() || {};
        const url = prompt(
            'Drive保存先のGASウェブアプリURL（/exec）を入力。空欄にすると保存を停止します。',
            current.url || ''
        );

        if (url === null) {
            return;
        }

        if (!url.trim()) {
            GM_setValue(DRIVE_CONFIG_KEY, null);
            showToast('Drive保存を停止しました（コピーは使えます）');
            return;
        }

        if (!isReceiverUrl(url.trim())) {
            showToast('GASの /exec URLを入力してください', true);
            return;
        }

        const token = prompt('GASのsetupで発行したトークンを入力', '');

        if (token === null) {
            return;
        }

        if (!/^[a-f0-9]{64}$/.test(token.trim())) {
            showToast('トークンは64文字の英数字です。setupのログからコピーしてください', true);
            return;
        }

        GM_setValue(DRIVE_CONFIG_KEY, { url: url.trim(), token: token.trim() });
        showToast('Drive保存を設定しました。次のコピーから保存します');
    }


    /*
     * 同じ内容の再送では同じID・日時を使う。
     * GAS はID・日時からファイル名を決めるので、応答が失われて送り直しても重複しない
     */
    function prepareUpload(result) {

        if (!lastUpload || lastUpload.markdown !== result.text) {
            lastUpload = {
                requestId: createRequestId(),
                capturedAt: new Date().toISOString(),
                title: (result.title || getTitle()).slice(0, 300),
                url: location.href,
                markdown: result.text,
                images: Array.isArray(result.images) ? result.images : []
            };
        }

        return lastUpload;
    }


    function sendToDrive(config, upload) {

        if (!isReceiverUrl(config.url) || !/^[a-f0-9]{64}$/.test(config.token || '')) {
            return Promise.reject(new Error('Drive保存の設定をやり直してください'));
        }

        if (upload.markdown.length > DRIVE_MAX_CHARS) {
            return Promise.reject(new Error('本文が保存上限（50万文字）を超えています'));
        }

        // 控えの管理用の項目は送らない
        const payload = {
            requestId: upload.requestId,
            capturedAt: upload.capturedAt,
            title: toWellFormed(upload.title),
            url: upload.url,
            markdown: toWellFormed(upload.markdown),
            token: config.token
        };

        // 画像があるときだけ一覧を付ける（v1.5.0 以前の控えには無い）
        const images =
            Array.isArray(upload.images)
                ? upload.images.slice(0, IMAGE_MAX).map(image => ({
                    n: image.n,
                    url: image.url,
                    alt: toWellFormed(image.alt || '')
                }))
                : [];

        if (images.length) {
            payload.images = images;
        }

        return new Promise((resolve, reject) => {

            GM_xmlhttpRequest({
                method: 'POST',
                url: config.url,
                anonymous: true,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify(payload),
                timeout: images.length ? DRIVE_IMAGE_TIMEOUT_MS : DRIVE_TIMEOUT_MS,
                onload(response) {

                    let data = null;

                    try {
                        data = JSON.parse(response.responseText);
                    } catch (error) {
                        data = null;
                    }

                    const answered =
                        response.status >= 200 &&
                        response.status < 300 &&
                        data &&
                        typeof data === 'object';

                    if (answered && data.ok && data.fileId) {
                        resolve(data);
                        return;
                    }

                    // 受け口が答えたうえで断った。理由は受け口の文言をそのまま出す
                    if (answered && data.ok === false && typeof data.message === 'string') {
                        reject(classifyRejection(data.message));
                        return;
                    }

                    reject(new Error('Drive保存を確認できません。URL・公開設定・トークンを確認してください'));
                },
                onerror: () => reject(new Error('通信に失敗しました')),
                ontimeout: () => reject(new Error('保存の応答がありません。フォルダを確認してください')),
                onabort: () => reject(new Error('保存の通信が中断されました'))
            });
        });
    }


    // 受け口が返した画像の保存結果を、トーストに添える一言にする
    function describeSavedImages(data) {

        const images = data && data.images;

        if (!images || typeof images !== 'object') {
            return '';
        }

        const saved = Number(images.saved) || 0;
        const failed = Number(images.failed) || 0;

        if (!saved && !failed) {
            return '';
        }

        return '（画像' + saved + '枚' + (failed ? '、保存できなかった画像' + failed + '枚' : '') + '）';
    }


    /*
     * 受け口（page-markdown-receiver.gs）の断り方を3つに分ける。
     * - duplicateId: 同じ送信IDで別の中身が保存済み。新しいIDを付ければ保存できる
     * - rejected:    中身が受け付けられない。何度送っても同じなので、自動では送り直さない
     * - それ以外:    混雑・一時的な失敗・トークン違い。待って送り直す
     */
    function classifyRejection(message) {

        const error = new Error(message.slice(0, 200) || 'Drive保存に失敗しました');

        if (/送信IDが重複/.test(message)) {
            error.duplicateId = true;
        } else if (/不正/.test(message)) {
            error.rejected = true;
        }

        return error;
    }


    // ============================================================
    // 届かなかった保存の控えと再送
    // ============================================================

    let retrying = false;
    let retryTimer = null;
    let badgeEl = null;


    function canKeepPending() {

        return (
            typeof GM_getValue === 'function' &&
            typeof GM_setValue === 'function' &&
            typeof GM_listValues === 'function' &&
            typeof GM_deleteValue === 'function'
        );
    }


    function readPending(requestId) {

        const record = GM_getValue(PENDING_PREFIX + requestId, null);

        if (
            !record ||
            typeof record !== 'object' ||
            typeof record.requestId !== 'string' ||
            typeof record.markdown !== 'string'
        ) {
            return null;
        }

        return record;
    }


    function writePending(record) {

        GM_setValue(PENDING_PREFIX + record.requestId, record);
    }


    function removePending(requestId) {

        if (canKeepPending()) {
            GM_deleteValue(PENDING_PREFIX + requestId);
        }
    }


    // 古い順
    function listPending() {

        if (!canKeepPending()) {
            return [];
        }

        return GM_listValues()
            .filter(key => key.startsWith(PENDING_PREFIX))
            .map(key => readPending(key.slice(PENDING_PREFIX.length)))
            .filter(Boolean)
            .sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt)));
    }


    /*
     * 送る前に控える。届いたと確認できたら消す。
     * 送信中にページを離れても、控えが残っていれば別のページで送り直せる
     */
    function keepPending(upload) {

        if (!canKeepPending()) {
            return false;
        }

        const existing = readPending(upload.requestId);

        if (!existing && listPending().length >= PENDING_MAX) {
            return false;
        }

        writePending({
            ...upload,
            attempts: existing ? existing.attempts + 1 : 1,
            lastTriedAt: Date.now(),
            lastError: ''
        });

        return true;
    }


    function markPendingFailed(requestId, message, rejected = false) {

        const record = canKeepPending() ? readPending(requestId) : null;

        // 送信中に他のタブで保存済み・削除済みになっていたら書き戻さない
        if (record) {
            writePending({ ...record, lastError: message, rejected: Boolean(rejected) });
        }
    }


    /*
     * 「同じIDで別の中身」と断られた控えに、新しいIDを付け直す。
     * 中身は失わず、Drive には別のファイルとして保存される
     */
    function reissuePending(record) {

        const fresh = {
            ...record,
            requestId: createRequestId(),
            attempts: 1,
            lastTriedAt: Date.now(),
            lastError: '',
            rejected: false
        };

        if (canKeepPending()) {
            writePending(fresh);
            removePending(record.requestId);
        }

        // 同じ内容をもう一度押したときも、新しいIDで送る
        if (lastUpload && lastUpload.requestId === record.requestId) {
            lastUpload = { ...lastUpload, requestId: fresh.requestId };
        }

        return fresh;
    }


    function retryDelay(record) {

        const index =
            Math.min(
                Math.max(0, (record.attempts || 1) - 1),
                RETRY_DELAYS_MS.length - 1
            );

        return RETRY_DELAYS_MS[index];
    }


    function updateBadge(count = listPending().length) {

        if (!badgeEl) {
            return;
        }

        badgeEl.textContent = count > 99 ? '99+' : String(count);
        badgeEl.style.display = count ? 'block' : 'none';
    }


    /*
     * 控えを送り直す。all が false なら、待ち時間を過ぎたものだけ。
     * 受け付けられないと断られた控えは、includeRejected（メニューの手動送り直し）のときだけ送る。
     * 1件でも通信に失敗したら、残りもつながらない見込みが高いので止める
     */
    async function retryPending(options = {}) {

        const config = readDriveConfig();

        if (retrying || !config) {
            return null;
        }

        retrying = true;

        let saved = 0;
        let lastError = '';
        let rejectedNow = 0;

        try {

            for (const item of listPending()) {

                // 他のタブが先に送った・試した場合に備えて読み直す
                const record = readPending(item.requestId);

                if (!record) {
                    continue;
                }

                if (record.rejected && !options.includeRejected) {
                    continue;
                }

                if (
                    !options.all &&
                    Date.now() - (record.lastTriedAt || 0) < retryDelay(record)
                ) {
                    continue;
                }

                // 試したことを先に書き、他のタブが同時に送らないようにする
                const claimed = {
                    ...record,
                    attempts: (record.attempts || 1) + 1,
                    lastTriedAt: Date.now()
                };

                writePending(claimed);

                try {

                    await sendToDrive(config, claimed);

                    removePending(claimed.requestId);

                    saved++;

                } catch (error) {

                    lastError = error.message || '保存に失敗しました';

                    if (error.duplicateId) {

                        const outcome = await sendReissued(config, claimed);

                        if (outcome.saved) {
                            saved++;
                            continue;
                        }

                        lastError = outcome.error.message || '保存に失敗しました';

                        if (outcome.error.rejected || outcome.error.duplicateId) {
                            rejectedNow++;
                            continue;
                        }

                        break;
                    }

                    if (error.rejected) {

                        markPendingFailed(claimed.requestId, lastError, true);

                        rejectedNow++;

                        // 中身の問題なので、ほかの控えは送ってみる
                        continue;
                    }

                    markPendingFailed(claimed.requestId, lastError);

                    break;
                }
            }

        } finally {

            retrying = false;

            scheduleRetry();
        }

        return {
            saved,
            left: listPending().length,
            lastError,
            rejectedNow
        };
    }


    // 新しいIDを付け直して1回だけ送る
    async function sendReissued(config, record) {

        const fresh = reissuePending(record);

        try {

            await sendToDrive(config, fresh);

            removePending(fresh.requestId);

            return { saved: true };

        } catch (error) {

            markPendingFailed(
                fresh.requestId,
                error.message || '保存に失敗しました',
                Boolean(error.rejected || error.duplicateId)
            );

            return { saved: false, error };
        }
    }


    function reportRetry(report, manual) {

        if (!report) {
            return;
        }

        // 受け付けられない控えは自動では送らなくなるので、理由と消し方を一度だけ出す
        if (report.rejectedNow) {
            showToast(
                (report.saved ? '未保存だった' + report.saved + '件を保存しました。' : '') +
                '保存できない控えが' + report.rejectedNow + '件あります: ' + report.lastError +
                '（メニュー「未保存の控えを削除」で消せます）',
                true
            );
            return;
        }

        if (report.saved && !report.left) {
            showToast('未保存だった' + report.saved + '件をDriveに保存しました');
            return;
        }

        if (report.saved) {
            showToast(
                '未保存だった' + report.saved + '件を保存しました。残り' +
                report.left + '件: ' + report.lastError,
                true
            );
            return;
        }

        // 自動の再送で何も進まなかったときは黙る（件数はボタンに出ている）
        if (manual) {
            showToast(
                report.lastError
                    ? '送り直せませんでした: ' + report.lastError
                    : '送り直す控えはありませんでした',
                Boolean(report.lastError)
            );
        }
    }


    /*
     * いちばん早く送り直せる時刻にタイマーを置く。
     * iPhone は裏に回るとタイマーが止まるので、表に戻ったときにも呼ぶ
     */
    function scheduleRetry() {

        clearTimeout(retryTimer);

        const records = listPending();

        updateBadge(records.length);

        // 受け付けられないと断られた控えは、自動では送り直さない
        const retriable = records.filter(record => !record.rejected);

        if (!retriable.length || !readDriveConfig()) {
            return;
        }

        const now = Date.now();

        const wait =
            Math.min(
                ...retriable.map(record =>
                    Math.max(0, (record.lastTriedAt || 0) + retryDelay(record) - now)
                )
            );

        retryTimer =
            setTimeout(
                () => {
                    retryPending().then(report => reportRetry(report, false));
                },
                wait + 500
            );
    }


    function describePending(records) {

        const lines =
            records
                .slice(0, PENDING_LIST_LIMIT)
                .map((record, index) =>
                    (index + 1) + '. ' + (record.title || 'タイトル不明') +
                    '\n   ' + record.url +
                    (record.lastError
                        ? '\n   理由: ' + record.lastError + (record.rejected ? '（自動では送り直しません）' : '')
                        : '')
                );

        if (records.length > PENDING_LIST_LIMIT) {
            lines.push('ほか' + (records.length - PENDING_LIST_LIMIT) + '件');
        }

        return lines.join('\n');
    }


    async function retryFromMenu() {

        const records = listPending();

        if (!records.length) {
            showToast('未保存はありません');
            return;
        }

        if (!readDriveConfig()) {
            showToast('Drive保存が未設定です。先に「Drive保存を設定／停止」から設定してください', true);
            return;
        }

        const ok = confirm(
            '未保存 ' + records.length + '件\n\n' +
            describePending(records) +
            '\n\n今すぐDriveへ送り直しますか？'
        );

        if (!ok) {
            return;
        }

        showToast('未保存を送り直しています…');

        const report = await retryPending({ all: true, includeRejected: true });

        if (!report) {
            showToast('送り直しの途中です。少し待ってからもう一度どうぞ');
            return;
        }

        reportRetry(report, true);
    }


    function discardFromMenu() {

        const records = listPending();

        if (!records.length) {
            showToast('未保存はありません');
            return;
        }

        const ok = confirm(
            '未保存 ' + records.length + '件\n\n' +
            describePending(records) +
            '\n\nこの控えを削除しますか？ 削除するとDriveには保存されません。'
        );

        if (!ok) {
            return;
        }

        for (const record of records) {
            removePending(record.requestId);
        }

        scheduleRetry();

        showToast('未保存の控えを' + records.length + '件削除しました');
    }


    async function copyPage() {

        if (saving) {
            showToast('Driveへ保存中です');
            return;
        }

        let result;

        try {

            result = extract();

        } catch (error) {

            console.error('[ページ本文コピー] 抽出に失敗:', error);

            showToast('本文の抽出に失敗しました（コンソール参照）', true);

            return;
        }

        lastResult = result;

        if (!result.text) {

            showToast('コピーする本文が見つかりませんでした', true);

            return;
        }

        // ユーザー操作の直後にコピーを開始する（iOSの権限判定対策）
        const copying = writeClipboard(result.text);
        const config = readDriveConfig();

        if (config) {

            saving = true;

            let settled = false;

            const upload = prepareUpload(result);

            // 上限を超えた本文は控えても送れないので、控えない
            const kept =
                upload.markdown.length <= DRIVE_MAX_CHARS &&
                keepPending(upload);

            updateBadge();

            showToast(kept
                ? 'Driveへ送信中…（控えたので移動して大丈夫です）'
                : 'Driveへ送信中…');

            // コピーの結果はDriveの応答を待たずに出す
            copying.then(ok => {

                if (settled) {
                    return;
                }

                showToast(
                    ok
                        ? 'コピーしました。Driveへ送信中…' + (kept ? '（移動して大丈夫です）' : '')
                        : 'コピーに失敗しました。Driveへ送信中…',
                    !ok
                );
            });

            try {
                const [copied, stored] = await Promise.allSettled([
                    copying,
                    sendToDrive(config, upload)
                ]);
                const copyOk = copied.status === 'fulfilled' && copied.value;
                const driveOk = stored.status === 'fulfilled';

                settled = true;

                if (driveOk) {
                    removePending(upload.requestId);

                    const imageNote = describeSavedImages(stored.value);

                    showToast((copyOk
                        ? 'Driveに保存し、コピーしました'
                        : 'Driveに保存しました。コピーは失敗しました') + imageNote, !copyOk);
                } else if (stored.reason.duplicateId) {

                    // 同じIDで別の中身が保存済み。新しいIDで送り直す
                    const outcome =
                        kept
                            ? await sendReissued(config, readPending(upload.requestId) || upload)
                            : { saved: false, error: stored.reason };

                    if (!kept) {
                        lastUpload = null;
                    }

                    showToast(
                        outcome.saved
                            ? (copyOk ? 'Driveに保存し、コピーしました' : 'Driveに保存しました。コピーは失敗しました')
                            : (copyOk ? 'コピー済み。' : 'コピーも失敗。') + (outcome.error.message || '保存に失敗しました'),
                        !outcome.saved || !copyOk
                    );
                } else {
                    const reason = stored.reason.message || '保存に失敗しました';
                    const rejected = Boolean(stored.reason.rejected);

                    if (kept) {
                        markPendingFailed(upload.requestId, reason, rejected);
                    }

                    showToast(
                        (copyOk ? 'コピー済み。' : 'コピーも失敗。') + reason +
                        (kept
                            ? (rejected
                                ? '（受け付けられない内容なので、自動では送り直しません）'
                                : '（控えたので、あとで自動で送り直します）')
                            : ''),
                        true
                    );
                }

                // つながっているうちに、前に届かなかった分もまとめて送る
                if (driveOk && listPending().some(record => !record.rejected)) {
                    retryPending({ all: true }).then(report => reportRetry(report, false));
                }
            } finally {
                saving = false;
                scheduleRetry();
            }

            return;
        }

        const ok = await copying;

        if (!ok) {
            showToast('クリップボードへの書き込みに失敗しました', true);
            return;
        }

        const label =
            result.method === '選択範囲'
                ? '選択範囲'
                : '本文';

        let message =
            result.chars.toLocaleString() +
            '文字をコピーしました（' + label + '）';

        if (result.chars > WARN_CHARS) {
            message += ' ※長文です。AIの入力上限に注意';
        }

        showToast(message);
    }


    // ------------------------------------------------------------
    // ボタン（ドラッグで動かせる）
    // ------------------------------------------------------------

    function buildUi() {

        if (document.getElementById(HOST_ID)) {
            return;
        }

        hostEl = document.createElement('div');

        hostEl.id = HOST_ID;

        Object.assign(
            hostEl.style,
            {
                all: 'initial',
                position: 'fixed',
                width: BUTTON_SIZE + 'px',
                height: BUTTON_SIZE + 'px',
                zIndex: '2147483647'
            }
        );

        const shadow =
            hostEl.attachShadow({ mode: 'open' });


        const button =
            document.createElement('button');

        button.type = 'button';

        button.textContent = '📋';

        button.title =
            '本文をコピー・設定済みならDrive保存（Alt+Shift+C）／ドラッグで移動';

        Object.assign(
            button.style,
            {
                width: BUTTON_SIZE + 'px',
                height: BUTTON_SIZE + 'px',
                border: 'none',
                borderRadius: '50%',
                background: '#1f2933',
                color: '#fff',
                fontSize: '18px',
                lineHeight: BUTTON_SIZE + 'px',
                padding: '0',
                cursor: 'grab',
                opacity: IDLE_OPACITY,
                boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
                transition: 'opacity 0.15s',

                // 指でドラッグしても、ページがスクロールしない
                touchAction: 'none',

                // 長押しで文字選択・メニューが出ない
                userSelect: 'none',
                webkitUserSelect: 'none',
                webkitTouchCallout: 'none'
            }
        );


        // ----------------------------------------------------------
        // ドラッグ
        // ----------------------------------------------------------

        let drag = null;

        // ドラッグの直後に click が来ても、コピーを走らせない
        let suppressClick = false;


        button.addEventListener(
            'pointerdown',
            event => {

                if (
                    event.pointerType === 'mouse' &&
                    event.button !== 0
                ) {
                    return;
                }

                suppressClick = false;

                const rect =
                    hostEl.getBoundingClientRect();

                drag = {
                    pointerId: event.pointerId,
                    startX: event.clientX,
                    startY: event.clientY,
                    originLeft: rect.left,
                    originTop: rect.top,
                    moved: false
                };

                try {
                    button.setPointerCapture(event.pointerId);
                } catch (error) {
                    // 取れなくても、ボタン上の動きは追える
                }
            }
        );


        button.addEventListener(
            'pointermove',
            event => {

                if (!drag || event.pointerId !== drag.pointerId) {
                    return;
                }

                const dx = event.clientX - drag.startX;
                const dy = event.clientY - drag.startY;

                if (
                    !drag.moved &&
                    Math.hypot(dx, dy) < DRAG_THRESHOLD
                ) {
                    return;
                }

                drag.moved = true;

                button.style.opacity = '1';

                applyPosition(
                    drag.originLeft + dx,
                    drag.originTop + dy
                );

                event.preventDefault();
            }
        );


        function endDrag(event) {

            if (!drag || event.pointerId !== drag.pointerId) {
                return;
            }

            const moved = drag.moved;

            drag = null;

            try {
                button.releasePointerCapture(event.pointerId);
            } catch (error) {
                // すでに解放済み
            }

            button.style.opacity = IDLE_OPACITY;

            if (moved) {

                suppressClick = true;

                savePosition();
            }
        }


        button.addEventListener('pointerup', endDrag);
        button.addEventListener('pointercancel', endDrag);


        button.addEventListener(
            'mouseenter',
            () => { button.style.opacity = '1'; }
        );

        button.addEventListener(
            'mouseleave',
            () => {

                if (!drag) {
                    button.style.opacity = IDLE_OPACITY;
                }
            }
        );

        // ボタンを押しても選択範囲が解除されないようにする
        button.addEventListener(
            'mousedown',
            event => event.preventDefault()
        );


        // キーボード操作・タップ・クリックはここでコピーする
        button.addEventListener(
            'click',
            () => {

                if (suppressClick) {

                    suppressClick = false;

                    return;
                }

                copyPage();
            }
        );


        // ----------------------------------------------------------
        // トースト
        // ----------------------------------------------------------

        toastEl = document.createElement('div');

        Object.assign(
            toastEl.style,
            {
                position: 'absolute',
                width: 'max-content',
                padding: '8px 12px',
                borderRadius: '8px',
                color: '#fff',
                font: '13px/1.5 sans-serif',
                opacity: '0',
                pointerEvents: 'none',
                transition: 'opacity 0.2s'
            }
        );

        // ----------------------------------------------------------
        // 未保存の件数（ボタン右上）
        // ----------------------------------------------------------

        badgeEl = document.createElement('div');

        badgeEl.title = '未保存の件数（メニュー「未保存を一覧・再送」で手動送信）';

        Object.assign(
            badgeEl.style,
            {
                position: 'absolute',
                top: '-4px',
                right: '-4px',
                minWidth: '16px',
                height: '16px',
                padding: '0 4px',
                boxSizing: 'border-box',
                borderRadius: '8px',
                background: '#b3261e',
                color: '#fff',
                font: 'bold 11px/16px sans-serif',
                textAlign: 'center',
                pointerEvents: 'none',
                display: 'none'
            }
        );

        shadow.append(toastEl, button, badgeEl);

        document.documentElement.appendChild(hostEl);

        placeButton();

        updateBadge();
    }


    // ============================================================
    // ショートカット・自己修復
    // ============================================================

    window.addEventListener(
        'keydown',
        event => {

            if (
                event.altKey &&
                event.shiftKey &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.isComposing &&
                event.code === HOTKEY_CODE
            ) {

                event.preventDefault();

                copyPage();
            }
        },
        true
    );


    // 画面サイズ・向きが変わっても、ボタンを画面内に収める
    window.addEventListener('resize', placeButton);


    /*
     * サイト側の再描画でボタンが消えたら作り直す
     * （documentElement 直下だけ見るので負荷は小さい）
     */
    new MutationObserver(() => {

        if (!document.getElementById(HOST_ID)) {
            buildUi();
        }

    }).observe(
        document.documentElement,
        { childList: true }
    );


    // ============================================================
    // 診断
    // ============================================================

    window.__tmCopyText = {

        // 実際にコピーせず、抽出結果だけ返す
        extract,

        copy: copyPage,

        // 含めた・除外した要素と理由を表で出す
        dump() {

            const result = extract({ record: true });

            console.log(
                '[ページ本文コピー]',
                '判定:', result.method,
                '/ 起点:', result.rootDescription,
                '/ 文字数:', result.chars
            );

            console.table(result.log);

            return result;
        },

        // 未保存の控えを表で出す（本文は長いので文字数だけ）
        pending() {

            const rows =
                listPending().map(record => ({
                    タイトル: record.title,
                    URL: record.url,
                    文字数: record.markdown.length,
                    試行回数: record.attempts,
                    最後に試した: new Date(record.lastTriedAt || 0).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
                    理由: record.lastError,
                    送信ID: record.requestId
                }));

            console.table(rows);

            return rows;
        },

        // 待ち時間を無視して、控えをすべて送り直す
        retry: () => retryPending({ all: true }),

        get last() {
            return lastResult;
        }
    };


    // ============================================================
    // 初回
    // ============================================================

    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('Drive保存を設定／停止', configureDrive);
        GM_registerMenuCommand('未保存を一覧・再送', retryFromMenu);
        GM_registerMenuCommand('未保存の控えを削除', discardFromMenu);
        GM_registerMenuCommand('本文抽出を診断', () => window.__tmCopyText.dump());
    }

    buildUi();

    // 前のページで届かなかった保存があれば、待ち時間のあとで送り直す
    scheduleRetry();

    // アプリに戻った・電波が戻ったときにも確かめる
    document.addEventListener(
        'visibilitychange',
        () => {

            if (document.visibilityState === 'visible') {
                scheduleRetry();
            }
        }
    );

    window.addEventListener(
        'online',
        () => {
            retryPending({ all: true }).then(report => reportRetry(report, false));
        }
    );

})();
