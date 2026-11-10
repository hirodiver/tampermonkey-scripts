// ==UserScript==
// @name         YouTube チャット高さ調整 v1.2.0
// @namespace    local.hiro.tools
// @version      1.2.0
// @description  ウインドウが狭く、ライブチャットが映像の下に出る並びのとき、上の YouTube ロゴ・検索の帯を隠し、チャット上部の見出しとスーパーチャットの帯を細い帯1本（強調ワード・非表示リストのボタンだけ）にし、映像とチャット欄のあいだの余白を詰め、チャット欄を画面に収まる高さまで縮める。映像・流れるチャット・入力欄（スーパーチャット等のボタンを含む）が、ページをスクロールしなくても一画面に入る。チャットが映像の横にある広い窓では何もしない
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

    // 縦並びのとき、映像とチャット欄のあいだに残す余白（px）。
    // YouTube は 30px ほど空けているので、ここまで詰める
    const PLAYER_GAP = 4;

    // 映像とチャット欄のあいだがこれより広いときは、何か別の物が挟まっているとみなし、
    // 詰めない（px）
    const MAX_GAP_TO_CLOSE = 80;

    // 変化を受けてから計算し直すまでの待ち時間（ms）
    const DEBOUNCE_MS = 80;

    // 縦並びのとき、ページ上部の YouTube ロゴ・検索の帯を隠すか
    const HIDE_MASTHEAD = true;

    // 縦並びのとき、チャット上部の見出し（「チャット ∨」「⋮」「×」）と
    // スーパーチャットの帯を隠すか。隠すと「⋮」「×」と上位チャットの切替は使えない
    const COMPACT_CHAT_HEADER = true;

    // 見出しを隠したとき、強調ワード・非表示リストのボタン用に残す細い帯の高さ（px）。
    // どちらのスクリプトも入っていなければ帯も消す
    const COMPACT_STRIP_HEIGHT = 40;

    // 書き換えるスタイル
    const STYLE_PROPS = [
        'height',
        'min-height',
        'max-height',
        'margin-top'
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

    // いま手を入れている要素と、入れたスタイル（{ 'height': '612px', ... }）
    let fittedEl = null;
    let fittedStyles = null;

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

    // styles に無いものは YouTube の元の値に戻す
    function applyStyles(el, styles) {
        rememberOriginal(el);
        restoreOriginal(el);

        for (const prop of Object.keys(styles)) {
            el.style.setProperty(prop, styles[prop], 'important');
        }

        if (styles.height) {
            el.dataset.tmChatFit = String(parseInt(styles.height, 10));
        } else {
            delete el.dataset.tmChatFit;
        }

        if (styles['margin-top']) {
            el.dataset.tmChatGap = String(parseInt(styles['margin-top'], 10));
        } else {
            delete el.dataset.tmChatGap;
        }
    }

    function release(el) {
        if (!el) {
            return;
        }

        restoreOriginal(el);
        originalStyles.delete(el);
        delete el.dataset.tmChatFit;
        delete el.dataset.tmChatGap;
    }

    // ============================================================
    // 縦並びのときに上の帯を減らす
    // ============================================================

    // ページ側（ロゴ・検索の帯）の目印
    const PAGE_COMPACT_ATTR = 'data-tm-chat-fit';

    // チャットの iframe 側の目印（強調ワード・非表示リストもこれを見て位置を変える）
    const CHAT_COMPACT_ATTR = 'data-tm-chat-compact';

    const CHAT_STYLE_ID = 'tm-chat-fit-compact-style';

    function injectPageStyle() {
        if (document.getElementById('tm-chat-fit-page-style')) {
            return;
        }

        const style = document.createElement('style');

        style.id = 'tm-chat-fit-page-style';

        // 上の帯は position: fixed で、本文は帯の高さぶん下げてある。
        // 帯を消し、その下げ幅も 0 にする
        style.textContent = `
            html[${PAGE_COMPACT_ATTR}] #masthead-container,
            html[${PAGE_COMPACT_ATTR}] ytd-masthead {
                display: none !important;
            }

            html[${PAGE_COMPACT_ATTR}] ytd-app {
                --ytd-masthead-height: 0px !important;
                --ytd-toolbar-height: 0px !important;
            }

            html[${PAGE_COMPACT_ATTR}] ytd-page-manager,
            html[${PAGE_COMPACT_ATTR}] #page-manager {
                margin-top: 0 !important;
            }
        `;

        (document.head || document.documentElement).appendChild(style);
    }

    function setPageCompact(on) {
        const root = document.documentElement;
        const want = on && HIDE_MASTHEAD;

        if (want === root.hasAttribute(PAGE_COMPACT_ATTR)) {
            return;
        }

        if (want) {
            injectPageStyle();
            root.setAttribute(PAGE_COMPACT_ATTR, '');
        } else {
            root.removeAttribute(PAGE_COMPACT_ATTR);
        }
    }

    // チャットの iframe（同じ www.youtube.com なので中を触れる）
    function chatDocument(chatEl) {
        const iframe = chatEl && chatEl.querySelector('iframe');

        if (!iframe) {
            return null;
        }

        watchIframeLoad(iframe);

        try {
            const doc = iframe.contentDocument;

            return doc && doc.documentElement ? doc : null;
        } catch (e) {
            return null;
        }
    }

    function injectChatStyle(doc) {
        if (doc.getElementById(CHAT_STYLE_ID)) {
            return;
        }

        const style = doc.createElement('style');

        style.id = CHAT_STYLE_ID;

        // 見出しは消さずに中身だけ見えなくし、ボタン用の細い帯として残す。
        // ボタンのスクリプトが無ければ帯ごと消す
        style.textContent = `
            html[${CHAT_COMPACT_ATTR}] yt-live-chat-header-renderer {
                display: block !important;
                height: ${COMPACT_STRIP_HEIGHT}px !important;
                min-height: 0 !important;
                padding: 0 !important;
                overflow: hidden !important;
            }

            html[${CHAT_COMPACT_ATTR}] yt-live-chat-header-renderer > * {
                visibility: hidden !important;
            }

            html[${CHAT_COMPACT_ATTR}]:not(:has(.tm-ychl-open, .tm-ychide-open)) yt-live-chat-header-renderer {
                display: none !important;
            }

            html[${CHAT_COMPACT_ATTR}] yt-live-chat-ticker-renderer,
            html[${CHAT_COMPACT_ATTR}] #ticker {
                display: none !important;
            }
        `;

        (doc.head || doc.documentElement).appendChild(style);
    }

    function setChatCompact(chatEl, on) {
        const doc = chatDocument(chatEl);

        if (!doc) {
            return;
        }

        const root = doc.documentElement;
        const want = on && COMPACT_CHAT_HEADER;

        if (want) {
            injectChatStyle(doc);
        }

        if (want === root.hasAttribute(CHAT_COMPACT_ATTR)) {
            return;
        }

        root.toggleAttribute(CHAT_COMPACT_ATTR, want);

        // 強調ワード・非表示リストのボタンに位置を測り直させる
        try {
            doc.defaultView.dispatchEvent(new Event('resize'));
        } catch (e) {
            // 何もしない（1秒ごとの見直しで追いつく）
        }
    }

    // チャットの iframe が読み込み直されたら（配信の切替など）付け直す
    const watchedIframes = new WeakSet();

    function watchIframeLoad(iframe) {
        if (watchedIframes.has(iframe)) {
            return;
        }

        watchedIframes.add(iframe);
        iframe.addEventListener('load', () => scheduleUpdate(0));
    }

    // ============================================================
    // 縦並びのときに上の帯を減らす
    // ============================================================

    // ページ側（ロゴ・検索の帯）の目印
    const PAGE_COMPACT_ATTR = 'data-tm-chat-fit';

    // チャットの iframe 側の目印（強調ワード・非表示リストもこれを見て位置を変える）
    const CHAT_COMPACT_ATTR = 'data-tm-chat-compact';

    const CHAT_STYLE_ID = 'tm-chat-fit-compact-style';

    function injectPageStyle() {
        if (document.getElementById('tm-chat-fit-page-style')) {
            return;
        }

        const style = document.createElement('style');

        style.id = 'tm-chat-fit-page-style';

        // 上の帯は position: fixed で、本文は帯の高さぶん下げてある。
        // 帯を消し、その下げ幅も 0 にする
        style.textContent = `
            html[${PAGE_COMPACT_ATTR}] #masthead-container,
            html[${PAGE_COMPACT_ATTR}] ytd-masthead {
                display: none !important;
            }

            html[${PAGE_COMPACT_ATTR}] ytd-app {
                --ytd-masthead-height: 0px !important;
                --ytd-toolbar-height: 0px !important;
            }

            html[${PAGE_COMPACT_ATTR}] ytd-page-manager,
            html[${PAGE_COMPACT_ATTR}] #page-manager {
                margin-top: 0 !important;
            }
        `;

        (document.head || document.documentElement).appendChild(style);
    }

    function setPageCompact(on) {
        const root = document.documentElement;
        const want = on && HIDE_MASTHEAD;

        if (want === root.hasAttribute(PAGE_COMPACT_ATTR)) {
            return;
        }

        if (want) {
            injectPageStyle();
            root.setAttribute(PAGE_COMPACT_ATTR, '');
        } else {
            root.removeAttribute(PAGE_COMPACT_ATTR);
        }
    }

    // チャットの iframe（同じ www.youtube.com なので中を触れる）
    function chatDocument(chatEl) {
        const iframe = chatEl && chatEl.querySelector('iframe');

        if (!iframe) {
            return null;
        }

        watchIframeLoad(iframe);

        try {
            const doc = iframe.contentDocument;

            return doc && doc.documentElement ? doc : null;
        } catch (e) {
            return null;
        }
    }

    function injectChatStyle(doc) {
        if (doc.getElementById(CHAT_STYLE_ID)) {
            return;
        }

        const style = doc.createElement('style');

        style.id = CHAT_STYLE_ID;

        // 見出しは消さずに中身だけ見えなくし、ボタン用の細い帯として残す。
        // ボタンのスクリプトが無ければ帯ごと消す
        style.textContent = `
            html[${CHAT_COMPACT_ATTR}] yt-live-chat-header-renderer {
                display: block !important;
                height: ${COMPACT_STRIP_HEIGHT}px !important;
                min-height: 0 !important;
                padding: 0 !important;
                overflow: hidden !important;
            }

            html[${CHAT_COMPACT_ATTR}] yt-live-chat-header-renderer > * {
                visibility: hidden !important;
            }

            html[${CHAT_COMPACT_ATTR}]:not(:has(.tm-ychl-open, .tm-ychide-open)) yt-live-chat-header-renderer {
                display: none !important;
            }

            html[${CHAT_COMPACT_ATTR}] yt-live-chat-ticker-renderer,
            html[${CHAT_COMPACT_ATTR}] #ticker {
                display: none !important;
            }
        `;

        (doc.head || doc.documentElement).appendChild(style);
    }

    function setChatCompact(chatEl, on) {
        const doc = chatDocument(chatEl);

        if (!doc) {
            return;
        }

        const root = doc.documentElement;
        const want = on && COMPACT_CHAT_HEADER;

        if (want) {
            injectChatStyle(doc);
        }

        if (want === root.hasAttribute(CHAT_COMPACT_ATTR)) {
            return;
        }

        root.toggleAttribute(CHAT_COMPACT_ATTR, want);

        // 強調ワード・非表示リストのボタンに位置を測り直させる
        try {
            doc.defaultView.dispatchEvent(new Event('resize'));
        } catch (e) {
            // 何もしない（1秒ごとの見直しで追いつく）
        }
    }

    // チャットの iframe が読み込み直されたら（配信の切替など）付け直す
    const watchedIframes = new WeakSet();

    function watchIframeLoad(iframe) {
        if (watchedIframes.has(iframe)) {
            return;
        }

        watchedIframes.add(iframe);
        iframe.addEventListener('load', () => scheduleUpdate(0));
    }

    // ============================================================
    // 高さの計算
    // ============================================================

    // 見出しを細くしているチャット枠
    let compactChatEl = null;

    // 最後の判定結果（診断用）
    let lastResult = { state: 'まだ判定していない' };

    function emptyResult(chat, player) {
        return {
            state: '',
            compact: false,
            chatSelector: chat.selector,
            playerSelector: player.selector,
            viewportHeight: document.documentElement.clientHeight,
            scrollY: Math.round(window.scrollY),
            playerTopInPage: null,
            gapBefore: null,
            gapAfter: null,
            chatTopInPage: null,
            naturalHeight: null,
            availableHeight: null,
            appliedHeight: null
        };
    }

    // 映像下端からチャット上端までの距離
    function gapBetween(playerEl, chatEl) {
        return Math.round(
            chatEl.getBoundingClientRect().top
            - playerEl.getBoundingClientRect().bottom
        );
    }

    /*
     * 判定して、チャット枠に付けるスタイルを決める。
     * 戻り値の styles が空なら何も付けない。
     */
    function decide() {
        const chat = findFirst(chatSelectors);
        const player = findFirst(playerSelectors);
        const result = emptyResult(chat, player);
        const none = (state, chatEl) => {
            result.state = state;
            return { result, chatEl, styles: {} };
        };

        // 前に手を入れた要素が差し替わっていたら、古い方は戻しておく
        if (fittedEl && fittedEl !== chat.el) {
            release(fittedEl);
            fittedEl = null;
            fittedStyles = null;
        }

        result.compact = false;

        if (document.fullscreenElement) {
            return none('全画面表示中のため何もしない', null);
        }

        if (!chat.el) {
            return none('チャット欄が見つからない（ライブでない・閉じている）', null);
        }

        if (chat.el.hasAttribute('collapsed')) {
            return none('チャット欄は折りたたまれている', chat.el);
        }

        if (!player.el) {
            return none('映像が見つからない', chat.el);
        }

        // YouTube 自身の位置と高さを測る。同じ処理の中で付け直すので画面には出ない
        if (fittedEl === chat.el) {
            restoreOriginal(chat.el);
        }

        // 横並び（チャットが映像の右）なら、YouTube が画面に合わせているので触らない。
        // 上の帯を隠しても映像とチャットは一緒に動くので、この判定は変わらない
        if (gapBetween(player.el, chat.el) < -BELOW_TOLERANCE) {
            return none('チャットは映像の横にある（何もしない）', chat.el);
        }

        // 上の帯を減らしてから、位置と高さを測る
        result.compact = true;
        setPageCompact(true);

        const styles = {};

        // 下で仮に margin を付けるので、その前に YouTube の元の値を覚えておく
        rememberOriginal(chat.el);

        // 1. 映像とのあいだを詰める（負の margin で引き上げる）
        const gap = gapBetween(player.el, chat.el);

        result.gapBefore = gap;

        if (gap > PLAYER_GAP && gap <= MAX_GAP_TO_CLOSE) {
            const marginTop = parseFloat(getComputedStyle(chat.el).marginTop) || 0;

            styles['margin-top'] = Math.round(marginTop - (gap - PLAYER_GAP)) + 'px';
            chat.el.style.setProperty('margin-top', styles['margin-top'], 'important');

            // 外側の余白と打ち消し合って思ったほど上がらなかったら、もう一度だけ足す
            const rest = gapBetween(player.el, chat.el) - PLAYER_GAP;

            if (rest > 0) {
                styles['margin-top'] = Math.round(parseFloat(styles['margin-top']) - rest) + 'px';
                chat.el.style.setProperty('margin-top', styles['margin-top'], 'important');
            }
        }

        result.gapAfter = gapBetween(player.el, chat.el);

        // 2. 画面に収まる高さ
        const chatRect = chat.el.getBoundingClientRect();
        const naturalHeight = Math.round(chatRect.height);
        const chatTopInPage = Math.round(chatRect.top + window.scrollY);

        result.naturalHeight = naturalHeight;
        result.chatTopInPage = chatTopInPage;
        result.playerTopInPage = Math.round(
            player.el.getBoundingClientRect().top + window.scrollY
        );

        const available = Math.floor(
            result.viewportHeight - chatTopInPage - BOTTOM_MARGIN
        );

        result.availableHeight = available;

        if (naturalHeight <= available) {
            result.state = 'もともと画面に収まっている（高さは触らない）';
            return { result, chatEl: chat.el, styles };
        }

        const height = Math.max(MIN_CHAT_HEIGHT, available);

        if (height >= naturalHeight) {
            result.state = '最小の高さより縮められない（高さは触らない）';
            return { result, chatEl: chat.el, styles };
        }

        result.state = available < MIN_CHAT_HEIGHT
            ? '縮めた（画面が低いので最小の高さで止めた）'
            : '縮めた';
        result.appliedHeight = height;

        // height は枠線・内側余白を含まない（content-box）ことがあるので、そのぶんを引く
        const computed = getComputedStyle(chat.el);
        const extra = computed.boxSizing === 'border-box'
            ? 0
            : Math.max(0, chatRect.height - parseFloat(computed.height || '0'));
        const px = Math.round(height - extra) + 'px';

        styles['height'] = px;
        styles['min-height'] = '0px';
        styles['max-height'] = px;

        return { result, chatEl: chat.el, styles };
    }

    function update() {
        const { result, chatEl, styles } = decide();

        lastResult = result;

        setPageCompact(result.compact);

        if (chatEl) {
            setChatCompact(chatEl, result.compact);
        }

        // 前の枠（作り直される前）の iframe にも目印が残らないようにする
        if (compactChatEl && compactChatEl !== chatEl) {
            setChatCompact(compactChatEl, false);
        }

        compactChatEl = result.compact ? chatEl : null;

        if (chatEl && Object.keys(styles).length > 0) {
            applyStyles(chatEl, styles);
            fittedEl = chatEl;
            fittedStyles = styles;
            watchSize(chatEl);
            watchChatStyle(chatEl);
            return;
        }

        if (fittedEl) {
            release(fittedEl);
            fittedEl = null;
            fittedStyles = null;
        }

        // 測るときに覚えた元の値は、もう要らない
        if (chatEl) {
            restoreOriginal(chatEl);
            originalStyles.delete(chatEl);
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
        if (!fittedEl || !fittedStyles) {
            return;
        }

        for (const prop of Object.keys(fittedStyles)) {
            const value = fittedEl.style.getPropertyValue(prop);
            const priority = fittedEl.style.getPropertyPriority(prop);

            if (value !== fittedStyles[prop] || priority !== 'important') {
                scheduleUpdate(0);
                return;
            }
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
