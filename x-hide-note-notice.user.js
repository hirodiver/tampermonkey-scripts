// ==UserScript==
// @name         X ノート通知非表示 v1.0.0
// @namespace    local.hiro.tools
// @version      1.0.0
// @description  X の通知タブからコミュニティノート関連の通知を非表示にする
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-idle
// @noframes
// @homepageURL  https://github.com/hirodiver/tampermonkey-scripts
// @supportURL   https://github.com/hirodiver/tampermonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-hide-note-notice.user.js
// @updateURL    https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-hide-note-notice.user.js
// ==/UserScript==

/*
 * 通知タブのコミュニティノート関連の通知を display:none で隠す。
 *
 * X は SPA なので、通知ページ以外から遷移してくる経路もある。
 * そのため @match はサイト全体に張り、処理側でパスを見て判定する。
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

    // DOM変化後の再処理までの待ち時間（ミリ秒）
    const REBUILD_DELAY = 250;

    // SPA遷移直後の再処理までの待ち時間（ミリ秒）
    const NAV_DELAY = 500;

    // 通知1件分の要素（上から順に試す）
    const CELL_SELECTORS = [
        'div[data-testid="cellInnerDiv"]',
        'section[role="region"] > div > div > div'
    ];

    // コミュニティノートの通知に含まれる文字列（部分一致）
    const COMMUNITY_NOTE_KEYWORDS = [
        'コミュニティノート',
        'Community Note',
        'community note'
    ];

    // 本スクリプトが非表示にした要素の目印
    const HIDDEN_ATTR = 'data-tm-note-hidden';


    // ============================================================
    // 状態
    // ============================================================

    let rebuildTimer = null;

    let processing = false;
    let reprocessRequested = false;


    // ============================================================
    // 小物
    // ============================================================

    function log(...args) {

        if (DEBUG) {
            console.log('[Xノート通知非表示]', ...args);
        }
    }


    function isNotificationsPage() {

        return location.pathname
            .startsWith('/notifications');
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


    // ============================================================
    // 表示・非表示
    // ============================================================

    /*
     * X はスクロール時に同じ DOM 要素を別の通知に使い回す。
     * 一度隠した要素をそのままにすると、通常の通知が消えてしまう。
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

    function isCommunityNoteNotice(cell) {

        const text =
            cell.textContent || '';


        return COMMUNITY_NOTE_KEYWORDS.some(
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
            return;
        }


        /*
         * 通知ページ以外へ移動した場合は、
         * 使い回された要素が隠れたままにならないよう表示へ戻す
         */
        const onNotifications =
            isNotificationsPage();


        let changed = 0;


        for (const cell of cells) {

            const hide =
                onNotifications &&
                isCommunityNoteNotice(cell);


            if (setHidden(cell, hide)) {
                changed++;
            }
        }


        if (changed) {
            log('表示状態を変更:', changed, '件');
        }
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

            processCells();

        } catch (error) {

            console.warn(
                '[Xノート通知非表示] 処理中にエラー:',
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
     * X は history API で画面を切り替えるため、
     * pushState / replaceState を包んで遷移を検知する
     */
    function hookHistory() {

        for (const name of ['pushState', 'replaceState']) {

            const original = history[name];

            history[name] = function (...args) {

                const result =
                    original.apply(this, args);

                scheduleProcess(NAV_DELAY);

                return result;
            };
        }


        window.addEventListener(
            'popstate',
            () => scheduleProcess(NAV_DELAY)
        );
    }


    // ============================================================
    // DOM監視
    // ============================================================

    const observer =
        new MutationObserver(mutations => {

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

    hookHistory();


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
