// ==UserScript==
// @name         Claude 音声入力キー v1.0.1
// @namespace    local.hiro.tools
// @version      1.0.1
// @description  Claude Code（claude.ai/code）の音声入力を、マイクボタンをクリックする代わりに Ctrl+D で開始・停止する。入力欄に文字があってマイクボタンが隠れているときも押せる。通常のチャット（claude.ai）でも効く
// @match        https://claude.ai/*
// @grant        none
// @run-at       document-start
// @noframes
// @homepageURL  https://github.com/hirodiver/tampermonkey-scripts
// @supportURL   https://github.com/hirodiver/tampermonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/claude-dictation-shortcut.user.js
// @updateURL    https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/claude-dictation-shortcut.user.js
// ==/UserScript==

(function () {
    'use strict';

    /*
     * Ctrl+D を押すと、入力欄のマイクボタン（音声入力）を代わりに押す。
     * もう一度押すと、もう一度マイクボタンを押す（＝止まる）。
     * Ctrl+D は「デスクトップ版の Claude で効く」という利用者の報告があり選んだ
     * （公式の説明は無く、別の報告では「キーは無い」とされている。未確認）。
     *
     * ■ 入力欄の右端の構造（claude.ai の通常チャットで確認されたもの、2026-10）
     *
     *   .grid
     *     ├ [data-cds-part="send-slot"]  … 送信ボタン
     *     └ [data-cds-part="idle-slot"]  … 音声入力ボタン「Dictate」
     *                                       （右の ∨ はマイクの選択。押さない）
     *
     *   入力欄に文字があると idle-slot は inert + 不可視になり、送信ボタンに
     *   入れ替わる。消えたのではなく DOM に残っているので、キーからは押せる。
     *   Claude Code（claude.ai/code）でも同じ部品を使っている前提（未確認）。
     *
     * ■ ボタンの探し方（上から順に強い）
     *
     *   1. 覚えたボタン（下の「教える」で登録したもの）
     *   2. ラベル（aria-label 等）が「Dictate」「音声入力」など
     *   3. 直前に Ctrl+D で押したボタン（録音中にラベルが「Stop」等に変わっても止められる）
     *   4. 入力欄の idle-slot の中のボタン（ラベルが何語でも当たる）
     *   5. ラベルが「Microphone」「マイク」だけのボタン
     *   6. マイクの絵のボタン
     *
     *   4〜6 は、いま使っている入力欄の近くにあるものだけ。
     *   どの段でも、音声モード（声で会話する別機能）・録音の取り消し・
     *   マイクの選択（∨）・送信・停止・PR 作成などは押さない。
     *
     * ■ 見つからないとき（教える）
     *
     *   Ctrl+D で見つからなければ「マイクボタンを1回クリックすると覚えます」と出る。
     *   そのままマイクボタンをクリックすると覚え、次から Ctrl+D で押せる。
     *   Ctrl+Shift+D でいつでも覚え直せる。
     *
     * ■ 診断
     *
     *   DevTools のコンソールで window.__tmClaudeDictation.dump()
     *   見つけたボタンの候補と、入力欄のまわりのボタンを console.table で出す。
     *   覚えたボタンを忘れるには window.__tmClaudeDictation.forget()
     */

    // ============================================================
    // 設定
    // ============================================================

    const VERSION = '1.0.1';

    /*
     * 音声入力を開始・停止するキー。
     * code は KeyboardEvent.code（キー配列に左右されない物理キー。D なら 'KeyD'）。
     * claude.ai の中では Chrome の「ブックマークに追加」（Ctrl+D）より先に受け取って打ち消す
     */
    const SHORTCUT = {
        code: 'KeyD',
        ctrl: true,
        alt: false,
        shift: false,
        meta: false
    };

    // マイクボタンを覚え直すキー（既定は Ctrl+Shift+D）
    const LEARN_SHORTCUT = {
        code: 'KeyD',
        ctrl: true,
        alt: false,
        shift: true,
        meta: false
    };

    // マイクボタンを押したとき、画面下に短い知らせを出すか
    const SHOW_PRESS_TOAST = true;

    // 知らせを出しておく時間（ミリ秒）
    const TOAST_MS = 1500;

    // 「次にクリックしたボタンを覚える」状態を続ける時間（ミリ秒）
    const LEARN_TIMEOUT_MS = 15000;

    // 入力欄から何段さかのぼって「同じ入力欄のボタン」とみなすか
    const MAX_COMPOSER_DEPTH = 12;

    // 診断で「入力欄のまわりのボタン」として出す範囲（入力欄から何段まで）
    const DUMP_COMPOSER_DEPTH = 8;

    // 直前に押したボタンを「止めるときも押すボタン」として覚えておく時間（ミリ秒）
    const LAST_PRESSED_MS = 10 * 60 * 1000;

    // 覚えたボタンの目印を作るとき、祖先を何段まで見るか
    const CDS_PATH_DEPTH = 6;

    // 覚えたボタンの保存キー（localStorage。claude.ai の中だけに残る）
    const STORAGE_LEARNED = 'tm-claude-dictation-shortcut-learned';

    const TOAST_ID = 'tm-claude-dictation-shortcut-toast';


    // ============================================================
    // 目印
    // ============================================================

    /*
     * 音声入力ボタンのラベル（aria-label / title / 中の文字）。
     * 英語版は「Dictate」。日本語版の表記は未確認なので、ありそうな語を並べる。
     * 録音中に「Stop dictation」「録音を停止」等へ変わっても当たる
     */
    const DICTATE_LABEL_PATTERNS = [
        /dictat/i,
        /speech.?to.?text/i,
        /voice (input|typing)/i,
        /\b(recording|listening)\b/i,
        /音声入力/,
        /音声で入力/,
        /ディクテーション/,
        /口述/,
        /録音/
    ];

    // マイクとだけ書かれたボタン（保険。入力欄の近くにあるときだけ使う）
    const MIC_LABEL_PATTERNS = [
        /microphone/i,
        /\bmic\b/i,
        /マイク/
    ];

    /*
     * 押してはいけないボタン（覚えたボタン以外すべてに効く）。
     *   - 音声モード（声で会話する別機能）
     *   - 録音の取り消し（話した内容が消える）
     *   - マイクの選び直し（音声入力ボタンの右の ∨）
     */
    const EXCLUDE_LABEL_PATTERNS = [
        /voice mode/i,
        /音声モード/,
        /ボイスモード/,
        /会話/,
        /cancel|discard/i,
        /キャンセル|取り消|破棄/,
        /select|choose|change|switch|setting/i,
        /選択|選ぶ|切り替|切替|変更|設定/
    ];

    /*
     * ラベルで「音声入力」と分からないボタンのうち、押すと困るもの。
     * idle-slot やマイクの絵で拾ったボタン、教えるときのクリックに効く
     * （「音声入力を停止」のように音声入力のラベルなら、こちらには引っかけない）
     */
    const DANGER_LABEL_PATTERNS = [
        /send|submit|stop|interrupt|delete|archive|merge|create|pull request|\bpr\b/i,
        /送信|停止|中断|止め|削除|アーカイブ|マージ|作成/
    ];

    // 入力欄の右端で、音声入力ボタンが入る入れ物（claude.ai の通常チャットで確認）
    const DICTATE_SLOT_SELECTORS = [
        '[data-cds-part="idle-slot"]'
    ];

    // マイクの絵（保険）
    const MIC_ICON_SELECTORS = [
        'svg[class*="microphone" i]',
        'svg[class*="lucide-mic" i]',
        '[data-icon*="microphone" i]'
    ];

    // 入力欄
    const EDITOR_SELECTORS = [
        '[contenteditable="true"]',
        'textarea'
    ];

    // 押せる要素
    const BUTTON_SELECTOR = 'button, [role="button"]';

    // 判定の強さ（大きいほど優先）
    const LEVEL_LEARNED = 6;
    const LEVEL_LABEL = 5;
    const LEVEL_LAST_PRESSED = 4;
    const LEVEL_SLOT = 3;
    const LEVEL_MIC_LABEL = 2;
    const LEVEL_MIC_ICON = 1;

    const LEVEL_NAMES = {
        [LEVEL_LEARNED]: '覚えたボタン',
        [LEVEL_LABEL]: 'ラベル',
        [LEVEL_LAST_PRESSED]: '直前に押したボタン',
        [LEVEL_SLOT]: 'idle-slot',
        [LEVEL_MIC_LABEL]: 'マイクのラベル',
        [LEVEL_MIC_ICON]: 'マイクの絵'
    };


    // ============================================================
    // 状態
    // ============================================================

    // 最後にフォーカスがあった入力欄
    let lastEditor = null;

    // 「次にクリックしたボタンを覚える」状態（{ timer } か null）
    let learning = null;

    let toastTimer = null;

    // 直近に押したときの記録（診断用）
    let lastPress = null;

    // 直前に押したボタン（{ button, at } か null）
    let lastPressed = null;


    // ============================================================
    // 小物
    // ============================================================

    function matchesAny(text, patterns) {

        return Boolean(text) && patterns.some(pattern => pattern.test(text));
    }


    function readJson(key, fallback) {

        try {

            const raw = localStorage.getItem(key);

            return raw ? JSON.parse(raw) : fallback;

        } catch {

            return fallback;
        }
    }


    function writeJson(key, value) {

        try {

            if (value === null) {
                localStorage.removeItem(key);
            } else {
                localStorage.setItem(key, JSON.stringify(value));
            }

        } catch {

            // 保存できなくても、このページの間は動く
        }
    }


    function shortcutText(shortcut) {

        const keyName = shortcut.code
            .replace(/^Key/, '')
            .replace(/^Digit/, '');

        return [
            shortcut.ctrl ? 'Ctrl' : '',
            shortcut.alt ? 'Alt' : '',
            shortcut.shift ? 'Shift' : '',
            shortcut.meta ? 'Meta' : '',
            keyName
        ]
            .filter(Boolean)
            .join('+');
    }


    function isOwnElement(el) {

        return Boolean(el.closest('#' + TOAST_ID));
    }


    // ============================================================
    // ボタンのラベル・見え方
    // ============================================================

    function getLabel(el) {

        const aria = (el.getAttribute('aria-label') || '').trim();

        if (aria) {
            return aria;
        }


        const labelledBy = (el.getAttribute('aria-labelledby') || '')
            .split(/\s+/)
            .filter(Boolean)
            .map(id => document.getElementById(id))
            .filter(Boolean)
            .map(node => node.textContent.trim())
            .join(' ');

        if (labelledBy) {
            return labelledBy;
        }


        const title = (el.getAttribute('title') || '').trim();

        if (title) {
            return title;
        }


        const svgTitle = el.querySelector('svg title');

        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();

        return (text || (svgTitle ? svgTitle.textContent.trim() : '')).slice(0, 60);
    }


    // 画面に見えていて、人が押せる状態か（inert・不可視・透明・大きさ0 は見えていない扱い）
    function isShown(el) {

        if (!el.isConnected || el.closest('[inert]')) {
            return false;
        }


        const rect = el.getBoundingClientRect();

        if (rect.width === 0 || rect.height === 0) {
            return false;
        }


        for (let node = el; node && node !== document.documentElement; node = node.parentElement) {

            const style = getComputedStyle(node);

            if (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                Number(style.opacity) === 0
            ) {
                return false;
            }
        }

        return true;
    }


    function isDisabled(el) {

        return el.disabled === true || el.getAttribute('aria-disabled') === 'true';
    }


    // 押すとメニューが開くボタン（マイク選択の ∨ など）
    function hasPopup(el) {

        const value = el.getAttribute('aria-haspopup');

        return value !== null && value !== 'false';
    }


    // claude.ai の部品名（data-cds / data-cds-part）を、祖先からつないだもの
    function cdsPathOf(el) {

        const parts = [];

        let node = el;

        for (let depth = 0; node && depth < CDS_PATH_DEPTH; depth++) {

            const name =
                node.getAttribute('data-cds-part') ||
                node.getAttribute('data-cds') ||
                '';

            if (name) {
                parts.unshift(name);
            }

            node = node.parentElement;
        }

        return parts.join('>');
    }


    function describe(el) {

        if (!el) {
            return '（なし）';
        }

        const id = el.id ? '#' + el.id : '';

        const testId = el.getAttribute('data-testid');

        return el.tagName.toLowerCase() +
            id +
            (testId ? `[data-testid="${testId}"]` : '') +
            (el.getAttribute('contenteditable') === 'true' ? '[contenteditable]' : '');
    }


    // ============================================================
    // 入力欄
    // ============================================================

    function isEditor(el) {

        return Boolean(el) &&
            el instanceof Element &&
            EDITOR_SELECTORS.some(selector => el.matches(selector));
    }


    function findEditor() {

        const active = document.activeElement;

        if (isEditor(active)) {
            return active;
        }


        if (lastEditor && lastEditor.isConnected && isShown(lastEditor)) {
            return lastEditor;
        }


        const editors = [...document.querySelectorAll(EDITOR_SELECTORS.join(','))]
            .filter(el => !isOwnElement(el))
            .filter(isShown);

        return editors[0] || null;
    }


    // 入力欄から何段さかのぼると、そのボタンを含むか（含まなければ Infinity）
    function distanceFromEditor(button, editor) {

        if (!editor) {
            return Infinity;
        }

        let node = editor;

        for (let depth = 0; node && depth <= MAX_COMPOSER_DEPTH; depth++) {

            if (node.contains(button)) {
                return depth;
            }

            node = node.parentElement;
        }

        return Infinity;
    }


    // ============================================================
    // 覚えたボタン
    // ============================================================

    function loadLearned() {

        const learned = readJson(STORAGE_LEARNED, null);

        return learned && typeof learned === 'object' ? learned : null;
    }


    function fingerprintOf(button) {

        return {
            label: getLabel(button),
            testId: button.getAttribute('data-testid') || '',
            cdsPath: cdsPathOf(button),
            savedAt: new Date().toISOString()
        };
    }


    function matchesLearned(button, label, learned) {

        if (!learned) {
            return false;
        }


        if (learned.testId && button.getAttribute('data-testid') === learned.testId) {
            return true;
        }


        if (learned.label && label === learned.label) {
            return true;
        }


        // 録音中にラベルが変わっても当たるよう、部品名でも見る（∨ は除く）
        return Boolean(learned.cdsPath) &&
            !hasPopup(button) &&
            cdsPathOf(button) === learned.cdsPath;
    }


    // ============================================================
    // マイクボタンを探す
    // ============================================================

    function isInDictateSlot(button) {

        return DICTATE_SLOT_SELECTORS.some(selector => button.closest(selector));
    }


    function hasMicIcon(button) {

        return MIC_ICON_SELECTORS.some(selector => button.querySelector(selector));
    }


    // ボタン1つを判定する。押す候補なら { level }、外すなら { reason }
    function classify(button, learned) {

        const label = getLabel(button);

        if (matchesLearned(button, label, learned)) {
            return { level: LEVEL_LEARNED, label };
        }


        if (hasPopup(button)) {
            return { reason: 'メニューを開くボタン', label };
        }

        if (matchesAny(label, EXCLUDE_LABEL_PATTERNS)) {
            return { reason: '押さないラベル', label };
        }


        if (matchesAny(label, DICTATE_LABEL_PATTERNS)) {
            return { level: LEVEL_LABEL, label };
        }


        // 録音を始めたボタンそのもの。ラベルが「Stop」等に変わっていても、止めるために押す
        if (
            lastPressed &&
            lastPressed.button === button &&
            Date.now() - lastPressed.at < LAST_PRESSED_MS
        ) {
            return { level: LEVEL_LAST_PRESSED, label };
        }


        // ここから下はラベルで音声入力と分からないもの。送信・停止などは押さない
        if (matchesAny(label, DANGER_LABEL_PATTERNS)) {
            return { reason: '押すと困るラベル', label };
        }

        if (isInDictateSlot(button)) {
            return { level: LEVEL_SLOT, label };
        }

        if (matchesAny(label, MIC_LABEL_PATTERNS)) {
            return { level: LEVEL_MIC_LABEL, label };
        }

        if (hasMicIcon(button)) {
            return { level: LEVEL_MIC_ICON, label };
        }

        return { reason: '音声入力の目印なし', label };
    }


    /*
     * 候補を強い順に並べ、先頭を押す。
     *   判定の強さ → 入力欄からの近さ → 見えているか → ページ上の順
     * idle-slot・マイクのラベル・マイクの絵は、入力欄の近くにあるものだけ
     */
    function findDictateButton() {

        const editor = findEditor();

        const learned = loadLearned();

        const candidates = [];

        const buttons = [...document.querySelectorAll(BUTTON_SELECTOR)]
            .filter(button => !isOwnElement(button));


        buttons.forEach((button, order) => {

            const result = classify(button, learned);

            if (!result.level) {
                return;
            }


            const distance = distanceFromEditor(button, editor);

            const needsComposer = result.level <= LEVEL_SLOT;

            if (needsComposer && !Number.isFinite(distance)) {
                return;
            }


            candidates.push({
                button,
                level: result.level,
                how: LEVEL_NAMES[result.level],
                label: result.label,
                distance,
                shown: isShown(button),
                order
            });
        });


        candidates.sort((a, b) =>
            b.level - a.level ||
            a.distance - b.distance ||
            Number(b.shown) - Number(a.shown) ||
            a.order - b.order
        );


        return {
            editor,
            learned,
            candidates,
            chosen: candidates[0] || null
        };
    }


    // ============================================================
    // 押す
    // ============================================================

    /*
     * 人がクリックしたときと同じ順にイベントを送る。
     * 入力欄に文字があるとき、マイクボタンは inert + 不可視の入れ物の中にあり、
     * 本物のクリックは届かないが、dispatchEvent なら届く
     */
    function pressButton(button) {

        const rect = button.getBoundingClientRect();

        const base = {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            button: 0,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2
        };

        const pointer = {
            ...base,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true
        };


        button.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, buttons: 1 }));

        button.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));

        button.dispatchEvent(new PointerEvent('pointerup', { ...pointer, buttons: 0 }));

        button.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));

        button.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0, detail: 1 }));
    }


    // 話したあと Enter で送れるよう、入力欄にフォーカスを戻す
    function focusEditor(editor) {

        if (!editor || isEditor(document.activeElement)) {
            return;
        }

        try {

            editor.focus({ preventScroll: true });

        } catch {

            // フォーカスできなくても音声入力は動く
        }
    }


    function toggleDictation() {

        const result = findDictateButton();

        const chosen = result.chosen;

        if (!chosen) {

            lastPress = {
                at: new Date().toISOString(),
                result: '見つからない'
            };

            startLearning(true);

            return;
        }


        if (isDisabled(chosen.button)) {

            lastPress = {
                at: new Date().toISOString(),
                result: '無効なので押さず',
                how: chosen.how,
                label: chosen.label
            };

            showToast(`マイクボタンが押せない状態です（${chosen.label || 'ラベルなし'}）`);

            return;
        }


        pressButton(chosen.button);

        focusEditor(result.editor);


        lastPressed = {
            button: chosen.button,
            at: Date.now()
        };


        lastPress = {
            at: new Date().toISOString(),
            result: '押した',
            how: chosen.how,
            label: chosen.label,
            shown: chosen.shown
        };

        if (SHOW_PRESS_TOAST) {
            showToast('🎙 マイクボタンを押しました');
        }
    }


    // ============================================================
    // 教える（次にクリックしたボタンを覚える）
    // ============================================================

    function startLearning(notFound) {

        stopLearning();

        // 覚え直すときは、直前に押したボタンも当てにしない
        lastPressed = null;


        learning = {
            timer: setTimeout(() => {

                stopLearning();

                showToast('マイクボタンを覚えるのをやめました');

            }, LEARN_TIMEOUT_MS)
        };


        const lead = notFound
            ? 'マイクボタンが見つかりませんでした。'
            : '';

        showToast(
            lead + 'マイクボタンを1回クリックすると覚えます（Esc でやめる）',
            LEARN_TIMEOUT_MS
        );
    }


    function stopLearning() {

        if (learning) {
            clearTimeout(learning.timer);
        }

        learning = null;
    }


    // 教えている間の本物のクリック。クリックそのものは止めない（そのまま録音が始まる）
    function onClickCapture(event) {

        if (!learning || !event.isTrusted || !(event.target instanceof Element)) {
            return;
        }


        const button = event.target.closest(BUTTON_SELECTOR);

        if (!button || isOwnElement(button)) {
            return;
        }


        const fingerprint = fingerprintOf(button);

        if (
            !matchesAny(fingerprint.label, DICTATE_LABEL_PATTERNS) &&
            matchesAny(fingerprint.label, DANGER_LABEL_PATTERNS)
        ) {

            showToast(
                `「${fingerprint.label}」は覚えません。マイクボタンをクリックしてください`,
                LEARN_TIMEOUT_MS
            );

            return;
        }


        if (!fingerprint.label && !fingerprint.testId && !fingerprint.cdsPath) {

            showToast(
                'このボタンには目印が無く、覚えられませんでした',
                LEARN_TIMEOUT_MS
            );

            return;
        }


        writeJson(STORAGE_LEARNED, fingerprint);

        stopLearning();

        showToast(
            `覚えました（${fingerprint.label || fingerprint.testId || fingerprint.cdsPath}）。` +
            `次から ${shortcutText(SHORTCUT)} で押します`,
            TOAST_MS * 2
        );
    }


    function forget() {

        writeJson(STORAGE_LEARNED, null);

        lastPressed = null;

        showToast('覚えたマイクボタンを忘れました');
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


    // ページ側（claude.ai・Chrome のブックマーク）には渡さない
    function consume(event) {

        event.preventDefault();

        event.stopImmediatePropagation();
    }


    function onKeyDown(event) {

        // 日本語の変換中は触らない
        if (event.isComposing || event.keyCode === 229) {
            return;
        }


        if (matchesShortcut(event, LEARN_SHORTCUT)) {

            consume(event);

            if (!event.repeat) {
                startLearning(false);
            }

            return;
        }


        if (matchesShortcut(event, SHORTCUT)) {

            consume(event);

            // 押しっぱなしの連打では1回だけ
            if (!event.repeat) {
                toggleDictation();
            }

            return;
        }


        // Esc は claude.ai 側にもそのまま渡す
        if (learning && event.key === 'Escape') {

            stopLearning();

            showToast('マイクボタンを覚えるのをやめました');
        }
    }


    function onFocusIn(event) {

        if (isEditor(event.target) && !isOwnElement(event.target)) {
            lastEditor = event.target;
        }
    }


    // ============================================================
    // 診断
    // ============================================================

    function dump() {

        const result = findDictateButton();

        const candidateRows = result.candidates.map((candidate, index) => ({
            '順位': index + 1,
            '押す': candidate === result.chosen ? '★' : '',
            '判定': candidate.how,
            'ラベル': candidate.label,
            '見えている': candidate.shown,
            'inert の中': Boolean(candidate.button.closest('[inert]')),
            '無効': isDisabled(candidate.button),
            '入力欄から': Number.isFinite(candidate.distance) ? candidate.distance + '段' : '遠い',
            'data-cds': cdsPathOf(candidate.button),
            'data-testid': candidate.button.getAttribute('data-testid') || ''
        }));


        // 入力欄のまわりのボタン（外れたときに、何が並んでいるかを見る）
        const nearbyRows = [...document.querySelectorAll(BUTTON_SELECTOR)]
            .filter(button => !isOwnElement(button))
            .map(button => ({
                button,
                distance: distanceFromEditor(button, result.editor)
            }))
            .filter(item => item.distance <= DUMP_COMPOSER_DEPTH)
            .map(item => {

                const judged = classify(item.button, result.learned);

                return {
                    'ラベル': judged.label,
                    '判定': judged.level ? LEVEL_NAMES[judged.level] : '外す: ' + judged.reason,
                    '見えている': isShown(item.button),
                    'aria-haspopup': item.button.getAttribute('aria-haspopup') || '',
                    '入力欄から': item.distance + '段',
                    'data-cds': cdsPathOf(item.button),
                    'data-testid': item.button.getAttribute('data-testid') || ''
                };
            });


        console.log(
            `[Claude 音声入力キー v${VERSION}] キー: ${shortcutText(SHORTCUT)}` +
            ` / 覚え直し: ${shortcutText(LEARN_SHORTCUT)}`
        );

        console.log('入力欄:', describe(result.editor), result.editor);

        console.log('覚えたボタン:', result.learned);

        console.log('直近に押したとき:', lastPress);

        console.log('■ 押す候補');

        console.table(candidateRows);

        console.log('■ 入力欄のまわりのボタン');

        console.table(nearbyRows);


        return {
            version: VERSION,
            editor: describe(result.editor),
            learned: result.learned,
            lastPress,
            candidates: candidateRows,
            nearby: nearbyRows
        };
    }


    // ============================================================
    // 起動
    // ============================================================

    // ページ（claude.ai）より先にキーを受け取るため、window のキャプチャで登録する
    window.addEventListener('keydown', onKeyDown, true);

    document.addEventListener('click', onClickCapture, true);

    document.addEventListener('focusin', onFocusIn, true);


    window.__tmClaudeDictation = {
        version: VERSION,
        dump,
        press: toggleDictation,
        learn: () => startLearning(false),
        forget
    };
})();
