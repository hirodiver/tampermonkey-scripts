// ==UserScript==
// @name         Twitch Volume Boost v1.0.0
// @namespace    local.hiro.tools
// @version      1.0.0
// @description  Twitchの音量を100%超（最大500%）に増幅する。プレイヤー上のホバーで出るスライダー、Alt+↑/↓/0、Tampermonkeyメニューで操作する
// @match        https://www.twitch.tv/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        unsafeWindow
// @homepageURL  https://github.com/hirodiver/tampermonkey-scripts
// @supportURL   https://github.com/hirodiver/tampermonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/twitch-volume-boost.user.js
// @updateURL    https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/twitch-volume-boost.user.js
// ==/UserScript==

/*
  * 音声経路: video -> GainNode -> DynamicsCompressor（簡易リミッター） -> destination
  * Twitch側の音量スライダー（video.volume）は経路の手前で効くので、掛け算になる。
  *
  * 経路へつなぐ（createMediaElementSource）のは、次の条件がそろったときだけ。
  * 一度つなぐと元に戻せず、以後の音はすべて AudioContext を通るため。
  *
  * - 倍率が100%を超えている
  *   100%のままなら経路を通す意味がなく、リミッターで音質を変えるだけになる
  * - AudioContext が動いている（running）
  *   ブラウザの自動再生ポリシーで、ユーザー操作の前は suspended のまま始まる。
  *   この状態でつなぐと、操作するまで配信が無音になる
  * - video が MSE（blob: URL）で再生している
  *   別オリジンの直接URL（iOS Safari のネイティブHLS等）をつなぐと、
  *   CORSの制限で無音になる。対象外として何もしない
  */

(function () {
    'use strict';

    // ============================================================
    // 設定
    // ============================================================
    const MIN_BOOST = 1.0;
    const MAX_BOOST = 5.0;
    const STEP = 0.25;
    const DEFAULT_BOOST = 1.0;
    const USE_LIMITER = true; // 増幅時の音割れ対策（簡易リミッター）
    const STORE_KEY = 'twitchBoost';
    const UI_MIN_WIDTH = 300; // これ未満の幅のvideo（ホバープレビュー等）にはUIを出さない
    const FLASH_MS = 1200; // キー・メニュー操作の後、スライダーを見せておく時間
    const GAIN_SMOOTHING = 0.02; // 増幅率を変えたときになめらかに追従させる時定数（秒）。プツッという音を防ぐ
    const LOG = '[Twitch Volume Boost]';

    // 簡易リミッター（DynamicsCompressor）の設定
    const LIMITER = { threshold: -3, knee: 0, ratio: 20, attack: 0.003, release: 0.1 };
    // DynamicsCompressor は仕様上、自動でメイクアップゲインを足す（この設定で約+1.7dB = 約1.22倍）。
    // そのままだと「×2.00」が実際は約2.44倍になるので、GainNode 側で打ち消す。
    // 仕様: makeup = (1 / 0dB入力時のゲイン)^0.6
    const LIMITER_MAKEUP = USE_LIMITER
        ? Math.pow(10, ((-LIMITER.threshold * (1 - 1 / LIMITER.ratio)) * 0.6) / 20)
        : 1;

    // プレイヤーの入れ物。上から順に探し、無ければ大きさで推定する
    const CONTAINER_SELECTORS = [
        '.video-player__container',
        '[data-a-target="video-player"]',
        '.video-player',
    ];

    // ============================================================
    // 状態
    // ============================================================
    let boost = clamp(Number(GM_getValue(STORE_KEY, DEFAULT_BOOST)) || DEFAULT_BOOST);
    let ctx = null;

    const hooked = new WeakMap(); // video -> { gain } | { gain: null, reason }
    const uiMap = new WeakMap(); // video -> { root, slider, label, timer }
    const watched = new WeakSet(); // 'playing' 等を見ている video

    function clamp(v) {
        return Math.min(MAX_BOOST, Math.max(MIN_BOOST, v));
    }

    function formatBoost(v) {
        return `×${v.toFixed(2)}`;
    }

    function getContext() {
        if (!ctx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            ctx = new AC();
            ctx.addEventListener('statechange', scheduleScan);
        }
        return ctx;
    }

    function isRunning() {
        return !!ctx && ctx.state === 'running';
    }

    function resume() {
        if (ctx && ctx.state === 'suspended') {
            ctx.resume().then(scheduleScan, () => {});
        }
    }

    // ============================================================
    // 音声経路
    // ============================================================
    function isMse(video) {
        return (video.currentSrc || video.src || '').startsWith('blob:');
    }

    function hook(video) {
        if (hooked.has(video)) {
            return;
        }

        if (!watched.has(video)) {
            // src の差し替え・再生開始の時点で判定し直す
            watched.add(video);
            for (const type of ['loadstart', 'playing', 'volumechange']) {
                video.addEventListener(type, scheduleScan);
            }
        }

        if (boost <= 1) {
            return; // 100%のままならつながない
        }

        getContext();

        if (!isRunning()) {
            resume(); // ユーザー操作の後なら動き出す。動いたら scan し直す
            return;
        }

        if (!isMse(video)) {
            if (video.currentSrc) {
                // 再生対象が決まっていて MSE ではない。つなぐと無音になりうるので触らない
                hooked.set(video, { gain: null, reason: `対象外のsrc: ${video.currentSrc.slice(0, 40)}` });
            }
            return; // currentSrc が空ならまだ読み込み前。loadstart で判定し直す
        }

        try {
            const source = ctx.createMediaElementSource(video);
            const gain = ctx.createGain();
            gain.gain.value = boost / LIMITER_MAKEUP;
            source.connect(gain);

            if (USE_LIMITER) {
                const limiter = ctx.createDynamicsCompressor();
                for (const [k, v] of Object.entries(LIMITER)) {
                    limiter[k].value = v;
                }
                gain.connect(limiter);
                limiter.connect(ctx.destination);
            } else {
                gain.connect(ctx.destination);
            }

            hooked.set(video, { gain });
        } catch (e) {
            // 既に別の経路（他の拡張など）へ接続済みの video など。再試行しない
            hooked.set(video, { gain: null, reason: String(e && e.message) });
            console.warn(LOG, 'hook failed', e);
        }
    }

    function applyBoost() {
        for (const video of document.querySelectorAll('video')) {
            const entry = hooked.get(video);

            if (entry && entry.gain) {
                entry.gain.gain.setTargetAtTime(
                    boost / LIMITER_MAKEUP,
                    entry.gain.context.currentTime,
                    GAIN_SMOOTHING
                );
            }

            const ui = uiMap.get(video);

            if (ui) {
                ui.slider.value = String(boost);
                ui.label.textContent = formatBoost(boost);
            }
        }

        scan(); // 100%から上げたときに、ここで初めてつなぐ
    }

    function setBoost(value, { flash = false } = {}) {
        boost = clamp(Math.round(value * 100) / 100);

        try {
            GM_setValue(STORE_KEY, boost);
        } catch {
            // 保存失敗は無視
        }

        applyBoost();

        if (flash) {
            flashUi();
        }
    }

    // ============================================================
    // UI（プレイヤー上にホバーで出る小さなスライダー）
    // ============================================================
    const CSS = `
        .tvb-panel {
            position: absolute; left: 8px; top: 8px; z-index: 9999;
            display: flex; align-items: center; gap: 6px;
            padding: 4px 8px; border-radius: 6px;
            background: rgba(0, 0, 0, 0.65); color: #fff;
            font: 12px/1 sans-serif;
            opacity: 0; pointer-events: none; transition: opacity 0.15s;
        }
        .tvb-host:hover > .tvb-panel, .tvb-panel:hover, .tvb-panel.tvb-show,
        .tvb-panel:focus-within { opacity: 1; pointer-events: auto; }
        .tvb-panel input[type=range] { width: 110px; margin: 0; }
        .tvb-panel .tvb-label { min-width: 40px; text-align: right; font-variant-numeric: tabular-nums; }
    `;

    function injectStyle() {
        if (typeof GM_addStyle === 'function') {
            GM_addStyle(CSS); // ページのCSPに左右されない
            return;
        }
        const style = document.createElement('style');
        style.textContent = CSS;
        (document.head || document.documentElement).appendChild(style);
    }

    // video を包むプレイヤーの入れ物。既知のセレクタ → 大きさが video とほぼ同じ祖先
    function findContainer(video) {
        for (const sel of CONTAINER_SELECTORS) {
            const el = video.closest(sel);
            if (el) {
                return el;
            }
        }

        const vr = video.getBoundingClientRect();
        let best = video.parentElement;
        for (let el = video.parentElement; el && el !== document.body; el = el.parentElement) {
            const r = el.getBoundingClientRect();
            if (r.width > vr.width * 1.2 + 4 || r.height > vr.height * 1.5 + 4) {
                break;
            }
            best = el;
        }
        return best;
    }

    // フルスクリーン中は、その要素の中に置かないと見えない
    function placeOf(video) {
        const fs = document.fullscreenElement || document.webkitFullscreenElement;
        const container = findContainer(video);

        if (fs && fs !== video && fs.contains(video) && !(container && fs.contains(container))) {
            return fs;
        }
        return container;
    }

    function createUi(video) {
        const existing = uiMap.get(video);

        if (video.clientWidth < UI_MIN_WIDTH) {
            if (existing) {
                existing.root.remove(); // ミニプレイヤーへ縮んだ等
            }
            return;
        }

        const host = placeOf(video);

        if (!host) {
            return;
        }

        if (existing) {
            // プレイヤーの作り直し・フルスクリーン切替で入れ物が変わったら付け替える
            if (existing.root.parentElement !== host) {
                attach(host, existing.root);
            }
            return;
        }

        const root = document.createElement('div');
        root.className = 'tvb-panel';
        root.title = 'Twitch Volume Boost（Alt+↑ / Alt+↓ / Alt+0）';

        const icon = document.createElement('span');
        icon.textContent = '🔊';

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = String(MIN_BOOST);
        slider.max = String(MAX_BOOST);
        slider.step = String(STEP);
        slider.value = String(boost);
        slider.setAttribute('aria-label', '音量ブースト');

        const label = document.createElement('span');
        label.className = 'tvb-label';
        label.textContent = formatBoost(boost);

        slider.addEventListener('input', () => setBoost(Number(slider.value)));

        // Twitch側のクリック（一時停止）・ダブルクリック（全画面）・キー操作に拾われないようにする
        for (const type of ['click', 'dblclick', 'mousedown', 'pointerdown', 'keydown', 'wheel']) {
            root.addEventListener(type, (e) => e.stopPropagation());
        }

        root.append(icon, slider, label);
        attach(host, root);
        uiMap.set(video, { root, slider, label, timer: 0 });
    }

    function attach(host, root) {
        host.classList.add('tvb-host');
        if (getComputedStyle(host).position === 'static') {
            host.style.position = 'relative';
        }
        host.appendChild(root);
    }

    function flashUi() {
        for (const video of document.querySelectorAll('video')) {
            const ui = uiMap.get(video);
            if (!ui || !ui.root.isConnected) {
                continue;
            }
            ui.root.classList.add('tvb-show');
            clearTimeout(ui.timer);
            ui.timer = setTimeout(() => ui.root.classList.remove('tvb-show'), FLASH_MS);
        }
    }

    // ============================================================
    // 走査（SPA遷移・プレイヤー再生成に追従）
    // ============================================================
    function scan() {
        for (const video of document.querySelectorAll('video')) {
            hook(video);
            createUi(video);
        }
    }

    let timer = null;

    function scheduleScan() {
        if (timer) {
            return;
        }

        timer = setTimeout(() => {
            timer = null;
            scan();
        }, 300);
    }

    // ============================================================
    // 操作: Alt+↑ / Alt+↓ / Alt+0 とメニューコマンド
    // ============================================================
    function isTextField(t) {
        if (!t || !t.tagName) {
            return false;
        }
        if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') {
            return true;
        }
        // 自分のスライダー（type=range）は除外しない。押した後もキーが効くように
        return t.tagName === 'INPUT' && t.type !== 'range';
    }

    // window の capture で拾い、Twitch の矢印キー（音量）より先に処理する
    window.addEventListener(
        'keydown',
        (e) => {
            if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || isTextField(e.target)) {
                return;
            }

            // macOS の Option+0 は e.key が「º」になるため、e.code で判定する
            if (e.code === 'ArrowUp') {
                setBoost(boost + STEP, { flash: true });
            } else if (e.code === 'ArrowDown') {
                setBoost(boost - STEP, { flash: true });
            } else if (e.code === 'Digit0' || e.code === 'Numpad0') {
                setBoost(1, { flash: true });
            } else {
                return;
            }

            e.preventDefault();
            e.stopPropagation();
        },
        true
    );

    // コンソールから: __tmTwitchVolumeBoost.dump() / __tmTwitchVolumeBoost.set(3)
    try {
        const api = {
            dump,
            set: (v) => setBoost(Number(v), { flash: true }),
        };
        (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__tmTwitchVolumeBoost = api;
    } catch {
        // 公開できなくてもメニューから診断できる
    }

    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('音量ブースト +0.25', () => setBoost(boost + STEP, { flash: true }));
        GM_registerMenuCommand('音量ブースト -0.25', () => setBoost(boost - STEP, { flash: true }));
        GM_registerMenuCommand('音量ブースト リセット', () => setBoost(1, { flash: true }));
        GM_registerMenuCommand('診断をコンソールに出す', dump);
    }

    // 別タブで変えた倍率を反映する
    if (typeof GM_addValueChangeListener === 'function') {
        GM_addValueChangeListener(STORE_KEY, (_key, _old, value, remote) => {
            if (remote) {
                boost = clamp(Number(value) || DEFAULT_BOOST);
                applyBoost();
            }
        });
    }

    function dump() {
        const rows = [...document.querySelectorAll('video')].map((v) => {
            const entry = hooked.get(v);
            const ui = uiMap.get(v);
            const c = findContainer(v);
            return {
                size: `${v.clientWidth}x${v.clientHeight}`,
                src: (v.currentSrc || '').slice(0, 40),
                paused: v.paused,
                volume: v.volume,
                muted: v.muted,
                hooked: entry ? (entry.gain ? 'yes' : `no (${entry.reason})`) : 'not yet',
                container: c ? `${c.tagName.toLowerCase()}.${[...c.classList].join('.')}` : null,
                matchedSelector: CONTAINER_SELECTORS.find((s) => v.closest(s)) || '(大きさで推定)',
                ui: ui ? (ui.root.isConnected ? 'shown' : 'detached') : 'none',
            };
        });
        console.log(LOG, { boost, context: ctx ? ctx.state : 'none', fullscreen: !!document.fullscreenElement });
        console.table(rows);
    }

    // ユーザー操作で AudioContext を起こす（自動再生ポリシー対策）
    for (const type of ['pointerdown', 'keydown']) {
        window.addEventListener(type, resume, true);
    }

    document.addEventListener('fullscreenchange', scan);
    document.addEventListener('webkitfullscreenchange', scan);

    injectStyle();
    scan();
    new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
})();
