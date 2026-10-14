// ==UserScript==
// @name         YouTube 音量ブースト v1.0.0
// @namespace    local.hiro.tools
// @version      1.0.0
// @description  YouTube の音量を 100% より上（最大 600%）まで上げる。プレーヤーの音量バーの右に延長部分を足し、音量 100% で ↑ キーを押したときも、その先へ上がる
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
     * 見た目は「YouTube の音量バーが右へ伸びた」形にする。
     *
     *   [ミュート][YouTube の音量 0〜100%][延長部分 100〜600%] 250%
     *
     * 1本の長いバーとして扱うため、次のように連動させる。
     *   - 延長部分を上げたら、YouTube 側の音量は 100% にそろえる（ミュートも解く）
     *   - YouTube 側の音量を 100% 未満に下げたら、ブーストは 100% に戻す
     *   - 音量 100% で ↑ キーを押すと延長部分が上がり、↓ キーはブースト分から下がる
     *
     * 注意:
     *   - 動画を Web Audio につなぐと、外す方法がない（ページを開き直すまで）。
     *     そのため、ブーストを 100% より上げるまでは音声に一切手を付けない。
     *   - Chrome は、ページを一度もクリックしていない状態では Web Audio を止めておく
     *     （自動再生の制限）。止まったままつなぐと無音になるので、そのときは
     *     つながずに待ち、最初のクリックかキー入力で有効にする。
     *
     * 診断: DevTools のコンソールで window.__tmYtVolumeBoost.dump()
     */

    // ============================================================
    // 設定
    // ============================================================

    // ブーストの上限（%）。Volume Master と同じ 600%
    const MAX_BOOST = 600;

    // 延長部分をドラッグしたときの刻み（%）
    const SLIDER_STEP = 5;

    // ↑↓キー・ホイール1回で動く量（%）
    const KEY_STEP = 10;

    // 次に YouTube を開いたときもブーストを引き継ぐか
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

    // 延長部分の長さ（px）。YouTube の音量バーとだいたいそろえる
    const TRACK_WIDTH = 64;

    // つまみの直径（px）
    const KNOB_SIZE = 12;

    // 画面上部の「音量 250%」表示を出しておく時間（ms）
    const TOAST_MS = 900;

    // YouTube 側で音量が下がったのを確かめるまでの待ち（ms）。
    // 動画の切り替わりなどで一瞬だけ違う値が見えても、ブーストを外さないため
    const VOLUME_CHECK_DELAY = 300;

    // 延長部分を付け直すまでのデバウンス（ms）
    const MOUNT_DEBOUNCE = 200;

    // ============================================================
    // 定数
    // ============================================================

    const STORE_KEY = 'tm-yt-volume-boost';
    const STYLE_ID = 'tm-ytvb-style';
    const WIDGET_CLASS = 'tm-ytvb';
    const TOAST_CLASS = 'tm-ytvb-toast';
    const HOST_ATTR = 'data-tm-ytvb-host';

    // 延長部分を付けるプレーヤー（上から順に試す）
    const PLAYER_SELECTORS = [
        '#movie_player',                                                         // 通常の再生ページ
        '.html5-video-player:not(#inline-preview-player):not(#shorts-player)'    // 保険
    ];

    // 延長部分を置く場所（上から順に試す）
    //   after  = その要素の直後
    //   append = その要素の末尾
    const MOUNT_POINTS = [
        { selector: '.ytp-volume-area .ytp-volume-panel', mode: 'after' },                    // 音量バーの直後（本命）
        { selector: '.ytp-volume-panel', mode: 'after' },                                     // 音量欄の名前が変わったとき
        { selector: '.ytp-left-controls [role="slider"][aria-valuemax="100"]', mode: 'after' }, // クラス名が変わったとき（0〜100 のスライダー）
        { selector: '.ytp-volume-area', mode: 'append' },
        { selector: '.ytp-mute-button', mode: 'after' },
        { selector: '.ytp-left-controls', mode: 'append' }                                    // 最後の手段: 左側のボタン列の末尾
    ];

    // ============================================================
    // 状態
    // ============================================================

    let boost = loadBoost();          // %（100〜MAX_BOOST）

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
    let lastRenderSignature = '';

    let toast = null;
    let toastTimer = null;

    let volumeCheckTimer = null;
    let dragging = false;

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

    // ブーストが 100% を超えたら音声経路を用意してつなぐ。
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
            typeof player.isMuted === 'function'
        ) {
            return player;
        }

        return null;
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

    // 延長部分を上げたら、手前の YouTube 側を 100% にそろえる
    function raiseYtVolumeToMax() {
        const api = getPlayerApi();

        if (!api) {
            return;
        }

        try {
            if (typeof api.setVolume === 'function' && Number(api.getVolume()) < 100) {
                api.setVolume(100);
            }

            if (typeof api.unMute === 'function' && api.isMuted()) {
                api.unMute();
            }
        } catch (e) {
            // YouTube の API が変わっていても、ブースト自体は効く
        }
    }

    // YouTube 側の音量が 100% 未満に下げられたら、ブーストを戻す
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
    // ブーストの変更
    // ============================================================

    function snapToStep(value, step) {
        return 100 + Math.round((value - 100) / step) * step;
    }

    // options.fromUser: 利用者の操作（YouTube 側の音量も 100% にそろえる）
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
                raiseYtVolumeToMax();
            }

            activateBoost();
        }

        applyGain();
        render();

        if (opts.toast) {
            showToast();
        }
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

        // プレーヤーの操作バーは常に暗い背景なので、色は YouTube の音量バーに合わせて固定
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
            '[' + HOST_ATTR + ']:hover .tm-ytvb-track,',
            '.' + WIDGET_CLASS + ':focus-visible .tm-ytvb-track,',
            '.' + WIDGET_CLASS + '.tm-ytvb-dragging .tm-ytvb-track {',
            '    width: ' + TRACK_WIDTH + 'px;',
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
            '    background: rgba(255, 255, 255, .2);',
            '}',
            '.tm-ytvb-fill {',
            '    position: absolute;',
            '    left: 0;',
            '    top: 0;',
            '    bottom: 0;',
            '    width: 0;',
            '    border-radius: 1.5px;',
            '    background: #ffb000;',
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
            '.' + WIDGET_CLASS + ':focus-visible .tm-ytvb-label,',
            '.' + WIDGET_CLASS + '.tm-ytvb-dragging .tm-ytvb-label {',
            '    display: inline;',
            '}',
            '.' + WIDGET_CLASS + '.tm-ytvb-boosted .tm-ytvb-label {',
            '    color: #ffb000;',
            '}',
            '.' + WIDGET_CLASS + '.tm-ytvb-waiting .tm-ytvb-label {',
            '    opacity: .6;',
            '    text-decoration: underline dotted;',
            '}',
            '.' + WIDGET_CLASS + '.tm-ytvb-error .tm-ytvb-label {',
            '    color: #ff6e6e;',
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
    // 延長部分（スライダー）
    // ============================================================

    function getWidget() {
        if (widget) {
            return widget;
        }

        widget = document.createElement('div');
        widget.className = WIDGET_CLASS;
        widget.tabIndex = 0;
        widget.setAttribute('role', 'slider');
        widget.setAttribute('aria-label', '音量ブースト');
        widget.setAttribute('aria-valuemin', '100');
        widget.setAttribute('aria-valuemax', String(MAX_BOOST));

        const track = document.createElement('div');
        track.className = 'tm-ytvb-track';

        const rail = document.createElement('div');
        rail.className = 'tm-ytvb-rail';

        const fill = document.createElement('div');
        fill.className = 'tm-ytvb-fill';

        const knob = document.createElement('div');
        knob.className = 'tm-ytvb-knob';

        const label = document.createElement('span');
        label.className = 'tm-ytvb-label';

        rail.appendChild(fill);
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

    function boostFromPointer(event, track) {
        const rect = track.getBoundingClientRect();
        const usable = rect.width - KNOB_SIZE;

        if (usable <= 0) {
            return boost;
        }

        const ratio = Math.min(
            1,
            Math.max(0, (event.clientX - rect.left - KNOB_SIZE / 2) / usable)
        );

        return snapToStep(
            100 + ratio * (MAX_BOOST - 100),
            SLIDER_STEP
        );
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

        setBoost(boostFromPointer(event, track), {
            fromUser: true,
            toast: false
        });
    }

    function onTrackPointerMove(event) {
        if (!dragging) {
            return;
        }

        setBoost(boostFromPointer(event, event.currentTarget), {
            fromUser: true,
            toast: false
        });
    }

    function onTrackPointerUp(event) {
        if (!dragging) {
            return;
        }

        dragging = false;
        widget.classList.remove('tm-ytvb-dragging');

        try {
            event.currentTarget.releasePointerCapture(event.pointerId);
        } catch (e) {
            // すでに外れている
        }
    }

    function onWidgetWheel(event) {
        event.preventDefault();
        event.stopPropagation();

        if (event.deltaY === 0) {
            return;
        }

        setBoost(boost + (event.deltaY < 0 ? KEY_STEP : -KEY_STEP), {
            fromUser: true,
            toast: false
        });
    }

    function onWidgetDblClick(event) {
        event.preventDefault();
        event.stopPropagation();

        setBoost(100, {
            fromUser: true,
            toast: true
        });
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

    function buildTitle(problem) {
        const lines = [
            '音量ブースト: ' + boost + '%',
            'ドラッグ・ホイール・←→キーで調整、ダブルクリックで 100% に戻す'
        ];

        if (problem.waiting) {
            lines.push('※ ページを一度クリックすると有効になります（ブラウザの自動再生の制限）');
        }

        if (problem.error) {
            lines.push('※ 増幅できません: ' + problem.error);
        }

        return lines.join('\n');
    }

    function render() {
        if (!widget) {
            return;
        }

        const problem = getProblem();
        const signature = [
            boost,
            problem.waiting,
            problem.error
        ].join('|');

        if (signature === lastRenderSignature) {
            return;
        }

        lastRenderSignature = signature;

        const ratio = (boost - 100) / (MAX_BOOST - 100);
        const percent = (ratio * 100).toFixed(2) + '%';

        widget.querySelector('.tm-ytvb-fill').style.width = percent;
        widget.querySelector('.tm-ytvb-knob').style.left = percent;
        widget.querySelector('.tm-ytvb-label').textContent = boost + '%';

        widget.classList.toggle('tm-ytvb-boosted', boost > 100);
        widget.classList.toggle('tm-ytvb-waiting', problem.waiting);
        widget.classList.toggle('tm-ytvb-error', !!problem.error);

        widget.setAttribute('aria-valuenow', String(boost));
        widget.setAttribute('aria-valuetext', boost + '%');
        widget.title = buildTitle(problem);
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
        let text = '音量 ' + boost + '%';

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

        // 音量欄にマウスを乗せたら延長部分も開く（CSS の :hover で見る）
        w.parentElement.setAttribute(HOST_ATTR, '');

        mountedIndex = point.index;
        mountInfo = point.selector + '（' + (point.mode === 'after' ? '直後' : '末尾') + '）';

        render();
    }

    function isMountedAtBest() {
        if (!widget || !widget.isConnected || mountedIndex !== 0) {
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

    // 延長部分にフォーカスがあるとき
    function handleWidgetKey(event) {
        let next = null;

        if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
            next = boost + KEY_STEP;
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
            next = boost - KEY_STEP;
        } else if (event.key === 'Home') {
            next = 100;
        } else if (event.key === 'End') {
            next = MAX_BOOST;
        }

        if (next === null) {
            return;
        }

        // YouTube のシーク（←→）などに伝わらないよう、ここで止める
        consume(event);

        setBoost(next, {
            fromUser: true,
            toast: false
        });
    }

    // YouTube の音量キー（↑↓）の続き。
    // 音量 100% での ↑ はブーストを上げ、ブースト中の ↓ はブーストから下げる。
    // それ以外は YouTube にそのまま任せる。
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

    function onVolumeChange(event) {
        if (event.target instanceof HTMLMediaElement) {
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
        const videos = Array.from(document.querySelectorAll('video'));
        const attached = videos.filter((video) => {
            const state = videoStates.get(video);
            return state && state.source;
        });
        const problem = getProblem();

        return {
            ブースト: boost + '%',
            増幅率: gainNode ? gainNode.gain.value.toFixed(2) : '（未作成）',
            AudioContext: audioCtx ? audioCtx.state : '（未作成）',
            リミッター: routedThroughLimiter === null ? '（未接続）' : (routedThroughLimiter ? '通している' : '通していない'),
            YouTube音量: yt ? yt.volume + (yt.muted ? '（ミュート）' : '') : '（取得できない）',
            プレーヤー: describeElement(findPlayer()) || '見つからない',
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
        set: (value) => setBoost(value, {
            fromUser: true,
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

        // 前回のブーストを引き継いでいるとき
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
