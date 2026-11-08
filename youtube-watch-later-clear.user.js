// ==UserScript==
// @name         YouTube 後で見る一括削除 v1.0.0
// @namespace    local.hiro.tools
// @version      1.0.0
// @description  「後で見る」の再生リスト画面に「全部削除」ボタンを出し、押すと中の動画を上から順に1本ずつ「[後で見る]から削除」していく。途中で止められる。YouTube 本体のメニューを代わりに押すだけで、非公式APIは叩かない
// @match        https://www.youtube.com/*
// @grant        none
// @run-at       document-idle
// @homepageURL  https://github.com/hirodiver/tampermonkey-scripts
// @supportURL   https://github.com/hirodiver/tampermonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/youtube-watch-later-clear.user.js
// @updateURL    https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/youtube-watch-later-clear.user.js
// ==/UserScript==

(function () {
    'use strict';

    /*
     * 「後で見る」は https://www.youtube.com/playlist?list=WL 。
     * YouTube には「全部消す」が無い（「視聴済みの動画を削除」だけある）ので、
     * 各動画の「︙」メニュー → 「[後で見る]から削除」を、人の代わりに順に押していく。
     *
     *   [サムネ] タイトル … [︙]  ← これを押す
     *                         └ [後で見る]から削除  ← これを押す
     *
     * 消すのは YouTube 本体の操作そのものなので、元に戻す手段は YouTube 側に無い。
     * 押す前に確認を出す。
     *
     * 一覧は100本ずつ読み込まれる。見えている分を消し終えたら下端までスクロールして
     * 続きを読ませ、無くなるまで繰り返す。
     */

    // ============================================================
    // 設定
    // ============================================================

    // 1本消すごとに置く間(ms)。短くしすぎると YouTube に弾かれることがある
    const INTERVAL_MS = 350;

    // 「︙」を押してからメニューが出るのを待つ上限(ms)
    const MENU_TIMEOUT_MS = 3000;

    // 「削除」を押してから一覧の行が消えるのを待つ上限(ms)
    const REMOVE_TIMEOUT_MS = 5000;

    // 続きを読み込むのを待つ上限(ms)
    const LOAD_MORE_TIMEOUT_MS = 8000;

    // 続けて失敗したら止める回数
    const MAX_CONSECUTIVE_FAILURES = 5;

    // 画面の変化から表示を見直すまでの待ち時間(ms)
    const APPLY_DEBOUNCE_MS = 200;

    // ボタンの文字
    const LABEL_IDLE = '後で見るを全部削除';
    const LABEL_STOP_PREFIX = '停止';

    // ============================================================
    // 目印
    // ============================================================

    const PANEL_ID = 'tm-ywlc-panel';
    const BUTTON_ID = 'tm-ywlc-button';
    const STATUS_ID = 'tm-ywlc-status';

    // 一覧の1行。新旧を順に試す
    const ROW_SELECTORS = [
        'ytd-playlist-video-list-renderer ytd-playlist-video-renderer',
        'ytd-playlist-video-renderer',
        'ytd-playlist-video-list-renderer yt-lockup-view-model'
    ];

    // 行の中の「︙」ボタン。新旧を順に試す
    const MENU_BUTTON_SELECTORS = [
        '#menu button',
        'ytd-menu-renderer button',
        'ytd-menu-renderer yt-icon-button',
        'button[aria-label*="操作メニュー"]',
        'button[aria-label*="メニュー"]',
        'button[aria-label*="Action menu" i]',
        'button[aria-label*="More actions" i]'
    ];

    // 開いたメニューの入れ物
    const POPUP_SELECTORS = [
        'ytd-popup-container tp-yt-iron-dropdown',
        'ytd-menu-popup-renderer',
        'tp-yt-iron-dropdown',
        'yt-sheet-view-model',
        'yt-contextual-sheet-layout',
        '[role="menu"]',
        '[role="listbox"]'
    ];

    // メニューの1項目
    const MENU_ITEM_SELECTORS = [
        'ytd-menu-service-item-renderer',
        'yt-list-item-view-model',
        'tp-yt-paper-item',
        '[role="menuitem"]',
        '[role="option"]'
    ];

    // 押す項目の文字（上ほど優先）
    const REMOVE_TEXT_PATTERNS = [
        /後で見る.*から削除/,
        /Remove from .*Watch later/i,
        /から削除/,
        /^\s*Remove from/i
    ];

    // 続きの読み込み口
    const CONTINUATION_SELECTORS = [
        'ytd-playlist-video-list-renderer ytd-continuation-item-renderer',
        'ytd-continuation-item-renderer',
        'yt-next-continuation'
    ];

    // ============================================================
    // 状態
    // ============================================================

    let running = false;
    let stopRequested = false;
    let removedCount = 0;
    let failedCount = 0;
    let lastMessage = '未実行';
    let applyTimer = null;

    // 消せなかった行は飛ばす（同じ行を延々と押し続けないため）
    let failedRows = new WeakSet();

    // ============================================================
    // 小物
    // ============================================================

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function waitFor(fn, timeoutMs, stepMs) {
        const step = stepMs || 50;
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            const value = fn();

            if (value) {
                return value;
            }

            await sleep(step);
        }

        return null;
    }

    function isVisible(el) {
        if (!el || !el.isConnected) {
            return false;
        }

        if (el.hidden || el.closest('[hidden]')) {
            return false;
        }

        return el.getClientRects().length > 0;
    }

    function queryFirst(root, selectors) {
        for (const selector of selectors) {
            const found = root.querySelector(selector);

            if (found) {
                return found;
            }
        }

        return null;
    }

    function isWatchLaterPage() {
        if (location.pathname !== '/playlist') {
            return false;
        }

        const params = new URLSearchParams(location.search);

        return params.get('list') === 'WL';
    }

    // ============================================================
    // 一覧の行
    // ============================================================

    function findAllRows() {
        for (const selector of ROW_SELECTORS) {
            const rows = Array.from(document.querySelectorAll(selector))
                .filter((row) => isVisible(row));

            if (rows.length > 0) {
                return rows;
            }
        }

        // 最終手段: list=WL 付きの動画リンクから、「︙」を含む一番近い入れ物へたどる
        return findRowsByStructure();
    }

    function findRowsByStructure() {
        const links = document.querySelectorAll('a[href*="/watch?v="][href*="list=WL"]');
        const rows = [];

        for (const link of links) {
            const row = climbToRow(link);

            if (row && !rows.includes(row) && isVisible(row)) {
                rows.push(row);
            }
        }

        return rows;
    }

    function climbToRow(link) {
        let el = link.parentElement;

        for (let i = 0; i < 8 && el && el !== document.body; i += 1) {
            if (findMenuButton(el) && countVideoIds(el) === 1) {
                return el;
            }

            el = el.parentElement;
        }

        return null;
    }

    function countVideoIds(el) {
        const ids = new Set();

        for (const a of el.querySelectorAll('a[href*="/watch?v="]')) {
            const match = a.getAttribute('href').match(/[?&]v=([\w-]+)/);

            if (match) {
                ids.add(match[1]);
            }
        }

        return ids.size;
    }

    function findNextRow() {
        return findAllRows().find((row) => !failedRows.has(row)) || null;
    }

    function rowTitle(row) {
        const titleEl = queryFirst(row, [
            '#video-title',
            'a#video-title',
            'h3',
            'a[href*="/watch?v="][title]'
        ]);

        if (!titleEl) {
            return 'タイトル不明';
        }

        const text = (titleEl.getAttribute('title') || titleEl.textContent || '').trim();

        return text || 'タイトル不明';
    }

    function findMenuButton(row) {
        for (const selector of MENU_BUTTON_SELECTORS) {
            const candidates = row.querySelectorAll(selector);

            for (const el of candidates) {
                if (el.closest('a')) {
                    continue;
                }

                const button = el.matches('button') ? el : (el.querySelector('button') || el);

                if (isVisible(button)) {
                    return button;
                }
            }
        }

        return null;
    }

    // ============================================================
    // メニュー
    // ============================================================

    function findRemoveItem() {
        const items = [];

        for (const popupSelector of POPUP_SELECTORS) {
            for (const popup of document.querySelectorAll(popupSelector)) {
                if (!isVisible(popup) || popup.closest('#' + PANEL_ID)) {
                    continue;
                }

                for (const itemSelector of MENU_ITEM_SELECTORS) {
                    for (const item of popup.querySelectorAll(itemSelector)) {
                        if (isVisible(item) && !items.includes(item)) {
                            items.push(item);
                        }
                    }
                }
            }
        }

        for (const pattern of REMOVE_TEXT_PATTERNS) {
            const hit = items.find((item) => pattern.test((item.textContent || '').replace(/\s+/g, ' ')));

            if (hit) {
                return hit;
            }
        }

        return null;
    }

    function clickItem(item) {
        // ytd-menu-service-item-renderer は中の tp-yt-paper-item でクリックを受ける
        const inner = item.querySelector('tp-yt-paper-item, button, [role="menuitem"]') || item;

        inner.click();
    }

    function closeMenus() {
        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            keyCode: 27,
            bubbles: true
        }));

        document.body.click();
    }

    function isRowGone(row) {
        return !row.isConnected || !isVisible(row);
    }

    async function removeRow(row) {
        row.scrollIntoView({ block: 'center' });

        const button = findMenuButton(row);

        if (!button) {
            return 'メニューボタンが見つからない';
        }

        button.click();

        const item = await waitFor(findRemoveItem, MENU_TIMEOUT_MS);

        if (!item) {
            closeMenus();

            return '「後で見るから削除」が見つからない';
        }

        clickItem(item);

        const gone = await waitFor(() => isRowGone(row), REMOVE_TIMEOUT_MS);

        if (!gone) {
            closeMenus();

            return '押したが一覧から消えない';
        }

        return null;
    }

    // ============================================================
    // 続きの読み込み
    // ============================================================

    async function loadMore() {
        const continuation = queryFirst(document, CONTINUATION_SELECTORS);

        if (!continuation) {
            return false;
        }

        continuation.scrollIntoView({ block: 'end' });
        window.scrollTo(0, document.documentElement.scrollHeight);

        const appeared = await waitFor(() => findNextRow(), LOAD_MORE_TIMEOUT_MS, 200);

        return !!appeared;
    }

    // ============================================================
    // 実行
    // ============================================================

    async function run() {
        if (running) {
            return;
        }

        const first = findAllRows();

        if (first.length === 0) {
            setStatus('消す動画が見つかりません');

            return;
        }

        const ok = window.confirm(
            '「後で見る」の動画を全部削除します。\n'
            + '元には戻せません。よろしいですか？\n\n'
            + '（途中で止めるときは、同じボタンを押してください）'
        );

        if (!ok) {
            return;
        }

        running = true;
        stopRequested = false;
        removedCount = 0;
        failedCount = 0;
        failedRows = new WeakSet();

        let consecutiveFailures = 0;
        let endReason = '完了';

        render();

        while (true) {
            if (stopRequested) {
                endReason = '停止しました';
                break;
            }

            if (!isWatchLaterPage()) {
                endReason = 'ページを離れたので止めました';
                break;
            }

            let row = findNextRow();

            if (!row) {
                setStatus('続きを読み込み中…');

                const more = await loadMore();

                if (!more) {
                    break;
                }

                row = findNextRow();

                if (!row) {
                    break;
                }
            }

            const title = rowTitle(row);
            const error = await removeRow(row);

            if (error) {
                failedRows.add(row);
                failedCount += 1;
                consecutiveFailures += 1;
                console.warn('[後で見る一括削除] 失敗:', title, error);

                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    endReason = '続けて失敗したので止めました（' + error + '）';
                    break;
                }
            } else {
                removedCount += 1;
                consecutiveFailures = 0;
            }

            render();

            await sleep(INTERVAL_MS);
        }

        running = false;

        let message = endReason + '：' + removedCount + '件削除';

        if (failedCount > 0) {
            message += '（失敗' + failedCount + '件）';
        }

        setStatus(message);
        render();
    }

    function onButtonClick() {
        if (running) {
            stopRequested = true;
            setStatus('止めています…');

            return;
        }

        run();
    }

    // ============================================================
    // 表示
    // ============================================================

    function setStatus(text) {
        lastMessage = text;

        const status = document.getElementById(STATUS_ID);

        if (status) {
            status.textContent = text;
            status.style.display = text ? 'block' : 'none';
        }
    }

    function buildPanel() {
        const panel = document.createElement('div');
        panel.id = PANEL_ID;

        Object.assign(panel.style, {
            position: 'fixed',
            right: '24px',
            bottom: '24px',
            zIndex: '2300',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: '6px',
            fontFamily: 'Roboto, Arial, sans-serif'
        });

        const status = document.createElement('div');
        status.id = STATUS_ID;

        Object.assign(status.style, {
            display: 'none',
            maxWidth: '320px',
            padding: '6px 10px',
            borderRadius: '8px',
            fontSize: '12px',
            lineHeight: '1.4',
            color: 'var(--yt-spec-text-primary, #0f0f0f)',
            background: 'var(--yt-spec-menu-background, var(--yt-spec-base-background, #fff))',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.25)'
        });

        const button = document.createElement('button');
        button.id = BUTTON_ID;
        button.type = 'button';

        Object.assign(button.style, {
            padding: '10px 16px',
            border: 'none',
            borderRadius: '18px',
            fontSize: '14px',
            fontWeight: '500',
            cursor: 'pointer',
            color: '#fff',
            background: '#cc0000',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)'
        });

        button.addEventListener('click', onButtonClick);

        panel.append(status, button);

        return panel;
    }

    function render() {
        let panel = document.getElementById(PANEL_ID);

        if (!isWatchLaterPage()) {
            if (panel) {
                panel.remove();
            }

            return;
        }

        if (!panel) {
            panel = buildPanel();
            document.body.appendChild(panel);
            setStatus(lastMessage === '未実行' ? '' : lastMessage);
        }

        const button = document.getElementById(BUTTON_ID);
        const label = running
            ? LABEL_STOP_PREFIX + '（' + removedCount + '件削除済み）'
            : LABEL_IDLE;

        if (button.textContent !== label) {
            button.textContent = label;
        }

        button.style.background = running ? '#606060' : '#cc0000';
    }

    function scheduleApply() {
        clearTimeout(applyTimer);
        applyTimer = setTimeout(render, APPLY_DEBOUNCE_MS);
    }

    // ============================================================
    // 起動
    // ============================================================

    function start() {
        render();

        document.addEventListener('yt-navigate-finish', scheduleApply);
        window.addEventListener('popstate', scheduleApply);

        // サイト側の描き直しで自作パネルが消えたら作り直す
        const observer = new MutationObserver((mutations) => {
            const onlySelf = mutations.every((m) =>
                m.target.closest && m.target.closest('#' + PANEL_ID));

            if (onlySelf) {
                return;
            }

            const hasPanel = !!document.getElementById(PANEL_ID);

            if (hasPanel !== isWatchLaterPage()) {
                scheduleApply();
            }
        });

        observer.observe(document.body, {
            childList: true
        });
    }

    // ============================================================
    // 診断
    // ============================================================

    window.__tmYtWatchLaterClear = {
        dump() {
            const rows = findAllRows().map((row, index) => ({
                '番号': index + 1,
                'タイトル': rowTitle(row),
                '行の要素': row.tagName.toLowerCase(),
                '︙ボタン': findMenuButton(row) ? '○' : '×',
                '失敗済み': failedRows.has(row) ? '★' : ''
            }));

            console.log('[後で見る一括削除] 後で見るのページ:', isWatchLaterPage(),
                '/ 実行中:', running,
                '/ 削除:', removedCount,
                '/ 失敗:', failedCount,
                '/ 最後の表示:', lastMessage,
                '/ 続きの読み込み口:', !!queryFirst(document, CONTINUATION_SELECTORS),
                '/ 開いているメニューの削除項目:', findRemoveItem());
            console.table(rows);

            return rows;
        },
        stop() {
            stopRequested = true;
        }
    };

    if (document.body) {
        start();
    } else {
        document.addEventListener('DOMContentLoaded', start);
    }
})();
