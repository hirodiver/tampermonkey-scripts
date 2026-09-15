// ==UserScript==
// @name         X スペース帯非表示 v1.0.0
// @namespace    local.hiro.tools
// @version      1.0.0
// @description  X のタイムライン上部に出る音声スペースの帯（バー）を非表示にする
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-idle
// @noframes
// @homepageURL  https://github.com/hirodiver/tampermonkey-scripts
// @supportURL   https://github.com/hirodiver/tampermonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-hide-spaces-bar.user.js
// @updateURL    https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-hide-spaces-bar.user.js
// ==/UserScript==

/*
 * タイムラインの先頭に差し込まれる音声スペースの帯を display:none で隠す。
 *
 * X は SPA なので @match はサイト全体に張り、処理側でパスを見て判定する。
 * スペースのページ自体（/i/spaces/...）では何も隠さない。
 *
 * 非表示は要素の削除ではなく display:none で行う。
 * 誤爆したときに DevTools で元の要素を確認できるようにするため。
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

    // DOM変化後の再処理までの待ち時間（ミリ秒）
    const REBUILD_DELAY = 250;

    // SPA遷移直後の再処理までの待ち時間（ミリ秒）
    const NAV_DELAY = 500;

    // タイムライン1件分の要素（上から順に試す）
    const CELL_SELECTORS = [
        'div[data-testid="cellInnerDiv"]',
        'section[role="region"] > div > div > div'
    ];

    // スペースの帯だと判断する目印（いずれかに当たれば該当）
    const SPACE_MARK_SELECTORS = [
        'a[href*="/i/spaces/"]',
        'a[href^="/i/spaces"]',
        '[data-testid="audioSpaceRoot"]',
        '[data-testid="AudioSpacePill"]',
        '[data-testid="socialContext"][href*="/i/spaces/"]'
    ];

    // 画面下部の再生バー（上から順に試す）
    const AUDIO_DOCK_SELECTORS = [
        'div[data-testid="AudioDock"]',
        'div[data-testid="audioDock"]',
        'div[aria-label*="スペース"][role="complementary"]'
    ];

    // 目印が取れないとき最後に見る表示テキスト（部分一致）
    const SPACE_KEYWORDS = [
        'スペース',
        'Spaces',
        'Space'
    ];

    // 投稿本体の要素（これを含むセルは投稿なので隠さない）
    const TWEET_SELECTORS = [
        'article[data-testid="tweet"]',
        'article[role="article"]'
    ];

    // テキスト判定に回すセルの最大文字数（長い＝投稿とみなす）
    const KEYWORD_MAX_LENGTH = 120;

    // 本スクリプトが非表示にした要素の目印
    const HIDDEN_ATTR = 'data-tm-space-hidden';


    // ============================================================
    // 状態
    // ============================================================

    let rebuildTimer = null;

    // 最後に処理したパス（SPA遷移の検知に使う）
    let lastPath = location.pathname;

    let processing = false;
    let reprocessRequested = false;


    // ============================================================
    // 小物
    // ============================================================

    function log(...args) {

        if (DEBUG) {
            console.log('[Xスペース帯非表示]', ...args);
        }
    }


    /*
     * スペースそのものを開いているときは隠さない
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

            const found =
                document.querySelectorAll(selector);

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

        if (!document.body) {
            return;
        }


        observer.observe(
            document.body,
            {
                childList: true,
                subtree: true
            }
        );
    }


    // ============================================================
    // 起動
    // ============================================================

    window.addEventListener(
        'popstate',
        () => scheduleProcess(NAV_DELAY)
    );


    if (document.body) {

        startObserver();

    } else {

        document.addEventListener(
            'DOMContentLoaded',
            startObserver,
            { once: true }
        );
    }


    scheduleProcess(NAV_DELAY);

})();
