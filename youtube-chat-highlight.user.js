// ==UserScript==
// @name         YouTube チャット強調 v1.0.0
// @namespace    https://www.youtube.com/
// @version      1.0.0
// @description  ライブチャットで、指定した文字列を名前・チャンネルID・発言のどこかに含む発言をまるごと強調表示する（改行区切りで複数指定・部分一致・大文字小文字と全角半角を区別しない）
// @match        https://www.youtube.com/live_chat*
// @match        https://www.youtube.com/live_chat_replay*
// @grant        none
// @run-at       document-start
// @homepageURL  https://github.com/hirodiver/tampermonkey-scripts
// @supportURL   https://github.com/hirodiver/tampermonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/youtube-chat-highlight.user.js
// @updateURL    https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/youtube-chat-highlight.user.js
// ==/UserScript==

(() => {
    'use strict';

    /*
     * YouTube のライブチャットは watch ページ内の
     * iframe（/live_chat）で動く。ポップアウトしても同じURL。
     * このスクリプトはチャット側だけで動く。
     *
     * 強調ワードは改行区切りで複数指定できる。
     * 次のどこかに1つでも含まれていれば、その発言を丸ごと強調する。
     *   - 表示名（@ハンドル含む）
     *   - チャンネルID（UC…）
     *   - 発言の本文（絵文字は代替テキストで見る）
     *
     * 見た目（入力欄・強調色）は「YouTube 配信予定リスト」の
     * 「強調ワード」に揃えている。
     */

    const STORE_KEY = 'tm-yt-chat-highlight-words';
    const STYLE_ID = 'tm-ychl-style';
    const PANEL_ID = 'tm-ychl-panel';
    const OPEN_CLASS = 'tm-ychl-open';
    const HIT_CLASS = 'tm-ychl-hit';
    const SWEEP_MS = 1000;

    /*
     * 「強調ワード」ボタンを置く位置。
     *
     * YouTube チャット非表示と同じく、見出し帯の下端を実測して
     * そのすぐ下へ置く。非表示スクリプトの「非表示リスト」ボタンが
     * あるときは、その左隣に並べる（重ならないように）。
     */
    const HEADER_SELECTOR = [
        'yt-live-chat-header-renderer',
        '#chat-header'
    ].join(',');
    const HIDE_OPEN_SELECTOR = '.tm-ychide-open';
    const OPEN_GAP = 6;
    const OPEN_RIGHT = 8;
    const OPEN_FALLBACK_TOP = 56;
    const OPEN_MAX_RATIO = 0.3;
    const HEADER_MAX_RATIO = 0.4;

    // 強調の対象にする発言
    const MESSAGE_SELECTOR = [
        'yt-live-chat-text-message-renderer',
        'yt-live-chat-paid-message-renderer',
        'yt-live-chat-paid-sticker-renderer',
        'yt-live-chat-membership-item-renderer',
        'yt-live-chat-legacy-paid-message-renderer',
        'ytd-sponsorships-live-chat-gift-purchase-announcement-renderer',
        'ytd-sponsorships-live-chat-gift-redemption-announcement-renderer',
        'yt-live-chat-ticker-paid-message-item-renderer',
        'yt-live-chat-ticker-sponsor-item-renderer',
        'yt-live-chat-ticker-paid-sticker-item-renderer'
    ].join(',');

    let wordsText = loadWordsText();
    let terms = parseTerms(wordsText);

    let panel = null;
    let openBtn = null;
    let textarea = null;
    let countLabel = null;
    let panelOpen = false;
    let sweepTimer = null;
    let scheduled = false;

    /* ------------------------------------------------ 保存 */

    function loadWordsText() {
        try {
            return localStorage.getItem(STORE_KEY) || '';
        } catch {
            return '';
        }
    }

    function saveWordsText(value) {
        try {
            localStorage.setItem(STORE_KEY, value);
        } catch {}
    }

    /*
     * 比べる前に揃える。
     * 全角英数（ＡＢＣ）と半角、大文字と小文字を同じに扱う。
     */
    function normalize(text) {
        let out = String(text || '');
        try {
            out = out.normalize('NFKC');
        } catch {}
        return out.toLowerCase();
    }

    function parseTerms(text) {
        return String(text || '')
            .split(/\r?\n/)
            .map(line => normalize(line.trim()))
            .filter(Boolean);
    }

    /* ------------------------------------------------ 取得 */

    /*
     * チャンネルIDの取得。
     *
     * 通常の発言は author-external-channel-id 属性を持つ。
     * ティッカーは属性を持たないので、Polymer が抱えている
     * データを浅く掘って探す。
     */
    function authorIdOf(el) {
        const attr =
            el.getAttribute &&
            el.getAttribute('author-external-channel-id');
        if (attr) return attr;

        try {
            const data = el.__data && el.__data.data;
            const found = findChannelId(data, 0);
            if (found) return found;
        } catch {}

        return '';
    }

    function findChannelId(obj, depth) {
        if (!obj || typeof obj !== 'object' || depth > 5) {
            return '';
        }

        if (typeof obj.authorExternalChannelId === 'string') {
            return obj.authorExternalChannelId;
        }

        for (const key of Object.keys(obj)) {
            const value = obj[key];
            if (value && typeof value === 'object') {
                const found = findChannelId(value, depth + 1);
                if (found) return found;
            }
        }

        return '';
    }

    function authorNameOf(el) {
        const node =
            el.querySelector && el.querySelector('#author-name');
        if (node && node.textContent.trim()) {
            return node.textContent.trim();
        }

        try {
            const data = el.__data && el.__data.data;
            const name = data && data.authorName;
            if (name && typeof name.simpleText === 'string') {
                return name.simpleText.trim();
            }
        } catch {}

        return '';
    }

    /*
     * 本文。絵文字は <img> なので textContent に出ない。
     * alt（:smile: や 😀）を拾って文字として並べる。
     */
    function messageTextOf(el) {
        const parts = [];

        for (const node of el.querySelectorAll(
            '#message, #header-subtext, #primary-text'
        )) {
            parts.push(textWithEmoji(node));
        }

        return parts.join('\n');
    }

    function textWithEmoji(root) {
        let out = '';
        const walk = node => {
            for (const child of node.childNodes) {
                if (child.nodeType === 3) {
                    out += child.nodeValue;
                } else if (child.nodeType === 1) {
                    if (child.tagName === 'IMG') {
                        out += child.getAttribute('alt') ||
                            child.getAttribute('shared-tooltip-text') ||
                            '';
                    } else {
                        walk(child);
                    }
                }
            }
        };
        walk(root);
        return out;
    }

    /* ------------------------------------------------ 判定 */

    function isHit(el) {
        if (!terms.length) return false;

        const haystack = normalize(
            authorNameOf(el) + '\n' +
            authorIdOf(el) + '\n' +
            messageTextOf(el)
        );

        return terms.some(term => haystack.includes(term));
    }

    /*
     * 毎回すべての発言を判定し直す。
     * チャットは要素を使い回すため、外れた要素は必ず戻す。
     */
    function apply() {
        let count = 0;

        for (const el of document.querySelectorAll(MESSAGE_SELECTOR)) {
            const hit = isHit(el);
            el.classList.toggle(HIT_CLASS, hit);
            if (hit) count++;
        }

        updateCount(count);
        positionPanel();
    }

    function schedule() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            apply();
        });
    }

    function setWords(value) {
        wordsText = String(value || '');
        terms = parseTerms(wordsText);
        saveWordsText(wordsText);
        if (textarea && textarea.value !== wordsText) {
            textarea.value = wordsText;
        }
        apply();
    }

    /* ------------------------------------------------ UI */

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;

        const style = document.createElement('style');
        style.id = STYLE_ID;

        // 強調の色は配信予定リストと同じ（黄色の帯＋薄い黄色の背景＋太字）
        style.textContent = `
            .${HIT_CLASS} {
                background: rgba(255, 202, 40, 0.16) !important;
                box-shadow: inset 3px 0 0 0 #ffca28 !important;
            }

            .${HIT_CLASS} #message,
            .${HIT_CLASS} #author-name {
                font-weight: 600 !important;
            }

            /* スパチャ等は自前の色つきカードを持つので、枠でも示す */
            yt-live-chat-paid-message-renderer.${HIT_CLASS},
            yt-live-chat-paid-sticker-renderer.${HIT_CLASS},
            yt-live-chat-membership-item-renderer.${HIT_CLASS},
            yt-live-chat-legacy-paid-message-renderer.${HIT_CLASS},
            ytd-sponsorships-live-chat-gift-purchase-announcement-renderer.${HIT_CLASS},
            ytd-sponsorships-live-chat-gift-redemption-announcement-renderer.${HIT_CLASS},
            yt-live-chat-ticker-paid-message-item-renderer.${HIT_CLASS},
            yt-live-chat-ticker-sponsor-item-renderer.${HIT_CLASS},
            yt-live-chat-ticker-paid-sticker-item-renderer.${HIT_CLASS} {
                outline: 2px solid #ffca28 !important;
                outline-offset: -2px;
            }

            .${OPEN_CLASS} {
                position: fixed;
                right: ${OPEN_RIGHT}px;
                top: ${OPEN_FALLBACK_TOP}px;
                z-index: 9999;
                padding: 3px 10px;
                border-radius: 18px;
                border: 1px solid rgba(0,0,0,.1);
                background: #f2f2f2;
                color: #0f0f0f;
                font-family: Roboto, Arial, sans-serif;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                white-space: nowrap;
            }

            .${OPEN_CLASS}[data-active="true"] {
                box-shadow: inset 3px 0 0 0 #ffca28;
            }

            #${PANEL_ID} {
                position: fixed;
                right: ${OPEN_RIGHT}px;
                top: ${OPEN_FALLBACK_TOP + 30}px;
                z-index: 9999;
                box-sizing: border-box;
                width: min(300px, calc(100vw - 16px));
                padding: 12px 14px;
                border-radius: 12px;
                border: 1px solid rgba(0,0,0,.1);
                background: #fff;
                color: #0f0f0f;
                font-family: Roboto, Arial, sans-serif;
                box-shadow: 0 2px 10px rgba(0,0,0,.25);
            }

            #${PANEL_ID}[hidden] {
                display: none;
            }

            #${PANEL_ID} .tm-ychl-label {
                font-size: 13px;
                opacity: .65;
                margin-bottom: 6px;
                line-height: 1.5;
            }

            #${PANEL_ID} textarea {
                width: 100%;
                box-sizing: border-box;
                padding: 8px 10px;
                border-radius: 8px;
                border: 1px solid rgba(0,0,0,.1);
                background: #f2f2f2;
                color: #0f0f0f;
                font-family: inherit;
                font-size: 14px;
                line-height: 1.6;
                resize: vertical;
            }

            #${PANEL_ID} .tm-ychl-count {
                margin-top: 6px;
                font-size: 12px;
                opacity: .65;
            }

            html[dark] .${OPEN_CLASS} {
                background: #272727;
                color: #f1f1f1;
                border-color: rgba(255,255,255,.1);
            }

            html[dark] #${PANEL_ID} {
                background: #0f0f0f;
                color: #f1f1f1;
                border-color: rgba(255,255,255,.1);
            }

            html[dark] #${PANEL_ID} textarea {
                background: #272727;
                color: #f1f1f1;
                border-color: rgba(255,255,255,.1);
            }
        `;

        (document.head || document.documentElement).appendChild(style);
    }

    function buildPanel() {
        if (document.getElementById(PANEL_ID)) return;
        if (!document.body) return;

        openBtn = document.createElement('button');
        openBtn.className = OPEN_CLASS;
        openBtn.type = 'button';
        openBtn.textContent = '強調ワード';
        openBtn.setAttribute('aria-expanded', 'false');
        openBtn.addEventListener('click', () => {
            panelOpen = !panelOpen;
            panel.hidden = !panelOpen;
            openBtn.setAttribute(
                'aria-expanded',
                panelOpen ? 'true' : 'false'
            );
            positionPanel();
            if (panelOpen) textarea.focus();
        });

        panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.hidden = true;

        const label = document.createElement('div');
        label.className = 'tm-ychl-label';
        label.textContent =
            '強調したい文字列を改行区切りで入力（名前・チャンネルID・発言の部分一致）';

        textarea = document.createElement('textarea');
        textarea.rows = 4;
        textarea.spellcheck = false;
        textarea.value = wordsText;
        textarea.placeholder = '例）\n〇〇さん\nUCxxxxxxxx\n初見';

        textarea.addEventListener('input', () => {
            setWords(textarea.value);
        });

        // 入力中のキーをチャット側のショートカットへ渡さない
        textarea.addEventListener('keydown', event =>
            event.stopPropagation()
        );

        countLabel = document.createElement('div');
        countLabel.className = 'tm-ychl-count';

        panel.append(label, textarea, countLabel);

        document.body.appendChild(openBtn);
        document.body.appendChild(panel);
    }

    function updateCount(count) {
        if (openBtn) {
            openBtn.dataset.active = terms.length ? 'true' : 'false';
        }
        if (!countLabel) return;
        const text = terms.length
            ? `いま表示中の発言のうち ${count} 件を強調しています`
            : '空のときは何も強調しません';

        // 同じ文を書き直すと MutationObserver が再び動き、
        // 毎フレーム apply し続けてしまうので、変わったときだけ書く
        if (countLabel.textContent !== text) {
            countLabel.textContent = text;
        }
    }

    /*
     * 見出し帯の下端を測って、ボタンとパネルの縦位置を決める。
     * 非表示スクリプトのボタンがあれば、その左隣に並べる。
     */
    function positionPanel() {
        if (!openBtn || !panel) return;

        const viewport = window.innerHeight || 0;
        const width = window.innerWidth || 0;
        let top = OPEN_FALLBACK_TOP;

        for (const header of document.querySelectorAll(HEADER_SELECTOR)) {
            const rect = header.getBoundingClientRect();
            if (rect.height <= 0) continue;
            if (viewport && rect.height > viewport * HEADER_MAX_RATIO) {
                continue;
            }
            if (rect.bottom + OPEN_GAP > top) {
                top = rect.bottom + OPEN_GAP;
            }
        }

        if (viewport) {
            top = Math.min(top, viewport * OPEN_MAX_RATIO);
        }
        top = Math.max(top, 0);

        let right = OPEN_RIGHT;
        const hideOpen = document.querySelector(HIDE_OPEN_SELECTOR);
        if (hideOpen && width) {
            const rect = hideOpen.getBoundingClientRect();
            if (rect.width > 0) {
                right = Math.max(OPEN_RIGHT, width - rect.left + OPEN_GAP);
            }
        }

        openBtn.style.top = top + 'px';
        openBtn.style.right = right + 'px';
        panel.style.top = (top + 30) + 'px';
    }

    /* ------------------------------------------------ 起動 */

    function start() {
        injectStyle();
        buildPanel();
        apply();

        new MutationObserver(schedule).observe(
            document.documentElement,
            { childList: true, subtree: true, characterData: true }
        );

        // 取りこぼしの保険（属性や本文が後から入ることがある）
        if (!sweepTimer) {
            sweepTimer = setInterval(apply, SWEEP_MS);
        }

        window.addEventListener('resize', positionPanel);

        // ポップアウトしたチャットなど、別ウィンドウで変えた分を反映する
        window.addEventListener('storage', event => {
            if (event.key !== STORE_KEY) return;
            wordsText = loadWordsText();
            terms = parseTerms(wordsText);
            if (textarea && document.activeElement !== textarea) {
                textarea.value = wordsText;
            }
            apply();
        });
    }

    if (document.body) {
        start();
    } else {
        document.addEventListener('DOMContentLoaded', start, {
            once: true
        });
    }

    // 切り分け用。コンソールから状態を見たり、語を直接設定したりできる。
    window.__tmChatHighlight = {
        words: () => terms.slice(),
        set: value => setWords(value),
        dump: () =>
            Array.from(
                document.querySelectorAll(MESSAGE_SELECTOR)
            ).map(el => ({
                tag: el.tagName.toLowerCase(),
                id: authorIdOf(el),
                name: authorNameOf(el),
                text: messageTextOf(el),
                hit: el.classList.contains(HIT_CLASS)
            }))
    };
})();
