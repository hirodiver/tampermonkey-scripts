// ==UserScript==
// @name         Google AI概要非表示 v1.0.0
// @namespace    local.hiro.tools
// @version      1.0.0
// @description  Google 検索の結果ページに出る「AI による概要」（AI Overview）を非表示にする
// @match        https://www.google.com/search*
// @match        https://www.google.co.jp/search*
// @run-at       document-start
// @noframes
// @homepageURL  https://github.com/hirodiver/tampermonkey-scripts
// @supportURL   https://github.com/hirodiver/tampermonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/google-hide-ai-overview.user.js
// @updateURL    https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/google-hide-ai-overview.user.js
// ==/UserScript==

/*
 * Google 検索の「AI による概要」を隠す。
 * Windows の Chrome と iPhone の Safari（Tampermonkey）の両方で動かす前提。
 *
 * 消し方は2段構え。
 *
 * 1. CSS（document-start で注入）
 *    AI による概要の本体には data-attnms 属性が付いている。
 *    これと、本体を包む入れ物（:has で判定）を最初から消す。
 *    描画された瞬間から消えるので、一瞬見えることがない。
 *    セレクタは保守されている uBlock Origin 用フィルタ
 *    （Stevo's AI Blocklist、2026-11 時点）を参照した。
 *
 * 2. JS（保険）
 *    Google が属性やクラス名を変えた場合に備え、
 *    「AI による概要」「AI Overview」という見出しの文字列を探し、
 *    そこから上へ、ほかの検索結果の見出しを含まない範囲まで遡って消す。
 *    構造で狙うので、クラス名が変わっても当たる。
 *
 * ■ 診断（iPhone でも使える）
 *   検索結果の URL の末尾に #tmaio を付けて開くと、画面下に診断パネルが出る。
 *   「コピー」を押すとレポートがクリップボードに入る。
 *   コンソールが使える環境なら __tmGoogleAio.dump() でも同じものが出る。
 */

(function () {
    'use strict';

    // ============================================================
    // 設定
    // ============================================================

    const VERSION = '1.0.0';

    /*
     * AI による概要の本体に付く目印。
     * 2つ目は話題の AI 生成概要（モバイルの一部の検索で出る）
     */
    const AI_MARKERS = [
        '[data-attnms]',
        '[data-attrid="VisualDigestGeneratedDescription"]'
    ];

    /*
     * CSS で消すもの。1行ずつ別のルールとして注入する
     * （1つが無効でも他を巻き込まないため）
     */
    const CSS_RULES = [

        // 本体
        '[data-attnms]',

        // 上部に出たときの入れ物（残すと空白になる）
        '.Kevs9.SLPe5b:has([data-attnms])',

        // 検索結果の途中に出たときの入れ物
        '.ULSxyf:has(> .MjjYud > .Wm5I1e.SePcAf[data-tma="80"] [data-attnms])',

        // 見出しのロゴ（パソコン）
        '#rcnt:has([data-attnms]) .Ws2DOe .Y2jOfb',

        // 見出しのロゴ（モバイル）
        '.MjjYud:has(+ .MjjYud [data-attnms]) [data-prvwid="HEADER"] > .Ws2DOe',

        // 話題の AI 生成概要（モバイル）
        '.iVzeVc:has([data-attrid="VisualDigestGeneratedDescription"])',
        '[data-attrid="VisualDigestGeneratedDescription"]',

        // JS が見つけて印を付けたもの
        '[data-tm-aio="hidden"]'
    ];

    /*
     * 見出しの文字列。前後の空白を除いて完全一致したものだけを見出しとみなす。
     * 「AI Overview とは」のような通常の検索結果は当たらない
     */
    const AI_LABEL_PATTERN =
        /^(AI\s*による概要|AI\s*Overviews?)$/i;

    // ほかの検索結果の見出し。これを含む範囲までは遡らない
    const HEADING_SELECTOR =
        'h1, h2, h3, h4, [role="heading"]';

    /*
     * ここより上へは遡らない（検索結果全体の入れ物）。
     * この直下の子までが消す範囲の上限
     */
    const STOP_SELECTORS = [
        'html',
        'body',
        '#main',
        '#rcnt',
        '#center_col',
        '#search',
        '#rso',
        '#botstuff',
        '[role="main"]'
    ];

    // 印に使う属性
    const MARK_ATTR = 'data-tm-aio';

    // 注入する <style> の id
    const STYLE_ID = 'tm-google-hide-aio-style';

    // DOM の変化から判定し直すまでの待ち時間（ミリ秒）
    const SCAN_DEBOUNCE_MS = 150;

    // 診断パネル
    const DIAGNOSTIC_HASH = 'tmaio';

    const PANEL_ID = 'tm-google-hide-aio-panel';

    // 診断パネルを開いている間の更新間隔（ミリ秒）
    const PANEL_REFRESH_MS = 1500;


    // ============================================================
    // 状態
    // ============================================================

    // いま印を付けている要素
    let marked = new Set();

    // 直近の判定結果（診断用）
    let lastFindings = [];

    let scanTimer = null;

    let panelTimer = null;


    // ============================================================
    // CSS
    // ============================================================

    function buildCss() {

        return CSS_RULES
            .map(rule => `${rule} {\n    display: none !important;\n}`)
            .join('\n\n') + '\n';
    }


    function ensureStyle() {

        if (document.getElementById(STYLE_ID)) {
            return;
        }


        const root =
            document.head ||
            document.documentElement;

        if (!root) {
            return;
        }


        const style =
            document.createElement('style');

        style.id = STYLE_ID;

        /*
         * innerHTML は Trusted Types で弾かれるため使わない
         */
        style.textContent = buildCss();


        root.appendChild(style);
    }


    // ============================================================
    // 判定: 小物
    // ============================================================

    function textOf(element) {

        return (element.textContent || '')
            .replace(/\s+/g, ' ')
            .trim();
    }


    function isAiLabel(text) {

        return AI_LABEL_PATTERN.test(
            text
                .replace(/\s+/g, ' ')
                .trim()
        );
    }


    function isStop(element) {

        return STOP_SELECTORS.some(selector => {

            try {

                return element.matches(selector);

            } catch {

                return false;
            }
        });
    }


    function isInsideAiMarker(element) {

        return AI_MARKERS.some(
            selector => element.closest(selector)
        );
    }


    function isInsidePanel(node) {

        const element =
            node.nodeType === Node.ELEMENT_NODE ?
                node :
                node.parentElement;

        return !!element?.closest(`#${PANEL_ID}`);
    }


    /*
     * parent の中に、current の外にある「ほかの見出し」があるか。
     * AI による概要の中の見出しと、「AI による概要」という見出し自身は数えない
     */
    function hasForeignHeading(parent, current) {

        for (const heading of parent.querySelectorAll(HEADING_SELECTOR)) {

            if (current.contains(heading)) {
                continue;
            }

            if (isInsideAiMarker(heading)) {
                continue;
            }

            if (isAiLabel(textOf(heading))) {
                continue;
            }

            if (heading.closest(`[${MARK_ATTR}]`)) {
                continue;
            }


            return true;
        }


        return false;
    }


    /*
     * start から上へ、ほかの検索結果を含まない範囲まで遡る。
     * 検索結果全体の入れ物（STOP_SELECTORS）の直下で止まる
     */
    function climb(start) {

        let current = start;


        while (true) {

            const parent =
                current.parentElement;

            if (!parent) {
                break;
            }

            if (isStop(parent)) {
                break;
            }

            if (hasForeignHeading(parent, current)) {
                break;
            }


            current = parent;
        }


        return current;
    }


    // ============================================================
    // 判定: 候補探し
    // ============================================================

    /*
     * 「AI による概要」という文字列だけを持つテキストを探す
     */
    function findLabelElements() {

        const root =
            document.body;

        if (!root) {
            return [];
        }


        const found = [];

        const walker =
            document.createTreeWalker(
                root,
                NodeFilter.SHOW_TEXT
            );


        let node;

        while ((node = walker.nextNode())) {

            const value =
                node.nodeValue;

            if (!value || value.length > 40) {
                continue;
            }

            if (!isAiLabel(value)) {
                continue;
            }


            const element =
                node.parentElement;

            if (!element) {
                continue;
            }

            if (element.closest('script, style, noscript, textarea')) {
                continue;
            }

            if (isInsidePanel(element)) {
                continue;
            }


            found.push(element);
        }


        return found;
    }


    function findMarkerElements() {

        const found = [];

        for (const selector of AI_MARKERS) {

            for (const element of document.querySelectorAll(selector)) {

                if (!isInsidePanel(element)) {
                    found.push({ element, selector });
                }
            }
        }


        return found;
    }


    // ============================================================
    // 判定: 本体
    // ============================================================

    function scan() {

        scanTimer = null;


        const findings = [];

        const next = new Set();


        for (const { element, selector } of findMarkerElements()) {

            const target =
                climb(element);

            next.add(target);

            findings.push({
                種類: '目印',
                手がかり: selector,
                start: element,
                target
            });
        }


        for (const element of findLabelElements()) {

            const target =
                climb(element);

            next.add(target);

            findings.push({
                種類: '見出し',
                手がかり: textOf(element),
                start: element,
                target
            });
        }


        /*
         * 前回印を付けたが今回は当たらなかった要素から印を外す。
         * Google が要素を使い回して別の中身を入れた場合に、消したままにしない
         */
        for (const element of marked) {

            if (!next.has(element)) {
                element.removeAttribute(MARK_ATTR);
            }
        }


        for (const element of next) {

            if (element.getAttribute(MARK_ATTR) !== 'hidden') {
                element.setAttribute(MARK_ATTR, 'hidden');
            }
        }


        marked = next;

        lastFindings = findings;
    }


    function scheduleScan(delay = SCAN_DEBOUNCE_MS) {

        if (scanTimer !== null) {
            return;
        }


        scanTimer =
            setTimeout(
                scan,
                delay
            );
    }


    function startObserver() {

        const observer =
            new MutationObserver(mutations => {

                /*
                 * 診断パネル自身の変更は無視する（無限ループ防止）
                 */
                const relevant =
                    mutations.some(
                        mutation => !isInsidePanel(mutation.target)
                    );

                if (relevant) {
                    scheduleScan();
                }
            });


        /*
         * document-start では <html> がまだ無いことがある。
         * document 自体を見ておけば、あとから作られる要素も拾える
         */
        observer.observe(
            document,
            {
                childList: true,
                subtree: true,
                characterData: true
            }
        );
    }


    // ============================================================
    // 診断
    // ============================================================

    function describe(element) {

        if (!element) {
            return '(なし)';
        }


        const id =
            element.id ? `#${element.id}` : '';

        const classes =
            [...element.classList]
                .slice(0, 3)
                .map(name => `.${name}`)
                .join('');

        const jsname =
            element.getAttribute('jsname');


        return (
            element.tagName.toLowerCase() +
            id +
            classes +
            (jsname ? `[jsname=${jsname}]` : '')
        );
    }


    function isShown(element) {

        try {

            return getComputedStyle(element).display !== 'none' &&
                element.getClientRects().length > 0;

        } catch {

            return false;
        }
    }


    function buildReport() {

        scan();


        const lines = [];

        lines.push(`Google AI概要非表示 v${VERSION}`);
        lines.push(`URL: ${location.href}`);
        lines.push(`UA: ${navigator.userAgent}`);
        lines.push(`幅: ${window.innerWidth}px`);


        let hasSupport = false;

        try {

            hasSupport = CSS.supports('selector(:has(a))');

        } catch {

            hasSupport = false;
        }

        lines.push(`:has() 対応: ${hasSupport ? 'あり' : 'なし'}`);
        lines.push(`style 注入: ${document.getElementById(STYLE_ID) ? 'あり' : 'なし'}`);
        lines.push('');


        lines.push('■ CSS ルールごとの一致数');

        for (const rule of CSS_RULES) {

            let count;

            try {

                count = document.querySelectorAll(rule).length;

            } catch {

                count = '無効';
            }

            lines.push(`  ${count}  ${rule}`);
        }

        lines.push('');


        lines.push(`■ JS の判定（${lastFindings.length} 件）`);

        if (lastFindings.length === 0) {

            lines.push('  見つからず。AI による概要が出ているのに消えない場合は、');
            lines.push('  見出しの文字列が想定（AI による概要 / AI Overview）と違う可能性がある。');
        }


        lastFindings.forEach((finding, index) => {

            lines.push(
                `  ${index + 1}. ${finding.種類}: ${finding.手がかり}`
            );

            lines.push(
                `     起点: ${describe(finding.start)}`
            );

            lines.push(
                `     消す範囲: ${describe(finding.target)}` +
                ` 親=${describe(finding.target.parentElement)}`
            );

            lines.push(
                `     文字数: ${textOf(finding.target).length}` +
                `  先頭: ${textOf(finding.target).slice(0, 40)}`
            );
        });

        lines.push('');


        /*
         * 消えずに見えている「AI」を含む短い見出しを出す。
         * 見出しの文言が変わったときの手がかりにする
         */
        lines.push('■ 見えている「AI」を含む見出し');

        let visibleCount = 0;

        for (const heading of document.querySelectorAll(HEADING_SELECTOR + ', span, div')) {

            if (visibleCount >= 10) {
                break;
            }

            if (heading.children.length > 0) {
                continue;
            }

            const text =
                textOf(heading);

            if (text.length > 30 || !/\bAI\b/.test(text)) {
                continue;
            }

            if (isInsidePanel(heading) || !isShown(heading)) {
                continue;
            }


            visibleCount++;

            lines.push(
                `  「${text}」 ${describe(heading)}` +
                ` 親=${describe(heading.parentElement)}`
            );
        }

        if (visibleCount === 0) {
            lines.push('  なし');
        }


        return lines.join('\n');
    }


    // ============================================================
    // 診断パネル
    // ============================================================

    function wantsPanel() {

        return location.hash
            .toLowerCase()
            .includes(DIAGNOSTIC_HASH);
    }


    function makeButton(label, onClick) {

        const button =
            document.createElement('button');

        button.textContent = label;


        Object.assign(
            button.style,
            {
                flex: '1',
                padding: '10px',
                borderRadius: '8px',
                border: '1px solid #666',
                background: '#222',
                color: '#fff',
                font: 'inherit'
            }
        );


        button.addEventListener('click', onClick);


        return button;
    }


    function closePanel() {

        clearInterval(panelTimer);

        panelTimer = null;

        document.getElementById(PANEL_ID)?.remove();
    }


    function renderPanel() {

        if (!wantsPanel()) {

            closePanel();

            return;
        }


        if (!document.body) {
            return;
        }


        const report =
            buildReport();


        let panel =
            document.getElementById(PANEL_ID);


        if (!panel) {

            panel =
                document.createElement('div');

            panel.id = PANEL_ID;


            Object.assign(
                panel.style,
                {
                    position: 'fixed',
                    left: '8px',
                    right: '8px',
                    bottom: '8px',
                    maxHeight: '45vh',
                    overflow: 'auto',
                    zIndex: '2147483647',
                    padding: '10px',
                    borderRadius: '10px',
                    border: '1px solid #888',
                    background: '#000',
                    color: '#fff',
                    font: '12px/1.5 -apple-system, sans-serif',
                    boxSizing: 'border-box'
                }
            );


            document.body.appendChild(panel);


            /*
             * 開いている間は定期的に取り直す。
             * AI による概要は遅れて読み込まれるため
             */
            clearInterval(panelTimer);

            panelTimer =
                setInterval(
                    renderPanel,
                    PANEL_REFRESH_MS
                );
        }


        /*
         * コピー直後に作り直すと「コピーした」表示が消えるので、
         * 本文だけ差し替える
         */
        const existingArea =
            panel.querySelector('textarea');

        if (existingArea) {

            existingArea.value = report;

            return;
        }


        panel.replaceChildren();


        const buttons =
            document.createElement('div');

        Object.assign(
            buttons.style,
            {
                display: 'flex',
                gap: '8px',
                marginBottom: '8px'
            }
        );


        const copyButton =
            makeButton('コピー', async () => {

                const area =
                    panel.querySelector('textarea');

                try {

                    await navigator.clipboard
                        .writeText(area.value);

                    copyButton.textContent = 'コピーした';

                } catch {

                    /*
                     * 権限が無い場合は選択してもらう
                     */
                    area.focus();
                    area.select();

                    copyButton.textContent = '長押しでコピー';
                }
            });


        buttons.append(
            copyButton,
            makeButton('閉じる', closePanel)
        );


        const area =
            document.createElement('textarea');

        area.value = report;

        area.readOnly = true;

        Object.assign(
            area.style,
            {
                width: '100%',
                height: '28vh',
                background: '#111',
                color: '#eee',
                border: '1px solid #444',
                borderRadius: '6px',
                font: '11px/1.4 ui-monospace, monospace',
                boxSizing: 'border-box'
            }
        );


        panel.append(buttons, area);
    }


    try {

        window.__tmGoogleAio = {

            dump() {

                const report = buildReport();

                console.log(report);

                return report;
            },

            scan,

            css: buildCss
        };

    } catch {

        /*
         * 参照できない環境では諦める
         */
    }


    // ============================================================
    // 起動
    // ============================================================

    ensureStyle();

    startObserver();


    /*
     * document-start では <head> がまだ無いことがある。
     * その場合は <html> 直下に入れているので、そのままで効く。
     * 念のため DOM 構築後にも確認する
     */
    document.addEventListener(
        'DOMContentLoaded',
        () => {

            ensureStyle();

            scan();

            renderPanel();
        },
        { once: true }
    );


    window.addEventListener(
        'hashchange',
        renderPanel
    );


    if (document.readyState !== 'loading') {

        scan();

        renderPanel();
    }

})();
