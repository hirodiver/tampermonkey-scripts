// ==UserScript==
// @name         X 16進デコード v1.0.0
// @namespace    local.hiro.tools
// @version      1.0.0
// @description  X 上で UTF-8 の16進数文字列をドラッグして選択すると、デコードした文字列を選択位置の下に表示する
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// @homepageURL  https://github.com/hirodiver/tampermonkey-scripts
// @supportURL   https://github.com/hirodiver/tampermonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-hex-decode.user.js
// @updateURL    https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-hex-decode.user.js
// ==/UserScript==

/*
 * 投稿本文などにある UTF-8 の16進数文字列をドラッグで選択すると、
 * デコード結果を選択範囲のすぐ下に小さなパネルで出す。
 *
 *   68747470733a2f2f782e636f6d2f...  →  https://x.com/...
 *
 * 受け付ける書き方:
 *   - 区切りなし        68747470
 *   - 空白区切り        68 74 74 70
 *   - \x 付き           \x68\x74\x74\x70
 *   - % 付き（URL形式） %68%74%74%70
 *   - 0x 付き           0x68 0x74
 *
 * 選択範囲に16進数以外の文字が混ざっているとき（投稿全体を選んだときなど）は、
 * その中の16進数の連続（8文字以上）を探して、それぞれデコードする。
 *
 * UTF-8 として正しくないバイト列や、制御文字を含む結果は出さない。
 * 数字だけの選択（日付など）で誤ってパネルが出るのを防ぐため。
 *
 * パネルの閉じ方: パネルの外をクリック / Esc / 別の文字列を選択
 *
 * ■ 診断
 *   コンソールで window.__tmHexDecode.dump() を呼ぶと、
 *   いまの選択文字列と判定結果を console.table で出す。
 *   window.__tmHexDecode.decode('6869') で任意の文字列を試せる。
 */

(function () {
    'use strict';

    // ============================================================
    // 設定
    // ============================================================

    // 選択が止まってからデコードするまでの待ち時間（ミリ秒）
    const DEBOUNCE_MS = 250;

    // 選択全体を16進数とみなすときの最小の文字数（2文字 = 1バイト）
    const MIN_WHOLE_HEX_LENGTH = 4;

    // 文中から16進数の連続を拾うときの最小の文字数
    const MIN_EMBEDDED_HEX_LENGTH = 8;

    // 一度にデコードする選択文字列の上限（長すぎる選択は無視する）
    const MAX_SELECTION_LENGTH = 20000;

    // パネルの id
    const PANEL_ID = 'tm-x-hex-decode-panel';

    // ============================================================
    // デコード
    // ============================================================

    // 区切り記号（\x, %, 0x, 空白, コロン, ハイフン）を取り除く
    function stripSeparators(text) {
        return text
            .replace(/\\x/gi, '')
            .replace(/0x/gi, '')
            .replace(/%/g, '')
            .replace(/[\s:,\-]/g, '');
    }

    // 16進数の文字列を UTF-8 として読む。読めなければ null
    function decodeHexString(hex) {
        if (!/^[0-9a-fA-F]+$/.test(hex)) {
            return null;
        }

        if (hex.length % 2 !== 0) {
            return null;
        }

        const bytes = new Uint8Array(hex.length / 2);

        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
        }

        let text;

        try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch (e) {
            return null;
        }

        // 改行とタブ以外の制御文字を含むものは、意味のある文字列ではないとみなす
        if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) {
            return null;
        }

        if (text.trim() === '') {
            return null;
        }

        return text;
    }

    // 選択文字列からデコード結果の一覧を作る
    // 戻り値: [{ hex, text }]
    function decodeSelection(raw) {
        if (!raw || raw.length > MAX_SELECTION_LENGTH) {
            return [];
        }

        // 1. 選択全体が16進数（区切り付きを含む）なら、それを丸ごと読む
        const whole = stripSeparators(raw.trim());

        if (whole.length >= MIN_WHOLE_HEX_LENGTH) {
            const text = decodeHexString(whole);

            if (text !== null) {
                return [{ hex: whole, text: text }];
            }
        }

        // 2. 文中の16進数の連続を拾う
        const results = [];
        const pattern = new RegExp('[0-9a-fA-F]{' + MIN_EMBEDDED_HEX_LENGTH + ',}', 'g');
        let match;

        while ((match = pattern.exec(raw)) !== null) {
            let hex = match[0];

            // 奇数桁なら末尾1文字を落として試す
            if (hex.length % 2 !== 0) {
                hex = hex.slice(0, -1);
            }

            const text = decodeHexString(hex);

            if (text !== null) {
                results.push({ hex: hex, text: text });
            }
        }

        return results;
    }

    // ============================================================
    // パネル
    // ============================================================

    function isDarkBackground() {
        const color = getComputedStyle(document.body).backgroundColor;
        const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);

        if (!m) {
            return window.matchMedia('(prefers-color-scheme: dark)').matches;
        }

        const brightness = (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3;

        return brightness < 128;
    }

    function removePanel() {
        const panel = document.getElementById(PANEL_ID);

        if (panel) {
            panel.remove();
        }
    }

    function copyText(text, button) {
        const done = function () {
            const original = button.textContent;
            button.textContent = 'コピーしました';
            setTimeout(function () {
                button.textContent = original;
            }, 1200);
        };

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, function () {
                fallbackCopy(text);
                done();
            });
        } else {
            fallbackCopy(text);
            done();
        }
    }

    function fallbackCopy(text) {
        const area = document.createElement('textarea');
        area.value = text;
        Object.assign(area.style, {
            position: 'fixed',
            top: '-1000px'
        });
        document.body.appendChild(area);
        area.select();

        try {
            document.execCommand('copy');
        } catch (e) {
            // 何もしない
        }

        area.remove();
    }

    function makeButton(label, colors) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        Object.assign(button.style, {
            font: 'inherit',
            fontSize: '12px',
            padding: '2px 10px',
            borderRadius: '999px',
            border: '1px solid ' + colors.border,
            background: 'transparent',
            color: colors.text,
            cursor: 'pointer'
        });
        return button;
    }

    function showPanel(results, rect) {
        removePanel();

        const dark = isDarkBackground();
        const colors = dark
            ? { bg: '#16181c', text: '#e7e9ea', sub: '#71767b', border: '#2f3336', link: '#1d9bf0' }
            : { bg: '#ffffff', text: '#0f1419', sub: '#536471', border: '#cfd9de', link: '#1d9bf0' };

        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        Object.assign(panel.style, {
            position: 'absolute',
            zIndex: '2147483647',
            maxWidth: 'min(560px, calc(100vw - 16px))',
            padding: '8px 10px',
            borderRadius: '12px',
            border: '1px solid ' + colors.border,
            background: colors.bg,
            color: colors.text,
            boxShadow: '0 4px 16px rgba(0, 0, 0, 0.25)',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", sans-serif',
            fontSize: '14px',
            lineHeight: '1.5'
        });

        const title = document.createElement('div');
        title.textContent = '16進デコード';
        Object.assign(title.style, {
            fontSize: '11px',
            color: colors.sub,
            marginBottom: '4px'
        });
        panel.appendChild(title);

        results.forEach(function (result, index) {
            const item = document.createElement('div');
            Object.assign(item.style, {
                marginTop: index > 0 ? '8px' : '0',
                paddingTop: index > 0 ? '8px' : '0',
                borderTop: index > 0 ? '1px solid ' + colors.border : 'none'
            });

            const body = document.createElement('div');
            body.className = 'tm-hex-decoded';
            body.textContent = result.text;
            Object.assign(body.style, {
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                userSelect: 'text'
            });
            item.appendChild(body);

            const actions = document.createElement('div');
            Object.assign(actions.style, {
                display: 'flex',
                gap: '6px',
                marginTop: '6px'
            });

            const copyButton = makeButton('コピー', colors);
            copyButton.addEventListener('click', function () {
                copyText(result.text, copyButton);
            });
            actions.appendChild(copyButton);

            // URL なら開くリンクを付ける
            if (/^https?:\/\/\S+$/.test(result.text.trim())) {
                const link = document.createElement('a');
                link.className = 'tm-hex-open';
                link.href = result.text.trim();
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.textContent = '開く';
                Object.assign(link.style, {
                    fontSize: '12px',
                    padding: '2px 10px',
                    borderRadius: '999px',
                    border: '1px solid ' + colors.link,
                    color: colors.link,
                    textDecoration: 'none'
                });
                actions.appendChild(link);
            }

            item.appendChild(actions);
            panel.appendChild(item);
        });

        document.body.appendChild(panel);

        // 選択範囲の下に置く。画面からはみ出すなら位置を詰める
        const margin = 8;
        const panelWidth = panel.offsetWidth;
        let left = rect.left + window.scrollX;
        const maxLeft = window.scrollX + document.documentElement.clientWidth - panelWidth - margin;

        if (left > maxLeft) {
            left = maxLeft;
        }

        if (left < window.scrollX + margin) {
            left = window.scrollX + margin;
        }

        panel.style.left = left + 'px';
        panel.style.top = (rect.bottom + window.scrollY + 6) + 'px';
    }

    // ============================================================
    // 選択の監視
    // ============================================================

    let timer = null;
    let pointerDown = false;
    let lastSelection = '';

    function selectionInsidePanel(selection) {
        const panel = document.getElementById(PANEL_ID);

        if (!panel || selection.rangeCount === 0) {
            return false;
        }

        return panel.contains(selection.getRangeAt(0).commonAncestorContainer);
    }

    function handleSelection() {
        timer = null;

        if (pointerDown) {
            return;
        }

        const selection = window.getSelection();

        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
            // 選択が外れただけではパネルを閉じない（コピーボタンを押せるように）
            lastSelection = '';
            return;
        }

        if (selectionInsidePanel(selection)) {
            return;
        }

        const raw = selection.toString();

        if (raw === lastSelection && document.getElementById(PANEL_ID)) {
            return;
        }

        lastSelection = raw;

        const results = decodeSelection(raw);

        if (results.length === 0) {
            removePanel();
            return;
        }

        const rect = selection.getRangeAt(0).getBoundingClientRect();
        showPanel(results, rect);
    }

    function scheduleDecode(delay) {
        if (timer) {
            clearTimeout(timer);
        }

        timer = setTimeout(handleSelection, delay);
    }

    document.addEventListener('selectionchange', function () {
        scheduleDecode(DEBOUNCE_MS);
    });

    document.addEventListener('pointerdown', function (event) {
        const panel = document.getElementById(PANEL_ID);

        if (panel && panel.contains(event.target)) {
            return;
        }

        pointerDown = true;
        removePanel();
        lastSelection = '';
    }, true);

    document.addEventListener('pointerup', function () {
        pointerDown = false;
        scheduleDecode(DEBOUNCE_MS);
    }, true);

    document.addEventListener('pointercancel', function () {
        pointerDown = false;
        scheduleDecode(DEBOUNCE_MS);
    }, true);

    document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') {
            removePanel();
        }
    });

    // ============================================================
    // 診断
    // ============================================================

    window.__tmHexDecode = {
        decode: function (text) {
            return decodeSelection(String(text));
        },
        dump: function () {
            const selection = window.getSelection();
            const raw = selection ? selection.toString() : '';
            const results = decodeSelection(raw);
            const rows = results.length > 0
                ? results.map(function (r) {
                    return { 選択: raw.slice(0, 80), '16進': r.hex.slice(0, 80), 結果: r.text };
                })
                : [{ 選択: raw.slice(0, 80), '16進': '', 結果: '（デコードできる16進数が無い）' }];
            console.table(rows);
            return rows;
        }
    };
})();
