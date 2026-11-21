// ==UserScript==
// @name         Twitch Volume Boost v1.1.0
// @namespace    local.hiro.tools
// @version      1.1.0
// @description  Twitch の音量を 100% より上（最大 600%）まで上げる。プレイヤーの音量バーを 0〜600% の1本の長いバーに置き換え、つまみ1つで動かせる（目盛りは対数で、0〜100% がバーの約2/3）。YouTube 音量ブーストと同じ見た目・操作
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

(function () {
    'use strict';

    /*
     * YouTube 音量ブースト（youtube-volume-boost.user.js）の Twitch 版。
     * 見た目・操作はできるだけ YouTube 版に揃えている。
     *
     *   <video> → MediaElementSource → GainNode（×1〜×6） → リミッター → スピーカー
     *
     * Twitch 本来の音量バーは隠し、つまみ1つの 0〜600% のバーを置く。
     *
     *   [ミュート][0 ── 25 ── 50 ── 100 │ 200 ── 400 ─ 600] 250%
     *              ↑ Twitch の音量          ↑ 増幅（ブースト）
     *
     *   - 目盛りは対数（音量が 2 倍になるごとに同じ長さ）。0〜100% がバーの約 2/3
     *   - 0〜100% の部分は Twitch の音量そのもの
     *   - 100% より右は、Twitch の音量を 100% にしたうえで Web Audio で増幅する
     *
     * YouTube 版との違い:
     *   - Twitch には YouTube の getVolume / setVolume のような窓口が無いので、
     *     Twitch の音量バー（input type=range）を「人が動かしたように」動かして音量を変える
     *   - Twitch の音量バーが見つからないときは、Twitch の音量バーを残し、
     *     その右に 100〜600% の延長部分だけを付ける（YouTube 版の「API が無いとき」と同じ形）
     *   - 設定は GM_setValue に保存する（別タブにも反映する）
     *   - 現行の Twitch（Amazon IVS Player）は、映像を srcObject で渡すので src が空になる。
     *     srcObject の動画もつなぐ（v1.0.2〜）
     *
     * 注意:
     *   - 動画を Web Audio につなぐと、外す方法がない（ページを開き直すまで）。
     *     そのため、100% より上げるまでは音声に一切手を付けない。
     *   - Chrome は、ページを一度もクリックしていない状態では Web Audio を止めておく
     *     （自動再生の制限）。止まったままつなぐと無音になるので、そのときは
     *     つながずに待ち、最初のクリックかキー入力で有効にする。
     *
     * 診断: DevTools のコンソールで __tmTwitchVolumeBoost.dump()
     */

    // ============================================================
    // 設定
    // ============================================================

    // 上限（%）。YouTube 版と同じ 600%
    const MAX_BOOST = 600;

    // 100% より上をドラッグしたときの刻み（%）。100% 以下は 1% 刻み
    const SLIDER_STEP = 5;

    // ドラッグで 100% の前後このくらい（%）に来たら、100% ちょうどに吸い付ける
    const SNAP_TO_100 = 6;

    // 目盛りを対数にするか（音量が 2 倍になるごとに同じ長さ進む）。false で均等割り
    const LOG_SCALE = true;

    // 対数目盛りの下端（%）。これより小さい音量は、左端のわずかな区間（LOG_FLOOR_POS）に詰める
    const LOG_FLOOR = 3;
    const LOG_FLOOR_POS = 0.03;

    // ↑↓←→キー・ホイール1回で動く量（%）。100% 以下は 5%、上は 10%
    const KEY_STEP = 10;
    const SMALL_STEP = 5;

    // 次に Twitch を開いたときも増幅を引き継ぐか
    const REMEMBER_BOOST = true;

    // 100% を超えている間だけ、音割れを抑えるリミッターを通すか（初期値）。
    // バーの右クリック（または右の数字のクリック）で「きれい」と「大きく」が切り替わり、その選択を覚える
    const USE_LIMITER = true;

    // リミッターの設定（DynamicsCompressorNode）。
    // しきい値は 0dB。下げると Chrome が自動で音を持ち上げ（メイクアップゲイン）、表示とずれる
    const LIMITER = {
        threshold: 0,     // dB
        knee: 0,          // dB
        ratio: 20,
        attack: 0.003,    // 秒
        release: 0.25     // 秒
    };

    // 増幅率を変えたときに、なめらかに追従させる時定数（秒）。0 で即時
    const GAIN_SMOOTHING = 0.02;

    // 100% 以下に戻したあと、リミッターを外すまでの待ち（ms）
    const LIMITER_RELEASE_DELAY = 200;

    // 0〜100% の部分で、つまみが動く長さ（px）の既定値。
    // Twitch の音量バーが開いたときの幅を実測できたら、そちらを使う
    const DEFAULT_TRAVEL = 60;

    // バー全体の長さの上限（プレイヤーの幅に対する割合）
    const MAX_WIDTH_RATIO = 0.3;

    // Twitch の音量バーが見つからないときの延長部分（100〜600%）の長さ（px）
    const TRACK_WIDTH = 64;

    // つまみの直径（px）
    const KNOB_SIZE = 12;

    // 「音量 250%」表示を出しておく時間（ms）
    const TOAST_MS = 900;

    // Twitch 側の音量が下がったのを確かめるまでの待ち（ms）。
    // 配信の切り替わりなどで一瞬だけ違う値が見えても、増幅を外さないため
    const VOLUME_CHECK_DELAY = 300;

    // バーを付け直すまでの待ち（ms）
    const MOUNT_DEBOUNCE = 200;

    // これより小さい video（サイドバーのプレビュー等）のプレイヤーにはバーを付けない
    const PLAYER_MIN_WIDTH = 300;

    // ============================================================
    // 定数
    // ============================================================

    const STORE_KEY = 'boostPercent';            // 増幅（%）
    const OLD_STORE_KEY = 'twitchBoost';         // v1.0.x の保存値（倍率 1〜5）
    const LIMITER_STORE_KEY = 'limiterOn';
    const WIDGET_CLASS = 'tm-twvb';
    const TOAST_CLASS = 'tm-twvb-toast';
    const HOST_ATTR = 'data-tm-twvb-host';
    const HIDDEN_ATTR = 'data-tm-twvb-replaced';
    const LOG = '[Twitch Volume Boost]';

    // 色（プレイヤーの操作バーは常に暗い背景なので固定）
    const COLOR_BASE = '#fff';                   // 0〜100%
    const COLOR_BOOST = '#ffb000';               // 100% より上
    const COLOR_LOUD = '#ff7a3d';                // 「大きく」（リミッターなし）
    const RAIL_BASE = 'rgba(255, 255, 255, .2)';
    const RAIL_BOOST = 'rgba(255, 176, 0, .25)';

    // Twitch の音量バーが「開いている」とみなす幅（px）
    const PANEL_OPEN_MIN = 24;

    // プレイヤー（上から順に試す）
    const PLAYER_SELECTORS = [
        '.video-player__container',          // 実機で確認（2026-11）
        '[data-a-target="video-player"]',
        '.video-player'
    ];

    // Twitch の音量バー（0〜100 の range）。上から順に試す
    const VOLUME_INPUT_SELECTORS = [
        'input[data-a-target="player-volume-slider"]',
        'input[id^="player-volume-slider"]',        // 実機で確認（2026-11。id の後ろは毎回変わる）
        '.volume-slider__slider-container input[type="range"]'
    ];

    // バーを置く場所（上から順に試す）
    //   after    = その要素の直後
    //   append   = その要素の末尾
    //   replaces = その要素は Twitch の音量バーなので、1本化するときは隠す
    const MOUNT_POINTS = [
        { selector: '.volume-slider__slider-container', mode: 'after', replaces: true },   // 本命（実機で確認）
        { selector: '@volume-input', mode: 'after', replaces: true },                      // 入れ物の名前が変わったとき（音量バーそのもの）
        { selector: '[data-a-target="player-mute-unmute-button"]', mode: 'after', replaces: false },
        { selector: '.player-controls__left-control-group', mode: 'append', replaces: false }
    ];

    // ============================================================
    // 状態
    // ============================================================

    let boost = loadBoost();          // 増幅（%、100〜MAX_BOOST）
    let limiterOn = loadLimiterOn();  // true = きれい、false = 大きく

    let audioCtx = null;
    let gainNode = null;
    let limiterNode = null;
    let routedThroughLimiter = null;  // いまリミッターを通しているか（null = 未接続）
    let limiterReleaseTimer = null;
    let audioError = '';

    // video -> { source, error }
    const videoStates = new WeakMap();

    let widget = null;
    let mountTimer = null;
    let mountInfo = '（まだ探していない）';
    let mountedIndex = -1;
    let mountedPlayer = null;
    let replacedPanel = null;         // 1本化のために隠す Twitch の音量バー
    let lastRenderSignature = '';

    let panelWidth = 0;               // Twitch の音量バーが開いたときの幅（実測）
    let resizeObserver = null;
    let observedPanel = null;

    let toast = null;
    let toastTimer = null;

    let volumeCheckTimer = null;
    let dragging = false;
    let dragValue = null;

    // ============================================================
    // 保存
    // ============================================================

    function clampBoost(value) {
        const number = Number(value);

        if (!Number.isFinite(number)) {
            return 100;
        }

        return Math.min(
            MAX_BOOST,
            Math.max(100, Math.round(number))
        );
    }

    function readStore(key, fallback) {
        try {
            return GM_getValue(key, fallback);
        } catch (e) {
            return fallback;
        }
    }

    function writeStore(key, value) {
        try {
            GM_setValue(key, value);
        } catch (e) {
            // 保存できなくても、このページの中では効く
        }
    }

    function loadBoost() {
        if (!REMEMBER_BOOST) {
            return 100;
        }

        const saved = readStore(STORE_KEY, null);

        if (saved !== null && saved !== undefined) {
            return clampBoost(saved);
        }

        // v1.0.x は倍率（1〜5）で保存していた
        const old = Number(readStore(OLD_STORE_KEY, 1));

        return clampBoost(Number.isFinite(old) ? old * 100 : 100);
    }

    function loadLimiterOn() {
        const saved = readStore(LIMITER_STORE_KEY, null);

        return saved === null || saved === undefined ? USE_LIMITER : !!saved;
    }

    function saveBoost() {
        if (REMEMBER_BOOST) {
            writeStore(STORE_KEY, boost);
        }
    }

    function saveLimiterOn() {
        writeStore(LIMITER_STORE_KEY, limiterOn);
    }

    // ============================================================
    // 音声経路（Web Audio）
    // ============================================================

    function ensureAudioGraph() {
        if (audioCtx) {
            return audioCtx;
        }

        const AudioContextClass = window.AudioContext || window.webkitAudioContext;

        if (!AudioContextClass) {
            audioError = 'このブラウザは Web Audio に対応していません';
            return null;
        }

        try {
            audioCtx = new AudioContextClass();
        } catch (e) {
            audioError = 'AudioContext を作れません: ' + describeError(e);
            return null;
        }

        gainNode = audioCtx.createGain();
        gainNode.gain.value = boost / 100;

        if (typeof audioCtx.createDynamicsCompressor === 'function') {
            limiterNode = audioCtx.createDynamicsCompressor();
            limiterNode.threshold.value = LIMITER.threshold;
            limiterNode.knee.value = LIMITER.knee;
            limiterNode.ratio.value = LIMITER.ratio;
            limiterNode.attack.value = LIMITER.attack;
            limiterNode.release.value = LIMITER.release;
            limiterNode.connect(audioCtx.destination);
        }

        routeOutput();

        // 自動再生の制限が解けたら（最初のクリックなど）、そこで動画をつなぐ
        audioCtx.addEventListener('statechange', () => {
            attachAllVideos();
            render();
        });

        return audioCtx;
    }

    // 増幅器の出口を、リミッター経由か直接かに切り替える
    function routeOutput() {
        if (!gainNode) {
            return;
        }

        const useLimiter = !!limiterNode && limiterOn && boost > 100;

        if (routedThroughLimiter === useLimiter) {
            return;
        }

        gainNode.disconnect();
        gainNode.connect(useLimiter ? limiterNode : audioCtx.destination);
        routedThroughLimiter = useLimiter;
    }

    function scheduleRouteOutput() {
        clearTimeout(limiterReleaseTimer);
        limiterReleaseTimer = null;

        if (boost > 100) {
            routeOutput();
            return;
        }

        // 外すのは、増幅率が下がりきってから
        limiterReleaseTimer = setTimeout(
            routeOutput,
            LIMITER_RELEASE_DELAY
        );
    }

    function applyGain() {
        if (!gainNode) {
            return;
        }

        const value = boost / 100;

        if (GAIN_SMOOTHING > 0) {
            gainNode.gain.setTargetAtTime(
                value,
                audioCtx.currentTime,
                GAIN_SMOOTHING
            );
        } else {
            gainNode.gain.value = value;
        }

        scheduleRouteOutput();
    }

    function isAudioRunning() {
        return !!audioCtx && audioCtx.state === 'running';
    }

    // 再生している中身の種類。'srcObject:<型>' / 'blob' / 'url' / 'none'
    function sourceKind(video) {
        if (video.srcObject) {
            const name = video.srcObject.constructor && video.srcObject.constructor.name;

            return 'srcObject:' + (name || '不明');
        }

        const src = video.currentSrc || video.src || '';

        if (!src) {
            return 'none';
        }

        return src.startsWith('blob:') ? 'blob' : 'url';
    }

    // つないでも音が消えない動画か。
    // 別オリジンの直接URL（iOS Safari のネイティブHLS等）を CORS 無しでつなぐと無音になる。
    // 現行の Twitch は srcObject（ワーカーの MediaSource）なので対象になる
    function isAttachable(video) {
        const kind = sourceKind(video);

        if (kind === 'blob' || kind.startsWith('srcObject:')) {
            return true;
        }

        if (kind !== 'url') {
            return false;   // まだ読み込んでいない。再生が始まったときにもう一度見る
        }

        try {
            return new URL(video.currentSrc || video.src, location.href).origin === location.origin;
        } catch (e) {
            return false;
        }
    }

    function attachVideo(video) {
        const known = videoStates.get(video);

        if (known) {
            return !!known.source;
        }

        if (!isAudioRunning() || !isAttachable(video)) {
            return false;
        }

        try {
            const source = audioCtx.createMediaElementSource(video);

            source.connect(gainNode);

            videoStates.set(video, {
                source,
                error: ''
            });

            return true;
        } catch (e) {
            // ほかの拡張機能などが先につないでいると失敗する。その要素では二度と成功しない
            videoStates.set(video, {
                source: null,
                error: describeError(e)
            });

            return false;
        }
    }

    function attachAllVideos() {
        if (boost <= 100 || !isAudioRunning()) {
            return;
        }

        document.querySelectorAll('video').forEach(attachVideo);
    }

    // 100% を超えたら音声経路を用意してつなぐ。
    // Web Audio が止まっている（自動再生の制限）ときは、つながずに再開を頼むだけ
    function activateBoost() {
        if (boost <= 100) {
            return;
        }

        const ctx = ensureAudioGraph();

        if (!ctx) {
            return;
        }

        if (ctx.state === 'running') {
            attachAllVideos();
            return;
        }

        if (ctx.state === 'closed') {
            return;
        }

        ctx.resume()
            .then(() => {
                attachAllVideos();
                render();
            })
            .catch(() => {
                // 許可されなければ、次のクリックでもう一度頼む
            });
    }

    // ============================================================
    // Twitch 側の音量
    // ============================================================

    // 一番大きい video を持つプレイヤー（サイドバーのプレビュー等を除く）
    function findPlayer() {
        let best = null;
        let bestArea = 0;

        for (const selector of PLAYER_SELECTORS) {
            document.querySelectorAll(selector).forEach((player) => {
                const video = player.querySelector('video');

                if (!video || video.clientWidth < PLAYER_MIN_WIDTH) {
                    return;
                }

                const area = video.clientWidth * video.clientHeight;

                if (area > bestArea) {
                    best = player;
                    bestArea = area;
                }
            });

            if (best) {
                return best;
            }
        }

        return null;
    }

    function findVideo(player) {
        return player ? player.querySelector('video') : null;
    }

    // Twitch の音量バー（input type=range）
    function findVolumeInput(player) {
        if (!player) {
            return null;
        }

        for (const selector of VOLUME_INPUT_SELECTORS) {
            const input = player.querySelector(selector);

            if (input) {
                return input;
            }
        }

        return null;
    }

    function inputRange(input) {
        const min = Number(input.min || 0);
        const max = Number(input.max || 100);

        return {
            min: Number.isFinite(min) ? min : 0,
            max: Number.isFinite(max) && max > min ? max : 100
        };
    }

    // 0〜600% の1本のバーにできるか（Twitch の音量バーを動かせるか）
    function isUnified() {
        return !!findVolumeInput(findPlayer());
    }

    // Twitch の音量（0〜100）とミュート
    function readTwitchVolume() {
        const player = findPlayer();
        const input = findVolumeInput(player);
        const video = findVideo(player);

        if (!input) {
            return null;
        }

        const range = inputRange(input);
        const value = Number(input.value);

        if (!Number.isFinite(value)) {
            return null;
        }

        return {
            volume: Math.round((value - range.min) / (range.max - range.min) * 1000) / 10,
            muted: !!video && video.muted
        };
    }

    // Twitch の音量バーを、人が動かしたように動かす。
    // Twitch（React）は input イベントで音量を変えるので、値を書き換えてからイベントを送る
    function setTwitchVolume(volume) {
        const player = findPlayer();
        const input = findVolumeInput(player);

        if (!input) {
            return;
        }

        const range = inputRange(input);
        const target = range.min + (range.max - range.min) * Math.min(100, Math.max(0, volume)) / 100;
        const current = Number(input.value);

        if (!Number.isFinite(current) || Math.abs(current - target) > 1e-6) {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

            setter.call(input, String(target));
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }

        // ミュート中なら解く
        const video = findVideo(player);

        if (volume > 0 && video && video.muted) {
            const muteButton = player.querySelector('[data-a-target="player-mute-unmute-button"]');

            if (muteButton) {
                muteButton.click();
            }
        }
    }

    // Twitch 側の音量が 100% 未満に下げられたら、増幅を外す
    function scheduleVolumeCheck() {
        if (boost <= 100) {
            return;
        }

        clearTimeout(volumeCheckTimer);

        volumeCheckTimer = setTimeout(() => {
            volumeCheckTimer = null;

            const tw = readTwitchVolume();

            if (!tw || tw.muted || boost <= 100 || dragging) {
                return;
            }

            if (tw.volume < 99.5) {
                setBoost(100, {
                    fromUser: false,
                    toast: false
                });
            }
        }, VOLUME_CHECK_DELAY);
    }

    // ============================================================
    // 値の変更
    // ============================================================

    // 増幅だけを変える。
    // options.fromUser: 利用者の操作（Twitch 側の音量も 100% にそろえ、ミュートを解く）
    // options.toast:    「音量 250%」を出す
    function setBoost(value, options) {
        const opts = options || {};
        const next = clampBoost(value);

        if (next !== boost) {
            boost = next;
            saveBoost();
        }

        if (boost > 100) {
            if (opts.fromUser) {
                setTwitchVolume(100);
            }

            activateBoost();
        }

        applyGain();
        render();

        if (opts.toast) {
            showToast();
        }
    }

    // バーの下限（1本化なら 0、延長部分だけなら 100）
    function getRangeMin() {
        return isUnified() ? 0 : 100;
    }

    // バーが指している値（0〜600）
    function getSliderValue() {
        if (dragValue !== null) {
            return dragValue;
        }

        const tw = readTwitchVolume();

        if (!tw) {
            return boost;
        }

        if (tw.muted) {
            return 0;
        }

        if (boost > 100) {
            return boost;
        }

        return Math.round(tw.volume);
    }

    // バーの値を変える。100% 以下は Twitch の音量、上は増幅
    function setSliderValue(value, options) {
        const opts = options || {};

        if (!isUnified()) {
            setBoost(value, {
                fromUser: true,
                toast: opts.toast
            });
            return;
        }

        const next = Math.min(
            MAX_BOOST,
            Math.max(0, Math.round(value))
        );

        if (next > 100) {
            setBoost(next, {
                fromUser: true,
                toast: opts.toast
            });
            return;
        }

        setBoost(100, {
            fromUser: false,
            toast: false
        });

        setTwitchVolume(next);
        render();

        if (opts.toast) {
            showToast();
        }
    }

    // キー・ホイール1回ぶん動かした値。100% 以下は細かく、上は大きく刻む
    function stepValue(value, direction) {
        if (direction > 0) {
            return value < 100 ? Math.min(100, value + SMALL_STEP) : value + KEY_STEP;
        }

        return value > 100 ? Math.max(100, value - KEY_STEP) : value - SMALL_STEP;
    }

    // 値（%）→ バーの上の位置（0〜1）
    function valueToPos(value, unified) {
        const min = unified ? 0 : 100;
        const v = Math.min(MAX_BOOST, Math.max(min, value));

        if (!LOG_SCALE) {
            return (v - min) / (MAX_BOOST - min);
        }

        if (!unified) {
            return Math.log(v / 100) / Math.log(MAX_BOOST / 100);
        }

        if (v <= LOG_FLOOR) {
            return (v / LOG_FLOOR) * LOG_FLOOR_POS;
        }

        return LOG_FLOOR_POS +
            (1 - LOG_FLOOR_POS) * Math.log(v / LOG_FLOOR) / Math.log(MAX_BOOST / LOG_FLOOR);
    }

    // バーの上の位置（0〜1）→ 値（%）
    function posToValue(pos, unified) {
        const min = unified ? 0 : 100;
        const p = Math.min(1, Math.max(0, pos));

        if (!LOG_SCALE) {
            return min + p * (MAX_BOOST - min);
        }

        if (!unified) {
            return 100 * Math.pow(MAX_BOOST / 100, p);
        }

        if (p <= LOG_FLOOR_POS) {
            return (p / LOG_FLOOR_POS) * LOG_FLOOR;
        }

        return LOG_FLOOR * Math.pow(MAX_BOOST / LOG_FLOOR, (p - LOG_FLOOR_POS) / (1 - LOG_FLOOR_POS));
    }

    function snapValue(raw) {
        if (Math.abs(raw - 100) < SNAP_TO_100) {
            return 100;
        }

        if (raw <= 100) {
            return Math.round(raw);
        }

        return 100 + Math.round((raw - 100) / SLIDER_STEP) * SLIDER_STEP;
    }

    // ============================================================
    // スタイル
    // ============================================================

    function injectStyle() {
        const css = [
            '.' + WIDGET_CLASS + ' {',
            '    display: inline-flex;',
            '    align-items: center;',
            '    align-self: stretch;',
            '    min-height: 30px;',
            '    color: #fff;',
            '    outline: none;',
            '    user-select: none;',
            '}',
            '.tm-twvb-track {',
            '    position: relative;',
            '    flex: none;',
            '    width: 0;',
            '    height: 30px;',
            '    opacity: 0;',
            '    overflow: hidden;',
            '    cursor: pointer;',
            '    touch-action: none;',
            '    transition: width .2s cubic-bezier(.4, 0, 1, 1), opacity .2s;',
            '}',
            // 音量欄にマウスを乗せたとき・Twitch の音量バーが開いているとき・操作中に開く
            '[' + HOST_ATTR + ']:hover .tm-twvb-track,',
            '.' + WIDGET_CLASS + '.tm-twvb-open .tm-twvb-track,',
            '.' + WIDGET_CLASS + ':focus-visible .tm-twvb-track,',
            '.' + WIDGET_CLASS + '.tm-twvb-dragging .tm-twvb-track {',
            '    width: var(--tm-twvb-width, ' + TRACK_WIDTH + 'px);',
            '    opacity: 1;',
            '}',
            '.tm-twvb-rail {',
            '    position: absolute;',
            '    left: ' + (KNOB_SIZE / 2) + 'px;',
            '    right: ' + (KNOB_SIZE / 2) + 'px;',
            '    top: 50%;',
            '    height: 3px;',
            '    margin-top: -1.5px;',
            '    border-radius: 1.5px;',
            '    background: ' + RAIL_BASE + ';',
            '}',
            '.tm-twvb-fill {',
            '    position: absolute;',
            '    left: 0;',
            '    top: 0;',
            '    bottom: 0;',
            '    width: 0;',
            '    border-radius: 1.5px;',
            '    background: ' + COLOR_BOOST + ';',
            '}',
            '.tm-twvb-tick {',
            '    display: none;',
            '    position: absolute;',
            '    top: -3px;',
            '    bottom: -3px;',
            '    width: 2px;',
            '    margin-left: -1px;',
            '    background: rgba(255, 255, 255, .6);',
            '}',
            '.' + WIDGET_CLASS + '.tm-twvb-unified .tm-twvb-tick {',
            '    display: block;',
            '}',
            '.tm-twvb-knob {',
            '    position: absolute;',
            '    left: 0;',
            '    top: 50%;',
            '    width: ' + KNOB_SIZE + 'px;',
            '    height: ' + KNOB_SIZE + 'px;',
            '    margin: ' + (-KNOB_SIZE / 2) + 'px 0 0 ' + (-KNOB_SIZE / 2) + 'px;',
            '    border-radius: 50%;',
            '    background: #fff;',
            '}',
            '.tm-twvb-label {',
            '    display: none;',
            '    padding: 0 6px 0 4px;',
            '    font-size: 13px;',
            '    white-space: nowrap;',
            '    font-variant-numeric: tabular-nums;',
            '    cursor: pointer;',
            '}',
            '.' + WIDGET_CLASS + '.tm-twvb-boosted .tm-twvb-label,',
            '[' + HOST_ATTR + ']:hover .tm-twvb-label,',
            '.' + WIDGET_CLASS + '.tm-twvb-open .tm-twvb-label,',
            '.' + WIDGET_CLASS + ':focus-visible .tm-twvb-label,',
            '.' + WIDGET_CLASS + '.tm-twvb-dragging .tm-twvb-label {',
            '    display: inline;',
            '}',
            '.' + WIDGET_CLASS + '.tm-twvb-boosted .tm-twvb-label {',
            '    color: ' + COLOR_BOOST + ';',
            '}',
            '.' + WIDGET_CLASS + '.tm-twvb-waiting .tm-twvb-label {',
            '    opacity: .6;',
            '    text-decoration: underline dotted;',
            '}',
            '.' + WIDGET_CLASS + '.tm-twvb-loud.tm-twvb-boosted .tm-twvb-label {',
            '    color: ' + COLOR_LOUD + ';',
            '}',
            '.' + WIDGET_CLASS + '.tm-twvb-error .tm-twvb-label {',
            '    color: #ff6e6e;',
            '}',
            // 1本化したとき、Twitch 本来の音量バーは見えなくする。
            // 消さずに残すのは、開いたときの幅（=長さの基準・開くタイミング）を測るためと、
            // 音量を動かす窓口として使うため
            '[' + HIDDEN_ATTR + '] {',
            '    position: absolute !important;',
            '    visibility: hidden !important;',
            '    pointer-events: none !important;',
            '}',
            '.' + TOAST_CLASS + ' {',
            '    position: absolute;',
            '    left: 50%;',
            '    top: 10%;',
            '    z-index: 70;',
            '    transform: translateX(-50%);',
            '    padding: 6px 12px;',
            '    border-radius: 4px;',
            '    background: rgba(0, 0, 0, .6);',
            '    color: #fff;',
            '    font: 600 15px/1.4 sans-serif;',
            '    white-space: nowrap;',
            '    pointer-events: none;',
            '    opacity: 0;',
            '    transition: opacity .2s;',
            '}',
            '.' + TOAST_CLASS + '.tm-twvb-show {',
            '    opacity: 1;',
            '}'
        ].join('\n');

        if (typeof GM_addStyle === 'function') {
            GM_addStyle(css);   // ページの CSP に左右されない
            return;
        }

        const style = document.createElement('style');
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
    }

    // ============================================================
    // バー（スライダー）
    // ============================================================

    function getWidget() {
        if (widget) {
            return widget;
        }

        widget = document.createElement('div');
        widget.className = WIDGET_CLASS;
        widget.tabIndex = 0;
        widget.setAttribute('role', 'slider');
        widget.setAttribute('aria-label', '音量');
        widget.setAttribute('aria-valuemax', String(MAX_BOOST));

        const track = document.createElement('div');
        track.className = 'tm-twvb-track';

        const rail = document.createElement('div');
        rail.className = 'tm-twvb-rail';

        const fill = document.createElement('div');
        fill.className = 'tm-twvb-fill';

        const tick = document.createElement('div');
        tick.className = 'tm-twvb-tick';

        const knob = document.createElement('div');
        knob.className = 'tm-twvb-knob';

        const label = document.createElement('span');
        label.className = 'tm-twvb-label';

        rail.appendChild(fill);
        rail.appendChild(tick);
        rail.appendChild(knob);
        track.appendChild(rail);
        widget.appendChild(track);
        widget.appendChild(label);

        track.addEventListener('pointerdown', onTrackPointerDown);
        track.addEventListener('pointermove', onTrackPointerMove);
        track.addEventListener('pointerup', onTrackPointerUp);
        track.addEventListener('pointercancel', onTrackPointerUp);

        widget.addEventListener('wheel', onWidgetWheel, { passive: false });
        track.addEventListener('dblclick', onWidgetDblClick);
        label.addEventListener('click', onLabelClick);

        // 横幅が狭いと数字が隠れるので、バーの右クリックでも切り替えられるようにする
        widget.addEventListener('contextmenu', onLabelClick);

        // Twitch 側の操作（一時停止・全画面など）に伝わらないようにする
        ['mousedown', 'click', 'dblclick'].forEach((type) => {
            widget.addEventListener(type, (event) => {
                event.stopPropagation();
            });
        });

        return widget;
    }

    function valueFromPointer(event, track) {
        const rect = track.getBoundingClientRect();
        const usable = rect.width - KNOB_SIZE;

        if (usable <= 0) {
            return getSliderValue();
        }

        const pos = (event.clientX - rect.left - KNOB_SIZE / 2) / usable;

        return snapValue(posToValue(pos, isUnified()));
    }

    function dragTo(event, track) {
        const value = valueFromPointer(event, track);

        dragValue = value;

        setSliderValue(value, {
            toast: false
        });
    }

    function onTrackPointerDown(event) {
        if (event.button !== 0) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        const track = event.currentTarget;

        dragging = true;
        widget.classList.add('tm-twvb-dragging');

        try {
            track.setPointerCapture(event.pointerId);
        } catch (e) {
            // 取れなくても、押した位置には合わせられる
        }

        dragTo(event, track);
    }

    function onTrackPointerMove(event) {
        if (!dragging) {
            return;
        }

        dragTo(event, event.currentTarget);
    }

    function onTrackPointerUp(event) {
        if (!dragging) {
            return;
        }

        dragging = false;
        dragValue = null;
        widget.classList.remove('tm-twvb-dragging');

        try {
            event.currentTarget.releasePointerCapture(event.pointerId);
        } catch (e) {
            // すでに外れている
        }

        render();
    }

    function onWidgetWheel(event) {
        event.preventDefault();
        event.stopPropagation();

        if (event.deltaY === 0) {
            return;
        }

        setSliderValue(stepValue(getSliderValue(), event.deltaY < 0 ? 1 : -1), {
            toast: false
        });
    }

    // 数字のクリック・バーの右クリックで「きれい（リミッターあり）」と「大きく（なし）」を切り替える
    function onLabelClick(event) {
        event.preventDefault();
        event.stopPropagation();

        toggleLimiter();
    }

    function toggleLimiter() {
        limiterOn = !limiterOn;
        saveLimiterOn();
        routeOutput();
        render();

        showToast(limiterOn
            ? 'きれい（リミッターあり・音割れしない）'
            : '大きく（リミッターなし・音割れすることがある）');
    }

    function onWidgetDblClick(event) {
        event.preventDefault();
        event.stopPropagation();

        setSliderValue(100, {
            toast: true
        });
    }

    // ============================================================
    // 長さ
    // ============================================================

    // 0〜100% の部分で、つまみが動く長さ（px）
    function getTravel() {
        if (panelWidth >= PANEL_OPEN_MIN) {
            const travel = panelWidth - KNOB_SIZE;

            if (travel >= 20 && travel <= 200) {
                return travel;
            }
        }

        return DEFAULT_TRAVEL;
    }

    // バーの見た目の長さ（px）
    function getTrackWidth(player) {
        if (!isUnified()) {
            return TRACK_WIDTH;
        }

        let travel = getTravel() * (MAX_BOOST / 100);

        if (player && player.clientWidth > 0) {
            travel = Math.min(travel, player.clientWidth * MAX_WIDTH_RATIO);
        }

        return Math.round(travel + KNOB_SIZE);
    }

    // Twitch の音量バーの幅を見張る。
    // 開いたら（マウスを乗せたなど）こちらも開き、その幅を長さの基準にする
    function observePanel(panel) {
        if (typeof ResizeObserver !== 'function') {
            return;
        }

        if (!resizeObserver) {
            resizeObserver = new ResizeObserver(onResize);
        }

        if (observedPanel === panel) {
            return;
        }

        if (observedPanel) {
            resizeObserver.unobserve(observedPanel);
        }

        observedPanel = panel;

        if (panel) {
            resizeObserver.observe(panel);
        }
    }

    function onResize(entries) {
        for (const entry of entries) {
            if (entry.target !== observedPanel) {
                continue;
            }

            const width = entry.target.getBoundingClientRect().width;

            if (width > panelWidth) {
                panelWidth = width;
            }

            if (widget) {
                widget.classList.toggle('tm-twvb-open', width >= PANEL_OPEN_MIN);
            }
        }

        render();
    }

    // ============================================================
    // 表示
    // ============================================================

    // 増幅できていない理由（無ければ空）
    function getProblem() {
        if (boost <= 100) {
            return { waiting: false, error: '' };
        }

        if (audioError) {
            return { waiting: false, error: audioError };
        }

        if (!isAudioRunning()) {
            return { waiting: true, error: '' };
        }

        const video = findVideo(findPlayer());
        const state = video ? videoStates.get(video) : null;

        if (state && state.error) {
            return { waiting: false, error: state.error };
        }

        return { waiting: false, error: '' };
    }

    function buildTitle(value, unified, problem) {
        const lines = [
            unified
                ? '音量: ' + value + '%（0〜' + MAX_BOOST + '%。100% より右は増幅）'
                : '音量ブースト: ' + value + '%',
            'ドラッグ・ホイール・←→キーで調整、バーのダブルクリックで 100% に戻す',
            'バーを右クリック（または数字をクリック）: ' + (limiterOn
                ? 'いまは「きれい」（リミッターあり）→「大きく」に切り替え'
                : 'いまは「大きく」（リミッターなし）→「きれい」に切り替え')
        ];

        if (problem.waiting) {
            lines.push('※ ページを一度クリックすると増幅が有効になります（ブラウザの自動再生の制限）');
        }

        if (problem.error) {
            lines.push('※ 増幅できません: ' + problem.error);
        }

        return lines.join('\n');
    }

    function percent(ratio) {
        return (Math.min(1, Math.max(0, ratio)) * 100).toFixed(3) + '%';
    }

    // 1本化するときは Twitch の音量バーを隠す。
    // 隠すのはこのバーがすぐ隣にあるときだけ（付け損ねたら Twitch のバーが残る）
    function syncPanelHidden(unified) {
        if (!replacedPanel) {
            return;
        }

        const hide = unified &&
            !!widget &&
            replacedPanel.isConnected &&
            replacedPanel.nextElementSibling === widget;

        if (hide) {
            if (!replacedPanel.hasAttribute(HIDDEN_ATTR)) {
                replacedPanel.setAttribute(HIDDEN_ATTR, '');
            }
        } else if (replacedPanel.hasAttribute(HIDDEN_ATTR)) {
            replacedPanel.removeAttribute(HIDDEN_ATTR);
        }
    }

    function render() {
        if (!widget) {
            return;
        }

        const unified = isUnified();
        const player = findPlayer();
        const tw = unified ? readTwitchVolume() : null;
        const muted = !!tw && tw.muted && dragValue === null;
        const value = getSliderValue();
        const width = getTrackWidth(player);
        const problem = getProblem();

        syncPanelHidden(unified);

        const signature = [
            unified,
            value,
            muted,
            width,
            boost,
            limiterOn,
            problem.waiting,
            problem.error
        ].join('|');

        if (signature === lastRenderSignature) {
            return;
        }

        lastRenderSignature = signature;

        const min = unified ? 0 : 100;
        const ratio = valueToPos(value, unified);
        const mark = valueToPos(100, unified);

        const rail = widget.querySelector('.tm-twvb-rail');
        const fill = widget.querySelector('.tm-twvb-fill');
        const tick = widget.querySelector('.tm-twvb-tick');
        const knob = widget.querySelector('.tm-twvb-knob');
        const label = widget.querySelector('.tm-twvb-label');

        widget.style.setProperty('--tm-twvb-width', width + 'px');

        // 100% までは白、その先はオレンジ
        rail.style.background = unified
            ? 'linear-gradient(to right, ' + RAIL_BASE + ' 0 ' + percent(mark) + ', ' + RAIL_BOOST + ' ' + percent(mark) + ' 100%)'
            : RAIL_BASE;

        fill.style.width = percent(ratio);

        const boostColor = limiterOn ? COLOR_BOOST : COLOR_LOUD;

        if (!unified) {
            fill.style.background = boostColor;
        } else if (ratio <= mark) {
            fill.style.background = COLOR_BASE;
        } else {
            const baseEnd = percent(mark / ratio);

            fill.style.background = 'linear-gradient(to right, ' + COLOR_BASE + ' 0 ' + baseEnd + ', ' + boostColor + ' ' + baseEnd + ' 100%)';
        }

        tick.style.left = percent(mark);
        knob.style.left = percent(ratio);
        label.textContent = muted ? 'ミュート' : value + '%' + (limiterOn ? '' : '!');

        widget.classList.toggle('tm-twvb-unified', unified);
        widget.classList.toggle('tm-twvb-boosted', value > 100 && !muted);
        widget.classList.toggle('tm-twvb-waiting', problem.waiting);
        widget.classList.toggle('tm-twvb-error', !!problem.error);
        widget.classList.toggle('tm-twvb-loud', !limiterOn);

        widget.setAttribute('aria-valuemin', String(min));
        widget.setAttribute('aria-valuenow', String(value));
        widget.setAttribute('aria-valuetext', muted ? 'ミュート' : value + '%');
        widget.title = buildTitle(value, unified, problem);
    }

    // message を渡すとその文を、無ければ「音量 250%」を出す。
    // 全画面のときは全画面の要素の中に置かないと見えない
    function showToast(message) {
        const player = findPlayer();

        if (!player) {
            return;
        }

        if (!toast) {
            toast = document.createElement('div');
            toast.className = TOAST_CLASS;
            toast.setAttribute('aria-live', 'polite');
        }

        if (toast.parentElement !== player) {
            player.appendChild(toast);
        }

        const problem = getProblem();
        let text = message || '音量 ' + getSliderValue() + '%';

        if (message) {
            // そのまま出す
        } else if (problem.waiting) {
            text += '（クリックで有効）';
        } else if (problem.error) {
            text += '（増幅できません）';
        }

        toast.textContent = text;
        toast.classList.add('tm-twvb-show');

        clearTimeout(toastTimer);

        toastTimer = setTimeout(() => {
            toast.classList.remove('tm-twvb-show');
        }, TOAST_MS);
    }

    // ============================================================
    // 設置（SPA・再描画への対応）
    // ============================================================

    function findMountPoint(player) {
        for (let i = 0; i < MOUNT_POINTS.length; i++) {
            const point = MOUNT_POINTS[i];
            const element = point.selector === '@volume-input'
                ? findVolumeInput(player)
                : player.querySelector(point.selector);

            if (element) {
                return {
                    element,
                    mode: point.mode,
                    replaces: point.replaces,
                    index: i,
                    selector: point.selector
                };
            }
        }

        return null;
    }

    function isInPlace(point, w) {
        if (point.mode === 'after') {
            return point.element.nextElementSibling === w;
        }

        return w.parentElement === point.element;
    }

    function mount() {
        mountTimer = null;

        const player = findPlayer();

        if (!player) {
            mountInfo = '（プレイヤーがまだ無い）';
            return;
        }

        const point = findMountPoint(player);

        if (!point) {
            mountInfo = '見つからない（音量バーの場所が変わった可能性）';
            return;
        }

        const w = getWidget();

        if (!isInPlace(point, w)) {
            const oldHost = w.parentElement;

            if (point.mode === 'after') {
                point.element.after(w);
            } else {
                point.element.appendChild(w);
            }

            if (oldHost && oldHost !== w.parentElement) {
                oldHost.removeAttribute(HOST_ATTR);
            }
        }

        // 音量欄にマウスを乗せたらバーも開く（CSS の :hover で見る）
        w.parentElement.setAttribute(HOST_ATTR, '');

        // 前に隠した Twitch の音量バーが別の要素なら、隠すのをやめる
        const nextPanel = point.replaces ? point.element : null;

        if (replacedPanel && replacedPanel !== nextPanel) {
            replacedPanel.removeAttribute(HIDDEN_ATTR);
            w.classList.remove('tm-twvb-open');
        }

        replacedPanel = nextPanel;
        observePanel(replacedPanel);

        mountedIndex = point.index;
        mountedPlayer = player;
        mountInfo = point.selector + '（' + (point.mode === 'after' ? '直後' : '末尾') + '）';

        lastRenderSignature = '';
        render();
    }

    function isMountedAtBest() {
        if (!widget || !widget.isConnected || mountedIndex !== 0) {
            return false;
        }

        // Twitch の音量バーだけが作り直されたときは、新しい方を隠し直す
        if (!replacedPanel || !replacedPanel.isConnected || replacedPanel.nextElementSibling !== widget) {
            return false;
        }

        // 配信の切り替えなどで、別のプレイヤーが一番大きくなったとき
        return !!mountedPlayer && mountedPlayer.isConnected && mountedPlayer.contains(widget) &&
            findPlayer() === mountedPlayer;
    }

    // 予約済みならそれを待つ（ページの書き換えが続いても先送りにしない）
    function scheduleMount(delay) {
        if (mountTimer && delay > 0) {
            return;
        }

        clearTimeout(mountTimer);
        mountTimer = setTimeout(mount, delay);
    }

    function startObserver() {
        const observer = new MutationObserver(() => {
            // 本命の位置に付いていれば何もしない（自分の書き換えでもここで止まる）
            if (!isMountedAtBest()) {
                scheduleMount(MOUNT_DEBOUNCE);
            }

            // 配信の切り替えで新しい video が来たら、そちらもつなぐ
            if (boost > 100) {
                attachAllVideos();
            }
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    }

    // ============================================================
    // キー操作
    // ============================================================

    function isEditable(element) {
        if (!(element instanceof Element)) {
            return false;
        }

        if (element.isContentEditable) {
            return true;
        }

        if (widget && widget.contains(element)) {
            return false;
        }

        return !!element.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
    }

    function consume(event) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
    }

    // バーにフォーカスがあるとき
    function handleWidgetKey(event) {
        let next = null;

        if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
            next = stepValue(getSliderValue(), 1);
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
            next = stepValue(getSliderValue(), -1);
        } else if (event.key === 'Home') {
            next = getRangeMin();
        } else if (event.key === 'End') {
            next = MAX_BOOST;
        }

        if (next === null) {
            return;
        }

        consume(event);

        setSliderValue(next, {
            toast: false
        });
    }

    // プレイヤーを操作している最中か（プレイヤーをクリックした後・マウスが乗っている）
    function isPlayerActive(player) {
        const active = document.activeElement;

        if (active && active !== document.body && player.contains(active)) {
            return true;
        }

        // Twitch は動画をクリックしてもフォーカスが本文に残ることがあるので、マウスの位置でも見る
        const nothingFocused = !active || active === document.body || active === document.documentElement;

        return nothingFocused && player.matches(':hover');
    }

    // ↑↓ キー。プレイヤーを操作しているときだけ、バーと同じ刻みで 0〜600% を動かす
    // （100% 以下は 5%、上は 10%。100% を超えると増幅になる）
    function onKeyDown(event) {
        if (event.defaultPrevented || event.isComposing) {
            return;
        }

        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
            return;
        }

        const target = event.target instanceof Element ? event.target : null;

        if (widget && target && widget.contains(target)) {
            handleWidgetKey(event);
            return;
        }

        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
            return;
        }

        if (isEditable(target)) {
            return;
        }

        const player = findPlayer();

        if (!player || !isPlayerActive(player)) {
            return;
        }

        consume(event);

        setSliderValue(stepValue(getSliderValue(), event.key === 'ArrowUp' ? 1 : -1), {
            toast: true
        });
    }

    // ============================================================
    // イベント
    // ============================================================

    // クリック・キー入力は自動再生の制限を解くきっかけになる
    function onUserGesture() {
        if (boost > 100) {
            activateBoost();
        }
    }

    function onPlay(event) {
        if (event.target instanceof HTMLMediaElement && boost > 100) {
            activateBoost();
        }
    }

    // Twitch 側で音量・ミュートが変わったら、つまみを追いかける
    function onVolumeChange(event) {
        if (event.target instanceof HTMLMediaElement) {
            render();
            scheduleVolumeCheck();
        }
    }

    // Twitch の音量バーが（Twitch の画面の作り直しなどで）動いたとき
    function onInput(event) {
        if (event.target instanceof HTMLInputElement && event.target.type === 'range' && !(widget && widget.contains(event.target))) {
            render();
            scheduleVolumeCheck();
        }
    }

    // 全画面の切り替えでプレイヤーの大きさが変わる
    function onFullscreenChange() {
        lastRenderSignature = '';
        scheduleMount(0);
    }

    // 別のタブで変えた増幅・モードを反映する
    function onStoreChange(key, oldValue, newValue, remote) {
        if (!remote) {
            return;
        }

        if (key === STORE_KEY) {
            setBoost(newValue, {
                fromUser: false,
                toast: false
            });
        } else if (key === LIMITER_STORE_KEY) {
            limiterOn = !!newValue;
            routeOutput();
            render();
        }
    }

    // ============================================================
    // 診断
    // ============================================================

    function describeError(error) {
        if (!error) {
            return '不明なエラー';
        }

        return (error.name ? error.name + ': ' : '') + (error.message || String(error));
    }

    function describeElement(element) {
        if (!element) {
            return '';
        }

        const cls = Array.from(element.classList)
            .filter((c) => !c.startsWith('tm-twvb'))
            .join('.');
        const target = element.getAttribute('data-a-target');

        return element.tagName.toLowerCase() +
            (element.id ? '#' + element.id : '') +
            (cls ? '.' + cls : '') +
            (target ? '[data-a-target="' + target + '"]' : '');
    }

    function collectState() {
        const tw = readTwitchVolume();
        const player = findPlayer();
        const input = findVolumeInput(player);
        const videos = Array.from(document.querySelectorAll('video'));
        const attached = videos.filter((video) => {
            const state = videoStates.get(video);
            return state && state.source;
        });
        const problem = getProblem();
        const unified = isUnified();
        const version = typeof GM_info !== 'undefined' && GM_info.script ? GM_info.script.version : '';

        return {
            版: version,
            ページ: location.pathname,
            音量: getSliderValue() + '%',
            ブースト: boost + '%',
            増幅率: gainNode ? gainNode.gain.value.toFixed(2) : '（未作成）',
            AudioContext: audioCtx ? audioCtx.state : '（未作成）',
            リミッター: routedThroughLimiter === null ? '（未接続）' : (routedThroughLimiter ? '通している' : '通していない'),
            モード: limiterOn ? 'きれい（リミッターあり）' : '大きく（リミッターなし）',
            Twitch音量: tw ? tw.volume + (tw.muted ? '（ミュート）' : '') : '（取得できない）',
            Twitchの音量バー: input ? describeElement(input) + ' min=' + input.min + ' max=' + input.max + ' value=' + input.value : '見つからない',
            Twitchの音量バーの入れ物: replacedPanel ? describeElement(replacedPanel) + (replacedPanel.hasAttribute(HIDDEN_ATTR) ? '（隠している）' : '（残している）') : '（無い）',
            形: unified ? '1本のバー（0〜' + MAX_BOOST + '%）' : '延長部分だけ（Twitch の音量バーが見つからない）',
            バーの長さ: getTrackWidth(player) + 'px（音量バーの実測幅 ' + Math.round(panelWidth) + 'px）',
            プレイヤー: describeElement(player) || '見つからない',
            設置先: mountInfo,
            動画の数: videos.length,
            つないだ動画: attached.length,
            状態: problem.error ? '増幅できない: ' + problem.error : (problem.waiting ? 'クリック待ち（自動再生の制限）' : 'OK'),
            エラー: audioError || ''
        };
    }

    function collectVideos() {
        return Array.from(document.querySelectorAll('video')).map((video) => {
            const state = videoStates.get(video);
            const ancestors = [];

            for (let el = video.parentElement, i = 0; el && el !== document.body && i < 6; el = el.parentElement, i++) {
                ancestors.push(describeElement(el));
            }

            return {
                大きさ: video.clientWidth + 'x' + video.clientHeight,
                再生元: sourceKind(video),
                つないだ: state ? (state.source ? 'はい' : 'いいえ') : '未',
                エラー: state ? state.error : '',
                volume: Number(video.volume.toFixed(2)),
                muted: video.muted,
                paused: video.paused,
                親: ancestors
            };
        });
    }

    // 診断。コンソールの表示をコピーしても中身が落ちないよう、文字（JSON）で出す
    // （console.table はコピーすると「Array(1)」に畳まれる。v1.0.0 で実際に起きた）
    function dump() {
        const report = {
            state: collectState(),
            videos: collectVideos()
        };

        console.log(LOG + ' 診断\n' + JSON.stringify(report, null, 2));

        return report;
    }

    try {
        (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__tmTwitchVolumeBoost = {
            dump,
            state: collectState,
            // 0〜600（1本化のとき）。100 以下は Twitch の音量、上は増幅
            set: (value) => setSliderValue(value, {
                toast: true
            })
        };
    } catch (e) {
        // 公開できなくてもメニューから診断できる
    }

    // ============================================================
    // 起動
    // ============================================================

    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('音量 +10%', () => setSliderValue(stepValue(getSliderValue(), 1), { toast: true }));
        GM_registerMenuCommand('音量 -10%', () => setSliderValue(stepValue(getSliderValue(), -1), { toast: true }));
        GM_registerMenuCommand('音量 100% に戻す', () => setSliderValue(100, { toast: true }));
        GM_registerMenuCommand('きれい／大きく を切り替え', toggleLimiter);
        GM_registerMenuCommand('診断をコンソールに出す', dump);
    }

    if (typeof GM_addValueChangeListener === 'function') {
        GM_addValueChangeListener(STORE_KEY, onStoreChange);
        GM_addValueChangeListener(LIMITER_STORE_KEY, onStoreChange);
    }

    // キーは Twitch より先に受け取る（window・キャプチャ）
    window.addEventListener('keydown', onUserGesture, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onUserGesture, true);

    // 動画のイベントは泡立たないので、キャプチャで拾う
    document.addEventListener('play', onPlay, true);
    document.addEventListener('playing', onPlay, true);
    document.addEventListener('loadstart', onPlay, true);
    document.addEventListener('volumechange', onVolumeChange, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('fullscreenchange', onFullscreenChange);

    function start() {
        injectStyle();
        startObserver();
        mount();

        // 前回の増幅を引き継いでいるとき
        activateBoost();
        applyGain();
        render();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
