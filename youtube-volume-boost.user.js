// ==UserScript==
// @name         YouTube 音量ブースト v1.1.0
// @namespace    local.hiro.tools
// @version      1.1.0
// @description  YouTube の音量を 100% より上（最大 600%）まで上げる。プレーヤーの音量バーを 0〜600% の1本のバーに置き換え（0〜100% の長さはそのままで全体が6倍）、つまみ1つで動かせる。音量 100% で ↑ キーを押したときも、その先へ上がる
// @match        https://www.youtube.com/*
// @grant        none
// @run-at       document-start
// @noframes
// @homepageURL  https://github.com/hirodiver/tampermonkey-scripts
// @supportURL   https://github.com/hirodiver/tampermonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/youtube-volume-boost.user.js
// @updateURL    https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/youtube-volume-boost.user.js
// ==/UserScript==

(function () {
    'use strict';

    /*
     * Chrome 拡張「Volume Master」と同じく、Web Audio で音を増幅する。
     *
     *   <video> → MediaElementSource → GainNode（×1〜×6） → リミッター → スピーカー
     *
     * 見た目は「YouTube の音量バーが右へ6倍に伸びた」形にする。
     * YouTube 本来の音量バーは隠し、つまみ1つの 0〜600% のバーを置く。
     *
     *   [ミュート][0 ─ 100 │ 100 ─────────────── 600] 250%
     *              ↑ YouTube の音量   ↑ 増幅（ブースト）
     *
     *   - 0〜100% の部分は YouTube の音量そのもの（プレーヤーAPI の setVolume で動かす）。
     *     長さは YouTube の音量バーと同じにする
     *   - 100% より右は、YouTube の音量を 100% にしたうえで Web Audio で増幅する
     *   - YouTube の ↑↓ キー・ミュートで変えた音量も、つまみの位置に反映する
     *   - 音量 100% で ↑ キーを押すとその先へ上がり、↓ キーは増幅分から下がる
     *
     * YouTube のプレーヤーAPI が見つからないときは、元の音量バーを残し、
     * その右に 100〜600% の延長部分だけを付ける（v1.0 と同じ形）。
     *
     * 注意:
     *   - 動画を Web Audio につなぐと、外す方法がない（ページを開き直すまで）。
     *     そのため、100% より上げるまでは音声に一切手を付けない。
     *   - Chrome は、ページを一度もクリックしていない状態では Web Audio を止めておく
     *     （自動再生の制限）。止まったままつなぐと無音になるので、そのときは
     *     つながずに待ち、最初のクリックかキー入力で有効にする。
     *
     * 診断: DevTools のコンソールで window.__tmYtVolumeBoost.dump()
     */

    // ============================================================
    // 設定
    // ============================================================

    // 上限（%）。Volume Master と同じ 600%
    const MAX_BOOST = 600;

    // 100% より上をドラッグしたときの刻み（%）。100% 以下は 1% 刻み
    const SLIDER_STEP = 5;

    // ドラッグで 100% の前後このくらい（%）に来たら、100% ちょうどに吸い付ける
    const SNAP_TO_100 = 3;

    // ↑↓←→キー・ホイール1回で動く量（%）。100% 以下は YouTube と同じ 5%
    const KEY_STEP = 10;
    const SMALL_STEP = 5;

    // 次に YouTube を開いたときも増幅を引き継ぐか
    const REMEMBER_BOOST = true;

    // 100% を超えている間だけ、音割れを抑えるリミッターを通すか
    const USE_LIMITER = true;

    // リミッターの設定（DynamicsCompressorNode）。
    // しきい値は 0dB（音割れが始まる大きさ）ちょうどにする。
    // 0dB より下げると、Chrome がそのぶん音を自動で持ち上げる（メイクアップゲイン）ため、
    // 300% のつもりが 336% になるなど、表示とずれる（-2dB で約 +12%）。
    const LIMITER = {
        threshold: 0,     // dB。ここを超えた分を強く抑える
        knee: 0,          // dB
        ratio: 20,
        attack: 0.003,    // 秒
        release: 0.25     // 秒
    };

    // 増幅率を変えたときに、なめらかに追従させる時定数（秒）。0 で即時
    const GAIN_SMOOTHING = 0.02;

    // 100% 以下に戻したあと、リミッターを外すまでの待ち（ms）。
    // 増幅率が下がりきる前に外すと、一瞬だけ大きな音が出るため
    const LIMITER_RELEASE_DELAY = 200;

    // 0〜100% の部分で、つまみが動く長さ（px）。
    // YouTube の音量バー（幅 52px・つまみ 12px → 40px 動く）に合わせる。
    // YouTube の音量バーが開いたときの幅を実測できたら、そちらを使う
    const DEFAULT_TRAVEL = 40;
    const DEFAULT_TRAVEL_BIG = 60;     // 全画面など（ytp-big-mode）

    // バー全体の長さの上限（プレーヤーの幅に対する割合）。
    // 小さいプレーヤーで右側のボタンにかぶらないように縮める
    const MAX_WIDTH_RATIO = 0.3;

    // プレーヤーAPI が無いときの延長部分（100〜600%）の長さ（px）
    const TRACK_WIDTH = 64;

    // つまみの直径（px）
    const KNOB_SIZE = 12;

    // 画面上部の「音量 250%」表示を出しておく時間（ms）
    const TOAST_MS = 900;

    // YouTube 側で音量が下がったのを確かめるまでの待ち（ms）。
    // 動画の切り替わりなどで一瞬だけ違う値が見えても、増幅を外さないため
    const VOLUME_CHECK_DELAY = 300;

    // バーを付け直すまでの待ち（ms）
    const MOUNT_DEBOUNCE = 200;

    // ============================================================
    // 定数
    // ============================================================

    const STORE_KEY = 'tm-yt-volume-boost';
    const STYLE_ID = 'tm-ytvb-style';
    const WIDGET_CLASS = 'tm-ytvb';
    const TOAST_CLASS = 'tm-ytvb-toast';
    const HOST_ATTR = 'data-tm-ytvb-host';
    const HIDDEN_ATTR = 'data-tm-ytvb-replaced';

    // 色（プレーヤーの操作バーは常に暗い背景なので固定）
    const COLOR_BASE = '#fff';                       // 0〜100%（YouTube の音量バーと同じ白）
    const COLOR_BOOST = '#ffb000';                   // 100% より上
    const RAIL_BASE = 'rgba(255, 255, 255, .2)';
    const RAIL_BOOST = 'rgba(255, 176, 0, .25)';

    // YouTube の音量バーが「開いている」とみなす幅（px）
    const PANEL_OPEN_MIN = 24;

    // バーを付けるプレーヤー（上から順に試す）
    const PLAYER_SELECTORS = [
        '#movie_player',                                                         // 通常の再生ページ
        '.html5-video-player:not(#inline-preview-player):not(#shorts-player)'    // 保険
    ];

    // バーを置く場所（上から順に試す）
    //   after    = その要素の直後
    //   append   = その要素の末尾
    //   replaces = その要素は YouTube の音量バーなので、1本化するときは隠す
    const MOUNT_POINTS = [
        { selector: '.ytp-volume-area .ytp-volume-panel', mode: 'after', replaces: true },                    // 本命
        { selector: '.ytp-volume-panel', mode: 'after', replaces: true },                                     // 音量欄の名前が変わったとき
        { selector: '.ytp-left-controls [role="slider"][aria-valuemax="100"]', mode: 'after', replaces: true }, // クラス名が変わったとき（0〜100 のスライダー）
        { selector: '.ytp-volume-area', mode: 'append', replaces: false },
        { selector: '.ytp-mute-button', mode: 'after', replaces: false },
        { selector: '.ytp-left-controls', mode: 'append', replaces: false }                                   // 最後の手段: 左側のボタン列の末尾
    ];

    // ============================================================
    // 状態
    // ============================================================

    let boost = loadBoost();          // 増幅（%、100〜MAX_BOOST）

    let audioCtx = null;
    let gainNode = null;
    let limiterNode = null;
    let routedThroughLimiter = null;  // いまリミッターを通しているか（null = 未接続）
    let limiterReleaseTimer = null;
    let audioError = '';

    // video -> { source, error }
    // つないだ動画と、つなげなかった理由。つなげなかった理由は
    // 「別の何かが先につないでいる」など、その要素では二度と直らないものだけ
    const videoStates = new WeakMap();

    let widget = null;
    let mountTimer = null;
    let mountInfo = '（まだ探していない）';
    let mountedIndex = -1;
    let replacedPanel = null;         // 1本化のために隠す YouTube の音量バー
    let lastRenderSignature = '';

    // YouTube の音量バーが開いたときの幅（実測）。通常・全画面で分ける
    const panelWidths = {
        normal: 0,
        big: 0
    };

    let resizeObserver = null;
    let observedPlayer = null;
    let observedPanel = null;

    let toast = null;
    let toastTimer = null;

    let volumeCheckTimer = null;
    let dragging = false;
    let dragValue = null;             // ドラッグ中に表示する値（YouTube 側の反映待ちでつまみが揺れないように）

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

    function loadBoost() {
        if (!REMEMBER_BOOST) {
            return 100;
        }

        try {
            const saved = localStorage.getItem(STORE_KEY);

            return saved === null ? 100 : clampBoost(saved);
        } catch (e) {
            return 100;
        }
    }

    function saveBoost() {
        if (!REMEMBER_BOOST) {
            return;
        }

        try {
            localStorage.setItem(STORE_KEY, String(boost));
        } catch (e) {
            // 保存できなくても、このページの中では効く
        }
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

        if (USE_LIMITER && typeof audioCtx.createDynamicsCompressor === 'function') {
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

        const useLimiter = !!limiterNode && boost > 100;

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

    // つないでも音が消えない動画か。
    // 別のサイトの動画を CORS 無しでつなぐと、Chrome は無音にしてしまう。
    // YouTube の通常の再生は blob: の URL（MediaSource）なので問題ない。
    function isAttachable(video) {
        const src = video.currentSrc || video.src || '';

        if (!src) {
            // まだ読み込んでいない。再生が始まったときにもう一度見る
            return false;
        }

        if (src.startsWith('blob:')) {
            return true;
        }

        try {
            return new URL(src, location.href).origin === location.origin;
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
            // 1つの動画は1度しかつなげない。ほかの拡張機能などが先につないでいると、
            // ここで失敗する。その要素では二度と成功しないので、理由を覚えておく
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
    // Web Audio が止まっている（自動再生の制限）ときは、つながずに再開を頼むだけ。
    // 止まったままつなぐと無音になるため。
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
    // YouTube 側の音量
    // ============================================================

    function findPlayer() {
        for (const selector of PLAYER_SELECTORS) {
            const player = document.querySelector(selector);

            if (player) {
                return player;
            }
        }

        return null;
    }

    // プレーヤー要素に生えている YouTube の API（getVolume など）
    function getPlayerApi() {
        const player = document.getElementById('movie_player') || findPlayer();

        if (
            player &&
            typeof player.getVolume === 'function' &&
            typeof player.setVolume === 'function' &&
            typeof player.isMuted === 'function'
        ) {
            return player;
        }

        return null;
    }

    // 0〜600% の1本のバーにできるか（YouTube の音量を API で動かせるか）
    function isUnified() {
        return !!getPlayerApi();
    }

    // YouTube の音量スライダーの値（0〜100）とミュート。
    // video.volume は音量の自動調整（ラウドネス）で下がっていることがあるので使わない
    function readYtVolume() {
        const api = getPlayerApi();

        if (!api) {
            return null;
        }

        try {
            const volume = Number(api.getVolume());

            if (!Number.isFinite(volume)) {
                return null;
            }

            return {
                volume,
                muted: !!api.isMuted()
            };
        } catch (e) {
            return null;
        }
    }

    // YouTube 側の音量を変える（0〜100）。0 より大きければミュートも解く
    function setYtVolume(volume) {
        const api = getPlayerApi();

        if (!api) {
            return;
        }

        try {
            if (Number(api.getVolume()) !== volume) {
                api.setVolume(volume);
            }

            if (volume > 0 && typeof api.unMute === 'function' && api.isMuted()) {
                api.unMute();
            }
        } catch (e) {
            // YouTube の API が変わっていても、増幅自体は効く
        }
    }

    // YouTube 側の音量が 100% 未満に下げられたら、増幅を外す
    function scheduleVolumeCheck() {
        if (boost <= 100) {
            return;
        }

        clearTimeout(volumeCheckTimer);

        volumeCheckTimer = setTimeout(() => {
            volumeCheckTimer = null;

            const yt = readYtVolume();

            if (!yt || yt.muted || boost <= 100) {
                return;
            }

            if (yt.volume < 99.5) {
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
    // options.fromUser: 利用者の操作（YouTube 側の音量も 100% にそろえ、ミュートを解く）
    // options.toast:    画面上部に「音量 250%」を出す
    function setBoost(value, options) {
        const opts = options || {};
        const next = clampBoost(value);

        if (next !== boost) {
            boost = next;
            saveBoost();
        }

        if (boost > 100) {
            if (opts.fromUser) {
                setYtVolume(100);
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

        if (!isUnified()) {
            return boost;
        }

        const yt = readYtVolume();

        if (!yt) {
            return boost;
        }

        if (yt.muted) {
            return 0;
        }

        if (boost > 100) {
            return boost;
        }

        return Math.round(yt.volume);
    }

    // バーの値を変える。100% 以下は YouTube の音量、上は増幅
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

        setYtVolume(next);
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
        if (document.getElementById(STYLE_ID)) {
            return;
        }

        const parent = document.head || document.documentElement;

        if (!parent) {
            return;
        }

        const style = document.createElement('style');
        style.id = STYLE_ID;

        style.textContent = [
            '.' + WIDGET_CLASS + ' {',
            '    display: inline-flex;',
            '    align-items: center;',
            '    height: 100%;',
            '    vertical-align: top;',
            '    color: #fff;',
            '    outline: none;',
            '    user-select: none;',
            '}',
            '.tm-ytvb-track {',
            '    position: relative;',
            '    flex: none;',
            '    width: 0;',
            '    height: 100%;',
            '    min-height: 24px;',
            '    opacity: 0;',
            '    overflow: hidden;',
            '    cursor: pointer;',
            '    touch-action: none;',
            '    transition: width .2s cubic-bezier(.4, 0, 1, 1), opacity .2s;',
            '}',
            // 音量欄にマウスを乗せたとき・YouTube の音量バーが開いているとき・操作中に開く
            '[' + HOST_ATTR + ']:hover .tm-ytvb-track,',
            '.' + WIDGET_CLASS + '.tm-ytvb-open .tm-ytvb-track,',
            '.' + WIDGET_CLASS + ':focus-visible .tm-ytvb-track,',
            '.' + WIDGET_CLASS + '.tm-ytvb-dragging .tm-ytvb-track {',
            '    width: var(--tm-ytvb-width, ' + TRACK_WIDTH + 'px);',
            '    opacity: 1;',
            '}',
            '.tm-ytvb-rail {',
            '    position: absolute;',
            '    left: ' + (KNOB_SIZE / 2) + 'px;',
            '    right: ' + (KNOB_SIZE / 2) + 'px;',
            '    top: 50%;',
            '    height: 3px;',
            '    margin-top: -1.5px;',
            '    border-radius: 1.5px;',
            '    background: ' + RAIL_BASE + ';',
            '}',
            '.tm-ytvb-fill {',
            '    position: absolute;',
            '    left: 0;',
            '    top: 0;',
            '    bottom: 0;',
            '    width: 0;',
            '    border-radius: 1.5px;',
            '    background: ' + COLOR_BOOST + ';',
            '}',
            // 100% の目盛り（1本化のときだけ）
            '.tm-ytvb-tick {',
            '    display: none;',
            '    position: absolute;',
            '    top: -3px;',
            '    bottom: -3px;',
            '    width: 2px;',
            '    margin-left: -1px;',
            '    background: rgba(255, 255, 255, .6);',
            '}',
            '.' + WIDGET_CLASS + '.tm-ytvb-unified .tm-ytvb-tick {',
            '    display: block;',
            '}',
            '.tm-ytvb-knob {',
            '    position: absolute;',
            '    left: 0;',
            '    top: 50%;',
            '    width: ' + KNOB_SIZE + 'px;',
            '    height: ' + KNOB_SIZE + 'px;',
            '    margin: ' + (-KNOB_SIZE / 2) + 'px 0 0 ' + (-KNOB_SIZE / 2) + 'px;',
            '    border-radius: 50%;',
            '    background: #fff;',
            '}',
            '.tm-ytvb-label {',
            '    display: none;',
            '    padding: 0 6px 0 4px;',
            '    font-size: 109%;',
            '    white-space: nowrap;',
            '    font-variant-numeric: tabular-nums;',
            '    cursor: default;',
            '}',
            '.' + WIDGET_CLASS + '.tm-ytvb-boosted .tm-ytvb-label,',
            '[' + HOST_ATTR + ']:hover .tm-ytvb-label,',
            '.' + WIDGET_CLASS + '.tm-ytvb-open .tm-ytvb-label,',
            '.' + WIDGET_CLASS + ':focus-visible .tm-ytvb-label,',
            '.' + WIDGET_CLASS + '.tm-ytvb-dragging .tm-ytvb-label {',
            '    display: inline;',
            '}',
            '.' + WIDGET_CLASS + '.tm-ytvb-boosted .tm-ytvb-label {',
            '    color: ' + COLOR_BOOST + ';',
            '}',
            '.' + WIDGET_CLASS + '.tm-ytvb-waiting .tm-ytvb-label {',
            '    opacity: .6;',
            '    text-decoration: underline dotted;',
            '}',
            '.' + WIDGET_CLASS + '.tm-ytvb-error .tm-ytvb-label {',
            '    color: #ff6e6e;',
            '}',
            // 1本化したとき、YouTube 本来の音量バーは見えなくする。
            // 消さずに残すのは、開いたときの幅（=長さの基準・開くタイミング）を測るため
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
            '    font: 500 15px/1.4 Roboto, Arial, sans-serif;',
            '    white-space: nowrap;',
            '    pointer-events: none;',
            '    opacity: 0;',
            '    transition: opacity .2s;',
            '}',
            '.' + TOAST_CLASS + '.tm-ytvb-show {',
            '    opacity: 1;',
            '}'
        ].join('\n');

        parent.appendChild(style);
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
        track.className = 'tm-ytvb-track';

        const rail = document.createElement('div');
        rail.className = 'tm-ytvb-rail';

        const fill = document.createElement('div');
        fill.className = 'tm-ytvb-fill';

        const tick = document.createElement('div');
        tick.className = 'tm-ytvb-tick';

        const knob = document.createElement('div');
        knob.className = 'tm-ytvb-knob';

        const label = document.createElement('span');
        label.className = 'tm-ytvb-label';

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
        widget.addEventListener('dblclick', onWidgetDblClick);

        // YouTube 側の操作（再生・停止など）に伝わらないようにする
        ['mousedown', 'click'].forEach((type) => {
            widget.addEventListener(type, (event) => {
                event.stopPropagation();
            });
        });

        return widget;
    }

    function valueFromPointer(event, track) {
        const rect = track.getBoundingClientRect();
        const usable = rect.width - KNOB_SIZE;
        const min = getRangeMin();

        if (usable <= 0) {
            return getSliderValue();
        }

        const ratio = Math.min(
            1,
            Math.max(0, (event.clientX - rect.left - KNOB_SIZE / 2) / usable)
        );

        return snapValue(min + ratio * (MAX_BOOST - min));
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
        widget.classList.add('tm-ytvb-dragging');

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
        widget.classList.remove('tm-ytvb-dragging');

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

    function isBigMode(player) {
        return !!player && player.classList.contains('ytp-big-mode');
    }

    // 0〜100% の部分で、つまみが動く長さ（px）
    function getTravel(player) {
        const big = isBigMode(player);
        const measured = panelWidths[big ? 'big' : 'normal'];

        if (measured >= PANEL_OPEN_MIN) {
            // YouTube のつまみの直径（通常 12px・全画面 18px）を引いた分だけ動く
            const travel = measured - (big ? 18 : 12);

            if (travel >= 20 && travel <= 200) {
                return travel;
            }
        }

        return big ? DEFAULT_TRAVEL_BIG : DEFAULT_TRAVEL;
    }

    // バーの見た目の長さ（px）
    function getTrackWidth(player) {
        if (!isUnified()) {
            return TRACK_WIDTH;
        }

        let travel = getTravel(player) * (MAX_BOOST / 100);

        if (player && player.clientWidth > 0) {
            travel = Math.min(travel, player.clientWidth * MAX_WIDTH_RATIO);
        }

        return Math.round(travel + KNOB_SIZE);
    }

    // YouTube の音量バーの幅を見張る。
    // 開いたら（マウスを乗せた・常に開いている見た目など）こちらも開き、その幅を長さの基準にする
    function observeSizes(player, panel) {
        if (typeof ResizeObserver !== 'function') {
            return;
        }

        if (!resizeObserver) {
            resizeObserver = new ResizeObserver(onResize);
        }

        if (observedPlayer !== player) {
            if (observedPlayer) {
                resizeObserver.unobserve(observedPlayer);
            }

            observedPlayer = player;

            if (player) {
                resizeObserver.observe(player);
            }
        }

        if (observedPanel !== panel) {
            if (observedPanel) {
                resizeObserver.unobserve(observedPanel);
            }

            observedPanel = panel;

            if (panel) {
                resizeObserver.observe(panel);
            }
        }
    }

    function onResize(entries) {
        for (const entry of entries) {
            if (entry.target !== observedPanel) {
                continue;
            }

            const width = entry.target.getBoundingClientRect().width;
            const key = isBigMode(observedPlayer) ? 'big' : 'normal';

            if (width > panelWidths[key]) {
                panelWidths[key] = width;
            }

            if (widget) {
                widget.classList.toggle('tm-ytvb-open', width >= PANEL_OPEN_MIN);
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

        const player = findPlayer();
        const video = player ? player.querySelector('video') : null;
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
            'ドラッグ・ホイール・←→キーで調整、ダブルクリックで 100% に戻す'
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

    // 1本化するときは YouTube の音量バーを隠す。
    // 隠すのはこのバーがすぐ隣にあるときだけ（付け損ねたら YouTube のバーが残る）
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
        const yt = unified ? readYtVolume() : null;
        const muted = !!yt && yt.muted && dragValue === null;
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
            problem.waiting,
            problem.error
        ].join('|');

        if (signature === lastRenderSignature) {
            return;
        }

        lastRenderSignature = signature;

        const min = unified ? 0 : 100;
        const span = MAX_BOOST - min;
        const ratio = (value - min) / span;
        const mark = (100 - min) / span;      // 100% の位置（1本化なら 1/6、延長だけなら 0）

        const rail = widget.querySelector('.tm-ytvb-rail');
        const fill = widget.querySelector('.tm-ytvb-fill');
        const tick = widget.querySelector('.tm-ytvb-tick');
        const knob = widget.querySelector('.tm-ytvb-knob');
        const label = widget.querySelector('.tm-ytvb-label');

        widget.style.setProperty('--tm-ytvb-width', width + 'px');

        // 100% までは YouTube と同じ白、その先はオレンジ
        rail.style.background = unified
            ? 'linear-gradient(to right, ' + RAIL_BASE + ' 0 ' + percent(mark) + ', ' + RAIL_BOOST + ' ' + percent(mark) + ' 100%)'
            : RAIL_BASE;

        fill.style.width = percent(ratio);

        if (!unified) {
            fill.style.background = COLOR_BOOST;
        } else if (ratio <= mark) {
            fill.style.background = COLOR_BASE;
        } else {
            const baseEnd = percent(mark / ratio);

            fill.style.background = 'linear-gradient(to right, ' + COLOR_BASE + ' 0 ' + baseEnd + ', ' + COLOR_BOOST + ' ' + baseEnd + ' 100%)';
        }

        tick.style.left = percent(mark);
        knob.style.left = percent(ratio);
        label.textContent = muted ? 'ミュート' : value + '%';

        widget.classList.toggle('tm-ytvb-unified', unified);
        widget.classList.toggle('tm-ytvb-boosted', value > 100 && !muted);
        widget.classList.toggle('tm-ytvb-waiting', problem.waiting);
        widget.classList.toggle('tm-ytvb-error', !!problem.error);

        widget.setAttribute('aria-valuemin', String(min));
        widget.setAttribute('aria-valuenow', String(value));
        widget.setAttribute('aria-valuetext', muted ? 'ミュート' : value + '%');
        widget.title = buildTitle(value, unified, problem);
    }

    function showToast() {
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
        let text = '音量 ' + getSliderValue() + '%';

        if (problem.waiting) {
            text += '（クリックで有効）';
        } else if (problem.error) {
            text += '（増幅できません）';
        }

        toast.textContent = text;
        toast.classList.add('tm-ytvb-show');

        clearTimeout(toastTimer);

        toastTimer = setTimeout(() => {
            toast.classList.remove('tm-ytvb-show');
        }, TOAST_MS);
    }

    // ============================================================
    // 設置（SPA・再描画への対応）
    // ============================================================

    function findMountPoint(player) {
        for (let i = 0; i < MOUNT_POINTS.length; i++) {
            const point = MOUNT_POINTS[i];
            const element = player.querySelector(point.selector);

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
            mountInfo = '（プレーヤーがまだ無い）';
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

        // 前に隠した YouTube の音量バーが別の要素なら、隠すのをやめる
        const nextPanel = point.replaces ? point.element : null;

        if (replacedPanel && replacedPanel !== nextPanel) {
            replacedPanel.removeAttribute(HIDDEN_ATTR);
            w.classList.remove('tm-ytvb-open');
        }

        replacedPanel = nextPanel;

        observeSizes(player, replacedPanel);

        mountedIndex = point.index;
        mountInfo = point.selector + '（' + (point.mode === 'after' ? '直後' : '末尾') + '）';

        lastRenderSignature = '';
        render();
    }

    function isMountedAtBest() {
        if (!widget || !widget.isConnected || mountedIndex !== 0) {
            return false;
        }

        // YouTube の音量バーだけが作り直されたときは、新しい方を隠し直す
        if (!replacedPanel || !replacedPanel.isConnected || replacedPanel.nextElementSibling !== widget) {
            return false;
        }

        const player = findPlayer();

        return !!player && player.contains(widget);
    }

    // 予約済みならそれを待つ（ページの書き換えが続いても先送りにしない）。
    // delay 0 は今すぐ（遷移の直後など）
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
            if (isMountedAtBest()) {
                return;
            }

            scheduleMount(MOUNT_DEBOUNCE);
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

        // YouTube のシーク（←→）などに伝わらないよう、ここで止める
        consume(event);

        setSliderValue(next, {
            toast: false
        });
    }

    // YouTube の音量キー（↑↓）の続き。
    // 音量 100% での ↑ は増幅を上げ、増幅中の ↓ は増幅から下げる。
    // それ以外は YouTube にそのまま任せる（つまみは volumechange で追いかける）。
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

        // ショートでは ↑↓ が前後の動画への移動なので触らない
        if (location.pathname.startsWith('/shorts')) {
            return;
        }

        // プレーヤーにフォーカスがあるとき（動画をクリックしたあと）だけ
        const player = document.getElementById('movie_player') || findPlayer();
        const active = document.activeElement;

        if (!player || !active || !player.contains(active)) {
            return;
        }

        const yt = readYtVolume();

        if (!yt || yt.muted) {
            return;
        }

        if (event.key === 'ArrowUp') {
            if (yt.volume < 99.5) {
                return;
            }

            consume(event);

            setBoost(boost + KEY_STEP, {
                fromUser: true,
                toast: true
            });

            return;
        }

        if (boost <= 100) {
            return;
        }

        consume(event);

        setBoost(boost - KEY_STEP, {
            fromUser: true,
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

    // YouTube 側で音量・ミュートが変わったら、つまみを追いかける
    function onVolumeChange(event) {
        if (event.target instanceof HTMLMediaElement) {
            render();
            scheduleVolumeCheck();
        }
    }

    function onNavigateFinish() {
        scheduleMount(0);
        activateBoost();
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

        let text = element.tagName.toLowerCase();

        if (element.id) {
            text += '#' + element.id;
        }

        return text;
    }

    function collectState() {
        const yt = readYtVolume();
        const player = findPlayer();
        const videos = Array.from(document.querySelectorAll('video'));
        const attached = videos.filter((video) => {
            const state = videoStates.get(video);
            return state && state.source;
        });
        const problem = getProblem();
        const unified = isUnified();

        return {
            音量: getSliderValue() + '%',
            ブースト: boost + '%',
            増幅率: gainNode ? gainNode.gain.value.toFixed(2) : '（未作成）',
            AudioContext: audioCtx ? audioCtx.state : '（未作成）',
            リミッター: routedThroughLimiter === null ? '（未接続）' : (routedThroughLimiter ? '通している' : '通していない'),
            YouTube音量: yt ? yt.volume + (yt.muted ? '（ミュート）' : '') : '（取得できない）',
            形: unified ? '1本のバー（0〜' + MAX_BOOST + '%）' : '延長部分だけ（プレーヤーAPI が無い）',
            バーの長さ: getTrackWidth(player) + 'px（0〜100% は ' + Math.round(getTravel(player)) + 'px）',
            YouTubeの音量バー: replacedPanel ? (replacedPanel.hasAttribute(HIDDEN_ATTR) ? '隠している' : '残している') : '（無い）',
            プレーヤー: describeElement(player) || '見つからない',
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
            const src = video.currentSrc || video.src || '';
            const player = video.closest('.html5-video-player');

            return {
                プレーヤー: describeElement(player) || '（外）',
                src: src ? src.slice(0, 40) : '（未読み込み）',
                つないだ: state ? (state.source ? 'はい' : 'いいえ') : '未',
                エラー: state ? state.error : '',
                volume: Number(video.volume.toFixed(2)),
                muted: video.muted,
                paused: video.paused
            };
        });
    }

    function dump() {
        const state = collectState();
        const videos = collectVideos();

        console.table(Object.keys(state).map((key) => ({
            項目: key,
            値: state[key]
        })));

        console.table(videos);

        return {
            state,
            videos
        };
    }

    window.__tmYtVolumeBoost = {
        dump,
        state: collectState,
        // 0〜600（1本化のとき）。100 以下は YouTube の音量、上は増幅
        set: (value) => setSliderValue(value, {
            toast: true
        })
    };

    // ============================================================
    // 起動
    // ============================================================

    // キーは YouTube より先に受け取る（document-start・window・キャプチャ）
    window.addEventListener('keydown', onUserGesture, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onUserGesture, true);

    // 動画のイベントは泡立たないので、キャプチャで拾う
    document.addEventListener('play', onPlay, true);
    document.addEventListener('volumechange', onVolumeChange, true);

    document.addEventListener('yt-navigate-finish', onNavigateFinish);

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
