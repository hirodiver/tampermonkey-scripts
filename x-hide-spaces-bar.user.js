// ==UserScript==
// @name         X スペース帯非表示 v1.1.0
// @namespace    local.hiro.tools
// @version      1.1.0
// @description  X のタイムライン上部に出る音声スペースの帯（バー）を非表示にする
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-start
// @noframes
// @homepageURL  https://github.com/hirodiver/tampermonkey-scripts
// @supportURL   https://github.com/hirodiver/tampermonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-hide-spaces-bar.user.js
// @updateURL    https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-hide-spaces-bar.user.js
// ==/UserScript==

/*
 * タイムラインに差し込まれる音声スペースの帯を隠す。
 *
 * 二段構えにしている。
 *
 *   1. CSS（:has）— document-start で <style> を注入する。
 *      要素が生まれた瞬間から効くので、一瞬見えてから消える現象が起きない。
 *      スペースへのリンクを含み、投稿本体を含まないセルだけを狙う。
 *
 *   2. JavaScript — CSS で取り切れない分の保険。
 *      :has 非対応環境、リンクを持たない帯、下部の再生バーを見る。
 *
 * 非表示は要素の削除ではなく display:none で行う。
 * 誤爆したときに DevTools で元の要素を確認できるようにするため。
 *
 * 効かない・消えすぎる場合は、コンソールで次を実行すると
 * 候補要素の一覧が出る。そのまま報告に使える。
 *
 *   __tmSpacesBar.dump()
 */

(function () {
    'use strict';

    // ============================================================
    // 設定
    // ============================================================

    // true にするとコンソールに処理ログを出す
    const DEBUG = false;

    // 画面下部に居座る再生バー（オーディオドック）も隠すか
    const HIDE_AUDIO_DOCK = true;

    // 目印が無い帯を表示テキストで判定するか（誤爆が出るなら false）
    const USE_TEXT_FALLBACK = true;

    // DOM変化後の再処理までの待ち時間（ミリ秒）
    const REBUILD_DELAY = 250;

    // SPA遷移直後の再処理までの待ち時間（ミリ秒）
    const NAV_DELAY = 500;

    // スペースへのリンク
    const SPACE_LINK_SELECTOR = 'a[href*="/i/spaces/"]';

    // タイムライン1件分の要素（上から順に試す）
    const CELL_SELECTORS = [
        'div[data-testid="cellInnerDiv"]',
        'section[role="region"] > div > div > div'
    ];

    // スペースの帯だと判断する目印（いずれかに当たれば該当）
    const SPACE_MARK_SELECTORS = [
        SPACE_LINK_SELECTOR,
        'a[href^="/i/spaces"]',
        '[data-testid="audioSpaceRoot"]',
        '[data-testid="AudioSpacePill"]',
        '[data-testid="placementTracking"] a[href*="/i/spaces/"]'
    ];

    // 画面下部の再生バー
    const AUDIO_DOCK_SELECTORS = [
        'div[data-testid="AudioDock"]',
        'div[data-testid="audioDock"]',
        'div[data-testid="AudioDockSpace"]'
    ];

    // 目印が取れないとき最後に見る表示テキスト（部分一致）
    const SPACE_KEYWORDS = [
        'スペース',
        'Spaces'
    ];

    // 投稿本体の要素（これを含むセルは投稿なので隠さない）
    const TWEET_SELECTORS = [
        'article[data-testid="tweet"]',
        'article[role="article"]',
        'article'
    ];

    // テキスト判定に回すセルの最大文字数（長い＝投稿とみなす）
    const KEYWORD_MAX_LENGTH = 120;

    // 本スクリプトが非表示にした要素の目印
    const HIDDEN_ATTR = 'data-tm-space-hidden';

    // 注入する <style> の id
    const STYLE_ID = 'tm-hide-spaces-bar-style';


    // ============================================================
    // 状態
    // ============================================================

    let rebuildTimer = null;

    // 最後に処理したパス（SPA遷移の検知に使う）
    let lastPath = location.pathname;

    let processing = false;
    let reprocessRequested = false;

    let styleElement = null;


    // ============================================================
    // 小物
    // ============================================================

    function log(...args) {

        if (DEBUG) {
            console.log('[Xスペース帯非表示]', ...args);
        }
    }


    /*
     * スペースそのものを開いているときは何も隠さない
     */
    function isSpacePage() {

        return location.pathname
            .startsWith('/i/spaces');
    }


    /*
     * サイト側の DOM 変更に耐えるため、
     * セレクタを順に試して最初に当たったものを返す
     */
    function queryAll(selectors) {

        for (const selector of selectors) {

            let found;

            try {

                found =
                    document.querySelectorAll(selector);

            } catch {

                /*
                 * 未対応セレクタは黙って飛ばす
                 */
                continue;
            }


            if (found.length) {
                return [...found];
            }
        }

        return [];
    }


    function matchesAny(element, selectors) {

        return selectors.some(
            selector =>
                element.querySelector(selector) ||
                element.matches?.(selector)
        );
    }


    // ============================================================
    // CSSによる先回り（:has）
    // ============================================================

    /*
     * :has が使えるかどうか。
     * Chrome 105 / Safari 15.4 以降なら通る
     */
    function supportsHas() {

        try {

            return CSS.supports('selector(:has(a))');

        } catch {

            return false;
        }
    }


    function buildCss() {

        const rules = [];


        for (const cellSelector of CELL_SELECTORS) {

            /*
             * 「スペースへのリンクを持ち、投稿本体を持たないセル」だけを隠す。
             * スペースに言及しただけの投稿は :not(:has(article)) で除外される
             */
            rules.push(
                `${cellSelector}` +
                `:has(${SPACE_LINK_SELECTOR})` +
                `:not(:has(article))`
            );
        }


        if (HIDE_AUDIO_DOCK) {
            rules.push(...AUDIO_DOCK_SELECTORS);
        }


        return (
            rules.join(',\n') +
            ' {\n    display: none !important;\n}\n'
        );
    }


    function ensureStyle() {

        if (!supportsHas()) {
            return;
        }


        const root =
            document.head ||
            document.documentElement;

        if (!root) {
            return;
        }


        if (
            styleElement &&
            styleElement.isConnected
        ) {
            return;
        }


        styleElement =
            document.getElementById(STYLE_ID);


        if (!styleElement) {

            styleElement =
                document.createElement('style');

            styleElement.id = STYLE_ID;

            /*
             * innerHTML は Trusted Types で弾かれるため使わない
             */
            styleElement.textContent = buildCss();
        }


        root.appendChild(styleElement);

        log('スタイルを注入');
    }


    /*
     * スペースのページでは CSS ごと止める
     */
    function syncStyleEnabled() {

        if (!styleElement) {
            return;
        }


        styleElement.disabled = isSpacePage();
    }


    // ============================================================
    // 表示・非表示
    // ============================================================

    /*
     * X はスクロール時に同じ DOM 要素を別の項目に使い回す。
     * 一度隠した要素をそのままにすると、通常の投稿が消えてしまう。
     * そのため毎回すべてのセルを判定し直し、表示側にも戻す。
     */
    function setHidden(element, hidden) {

        const isHidden =
            element.hasAttribute(HIDDEN_ATTR);


        if (hidden && !isHidden) {

            element.setAttribute(HIDDEN_ATTR, '1');

            element.style.display = 'none';

            return true;
        }


        if (!hidden && isHidden) {

            element.removeAttribute(HIDDEN_ATTR);

            element.style.display = '';

            return true;
        }


        return false;
    }


    // ============================================================
    // 判定
    // ============================================================

    function isSpaceBar(cell) {

        /*
         * 投稿本体を含むセルは対象外。
         * スペースに言及しただけの投稿を巻き込まないため
         */
        if (matchesAny(cell, TWEET_SELECTORS)) {
            return false;
        }


        if (matchesAny(cell, SPACE_MARK_SELECTORS)) {
            return true;
        }


        if (!USE_TEXT_FALLBACK) {
            return false;
        }


        /*
         * 目印が取れない場合の最終手段。
         * 短いセルに限ってテキストで判定する
         */
        const text =
            (cell.textContent || '').trim();


        if (
            !text ||
            text.length > KEYWORD_MAX_LENGTH
        ) {
            return false;
        }


        return SPACE_KEYWORDS.some(
            keyword => text.includes(keyword)
        );
    }


    // ============================================================
    // メイン
    // ============================================================

    function processCells() {

        const cells =
            queryAll(CELL_SELECTORS);

        if (!cells.length) {
            return 0;
        }


        /*
         * スペースのページへ移動した場合は、
         * 使い回された要素が隠れたままにならないよう表示へ戻す
         */
        const active =
            !isSpacePage();


        let changed = 0;


        for (const cell of cells) {

            const hide =
                active &&
                isSpaceBar(cell);


            if (setHidden(cell, hide)) {
                changed++;
            }
        }


        return changed;
    }


    function processAudioDock() {

        if (!HIDE_AUDIO_DOCK) {
            return 0;
        }


        const docks =
            queryAll(AUDIO_DOCK_SELECTORS);

        if (!docks.length) {
            return 0;
        }


        const active =
            !isSpacePage();


        let changed = 0;


        for (const dock of docks) {

            if (setHidden(dock, active)) {
                changed++;
            }
        }


        return changed;
    }


    function process() {

        /*
         * 処理中に呼ばれたら、終了後に1回だけ追い実行する
         */
        if (processing) {

            reprocessRequested = true;

            return;
        }


        processing = true;


        try {

            ensureStyle();

            syncStyleEnabled();


            const changed =
                processCells() +
                processAudioDock();


            if (changed) {
                log('表示状態を変更:', changed, '件');
            }

        } catch (error) {

            console.warn(
                '[Xスペース帯非表示] 処理中にエラー:',
                error
            );

        } finally {

            processing = false;


            if (reprocessRequested) {

                reprocessRequested = false;

                scheduleProcess(REBUILD_DELAY);
            }
        }
    }


    function scheduleProcess(delay = REBUILD_DELAY) {

        clearTimeout(rebuildTimer);

        rebuildTimer =
            setTimeout(process, delay);
    }


    // ============================================================
    // SPA遷移
    // ============================================================

    /*
     * X は history API で画面を切り替えるが、
     * pushState / replaceState のラップは使わない。
     *
     * iOS の Tampermonkey はスクリプトを isolated world で実行するため、
     * こちらで書き換えた history はページ側の呼び出しを捕捉できない。
     * 代わりに、DOM監視のついでに URL の変化を見る。
     */
    function locationChanged() {

        const path = location.pathname;

        if (path === lastPath) {
            return false;
        }

        lastPath = path;

        return true;
    }


    // ============================================================
    // DOM監視
    // ============================================================

    const observer =
        new MutationObserver(mutations => {

            /*
             * ページの出入りをここで拾う
             */
            if (locationChanged()) {

                scheduleProcess(NAV_DELAY);

                return;
            }


            for (const mutation of mutations) {

                if (mutation.type !== 'childList') {
                    continue;
                }


                if (!mutation.addedNodes.length) {
                    continue;
                }


                /*
                 * 自分が隠した要素の中の変更は無視する
                 * （無限ループ防止）
                 */
                const target = mutation.target;

                if (
                    target instanceof Element &&
                    target.closest?.(`[${HIDDEN_ATTR}]`)
                ) {
                    continue;
                }


                scheduleProcess();

                return;
            }
        });


    function startObserver() {

        const root =
            document.body ||
            document.documentElement;

        if (!root) {
            return;
        }


        observer.observe(
            root,
            {
                childList: true,
                subtree: true
            }
        );
    }


    // ============================================================
    // 診断
    // ============================================================

    /*
     * うまくいかないときの調査用。
     * コンソールで __tmSpacesBar.dump() を実行する
     */
    const diagnostics = {

        dump() {

            const cells =
                queryAll(CELL_SELECTORS);


            const rows =
                cells.map((cell, index) => ({
                    index,

                    隠した:
                        cell.hasAttribute(HIDDEN_ATTR),

                    判定:
                        isSpaceBar(cell),

                    投稿:
                        matchesAny(cell, TWEET_SELECTORS),

                    リンク:
                        !!cell.querySelector(
                            SPACE_LINK_SELECTOR
                        ),

                    テキスト:
                        (cell.textContent || '')
                            .trim()
                            .slice(0, 40)
                }));


            console.table(rows);


            console.log(
                'セル数:', cells.length,
                '/ :has対応:', supportsHas(),
                '/ スタイル:',
                styleElement?.isConnected ?
                    (styleElement.disabled ? '無効' : '有効') :
                    '未注入',
                '/ ドック:',
                queryAll(AUDIO_DOCK_SELECTORS).length
            );


            return rows;
        },

        css: buildCss
    };


    try {

        window.__tmSpacesBar = diagnostics;

    } catch {

        /*
         * 参照できない環境では諦める
         */
    }


    // ============================================================
    // 起動
    // ============================================================

    window.addEventListener(
        'popstate',
        () => scheduleProcess(NAV_DELAY)
    );


    ensureStyle();


    if (document.body) {

        startObserver();

    } else {

        document.addEventListener(
            'DOMContentLoaded',
            () => {

                ensureStyle();

                startObserver();

                process();
            },
            { once: true }
        );
    }


    scheduleProcess(NAV_DELAY);

})();
