// ==UserScript==
// @name         ページ本文コピー v1.0.0
// @namespace    local.hiro.tools
// @version      1.0.0
// @description  表示中のページ本文（または選択範囲）をMarkdownにしてクリップボードへコピーする。AIに貼る用。
// @match        *://*/*
// @grant        none
// @run-at       document-idle
// @noframes
// @homepageURL  https://github.com/hirodiver/tampermonkey-scripts
// @supportURL   https://github.com/hirodiver/tampermonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/page-to-markdown.user.js
// @updateURL    https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/page-to-markdown.user.js
// ==/UserScript==

/*
 * 使い方
 *   - 右下のボタン、または Alt+Shift+C でコピー
 *   - 文字を選択していれば、選択範囲だけをコピー（周辺メニューの除外はしない）
 *   - 選択していなければ、本文を自動判定してコピー
 *
 * 外したとき
 *   - DevTools コンソールで window.__tmCopyText.dump() を実行すると、
 *     どの要素を含めた・除外したか、その理由が表で出る
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

    // リンクのURLを本文に残す（AIに渡すなら残したほうが情報量が多い）
    const INCLUDE_LINK_URL = true;

    // 折りたたみ（details・アコーディオン・非選択タブ）の中身を、開いた状態として含める
    const INCLUDE_COLLAPSED = true;

    // 画像は alt があるものだけ「[画像: alt]」として残す
    const INCLUDE_IMAGE_ALT = true;

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

        if (!S.range && el !== S.root) {

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

            const level = Number(tag[1]);

            // タイトルと同じ最初の h1 は、ヘッダに出すので重複させない
            if (
                level === 1 &&
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
            recording: Boolean(options.record),
            log: [],
            range: null,
            root: null,
            titleDropped: false
        };

        let parts = [];
        let method = '';
        let rootDescription = '';

        try {

            const ranges = getSelectionRanges();

            if (ranges.length) {

                method = '選択範囲';

                for (const range of ranges) {

                    S.range = range;
                    S.root = rangeRoot(range);

                    rootDescription = describe(S.root);

                    parts.push(convertRoot(S.root));
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

            const header = [
                '# ' + getTitle(),
                '',
                '- URL: ' + location.href,
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

    let toastEl = null;


    function showToast(message, isError = false) {

        if (!toastEl) {
            return;
        }

        toastEl.textContent = message;

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


    async function copyPage() {

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

        const ok =
            await writeClipboard(result.text);

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


    function buildUi() {

        if (document.getElementById(HOST_ID)) {
            return;
        }

        const host = document.createElement('div');

        host.id = HOST_ID;

        Object.assign(
            host.style,
            {
                all: 'initial',
                position: 'fixed',
                right: '16px',
                bottom: '16px',
                zIndex: '2147483647'
            }
        );

        const shadow =
            host.attachShadow({ mode: 'open' });


        const button =
            document.createElement('button');

        button.type = 'button';

        button.textContent = '📋';

        button.title =
            'ページ本文をMarkdownでコピー（Alt+Shift+C）';

        Object.assign(
            button.style,
            {
                width: '40px',
                height: '40px',
                border: 'none',
                borderRadius: '50%',
                background: '#1f2933',
                color: '#fff',
                fontSize: '18px',
                lineHeight: '40px',
                cursor: 'pointer',
                opacity: '0.35',
                boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
                transition: 'opacity 0.15s'
            }
        );

        button.addEventListener(
            'mouseenter',
            () => { button.style.opacity = '1'; }
        );

        button.addEventListener(
            'mouseleave',
            () => { button.style.opacity = '0.35'; }
        );

        // ボタンを押しても選択範囲が解除されないようにする
        button.addEventListener(
            'mousedown',
            event => event.preventDefault()
        );

        button.addEventListener('click', copyPage);


        toastEl = document.createElement('div');

        Object.assign(
            toastEl.style,
            {
                position: 'absolute',
                right: '0',
                bottom: '52px',
                maxWidth: '320px',
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

        shadow.append(toastEl, button);

        (document.documentElement).appendChild(host);
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

        get last() {
            return lastResult;
        }
    };


    // ============================================================
    // 初回
    // ============================================================

    buildUi();

})();
