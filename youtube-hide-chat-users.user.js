// ==UserScript==
// @name         YouTube チャット非表示 v1.0
// @namespace    https://www.youtube.com/
// @version      1.0
// @description  ライブチャットで指定したユーザーの発言をブロックせずに非表示にする（チャンネルID単位・スパチャ/メンバー加入/上部ティッカーも対象）
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
     */

    const STORE_KEY = 'tm-yt-chat-hide-users';
    const STYLE_ID = 'tm-ychide-style';
    const PANEL_ID = 'tm-ychide-panel';
    const HIDDEN_CLASS = 'tm-ychide-hidden';
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

    // [{ id, name, addedAt }]
    let entries = loadEntries();
    let idSet = new Set();
    let nameSet = new Set();
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
        idSet = new Set(
            entries
                .filter(e => e.id)
                .map(e => e.id)
        );

        // チャンネルIDが取れなかった相手のための保険。
        // 表示名は変わりうるので、あくまで補助。
        nameSet = new Set(
            entries
                .filter(e => !e.id && e.name)
                .map(e => e.name.toLowerCase())
        );
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

    function isBlocked(el) {
        const id = authorIdOf(el);
        if (id) return idSet.has(id);

        const name = authorNameOf(el);
        return !!name && nameSet.has(name.toLowerCase());
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
        const nodes = document.querySelectorAll(MESSAGE_SELECTOR);

        for (const el of nodes) {
            const hide = !paused && isBlocked(el);
            el.classList.toggle(HIDDEN_CLASS, hide);
        }

        for (const el of document.querySelectorAll(BUTTON_SELECTOR)) {
            ensureButton(el);
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

    /* ------------------------------------------------ 追加・削除 */

    function addAuthor(id, name) {
        if (!id && !name) return;

        const already = entries.some(e =>
            id ? e.id === id : !e.id && e.name === name
        );
        if (already) return;

        entries.push({
            id: id || '',
            name: name || '',
            addedAt: Date.now()
        });

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

            #${PANEL_ID} {
                position: fixed;
                right: 8px;
                bottom: 48px;
                z-index: 9999;
                width: 240px;
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
                gap: 6px;
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
                bottom: 8px;
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
                right: 2px;
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
     */
    function ensureButton(el) {
        if (el.querySelector(':scope > .tm-ychide-btn')) return;

        const btn = document.createElement('button');
        btn.className = 'tm-ychide-btn';
        btn.type = 'button';
        btn.textContent = '非表示';
        btn.title = 'このユーザーの発言を自分の画面から消す';

        btn.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            addAuthor(authorIdOf(el), authorNameOf(el));
        });

        el.appendChild(btn);
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
                '空です。発言にカーソルを載せると出る「非表示」ボタンで追加します。';
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

            const del = document.createElement('button');
            del.type = 'button';
            del.textContent = '解除';
            del.style.cursor = 'pointer';
            del.addEventListener('click', () => removeAt(index));

            row.appendChild(name);
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
        add: (id, name) => addAuthor(id || '', name || ''),
        remove: index => removeAt(index),
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
                hidden: el.classList.contains(HIDDEN_CLASS)
            }))
    };
})();
