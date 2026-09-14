// ==UserScript==
// @name         X タイムライン整理 v1.0.0
// @namespace    local.hiro.tools
// @version      1.0.0
// @description  X の「おすすめ」タブを隠して常にフォロー中を表示し、広告とコミュニティノートの通知を非表示にする
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-idle
// @noframes
// @homepageURL  https://github.com/hirodiver/tampermonkey-scripts
// @supportURL   https://github.com/hirodiver/tampermonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-timeline-declutter.user.js
// @updateURL    https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-timeline-declutter.user.js
// ==/UserScript==

/*
 * Control Panel for Twitter の機能のうち、常用する3つだけを実装したもの。
 *
 *   1. ホームの「おすすめ」タブを隠し、常に「フォロー中」を開く
 *   2. タイムラインの広告（プロモーション）ポストを隠す
 *   3. 通知タブのコミュニティノート関連の通知を隠す
 *
 * X の DOM は頻繁に変わる前提で、セレクタとラベル文字列はすべて
 * 配列にして総当たりする。壊れたときは「設定」セクションだけを直せばよい。
 *
 * 非表示は要素の削除ではなく display:none で行う。
 * 誤爆したときに DevTools で元の要素を確認できるようにするため。
 */

(function () {
    'use strict';

    // ============================================================
    // 設定
    // ============================================================

    // 機能ごとの有効／無効
    const ENABLE_FOLLOWING_TAB = true;      // おすすめタブを隠してフォロー中に切り替える
    const ENABLE_HIDE_PROMOTED = true;      // 広告ポストを隠す
    const ENABLE_HIDE_NOTE_NOTICE = true;   // コミュニティノートの通知を隠す

    // true にするとコンソールに処理ログを出す
    const DEBUG = false;

    // DOM変化後の再処理までの待ち時間（ミリ秒）
    const REBUILD_DELAY = 250;

    // SPA遷移直後の再処理までの待ち時間（ミリ秒）
    const NAV_DELAY = 500;

    // 「フォロー中」タブを自動クリックする最短間隔（ミリ秒）
    // X 側の再描画と競合して連打になるのを防ぐ
    const TAB_CLICK_INTERVAL = 1500;

    // タイムライン・通知の1件分の要素（上から順に試す）
    const CELL_SELECTORS = [
        'div[data-testid="cellInnerDiv"]',
        'section[role="region"] > div > div > div'
    ];

    // 広告であることが確実に分かるマーカー
    // （動画広告・カルーセル広告はこの要素を必ず持つ）
    const PROMOTED_MARKER_SELECTORS = [
        '[data-testid="placementTracking"]'
    ];

    // 広告ラベルの文字列（完全一致で判定する）
    const PROMOTED_LABELS = [
        '広告',
        'プロモーション',
        'Promoted',
        'Ad',
        'Sponsored'
    ];

    // コミュニティノートの通知に含まれる文字列（部分一致で判定する）
    const COMMUNITY_NOTE_KEYWORDS = [
        'コミュニティノート',
        'Community Note',
        'community note'
    ];

    // 「おすすめ」タブのラベル（完全一致）
    const FOR_YOU_LABELS = [
        'おすすめ',
        'For you'
    ];

    // 「フォロー中」タブのラベル（完全一致）
    const FOLLOWING_LABELS = [
        'フォロー中',
        'Following'
    ];

    // 本スクリプトが非表示にした要素の目印
    const HIDDEN_ATTR = 'data-tm-declutter-hidden';


    // ============================================================
    // 状態
    // ============================================================

    let rebuildTimer = null;

    let processing = false;
    let reprocessRequested = false;

    // 最後に「フォロー中」タブをクリックした時刻
    let lastTabClickAt = 0;


    // ============================================================
    // 小物
    // ============================================================

    function log(...args) {

        if (DEBUG) {
            console.log('[X整理]', ...args);
        }
    }


    /*
     * サイト側の DOM 変更に耐えるため、
     * セレクタを順に試して最初に当たったものを返す
     */
    function queryAll(root, selectors) {

        for (const selector of selectors) {

            const found =
                root.querySelectorAll(selector);

            if (found.length) {
                return [...found];
            }
        }

        return [];
    }


    function normalize(text) {

        return (text || '')
            .replace(/\s+/g, '')
            .trim();
    }


    function isHomePage() {

        return (
            location.pathname === '/home'
        );
    }


    function isNotificationsPage() {

        return location.pathname
            .startsWith('/notifications');
    }


    // ============================================================
    // 表示・非表示
    // ============================================================

    /*
     * X はスクロール時に同じ DOM 要素を別のポストに使い回す。
     * 一度隠した要素をそのままにすると、通常のポストが消えてしまう。
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
    // 広告判定
    // ============================================================

    /*
     * 本文中の「広告」という語で誤爆しないよう、
     * 判定対象は「子要素を持たない小さなラベル」かつ
     * 「ポスト本文の外」に限定する
     */
    function hasPromotedLabel(cell) {

        const spans =
            cell.querySelectorAll('span');


        for (const span of spans) {

            if (span.children.length) {
                continue;
            }


            const text =
                normalize(span.textContent);

            if (!text || text.length > 12) {
                continue;
            }


            if (!PROMOTED_LABELS.includes(text)) {
                continue;
            }


            // ポスト本文・引用元の本文の中は見ない
            if (span.closest('[data-testid="tweetText"]')) {
                continue;
            }


            return true;
        }


        return false;
    }


    function isPromoted(cell) {

        for (const selector of PROMOTED_MARKER_SELECTORS) {

            if (cell.querySelector(selector)) {
                return true;
            }
        }


        return hasPromotedLabel(cell);
    }


    // ============================================================
    // コミュニティノートの通知判定
    // ============================================================

    function isCommunityNoteNotice(cell) {

        const text =
            cell.textContent || '';


        return COMMUNITY_NOTE_KEYWORDS.some(
            keyword => text.includes(keyword)
        );
    }


    // ============================================================
    // セルの処理
    // ============================================================

    function processCells() {

        const cells =
            queryAll(document, CELL_SELECTORS);


        if (!cells.length) {
            return;
        }


        const onNotifications =
            isNotificationsPage();


        let changed = 0;


        for (const cell of cells) {

            let hide = false;


            if (
                ENABLE_HIDE_PROMOTED &&
                !onNotifications &&
                isPromoted(cell)
            ) {
                hide = true;
            }


            if (
                ENABLE_HIDE_NOTE_NOTICE &&
                onNotifications &&
                isCommunityNoteNotice(cell)
            ) {
                hide = true;
            }


            if (setHidden(cell, hide)) {
                changed++;
            }
        }


        if (changed) {
            log('表示状態を変更:', changed, '件');
        }
    }


    // ============================================================
    // ホームのタブ
    // ============================================================

    function getTabs() {

        return [
            ...document.querySelectorAll(
                '[role="tablist"] [role="tab"]'
            )
        ];
    }


    function matchTab(tab, labels) {

        const text =
            normalize(tab.textContent);

        return labels.some(
            label => normalize(label) === text
        );
    }


    function processTabs() {

        if (!isHomePage()) {
            return;
        }


        const tabs = getTabs();

        if (!tabs.length) {
            return;
        }


        let forYouTab = null;
        let followingTab = null;


        for (const tab of tabs) {

            if (matchTab(tab, FOR_YOU_LABELS)) {
                forYouTab = tab;
            }

            if (matchTab(tab, FOLLOWING_LABELS)) {
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

        if (forYouTab) {

            setHidden(forYouTab, true);
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


    // ============================================================
    // メイン
    // ============================================================

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

            if (ENABLE_FOLLOWING_TAB) {
                processTabs();
            }


            if (
                ENABLE_HIDE_PROMOTED ||
                ENABLE_HIDE_NOTE_NOTICE
            ) {
                processCells();
            }

        } catch (error) {

            console.warn('[X整理] 処理中にエラー:', error);

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
                 * 自分が隠した要素の変更は無視する
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
