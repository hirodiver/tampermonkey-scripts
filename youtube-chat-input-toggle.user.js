// ==UserScript==
// @name         YouTube チャット入力欄切替 v1.0.0
// @namespace    local.hiro.tools
// @version      1.0.0
// @description  ライブチャット下部の入力欄（文字を打つ枠と絵文字ボタン）を、ボタン1つで隠したり戻したりする。スーパーチャット（¥）とハートのボタンは残す
// @match        https://www.youtube.com/live_chat*
// @grant        none
// @run-at       document-start
// @homepageURL  https://github.com/hirodiver/tampermonkey-scripts
// @supportURL   https://github.com/hirodiver/tampermonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/youtube-chat-input-toggle.user.js
// @updateURL    https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/youtube-chat-input-toggle.user.js
// ==/UserScript==

(function () {
    'use strict';

    /*
     * YouTube のライブチャットは watch ページ内の iframe（/live_chat）で動く。
     * ポップアウトすると同じURLが単独のウィンドウになる。どちらも @match に一致する。
     *
     * 下部の入力帯は、おおむね次の並び:
     *
     *   [ 文字を打つ枠 … 😊 ]  [ ¥ ]  [ ♡ ]
     *    └──── 隠すのはここ ────┘   └ 残す ┘
     *
     * 入力帯の内部構造（id やクラス）は確認できていないので、
     * 「文字を打つ枠から親へたどり、¥ やハートなどのボタンを含まない
     * 一番外側の入れ物」を枠と見なす。絵文字ボタンだけは枠の一部として扱う。
     *
     * 隠すのは画面上だけ（display:none）。YouTube 側には何も送らない。
     */

    // ============================================================
    // 設定
    // ============================================================

    // 隠した／出した状態を覚えるキー（localStorage）
    const STORE_KEY = 'tm-yt-chat-input-hidden';

    // DOM の変化から枠を探し直すまでの待ち時間(ms)
    const APPLY_DEBOUNCE_MS = 150;

    // 変化の通知を取りこぼしたときの保険の見回り間隔(ms)
    const SWEEP_MS = 2000;

    // 入力帯がどこにも見つからないときに、文字の枠から親へたどる上限
    const MAX_CLIMB = 6;

    // ボタンの文字
    const LABEL_WHEN_SHOWN = '隠す';
    const LABEL_WHEN_HIDDEN = '入力欄';

    // ============================================================
    // 目印
    // ============================================================

    const STYLE_ID = 'tm-ycin-style';
    const BTN_ID = 'tm-ycin-toggle';
    const OFF_CLASS = 'tm-ycin-off';     // <html> に付ける。付いている間は隠す
    const PILL_CLASS = 'tm-ycin-pill';   // 隠す対象の入れ物に付ける

    // 入力帯全体（これより外へはたどらない）。新旧を順に試す
    const ROOT_SELECTORS = [
        'yt-live-chat-message-input-renderer',
        '#input-panel',
        'yt-live-chat-restricted-participation-renderer'
    ];

    // 文字を打つ枠。上から順に試す
    const FIELD_SELECTORS = [
        'yt-live-chat-text-input-field-renderer',
        'yt-live-chat-message-input-renderer div#input[contenteditable]',
        'yt-live-chat-message-input-renderer [contenteditable="true"]',
        'yt-live-chat-message-input-renderer [contenteditable]',
        '#input-panel [contenteditable]'
    ];

    // ボタンらしい要素。枠の外にあるはずのもの（¥・ハート・送信など）を見分けるのに使う
    const BUTTON_LIKE_SELECTOR = [
        'button',
        '[role="button"]',
        'yt-button-renderer',
        'yt-button-view-model',
        'yt-icon-button',
        'tp-yt-paper-icon-button',
        'yt-live-chat-icon-toggle-button-renderer',
        '#product-picker',
        '#send-button',
        'yt-reaction-control-panel-view-model',
        'yt-reaction-control-panel-overlay-view-model'
    ].join(',');

    // 絵文字ボタン。これだけは枠の一部として一緒に隠す
    const EMOJI_SELECTOR = [
        '#emoji',
        '[id*="emoji" i]',
        '[class*="emoji" i]',
        '[aria-label*="絵文字"]',
        '[aria-label*="emoji" i]'
    ].join(',');

    // 必ず残すもの（ボタンらしさの判定が外れたときの保険）
    const KEEP_SELECTOR = [
        '#product-picker',
        '[aria-label*="スーパー"]',
        '[aria-label*="Super" i]',
        '[aria-label*="Thanks" i]',
        'yt-reaction-control-panel-view-model',
        'yt-reaction-control-panel-overlay-view-model'
    ].join(',');

    // ============================================================
    // 状態
    // ============================================================

    let hidden = loadHidden();
    let currentPill = null;
    let lastReason = '未実行';
    let applyTimer = null;

    // ============================================================
    // 保存
    // ============================================================

    function loadHidden() {
        try {
            return localStorage.getItem(STORE_KEY) === '1';
        } catch (e) {
            return false;
        }
    }

    function saveHidden() {
        try {
            if (hidden) {
                localStorage.setItem(STORE_KEY, '1');
            } else {
                localStorage.removeItem(STORE_KEY);
            }
        } catch (e) {
            // 保存できなくても、このタブの切替は効く
        }
    }

    // ============================================================
    // CSS（document-start で先に効かせる）
    // ============================================================

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) {
            return;
        }

        const style = document.createElement('style');
        style.id = STYLE_ID;

        style.textContent = [
            // JS が見つけた枠
            `html.${OFF_CLASS} .${PILL_CLASS} { display: none !important; }`,

            // JS が枠を見つける前の保険（読み込み直後に一瞬見えないように）
            `html.${OFF_CLASS} yt-live-chat-message-input-renderer yt-live-chat-text-input-field-renderer { display: none !important; }`,

            // 切替ボタン
            `#${BTN_ID} {`,
            '    flex: 0 0 auto;',
            '    align-self: center;',
            '    height: 32px;',
            '    min-width: 44px;',
            '    margin: 0 6px 0 0;',
            '    padding: 0 10px;',
            '    border: none;',
            '    border-radius: 16px;',
            '    background: var(--yt-spec-badge-chip-background, rgba(0, 0, 0, 0.05));',
            '    color: var(--yt-spec-text-primary, #0f0f0f);',
            '    font-family: Roboto, Arial, sans-serif;',
            '    font-size: 12px;',
            '    line-height: 32px;',
            '    white-space: nowrap;',
            '    cursor: pointer;',
            '}',
            `#${BTN_ID}:hover {`,
            '    background: var(--yt-spec-button-chip-background-hover, rgba(0, 0, 0, 0.1));',
            '}'
        ].join('\n');

        (document.head || document.documentElement).appendChild(style);
    }

    function reflectClass() {
        if (document.documentElement) {
            document.documentElement.classList.toggle(OFF_CLASS, hidden);
        }
    }

    // document-start では <html> がまだ無いことがある。できた時点で cb を呼ぶ
    function whenRoot(cb) {
        if (document.documentElement) {
            cb();
            return;
        }

        const waiter = new MutationObserver(() => {
            if (document.documentElement) {
                waiter.disconnect();
                cb();
            }
        });

        waiter.observe(document, {
            childList: true
        });
    }

    // ============================================================
    // 枠を探す
    // ============================================================

    function findFirst(selectors, scope) {
        for (const selector of selectors) {
            let el = null;

            try {
                el = (scope || document).querySelector(selector);
            } catch (e) {
                el = null;
            }

            if (el) {
                return el;
            }
        }

        return null;
    }

    function findField() {
        return findFirst(FIELD_SELECTORS);
    }

    function findRoot(field) {
        for (const selector of ROOT_SELECTORS) {
            const root = field.closest(selector);

            if (root) {
                return root;
            }
        }

        return null;
    }

    function isOwnElement(el) {
        return el.id === BTN_ID || !!el.closest(`#${BTN_ID}`);
    }

    function isEmojiish(el) {
        if (el.matches(EMOJI_SELECTOR) || el.closest(EMOJI_SELECTOR)) {
            return true;
        }

        return !!el.querySelector(EMOJI_SELECTOR);
    }

    // この入れ物の中に、残すべきボタン（絵文字以外）があるか
    function blockerIn(container, field) {
        if (container.querySelector(KEEP_SELECTOR)) {
            return container.querySelector(KEEP_SELECTOR);
        }

        if (container.querySelector(`#${BTN_ID}`)) {
            return container.querySelector(`#${BTN_ID}`);
        }

        const buttons = container.querySelectorAll(BUTTON_LIKE_SELECTOR);

        for (const b of buttons) {
            if (field.contains(b)) {
                continue;
            }

            if (isOwnElement(b)) {
                return b;
            }

            // 絵文字ボタン（の中身）は枠の一部
            const emojiHost = b.closest(EMOJI_SELECTOR);

            if (emojiHost && container.contains(emojiHost)) {
                continue;
            }

            if (b.matches(EMOJI_SELECTOR) || b.querySelector(EMOJI_SELECTOR)) {
                continue;
            }

            return b;
        }

        return null;
    }

    // 文字の枠から親へたどり、残すボタンを含まない一番外側を返す
    function findPill(field) {
        const root = findRoot(field);
        let pill = field;
        let climbed = 0;

        while (pill.parentElement) {
            const parent = pill.parentElement;

            if (root && parent === root) {
                break;
            }

            if (!root && climbed >= MAX_CLIMB) {
                break;
            }

            if (parent === document.body || parent === document.documentElement) {
                break;
            }

            if (blockerIn(parent, field)) {
                break;
            }

            pill = parent;
            climbed += 1;
        }

        return pill;
    }

    // ============================================================
    // 切替ボタン
    // ============================================================

    function getButton() {
        let btn = document.getElementById(BTN_ID);

        if (btn) {
            return btn;
        }

        btn = document.createElement('button');
        btn.id = BTN_ID;
        btn.type = 'button';

        btn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            toggle();
        });

        // YouTube 側のキー操作（入力帯のショートカット等）に渡さない
        btn.addEventListener('keydown', (ev) => {
            ev.stopPropagation();
        });

        return btn;
    }

    function updateButton(btn) {
        const label = hidden ? LABEL_WHEN_HIDDEN : LABEL_WHEN_SHOWN;
        const tip = hidden ? 'チャット入力欄を出す' : 'チャット入力欄を隠す';

        if (btn.textContent !== label) {
            btn.textContent = label;
        }

        btn.title = tip;
        btn.setAttribute('aria-label', tip);
        btn.setAttribute('aria-pressed', hidden ? 'true' : 'false');
    }

    // ============================================================
    // 反映
    // ============================================================

    function apply() {
        applyTimer = null;
        reflectClass();

        const field = findField();

        if (!field) {
            lastReason = '文字を打つ枠が見つからない（未ログイン・チャット無効など）';
            clearMarks(null);
            const stale = document.getElementById(BTN_ID);

            if (stale) {
                stale.remove();
            }

            currentPill = null;
            return;
        }

        const pill = findPill(field);

        clearMarks(pill);

        if (!pill.classList.contains(PILL_CLASS)) {
            pill.classList.add(PILL_CLASS);
        }

        currentPill = pill;

        const btn = getButton();
        updateButton(btn);

        // 枠のすぐ前（同じ親の中）に置く。枠が隠れても同じ場所に残る
        if (btn.parentNode !== pill.parentNode || btn.nextElementSibling !== pill) {
            pill.parentNode.insertBefore(btn, pill);
        }

        lastReason = hidden ? '隠している' : '出している';
    }

    function clearMarks(keep) {
        for (const el of document.querySelectorAll(`.${PILL_CLASS}`)) {
            if (el !== keep) {
                el.classList.remove(PILL_CLASS);
            }
        }
    }

    function scheduleApply(delay) {
        if (applyTimer) {
            return;
        }

        applyTimer = setTimeout(apply, delay);
    }

    function toggle() {
        hidden = !hidden;
        saveHidden();
        apply();

        // 出したときは、すぐ打てるようにカーソルを入れる
        if (!hidden) {
            const field = findField();
            const editable = field && (field.matches('[contenteditable]')
                ? field
                : field.querySelector('[contenteditable]'));

            if (editable && typeof editable.focus === 'function') {
                editable.focus();
            }
        }
    }

    // ============================================================
    // 監視
    // ============================================================

    function isOwnMutation(m) {
        const t = m.target;

        if (t && t.nodeType === 1 && isOwnElement(t)) {
            return true;
        }

        for (const n of m.addedNodes) {
            if (n.nodeType === 1 && n.id === BTN_ID) {
                return true;
            }
        }

        return false;
    }

    function startObserver() {
        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (!isOwnMutation(m)) {
                    scheduleApply(APPLY_DEBOUNCE_MS);
                    return;
                }
            }
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    }

    // ポップアウトと埋め込みの両方を開いているとき、片方で切り替えたら揃える
    window.addEventListener('storage', (ev) => {
        if (ev.key !== STORE_KEY) {
            return;
        }

        hidden = loadHidden();
        apply();
    });

    // ============================================================
    // 診断
    // ============================================================

    function describe(el) {
        if (!el) {
            return '(なし)';
        }

        const id = el.id ? `#${el.id}` : '';
        const cls = typeof el.className === 'string' && el.className.trim()
            ? '.' + el.className.trim().split(/\s+/).join('.')
            : '';

        return el.tagName.toLowerCase() + id + cls;
    }

    window.__tmYtChatInput = {
        dump() {
            const field = findField();
            const rows = [];

            if (field) {
                const root = findRoot(field);
                let el = field;

                for (let i = 0; i < MAX_CLIMB + 4 && el; i += 1) {
                    const blocker = el === field ? null : blockerIn(el, field);

                    rows.push({
                        段: i,
                        要素: describe(el),
                        隠す対象: el === currentPill ? '★' : '',
                        止めたボタン: blocker ? describe(blocker) : '',
                        入力帯全体: el === root ? 'はい' : ''
                    });

                    if (el === root) {
                        break;
                    }

                    el = el.parentElement;
                }
            }

            console.log('[YouTube チャット入力欄切替] 状態:', hidden ? '隠す' : '出す', '/', lastReason);
            console.log('[YouTube チャット入力欄切替] 文字の枠:', describe(field));
            console.table(rows);

            return rows;
        },
        toggle
    };

    // ============================================================
    // 起動
    // ============================================================

    whenRoot(() => {
        reflectClass();
        injectStyle();
        startObserver();
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => apply());
    } else {
        apply();
    }

    setInterval(() => scheduleApply(0), SWEEP_MS);
})();
