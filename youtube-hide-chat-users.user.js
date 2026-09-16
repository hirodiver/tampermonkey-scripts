// ==UserScript==
// @name         YouTube チャット非表示 v1.1
// @namespace    https://www.youtube.com/
// @version      1.1
// @description  ライブチャットで指定したユーザーの発言をブロックせずに非表示にする（まるごと消す／名前を残して本文だけ消すの2種類・チャンネルID単位・スパチャ/メンバー加入/上部ティッカーも対象）
// @match        https://www.youtube.com/live_chat*
// @match        https://www.youtube.com/live_chat_replay*
// @grant        none
// @run-at       document-start
// @homepageURL  https://github.com/hirodiver/tampermonkey-scripts
// @supportURL   https://github.com/hirodiver/tampermonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/youtube-hide-chat-users.user.js
// @updateURL    https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/youtube-hide-chat-users.user.js
// ==/UserScript==

(() => {
    'use strict';

    /*
     * YouTube のライブチャットは watch ページ内の
     * iframe（/live_chat）で動く。ポップアウトすると
     * 同じURLが単独のウィンドウになる。
     * どちらも @match に一致するので、
     * このスクリプトはチャット側だけで動く。
     *
     * 非表示は「相手に分かる」ブロック機能とは無関係で、
     * こちらの画面から display:none で消すだけ。
     * YouTube 側には何も送らない。
     *
     * 消し方は2種類。
     *   'all'  … 発言をまるごと消す
     *   'text' … 名前は残して本文だけ消す
     *            （誰が喋ったかは分かる。会話の流れを
     *              見失いたくないときのため）
     */

    const STORE_KEY = 'tm-yt-chat-hide-users';
    const STYLE_ID = 'tm-ychide-style';
    const PANEL_ID = 'tm-ychide-panel';
    const HIDDEN_CLASS = 'tm-ychide-hidden';
    const TEXT_CLASS = 'tm-ychide-textonly';
    const MASK_CLASS = 'tm-ychide-mask';
    const MASK_TEXT = '（非表示）';
    const SWEEP_MS = 1000;

    // 発言1件を表す要素。スパチャ・メンバー加入・
    // 上部に流れるティッカーまで含めて消す。
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

    // 非表示ボタンを出すのは通常の発言まわりだけ。
    // ティッカーは小さすぎてボタンが載らない。
    const BUTTON_SELECTOR = [
        'yt-live-chat-text-message-renderer',
        'yt-live-chat-paid-message-renderer',
        'yt-live-chat-paid-sticker-renderer',
        'yt-live-chat-membership-item-renderer',
        'yt-live-chat-legacy-paid-message-renderer'
    ].join(',');

    /*
     * 上部のティッカーは本文を持たない（名前と金額だけ）。
     * 'text' はあくまで「本文を消す」設定なので、
     * ティッカーは 'all' のときだけ消す。
     */
    const TICKER_SELECTOR = [
        'yt-live-chat-ticker-paid-message-item-renderer',
        'yt-live-chat-ticker-sponsor-item-renderer',
        'yt-live-chat-ticker-paid-sticker-item-renderer'
    ].join(',');

    // [{ id, name, mode, addedAt }]  mode: 'all' | 'text'
    let entries = loadEntries();
    let idModes = new Map();
    let nameModes = new Map();
    rebuildIndex();

    // 一時解除（保存しない。タブを閉じると戻る）
    let paused = false;

    let panel = null;
    let listBox = null;
    let sweepTimer = null;
    let scheduled = false;

    /* ------------------------------------------------ 保存 */

    function loadEntries() {
        try {
            const raw = localStorage.getItem(STORE_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            return parsed
                .filter(e => e && (e.id || e.name))
                .map(e => ({
                    id: String(e.id || ''),
                    name: String(e.name || ''),

                    // v1.0 で保存した分には mode が無い。
                    // 当時の挙動（まるごと消す）に揃える。
                    mode: e.mode === 'text' ? 'text' : 'all',

                    addedAt: Number(e.addedAt) || 0
                }));
        } catch {
            return [];
        }
    }

    function saveEntries() {
        try {
            localStorage.setItem(
                STORE_KEY,
                JSON.stringify(entries)
            );
        } catch {}
    }

    function rebuildIndex() {
        idModes = new Map();
        nameModes = new Map();

        for (const entry of entries) {
            if (entry.id) {
                idModes.set(entry.id, entry.mode);
            } else if (entry.name) {
                // チャンネルIDが取れなかった相手のための保険。
                // 表示名は変わりうるので、あくまで補助。
                nameModes.set(entry.name.toLowerCase(), entry.mode);
            }
        }
    }

    /* ------------------------------------------------ 判定 */

    /*
     * チャンネルIDの取得。
     *
     * 通常の発言は author-external-channel-id 属性を持つ。
     * ティッカーは属性を持たないので、Polymer が抱えている
     * データを浅く掘って探す。isolated world では __data が
     * 見えないため、失敗しても落とさない。
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
        if (node) return node.textContent.trim();

        try {
            const data = el.__data && el.__data.data;
            const name = data && data.authorName;
            if (name && typeof name.simpleText === 'string') {
                return name.simpleText.trim();
            }
        } catch {}

        return '';
    }

    // '' | 'all' | 'text'
    function modeOf(el) {
        const id = authorIdOf(el);
        if (id) return idModes.get(id) || '';

        const name = authorNameOf(el);
        if (!name) return '';
        return nameModes.get(name.toLowerCase()) || '';
    }

    /* ------------------------------------------------ 適用 */

    /*
     * 毎回すべての発言を判定し直す。
     *
     * チャットは要素を使い回すことがあるため、
     * 条件から外れた要素は必ず表示へ戻す
     * （隠しっぱなしにしない）。
     */
    function apply() {
        for (const el of document.querySelectorAll(MESSAGE_SELECTOR)) {
            const mode = paused ? '' : modeOf(el);
            const isTicker = el.matches(TICKER_SELECTOR);

            // ティッカーには本文が無いので
            // 'text' では触らない。
            el.classList.toggle(
                HIDDEN_CLASS,
                mode === 'all'
            );

            el.classList.toggle(
                TEXT_CLASS,
                mode === 'text' && !isTicker
            );

            if (mode === 'text' && !isTicker) {
                ensureMask(el);
            }
        }

        for (const el of document.querySelectorAll(BUTTON_SELECTOR)) {
            ensureButtons(el);
        }
    }

    function schedule() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            apply();
        });
    }

    /*
     * 本文を消したとき、そこが空白になると
     * 何が起きたのか分からなくなる。
     * 代わりに「（非表示）」と置いておく。
     */
    function ensureMask(el) {
        if (el.querySelector('.' + MASK_CLASS)) return;

        const mask = document.createElement('span');
        mask.className = MASK_CLASS;
        mask.textContent = MASK_TEXT;

        const message = el.querySelector('#message');
        if (message && message.parentNode) {
            message.parentNode.insertBefore(
                mask,
                message.nextSibling
            );
        } else {
            el.appendChild(mask);
        }
    }

    /* ------------------------------------------------ 追加・削除 */

    function addAuthor(id, name, mode) {
        if (!id && !name) return;

        const wanted = mode === 'text' ? 'text' : 'all';

        const existing = entries.find(e =>
            id ? e.id === id : !e.id && e.name === name
        );

        if (existing) {
            // 同じ相手にもう一方のボタンを押したときは、
            // 二重登録ではなく消し方の切り替えとして扱う。
            existing.mode = wanted;
        } else {
            entries.push({
                id: id || '',
                name: name || '',
                mode: wanted,
                addedAt: Date.now()
            });
        }

        saveEntries();
        rebuildIndex();
        renderList();
        apply();
    }

    function setMode(index, mode) {
        if (!entries[index]) return;
        entries[index].mode = mode === 'text' ? 'text' : 'all';
        saveEntries();
        rebuildIndex();
        renderList();
        apply();
    }

    function removeAt(index) {
        entries.splice(index, 1);
        saveEntries();
        rebuildIndex();
        renderList();
        apply();
    }

    /* ------------------------------------------------ UI */

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            .${HIDDEN_CLASS} {
                display: none !important;
            }

            .${MASK_CLASS} {
                display: none;
            }

            .${TEXT_CLASS} #message,
            .${TEXT_CLASS} #sticker {
                display: none !important;
            }

            .${TEXT_CLASS} .${MASK_CLASS} {
                display: inline;
                opacity: .45;
            }

            #${PANEL_ID} {
                position: fixed;
                right: 8px;
                top: 40px;
                z-index: 9999;
                width: 250px;
                max-height: 60vh;
                overflow-y: auto;
                padding: 8px;
                border-radius: 8px;
                border: 1px solid rgba(0,0,0,.2);
                background: #fff;
                color: #0f0f0f;
                font-size: 12px;
                line-height: 1.5;
                box-shadow: 0 2px 10px rgba(0,0,0,.25);
            }

            html[dark] #${PANEL_ID} {
                background: #212121;
                color: #f1f1f1;
                border-color: rgba(255,255,255,.2);
            }

            #${PANEL_ID}[hidden] {
                display: none;
            }

            #${PANEL_ID} .tm-ychide-row {
                display: flex;
                align-items: center;
                gap: 4px;
                padding: 3px 0;
            }

            #${PANEL_ID} .tm-ychide-name {
                flex: 1;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .tm-ychide-open {
                position: fixed;
                right: 8px;
                top: 8px;
                z-index: 9999;
                padding: 3px 8px;
                border-radius: 12px;
                border: 1px solid rgba(0,0,0,.2);
                background: rgba(255,255,255,.9);
                color: #0f0f0f;
                font-size: 11px;
                cursor: pointer;
            }

            html[dark] .tm-ychide-open {
                background: rgba(40,40,40,.9);
                color: #f1f1f1;
                border-color: rgba(255,255,255,.2);
            }

            ${BUTTON_SELECTOR.split(',')
                .map(tag => tag + '{position:relative!important;}')
                .join('\n')}

            .tm-ychide-btn {
                position: absolute;
                top: 2px;
                z-index: 5;
                display: none;
                padding: 0 5px;
                border-radius: 10px;
                border: 1px solid rgba(0,0,0,.2);
                background: rgba(255,255,255,.92);
                color: #0f0f0f;
                font-size: 11px;
                line-height: 16px;
                cursor: pointer;
            }

            .tm-ychide-btn-all {
                right: 2px;
            }

            .tm-ychide-btn-text {
                right: 44px;
            }

            html[dark] .tm-ychide-btn {
                background: rgba(40,40,40,.92);
                color: #f1f1f1;
                border-color: rgba(255,255,255,.25);
            }

            ${BUTTON_SELECTOR.split(',')
                .map(tag => tag + ':hover .tm-ychide-btn')
                .join(',')} {
                display: block;
            }
        `;

        (document.head || document.documentElement).appendChild(style);
    }

    /*
     * 発言の右上に出す小さなボタン。
     * ふだんは隠れていて、発言にカーソルを載せたときだけ出る。
     *
     *   「非表示」 … 発言をまるごと消す
     *   「文だけ」 … 名前を残して本文だけ消す
     */
    function ensureButtons(el) {
        if (el.querySelector(':scope > .tm-ychide-btn')) return;

        el.appendChild(
            makeButton(
                el,
                'all',
                '非表示',
                'この人の発言をまるごと消す'
            )
        );

        el.appendChild(
            makeButton(
                el,
                'text',
                '文だけ',
                '名前は残して、本文だけ消す'
            )
        );
    }

    function makeButton(el, mode, label, title) {
        const btn = document.createElement('button');
        btn.className =
            'tm-ychide-btn tm-ychide-btn-' + mode;
        btn.type = 'button';
        btn.textContent = label;
        btn.title = title;

        btn.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            addAuthor(authorIdOf(el), authorNameOf(el), mode);
        });

        return btn;
    }

    function buildPanel() {
        if (document.getElementById(PANEL_ID)) return;
        if (!document.body) return;

        const open = document.createElement('button');
        open.className = 'tm-ychide-open';
        open.type = 'button';
        open.textContent = '非表示リスト';
        open.addEventListener('click', () => {
            panel.hidden = !panel.hidden;
            if (!panel.hidden) renderList();
        });

        panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.hidden = true;

        const head = document.createElement('div');
        head.textContent = '非表示にしているユーザー';
        head.style.fontWeight = '600';
        head.style.marginBottom = '4px';

        const pauseRow = document.createElement('label');
        pauseRow.style.display = 'flex';
        pauseRow.style.alignItems = 'center';
        pauseRow.style.gap = '4px';
        pauseRow.style.marginBottom = '6px';

        const pauseBox = document.createElement('input');
        pauseBox.type = 'checkbox';
        pauseBox.addEventListener('change', () => {
            paused = pauseBox.checked;
            apply();
        });

        pauseRow.appendChild(pauseBox);
        pauseRow.appendChild(
            document.createTextNode('一時的に表示する')
        );

        listBox = document.createElement('div');

        panel.appendChild(head);
        panel.appendChild(pauseRow);
        panel.appendChild(listBox);

        document.body.appendChild(open);
        document.body.appendChild(panel);

        renderList();
    }

    function renderList() {
        if (!listBox) return;
        listBox.replaceChildren();

        if (!entries.length) {
            const empty = document.createElement('div');
            empty.textContent =
                '空です。発言にカーソルを載せると出るボタンで追加します。';
            empty.style.opacity = '.7';
            listBox.appendChild(empty);
            return;
        }

        entries.forEach((entry, index) => {
            const row = document.createElement('div');
            row.className = 'tm-ychide-row';

            const name = document.createElement('span');
            name.className = 'tm-ychide-name';
            name.textContent = entry.name || entry.id;
            name.title = entry.id
                ? entry.name + ' (' + entry.id + ')'
                : entry.name + '（表示名で判定）';

            // 押すたびに「全部」と「文だけ」が入れ替わる
            const modeBtn = document.createElement('button');
            modeBtn.className = 'tm-ychide-mode';
            modeBtn.type = 'button';
            modeBtn.textContent =
                entry.mode === 'text' ? '文だけ' : '全部';
            modeBtn.title = '消し方を切り替える';
            modeBtn.style.cursor = 'pointer';
            modeBtn.addEventListener('click', () =>
                setMode(
                    index,
                    entry.mode === 'text' ? 'all' : 'text'
                )
            );

            const del = document.createElement('button');
            del.className = 'tm-ychide-remove';
            del.type = 'button';
            del.textContent = '解除';
            del.style.cursor = 'pointer';
            del.addEventListener('click', () => removeAt(index));

            row.appendChild(name);
            row.appendChild(modeBtn);
            row.appendChild(del);
            listBox.appendChild(row);
        });
    }

    /* ------------------------------------------------ 起動 */

    function start() {
        injectStyle();
        buildPanel();
        apply();

        new MutationObserver(schedule).observe(
            document.documentElement,
            { childList: true, subtree: true }
        );

        // 取りこぼしの保険。
        // チャットは描画が速く、属性だけが
        // 後から入る場合がある。
        if (!sweepTimer) {
            sweepTimer = setInterval(apply, SWEEP_MS);
        }

        /*
         * 別タブ・別ウィンドウ（ポップアウトしたチャット）で
         * 追加した分をその場で反映する。
         */
        window.addEventListener('storage', event => {
            if (event.key !== STORE_KEY) return;
            entries = loadEntries();
            rebuildIndex();
            renderList();
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

    // 切り分け用。コンソールから状態を見たり、
    // チャンネルIDを直接足したりできる。
    window.__tmChatHide = {
        list: () => entries.slice(),
        add: (id, name, mode) =>
            addAuthor(id || '', name || '', mode),
        remove: index => removeAt(index),
        mode: (index, value) => setMode(index, value),
        pause: value => {
            paused = !!value;
            apply();
        },
        dump: () =>
            Array.from(
                document.querySelectorAll(MESSAGE_SELECTOR)
            ).map(el => ({
                tag: el.tagName.toLowerCase(),
                id: authorIdOf(el),
                name: authorNameOf(el),
                mode: modeOf(el),
                hidden: el.classList.contains(HIDDEN_CLASS),
                textHidden: el.classList.contains(TEXT_CLASS)
            }))
    };
})();
