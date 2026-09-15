// ==UserScript==
// @name         X フォロー中固定 v1.1.0
// @namespace    local.hiro.tools
// @version      1.1.0
// @description  X ホームの「おすすめ」タブを隠し、常に「フォロー中」を表示する
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-idle
// @noframes
// @homepageURL  https://github.com/hirodiver/tampermonkey-scripts
// @supportURL   https://github.com/hirodiver/tampermonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-following-tab.user.js
// @updateURL    https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-following-tab.user.js
// ==/UserScript==

/*
 * ホームの「おすすめ」タブを display:none で隠し、
 * おすすめが選択されている場合は「フォロー中」タブをクリックする。
 *
 * X の DOM は頻繁に変わる前提で、ラベル文字列は配列にして総当たりする。
 * 壊れたときは「設定」セクションだけを直せばよい。
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

    // 「フォロー中」タブを自動クリックする最短間隔（ミリ秒）
    // X 側の再描画と競合して連打になるのを防ぐ
    const TAB_CLICK_INTERVAL = 1500;

    // タブ要素（上から順に試す）
    const TAB_SELECTORS = [
        '[role="tablist"] [role="tab"]',
        'nav[role="navigation"] [role="tab"]'
    ];

    // 「おすすめ」タブのラベル（空白を除いた完全一致）
    const FOR_YOU_LABELS = [
        'おすすめ',
        'For you'
    ];

    // 「フォロー中」タブのラベル（空白を除いた完全一致）
    const FOLLOWING_LABELS = [
        'フォロー中',
        'Following'
    ];

    // 本スクリプトが非表示にした要素の目印
    const HIDDEN_ATTR = 'data-tm-following-hidden';


    // ============================================================
    // 状態
    // ============================================================

    let rebuildTimer = null;

    // 最後に処理したパス（SPA遷移の検知に使う）
    let lastPath = location.pathname;

    // 最後に「フォロー中」タブをクリックした時刻
    let lastTabClickAt = 0;


    // ============================================================
    // 小物
    // ============================================================

    function log(...args) {

        if (DEBUG) {
            console.log('[Xフォロー中固定]', ...args);
        }
    }


    function normalize(text) {

        return (text || '')
            .replace(/\s+/g, '')
            .trim();
    }


    function isHomePage() {

        return location.pathname === '/home';
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


    function matchLabel(element, labels) {

        const text =
            normalize(element.textContent);

        return labels.some(
            label => normalize(label) === text
        );
    }


    // ============================================================
    // タブ処理
    // ============================================================

    function process() {

        if (!isHomePage()) {
            return;
        }


        const tabs =
            queryAll(TAB_SELECTORS);

        if (!tabs.length) {
            return;
        }


        let forYouTab = null;
        let followingTab = null;


        for (const tab of tabs) {

            if (matchLabel(tab, FOR_YOU_LABELS)) {
                forYouTab = tab;
            }

            if (matchLabel(tab, FOLLOWING_LABELS)) {
                followingTab = tab;
            }
        }


        /*
         * 「フォロー中」が見つからないときは何もしない。
         * タブ構成が変わった場合に、
         * おすすめだけ消えて何も見られなくなるのを防ぐ
         */
        if (!followingTab) {

            log('フォロー中タブが見つからない');

            return;
        }


        // --------------------------------------------------------
        // おすすめタブを隠す
        // --------------------------------------------------------

        if (
            forYouTab &&
            !forYouTab.hasAttribute(HIDDEN_ATTR)
        ) {

            forYouTab.setAttribute(HIDDEN_ATTR, '1');

            forYouTab.style.display = 'none';

            log('おすすめタブを隠した');
        }


        // --------------------------------------------------------
        // おすすめが選択されていたらフォロー中へ切り替える
        // --------------------------------------------------------

        const forYouSelected =
            forYouTab?.getAttribute('aria-selected') === 'true';

        const followingSelected =
            followingTab.getAttribute('aria-selected') === 'true';


        if (!forYouSelected || followingSelected) {
            return;
        }


        const now = Date.now();

        if (now - lastTabClickAt < TAB_CLICK_INTERVAL) {
            return;
        }


        lastTabClickAt = now;

        followingTab.click();

        log('フォロー中タブへ切り替えた');
    }


    function scheduleProcess(delay = REBUILD_DELAY) {

        clearTimeout(rebuildTimer);

        rebuildTimer =
            setTimeout(
                () => {

                    try {
                        process();

                    } catch (error) {

                        console.warn(
                            '[Xフォロー中固定] 処理中にエラー:',
                            error
                        );
                    }
                },
                delay
            );
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
     * 実行環境に依存せず、コードも少なくて済む。
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

    /*
     * タブの出現・再描画だけを見たいので、
     * 監視対象はタブが含まれる範囲に限らず body 全体だが、
     * 処理自体はタブ有無の確認だけで軽い
     */
    const observer =
        new MutationObserver(mutations => {

            /*
             * 他のページからホームへ戻ってきた場合をここで拾う
             */
            if (locationChanged()) {

                scheduleProcess(NAV_DELAY);

                return;
            }


            if (!isHomePage()) {
                return;
            }


            for (const mutation of mutations) {

                if (mutation.type !== 'childList') {
                    continue;
                }


                if (!mutation.addedNodes.length) {
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
