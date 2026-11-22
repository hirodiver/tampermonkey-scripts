// ==UserScript==
// @name         出前館 到着確認 v1.1.0
// @namespace    local.hiro.tools
// @version      1.1.0
// @description  カートで自分で「注文を完了する」を押した後に出る「お届け時間に変更があります」確認モーダルの「注文を完了する」ボタンを自動でクリックする
// @author       hirodiver
// @match        https://demae-can.com/*
// @match        https://*.demae-can.com/*
// @run-at       document-idle
// @grant        none
// @homepageURL  https://github.com/hirodiver/tampermonkey-scripts
// @supportURL   https://github.com/hirodiver/tampermonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/demae-can-confirm.user.js
// @updateURL    https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/demae-can-confirm.user.js
// ==/UserScript==

// -----------------------------------------------------------------------------
// 対象: カートで最初の「注文を完了する」を押した後、混雑等で到着時刻が変わった場合に
// 出る「お届け時間に変更があります」確認モーダル。このモーダルの中の「注文を完了する」
// ボタンを押さないと注文が確定しない仕様のため、自動でクリックして進める。
//
// 注文を勝手に確定させないよう、次の3つをすべて満たすボタンだけを押す。
//
//   1. 利用者が自分で注文のボタンを押してから USER_CLICK_WINDOW_MS 以内
//      （スクリプトの click() は isTrusted が false なので、ここには数えない）
//   2. 利用者が押した時点では画面に無かったボタン（＝その後に出たモーダルのボタン）
//   3. ボタンを囲むダイアログ（role="dialog" など、または画面に固定された重ね表示）の
//      中に「お届け時間」「変更」がある
//
// v1.0.x は祖先8段の文字だけで判定していたため、カートに「お届け時間 … 変更」の行が
// あると、カート本体の「注文を完了する」まで押していた。
// -----------------------------------------------------------------------------

(function () {
    'use strict';

    // ============================================================
    // 設定
    // ============================================================

    // 自動で押すボタンの文字（完全一致）
    const CONFIRM_BUTTON_TEXT = '注文を完了する';

    // ダイアログの中にこの文字があれば「お届け時間の変更」モーダルとみなす
    const CONFIRM_TITLE_PATTERN = /お届け時間.*変更/;

    // 利用者が押したとみなすボタンの文字（部分一致。文言が少し変わっても動くように）
    const USER_ORDER_BUTTON_PATTERN = /注文/;

    // 利用者が押してから、自動で押してよい時間
    const USER_CLICK_WINDOW_MS = 2 * 60 * 1000;

    // モーダルを見つけてから押すまでの待ち時間
    const CLICK_DELAY_MS = 500;

    // DOM の変化をまとめて処理する待ち時間
    const SCAN_DEBOUNCE_MS = 100;

    // ダイアログを探して祖先をさかのぼる段数
    const ANCESTOR_SEARCH_DEPTH = 12;

    const BUTTON_SELECTOR = 'button, [role="button"], a';

    const DIALOG_SELECTOR = [
        '[role="dialog"]',
        '[role="alertdialog"]',
        '[aria-modal="true"]',
        'dialog'
    ].join(', ');

    // ============================================================
    // 状態
    // ============================================================

    // 利用者が最後に注文のボタンを押した時刻（0 = まだ押していない）
    let userClickedAt = 0;

    // 利用者が押した時点で画面にあった「注文を完了する」ボタン（自動では押さない）
    let buttonsAtUserClick = new WeakSet();

    // 押す予約をしたボタン（同じボタンを二度押さない）
    const processedButtons = new WeakSet();

    let scanTimer = null;

    // ============================================================
    // 判定
    // ============================================================

    function isVisible(el) {
        return !!(el.offsetParent || el.getClientRects().length);
    }

    function isConfirmButton(el) {
        return el.textContent?.trim() === CONFIRM_BUTTON_TEXT;
    }

    function isDialogElement(el) {
        if (el.matches(DIALOG_SELECTOR)) {
            return true;
        }

        // role が付いていない重ね表示に備え、画面に固定された要素もダイアログとみなす
        return getComputedStyle(el).position === 'fixed';
    }

    // ボタンを囲む一番近いダイアログを返す（無ければ null）
    function findDialog(button) {
        let node = button.parentElement;

        for (let i = 0; i < ANCESTOR_SEARCH_DEPTH && node; i++) {
            if (node === document.body || node === document.documentElement) {
                return null;
            }

            if (isDialogElement(node)) {
                return node;
            }

            node = node.parentElement;
        }

        return null;
    }

    function isInsideChangeModal(button) {
        const dialog = findDialog(button);

        return !!dialog && CONFIRM_TITLE_PATTERN.test(dialog.textContent || '');
    }

    function isWithinUserClickWindow() {
        return userClickedAt > 0 && Date.now() - userClickedAt <= USER_CLICK_WINDOW_MS;
    }

    // ============================================================
    // 利用者のクリックを記録
    // ============================================================

    document.addEventListener('click', (event) => {
        // スクリプトの click() は isTrusted が false
        if (!event.isTrusted) {
            return;
        }

        const target = event.target instanceof Element
            ? event.target.closest(BUTTON_SELECTOR)
            : null;

        if (!target || !USER_ORDER_BUTTON_PATTERN.test(target.textContent || '')) {
            return;
        }

        userClickedAt = Date.now();
        buttonsAtUserClick = new WeakSet();

        document.querySelectorAll(BUTTON_SELECTOR).forEach((el) => {
            if (isConfirmButton(el)) {
                buttonsAtUserClick.add(el);
            }
        });

        scheduleScan();
    }, true);

    // ============================================================
    // 自動クリック
    // ============================================================

    function scan() {
        scanTimer = null;

        if (!isWithinUserClickWindow()) {
            return;
        }

        document.querySelectorAll(BUTTON_SELECTOR).forEach((button) => {
            if (processedButtons.has(button)) return;
            if (buttonsAtUserClick.has(button)) return;
            if (!isConfirmButton(button)) return;
            if (!isVisible(button)) return;
            if (!isInsideChangeModal(button)) return;

            processedButtons.add(button);

            setTimeout(() => {
                // 待つ間に閉じられた・外されたモーダルは押さない
                if (
                    button.isConnected &&
                    isVisible(button) &&
                    isInsideChangeModal(button) &&
                    isWithinUserClickWindow()
                ) {
                    button.click();
                }
            }, CLICK_DELAY_MS);
        });
    }

    function scheduleScan() {
        if (scanTimer) {
            return;
        }

        scanTimer = setTimeout(scan, SCAN_DEBOUNCE_MS);
    }

    // ============================================================
    // 監視
    // ============================================================

    // 要素の追加に加え、非表示から表示への切り替え（style・class など）も拾う
    const observer = new MutationObserver(scheduleScan);

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
            'style',
            'class',
            'hidden',
            'open',
            'aria-hidden'
        ]
    });

    // ============================================================
    // 診断
    // ============================================================

    // DevTools で window.__tmDemaeConfirm.dump() を実行すると、判定の内訳を表で出す
    window.__tmDemaeConfirm = {
        dump() {
            const rows = [];

            document.querySelectorAll(BUTTON_SELECTOR).forEach((button) => {
                if (!isConfirmButton(button)) return;

                const dialog = findDialog(button);

                rows.push({
                    id: button.id || '',
                    visible: isVisible(button),
                    presentAtUserClick: buttonsAtUserClick.has(button),
                    dialog: dialog ? (dialog.getAttribute('role') || dialog.tagName.toLowerCase()) : '（なし）',
                    titleMatched: !!dialog && CONFIRM_TITLE_PATTERN.test(dialog.textContent || ''),
                    processed: processedButtons.has(button)
                });
            });

            console.log('利用者が押してからの経過（秒）:', userClickedAt ? Math.round((Date.now() - userClickedAt) / 1000) : '未操作');
            console.table(rows);
            return rows;
        }
    };
})();
