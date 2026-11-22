// ==UserScript==
// @name         Gemini 音声入力キー v1.0.0
// @namespace    local.hiro.tools
// @version      1.0.0
// @description  Gemini（gemini.google.com）の音声入力を Ctrl+D で開始・停止する。Gemini 標準のキーは Ctrl+Shift+D で、Claude（「Claude 音声入力キー」）と同じ Ctrl+D にそろえる
// @match        https://gemini.google.com/*
// @grant        none
// @run-at       document-start
// @noframes
// @homepageURL  https://github.com/hirodiver/tampermonkey-scripts
// @supportURL   https://github.com/hirodiver/tampermonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/gemini-dictation-shortcut.user.js
// @updateURL    https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/gemini-dictation-shortcut.user.js
// ==/UserScript==

(function () {
    'use strict';

    /*
     * Ctrl+D を押すと、入力欄のマイクボタン（音声入力）を代わりに押す。
     * もう一度押すと、もう一度マイクボタンを押す（＝止まる）。
     * Gemini 標準の音声入力キーは Ctrl+Shift+D。Claude の Ctrl+D と手の動きをそろえるために作った。
     *
     * ■ ボタンの探し方（上から順に強い）
     *
     *   1. 音声入力の部品（speech-dictation-mic-button など）の中のボタン
     *   2. ラベル（aria-label 等）が「音声入力」「マイク」「Use microphone」など
     *   3. 直前に Ctrl+D で押したボタン（録音中にラベルが変わっても止められる）
     *   4. マイクの絵（mat-icon の mic）のボタン
     *
     *   どの段でも、サイドバー（チャット履歴）の中は探さない。履歴のタイトルに
     *   「音声入力」とあっても、そのメニューを押さない。
     *   Gemini Live（声で会話する別機能）・回答の停止・送信は押さない。
     *
     * ■ 見つからないとき
     *
     *   Gemini 標準の Ctrl+Shift+D を、作ったキーイベントとしてページに送る。
     *   ページがこれを受け付けるかは未確認（作ったイベントを無視するサイトもある）。
     *   あわせて画面下に「マイクボタンが見つかりません」と出す。
     *
     * ■ 診断
     *
     *   DevTools のコンソールで window.__tmGeminiDictation.dump()
     *   押す候補と、外したボタンとその理由を console.table で出す。
     */

    // ============================================================
    // 設定
    // ============================================================

    const VERSION = '1.0.0';

    /*
     * 音声入力を開始・停止するキー。
     * code は KeyboardEvent.code（キー配列に左右されない物理キー。D なら 'KeyD'）。
     * gemini.google.com の中では Chrome の「ブックマークに追加」（Ctrl+D）より先に受け取って打ち消す
     */
    const SHORTCUT = {
        code: 'KeyD',
        ctrl: true,
        alt: false,
        shift: false,
        meta: false
    };

    // マイクボタンが見つからないときに代わりに送る、Gemini 標準のキー（Ctrl+Shift+D）
    const FALLBACK_SHORTCUT = {
        key: 'D',
        code: 'KeyD',
        keyCode: 68,
        ctrl: true,
        alt: false,
        shift: true,
        meta: false
    };

    // マイクボタンを押したとき、画面下に短い知らせを出すか
    const SHOW_PRESS_TOAST = false;

    // 知らせを出しておく時間（ミリ秒）
    const TOAST_MS = 1500;

    // 見つからなかったときの知らせを出しておく時間（ミリ秒）
    const NOT_FOUND_TOAST_MS = 3000;

    // 直前に押したボタンを「止めるときも押すボタン」として覚えておく時間（ミリ秒）
    const LAST_PRESSED_MS = 10 * 60 * 1000;

    const TOAST_ID = 'tm-gemini-dictation-shortcut-toast';


    // ============================================================
    // 目印
    // ============================================================

    /*
     * 音声入力の部品の中のボタン。新旧の書き方を並べる。
     * Gemini の画面構造は公開の説明が無いため、どれも推測を含む
     */
    const DIRECT_SELECTORS = [
        'speech-dictation-mic-button button',      // 音声入力の部品
        '.mic-button-container button',            // 入れ物のクラス名
        'button.mic-button'                        // ボタン自身のクラス名
    ];

    // ここの中のボタンは探さない（サイドバー・チャット履歴）
    const EXCLUDED_AREA_SELECTORS = [
        'bard-sidenav',
        'side-navigation-content',
        'nav',
        '[role="navigation"]'
    ];

    // 音声入力ボタンのラベル（aria-label / title / 中の文字）。録音中の「録音を停止」等も当たる
    const DICTATE_LABEL_PATTERNS = [
        /^音声入力/,
        /^マイク/,
        /^録音/,
        /^use microphone/i,
        /^microphone/i,
        /^stop recording/i,
        /^voice (input|typing)/i,
        /dictat/i
    ];

    // マイクの絵（mat-icon の fonticon / data-mat-icon-name / 中の文字）
    const MIC_ICON_NAMES = [
        'mic',
        'mic_none',
        'mic_off'
    ];

    /*
     * 押さないボタンのラベル。
     * Gemini Live（声で会話する別機能）、回答の停止、送信
     */
    const NEVER_PRESS_LABEL_PATTERNS = [
        /\blive\b/i,
        /ライブ/,
        /stop (response|generating)/i,
        /回答を停止/,
        /生成を停止/,
        /^send/i,
        /送信/
    ];


    // ============================================================
    // 状態
    // ============================================================

    let lastPress = null;

    let toastTimer = null;


    // ============================================================
    // ボタンのラベル
    // ============================================================

    function labelOf(button) {

        const parts = [
            button.getAttribute('aria-label'),
            button.getAttribute('title'),
            button.getAttribute('mattooltip'),
            button.textContent
        ];

        return parts
            .map(part => (part || '').replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .join(' / ');
    }


    function iconNameOf(button) {

        const icon = button.querySelector('mat-icon');

        if (!icon) {
            return '';
        }


        return (
            icon.getAttribute('fonticon') ||
            icon.getAttribute('data-mat-icon-name') ||
            icon.textContent ||
            ''
        ).trim();
    }


    function matchesAny(text, patterns) {

        return patterns.some(pattern => pattern.test(text));
    }


    // ============================================================
    // マイクボタンを探す
    // ============================================================

    function isOwnElement(element) {

        return Boolean(element.closest('#' + TOAST_ID));
    }


    function isInExcludedArea(button) {

        return EXCLUDED_AREA_SELECTORS.some(selector => button.closest(selector));
    }


    /*
     * ボタン1つを判定する。
     * 押してよいなら { how }、押さないなら { reason } を返す
     */
    function classify(button) {

        const label = labelOf(button);

        if (isOwnElement(button)) {
            return { label, reason: 'このスクリプトの部品' };
        }

        if (isInExcludedArea(button)) {
            return { label, reason: 'サイドバーの中' };
        }

        if (button.disabled) {
            return { label, reason: '無効' };
        }

        if (matchesAny(label, NEVER_PRESS_LABEL_PATTERNS)) {
            return { label, reason: 'Live・停止・送信' };
        }


        if (DIRECT_SELECTORS.some(selector => button.matches(selector))) {
            return { label, how: '音声入力の部品' };
        }

        const ariaLabel = (button.getAttribute('aria-label') || '').trim();

        if (matchesAny(ariaLabel, DICTATE_LABEL_PATTERNS) || matchesAny(label, DICTATE_LABEL_PATTERNS)) {
            return { label, how: 'ラベル' };
        }

        if (lastPress && lastPress.button === button && Date.now() - lastPress.at < LAST_PRESSED_MS) {
            return { label, how: '直前に押したボタン' };
        }

        if (MIC_ICON_NAMES.includes(iconNameOf(button).toLowerCase())) {
            return { label, how: 'マイクの絵' };
        }


        return { label, reason: '音声入力と分からない' };
    }


    const HOW_ORDER = [
        '音声入力の部品',
        'ラベル',
        '直前に押したボタン',
        'マイクの絵'
    ];


    // 押す候補を強い順に並べて返す。chosen が押すボタン
    function findMicButton() {

        const candidates = [];

        const rejected = [];

        for (const button of document.querySelectorAll('button')) {

            const judged = classify(button);

            if (judged.how) {
                candidates.push({ button, ...judged });
            } else {
                rejected.push({ button, ...judged });
            }
        }


        candidates.sort((a, b) => HOW_ORDER.indexOf(a.how) - HOW_ORDER.indexOf(b.how));


        return {
            chosen: candidates.length ? candidates[0] : null,
            candidates,
            rejected
        };
    }


    // ============================================================
    // 押す
    // ============================================================

    function sendFallbackShortcut() {

        const target = document.activeElement || document.body || document;

        target.dispatchEvent(new KeyboardEvent('keydown', {
            key: FALLBACK_SHORTCUT.key,
            code: FALLBACK_SHORTCUT.code,
            keyCode: FALLBACK_SHORTCUT.keyCode,
            which: FALLBACK_SHORTCUT.keyCode,
            ctrlKey: FALLBACK_SHORTCUT.ctrl,
            altKey: FALLBACK_SHORTCUT.alt,
            shiftKey: FALLBACK_SHORTCUT.shift,
            metaKey: FALLBACK_SHORTCUT.meta,
            bubbles: true,
            cancelable: true,
            composed: true
        }));
    }


    function toggleDictation() {

        const result = findMicButton();

        if (result.chosen) {

            result.chosen.button.click();

            lastPress = {
                button: result.chosen.button,
                how: result.chosen.how,
                label: result.chosen.label,
                at: Date.now()
            };

            if (SHOW_PRESS_TOAST) {
                showToast('🎙 マイクボタンを押しました');
            }

            return true;
        }


        lastPress = {
            button: null,
            how: '見つからない（Ctrl+Shift+D を送った）',
            label: '',
            at: Date.now()
        };

        sendFallbackShortcut();

        showToast('マイクボタンが見つかりません。Ctrl+Shift+D を送りました', NOT_FOUND_TOAST_MS);

        return false;
    }


    // ============================================================
    // 知らせ
    // ============================================================

    function showToast(message, duration = TOAST_MS) {

        if (!document.body) {
            return;
        }


        let toast = document.getElementById(TOAST_ID);

        if (!toast) {

            toast = document.createElement('div');

            toast.id = TOAST_ID;

            toast.setAttribute('role', 'status');

            toast.setAttribute('aria-live', 'polite');

            Object.assign(toast.style, {
                position: 'fixed',
                left: '50%',
                bottom: '140px',
                transform: 'translateX(-50%)',
                maxWidth: 'min(90vw, 480px)',
                padding: '8px 14px',
                borderRadius: '8px',
                background: 'rgba(32, 32, 32, 0.92)',
                color: '#fff',
                font: '13px/1.5 system-ui, sans-serif',
                boxShadow: '0 4px 16px rgba(0, 0, 0, 0.25)',
                zIndex: '2147483647',
                pointerEvents: 'none',
                opacity: '0',
                transition: 'opacity 0.2s'
            });

            document.body.appendChild(toast);
        }


        toast.textContent = message;

        toast.style.opacity = '1';


        clearTimeout(toastTimer);

        toastTimer = setTimeout(() => {

            toast.style.opacity = '0';

        }, duration);
    }


    // ============================================================
    // キー
    // ============================================================

    function matchesShortcut(event, shortcut) {

        return event.code === shortcut.code &&
            event.ctrlKey === shortcut.ctrl &&
            event.altKey === shortcut.alt &&
            event.shiftKey === shortcut.shift &&
            event.metaKey === shortcut.meta;
    }


    function onKeyDown(event) {

        if (!matchesShortcut(event, SHORTCUT)) {
            return;
        }


        // ページ（Gemini）と Chrome のブックマークには渡さない
        event.preventDefault();

        event.stopImmediatePropagation();


        // 日本語の変換中は押さない（打ち消すだけ）
        if (event.isComposing || event.keyCode === 229) {
            return;
        }


        // 押しっぱなしの連打では1回だけ
        if (event.repeat) {
            return;
        }


        toggleDictation();
    }


    // ============================================================
    // 診断
    // ============================================================

    function rowOf(item) {

        return {
            '判定': item.how || '外す: ' + item.reason,
            'ラベル': item.label,
            'マイクの絵': iconNameOf(item.button),
            '親の部品': item.button.parentElement ? item.button.parentElement.tagName.toLowerCase() : ''
        };
    }


    function dump() {

        const result = findMicButton();

        const candidateRows = result.candidates.map((item, index) => ({
            '順位': index + 1,
            '押す': item === result.chosen ? '★' : '',
            ...rowOf(item)
        }));

        const rejectedRows = result.rejected
            .filter(item => item.reason !== 'このスクリプトの部品')
            .map(rowOf);


        console.log(`[Gemini 音声入力キー v${VERSION}] キー: Ctrl+D / 見つからないとき: Ctrl+Shift+D を送る`);

        console.log('直近に押したとき:', lastPress);

        console.log('■ 押す候補');

        console.table(candidateRows);

        console.log('■ 外したボタン');

        console.table(rejectedRows);


        return {
            version: VERSION,
            lastPress,
            candidates: candidateRows,
            rejected: rejectedRows
        };
    }


    // ============================================================
    // 起動
    // ============================================================

    // ページ（Gemini）より先にキーを受け取るため、window のキャプチャで登録する
    window.addEventListener('keydown', onKeyDown, true);


    window.__tmGeminiDictation = {
        version: VERSION,
        dump,
        press: toggleDictation
    };
})();
