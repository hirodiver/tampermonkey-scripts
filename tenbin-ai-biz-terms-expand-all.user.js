// ==UserScript==
// @name         天秤AI 約款一括展開 v1.0.0
// @namespace    local.hiro.tools
// @version      1.0.0
// @description  天秤AI Biz「主要AI約款比較」ページのアコーディオンを一括で開閉する
// @match        https://biz.tenbin.ai/trust*
// @run-at       document-idle
// @noframes
// @homepageURL  https://github.com/hirodiver/tampermonkey-scripts
// @supportURL   https://github.com/hirodiver/tampermonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/tenbin-ai-biz-terms-expand-all.user.js
// @updateURL    https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/tenbin-ai-biz-terms-expand-all.user.js
// ==/UserScript==

/*
 * 「主要AI約款比較」ページの各項目（B10, B11...）は
 * <div class="detail-card-header" onclick="toggleAcc(this.parentElement)">
 * を持ち、クリックのたびに親 <div class="detail-card"> の
 * open クラスが切り替わる作り。
 *
 * ページ側のグローバル関数 toggleAcc() を直接呼ぶのではなく、
 * 見出し要素へ click() を発行する。inline の onclick はページの
 * realm で定義されているため、isolated world から click() を
 * 発行するだけで正しく実行される（@inject-into page は不要）。
 *
 * 既に開いている項目（.detail-card.open）をクリックすると
 * 閉じてしまうため、状態を見てから必要な項目だけ操作する。
 *
 * ページ読み込み時に自動で全部開く。加えて、後から手動で
 * 全部閉じたい／開き直したい場合のために右下にボタンを置く。
 */

(function () {
    'use strict';

    // ============================================================
    // 設定
    // ============================================================

    // true にするとコンソールに処理ログを出す
    const DEBUG = false;

    // 起動直後の自動展開までの待ち時間（ミリ秒）。
    // ページ側の初期描画（一覧の生成）を待つ
    const INITIAL_DELAY = 500;

    // DOM変化後の再走査までの待ち時間（ミリ秒）
    const REBUILD_DELAY = 300;

    const CARD_SELECTOR = '.detail-card';
    const HEADER_SELECTOR = '.detail-card-header';
    const OPEN_CLASS = 'open';


    // ============================================================
    // 小物
    // ============================================================

    function log(...args) {

        if (DEBUG) {
            console.log('[天秤AI約款一括展開]', ...args);
        }
    }


    function getCards() {
        return [...document.querySelectorAll(CARD_SELECTOR)];
    }


    function isOpen(card) {
        return card.classList.contains(OPEN_CLASS);
    }


    /*
     * 見出しをクリックする。ページ側の onclick が
     * card の open クラスと本文の表示を切り替える
     */
    function toggleCard(card) {

        const header =
            card.querySelector(HEADER_SELECTOR);

        if (!header) {
            return false;
        }

        header.click();

        return true;
    }


    function setAllOpen(open) {

        const cards = getCards();

        let changed = 0;

        for (const card of cards) {

            if (isOpen(card) === open) {
                continue;
            }

            if (toggleCard(card)) {
                changed++;
            }
        }

        log(
            open ? '一括展開:' : '一括収納:',
            changed, '/', cards.length, '件'
        );

        return changed;
    }


    // ============================================================
    // 自動展開
    // ============================================================

    let expandTimer = null;
    let observing = false;

    function scheduleAutoExpand(delay = REBUILD_DELAY) {

        clearTimeout(expandTimer);

        expandTimer = setTimeout(() => {

            const cards = getCards();

            if (!cards.length) {
                return;
            }

            setAllOpen(true);

            /*
             * カードが一通り出そろったら監視を止める。
             * 手動で閉じた項目までここで開き直さないため
             */
            if (observer && observing) {

                observer.disconnect();

                observing = false;
            }

        }, delay);
    }


    const observer = new MutationObserver(() => {

        if (!observing) {
            return;
        }

        scheduleAutoExpand();
    });


    function startObserver() {

        if (!document.body) {
            return;
        }

        observing = true;

        observer.observe(
            document.body,
            {
                childList: true,
                subtree: true
            }
        );
    }


    // ============================================================
    // 操作パネル
    // ============================================================

    function injectPanel() {

        if (document.getElementById('tm-tenbin-expand-panel')) {
            return;
        }

        const panel = document.createElement('div');

        panel.id = 'tm-tenbin-expand-panel';

        panel.style.cssText = [
            'position:fixed',
            'right:16px',
            'bottom:16px',
            'z-index:2147483647',
            'display:flex',
            'gap:8px',
            'font-family:sans-serif'
        ].join(';');

        const makeButton = (label, onClick) => {

            const button = document.createElement('button');

            button.type = 'button';

            button.textContent = label;

            button.style.cssText = [
                'padding:8px 14px',
                'border:none',
                'border-radius:6px',
                'background:#3b5bdb',
                'color:#fff',
                'font-size:13px',
                'font-weight:500',
                'box-shadow:0 2px 6px rgba(0,0,0,0.25)',
                'cursor:pointer'
            ].join(';');

            button.addEventListener('click', onClick);

            return button;
        };

        panel.appendChild(
            makeButton('全部開く', () => setAllOpen(true))
        );

        panel.appendChild(
            makeButton('全部閉じる', () => setAllOpen(false))
        );

        document.body.appendChild(panel);
    }


    // ============================================================
    // 起動
    // ============================================================

    function start() {

        injectPanel();

        startObserver();

        scheduleAutoExpand(INITIAL_DELAY);
    }


    if (document.body) {

        start();

    } else {

        document.addEventListener(
            'DOMContentLoaded',
            start,
            { once: true }
        );
    }

})();
