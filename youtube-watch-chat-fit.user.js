// ==UserScript==
// @name         YouTube チャット高さ調整 v1.0.0
// @namespace    local.hiro.tools
// @version      1.0.0
// @description  ウインドウが狭く、ライブチャットが映像の下に出る並びのとき、チャット欄を画面に収まる高さまで縮める。映像・流れるチャット・入力欄（スーパーチャット等のボタンを含む）が、ページをスクロールしなくても一画面に入る。もともと収まっているときと、チャットが映像の横にあるときは何もしない
// @match        https://www.youtube.com/*
// @grant        none
// @run-at       document-start
// @noframes
// @homepageURL  https://github.com/hirodiver/tampermonkey-scripts
// @supportURL   https://github.com/hirodiver/tampermonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/youtube-watch-chat-fit.user.js
// @updateURL    https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/youtube-watch-chat-fit.user.js
// ==/UserScript==

(function () {
    'use strict';

    /*
     * チャット欄の中身（入力欄を含む）は live_chat の iframe で、iframe の高さは
     * 外側の ytd-live-chat-frame に合わせて伸び縮みする。入力欄は iframe の一番下に
     * 固定されているので、外枠を縮めれば入力欄は画面内に上がってくる。
     *
     * 高さは「ページ最上部（スクロール 0）のときにチャットの下端が画面の下端に来る値」。
     * YouTube 自身が付ける高さより短いときだけ縮め、長くはしない。
     * 入力欄の表示・非表示（YouTube チャット入力欄切替）は iframe の中の話なので、
     * このスクリプトとは干渉しない。
     */

    // ============================================================
    // 設定
    // ============================================================

    // チャット欄の下に残す余白（px）。チャット枠の角丸と影が切れない程度
    const BOTTOM_MARGIN = 8;

    // これより短くはしない（px）。画面がとても低いときに、流れるチャットが
    // 1〜2行しか見えなくなるのを防ぐ。このときはページを少しスクロールして使う
    const MIN_CHAT_HEIGHT = 240;

    // 「チャットが映像の下にある」とみなす、チャット上端と映像下端のずれの許容（px）
    const BELOW_TOLERANCE = 4;

    // 変化を受けてから計算し直すまでの待ち時間（ms）
    const DEBOUNCE_MS = 80;

    // 書き換えるスタイル
    const STYLE_PROPS = [
        'height',
        'min-height',
        'max-height'
    ];

    // ============================================================
    // 要素探し（構造で狙い、ID・クラスは新旧を順に試す）
    // ============================================================

    const chatSelectors = [
        'ytd-watch-flexy ytd-live-chat-frame#chat',     // 現行
        'ytd-live-chat-frame',                          // ID が変わったとき
        '#chat:has(> iframe#chatframe)',                // 要素名が変わったとき
        '#chat-container > *:has(iframe[src*="live_chat"])'
    ];

    const playerSelectors = [
        'ytd-watch-flexy #player-full-bleed-container', // 映像の下に全幅で並ぶ版
        'ytd-watch-flexy #player-container-outer',
        'ytd-watch-flexy #player-container',
        'ytd-watch-flexy #ytd-player',
        '#movie_player',                                // 保険
        '.html5-video-player'
    ];

    function isVisible(el) {
        if (!el || !el.isConnected) {
            return false;
        }

        const rect = el.getBoundingClientRect();

        return rect.width > 0 && rect.height > 0;
    }

    function findFirst(selectors) {
        for (const selector of selectors) {
            let list;

            try {
                list = document.querySelectorAll(selector);
            } catch (e) {
                // :has() が使えない古いブラウザ
                continue;
            }

            for (const el of list) {
                if (isVisible(el)) {
                    return { el, selector };
                }
            }
        }

        return { el: null, selector: '' };
    }

    // ============================================================
    // スタイルの付け外し（YouTube が付けたインラインスタイルは覚えて戻す）
    // ============================================================

    const originalStyles = new WeakMap();

    // いま手を入れている要素と、入れた高さ
    let fittedEl = null;
    let fittedHeight = 0;

    function rememberOriginal(el) {
        if (originalStyles.has(el)) {
            return;
        }

        const saved = {};

        for (const prop of STYLE_PROPS) {
            saved[prop] = {
                value: el.style.getPropertyValue(prop),
                priority: el.style.getPropertyPriority(prop)
            };
        }

        originalStyles.set(el, saved);
    }

    function restoreOriginal(el) {
        const saved = originalStyles.get(el);

        if (!saved) {
            return;
        }

        for (const prop of STYLE_PROPS) {
            if (saved[prop].value) {
                el.style.setProperty(
                    prop,
                    saved[prop].value,
                    saved[prop].priority
                );
            } else {
                el.style.removeProperty(prop);
            }
        }
    }

    function applyHeight(el, height) {
        rememberOriginal(el);

        const px = height + 'px';

        el.style.setProperty('height', px, 'important');
        el.style.setProperty('min-height', '0px', 'important');
        el.style.setProperty('max-height', px, 'important');

        el.dataset.tmChatFit = String(height);
    }

    function release(el) {
        if (!el) {
            return;
        }

        restoreOriginal(el);
        originalStyles.delete(el);
        delete el.dataset.tmChatFit;
    }

    // ============================================================
    // 高さの計算
    // ============================================================

    // 最後の判定結果（診断用）
    let lastResult = { state: 'まだ判定していない' };

    function measure() {
        const chat = findFirst(chatSelectors);
        const player = findFirst(playerSelectors);

        const result = {
            state: '',
            chatSelector: chat.selector,
            playerSelector: player.selector,
            viewportHeight: document.documentElement.clientHeight,
            scrollY: Math.round(window.scrollY),
            chatTopInPage: null,
            naturalHeight: null,
            availableHeight: null,
            appliedHeight: null
        };

        // 前に手を入れた要素が差し替わっていたら、古い方は戻しておく
        if (fittedEl && fittedEl !== chat.el) {
            release(fittedEl);
            fittedEl = null;
            fittedHeight = 0;
        }

        if (document.fullscreenElement) {
            result.state = '全画面表示中のため何もしない';
            return { result, chatEl: null, height: 0 };
        }

        if (!chat.el) {
            result.state = 'チャット欄が見つからない（ライブでない・閉じている）';
            return { result, chatEl: null, height: 0 };
        }

        if (chat.el.hasAttribute('collapsed')) {
            result.state = 'チャット欄は折りたたまれている';
            return { result, chatEl: chat.el, height: 0 };
        }

        // YouTube 自身の高さを測る。同じ処理の中で戻すので画面には出ない
        if (fittedEl === chat.el) {
            restoreOriginal(chat.el);
        }

        const chatRect = chat.el.getBoundingClientRect();
        const naturalHeight = Math.round(chatRect.height);
        const chatTopInPage = Math.round(chatRect.top + window.scrollY);

        result.naturalHeight = naturalHeight;
        result.chatTopInPage = chatTopInPage;

        if (!player.el) {
            result.state = '映像が見つからない';
            return { result, chatEl: chat.el, height: 0 };
        }

        const playerRect = player.el.getBoundingClientRect();

        // 横並び（チャットが映像の右）なら、YouTube が画面に合わせているので触らない
        const isBelowPlayer = chatRect.top >= playerRect.bottom - BELOW_TOLERANCE;

        if (!isBelowPlayer) {
            result.state = 'チャットは映像の横にある（何もしない）';
            return { result, chatEl: chat.el, height: 0 };
        }

        const available = Math.floor(
            result.viewportHeight - chatTopInPage - BOTTOM_MARGIN
        );

        result.availableHeight = available;

        if (naturalHeight <= available) {
            result.state = 'もともと画面に収まっている（何もしない）';
            return { result, chatEl: chat.el, height: 0 };
        }

        const height = Math.max(MIN_CHAT_HEIGHT, available);

        if (height >= naturalHeight) {
            result.state = '最小の高さより縮められない（何もしない）';
            return { result, chatEl: chat.el, height: 0 };
        }

        result.state = available < MIN_CHAT_HEIGHT
            ? '縮めた（画面が低いので最小の高さで止めた）'
            : '縮めた';
        result.appliedHeight = height;

        // height は枠線・内側余白を含まない（content-box）ことがあるので、そのぶんを引く
        const style = getComputedStyle(chat.el);
        const extra = style.boxSizing === 'border-box'
            ? 0
            : Math.max(0, chatRect.height - parseFloat(style.height || '0'));

        return {
            result,
            chatEl: chat.el,
            height: Math.round(height - extra)
        };
    }

    function update() {
        const { result, chatEl, height } = measure();

        lastResult = result;

        if (chatEl && height > 0) {
            applyHeight(chatEl, height);
            fittedEl = chatEl;
            fittedHeight = height;
            watchSize(chatEl);
            watchChatStyle(chatEl);
            return;
        }

        if (fittedEl) {
            release(fittedEl);
            fittedEl = null;
            fittedHeight = 0;
        }

        watchChatStyle(null);

        if (chatEl) {
            watchSize(chatEl);
        }
    }

    // ============================================================
    // 計算し直すきっかけ
    // ============================================================

    let timer = null;

    // YouTube のページは常にどこかが書き換わっているので、待ちを延ばし続けると
    // いつまでも計算されない。予約済みなら新しく予約しない（間引き）
    function scheduleUpdate(delay) {
        if (timer !== null) {
            return;
        }

        timer = setTimeout(
            () => {
                timer = null;
                update();
            },
            delay === undefined ? DEBOUNCE_MS : delay
        );
    }

    // 映像の大きさ（シアターモード・ウインドウ幅）とチャット枠の入れ替わりを見張る
    const watchedForSize = new WeakSet();

    const resizeObserver = typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => scheduleUpdate())
        : null;

    function watchSize(chatEl) {
        if (!resizeObserver) {
            return;
        }

        const targets = [
            findFirst(playerSelectors).el,
            chatEl && chatEl.parentElement
        ];

        for (const el of targets) {
            if (el && !watchedForSize.has(el)) {
                watchedForSize.add(el);
                resizeObserver.observe(el);
            }
        }
    }

    const mutationObserver = new MutationObserver(() => scheduleUpdate());

    // YouTube がチャット枠のスタイルを書き直して、こちらの高さが消えたら付け直す。
    // 自分で付けた直後の変化（高さがこちらの値のまま）は無視する（無限ループ防止）
    const chatStyleObserver = new MutationObserver(() => {
        if (!fittedEl) {
            return;
        }

        const height = fittedEl.style.getPropertyValue('height');
        const priority = fittedEl.style.getPropertyPriority('height');

        if (height !== fittedHeight + 'px' || priority !== 'important') {
            scheduleUpdate(0);
        }
    });

    let styleWatchedEl = null;

    function watchChatStyle(chatEl) {
        if (styleWatchedEl === chatEl) {
            return;
        }

        chatStyleObserver.disconnect();
        styleWatchedEl = chatEl;

        if (chatEl) {
            chatStyleObserver.observe(chatEl, {
                attributes: true,
                attributeFilter: ['style']
            });
        }
    }

    function startObserving() {
        mutationObserver.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            // 並び替え（横並び⇔縦並び）・折りたたみ・シアターモードで変わる属性
            attributeFilter: [
                'collapsed',
                'hidden',
                'theater',
                'fullscreen',
                'is-two-columns_'
            ]
        });
    }

    window.addEventListener('resize', () => scheduleUpdate());
    document.addEventListener('fullscreenchange', () => scheduleUpdate());
    document.addEventListener('yt-navigate-finish', () => scheduleUpdate(300));
    document.addEventListener('yt-page-data-updated', () => scheduleUpdate(300));

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            startObserving();
            scheduleUpdate(0);
        });
    } else {
        startObserving();
        scheduleUpdate(0);
    }

    // ============================================================
    // 診断
    // ============================================================

    window.__tmWatchChatFit = {
        dump() {
            update();
            console.table([lastResult]);
            return lastResult;
        },
        update
    };
})();
