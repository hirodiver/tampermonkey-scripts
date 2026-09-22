// ==UserScript==
// @name         X スペース帯非表示 v1.5.0
// @namespace    local.hiro.tools
// @version      1.5.0
// @description  X のタイムライン上部に出る音声スペースの帯（バー）を非表示にする
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-start
// @noframes
// @homepageURL  https://github.com/hirodiver/tampermonkey-scripts
// @supportURL   https://github.com/hirodiver/tampermonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-hide-spaces-bar.user.js
// @updateURL    https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-hide-spaces-bar.user.js
// ==/UserScript==

/*
 * タイムラインに差し込まれる音声スペースの帯を隠す。
 *
 * 三段構えにしている。上から順に確実だが、対象が狭い。
 *
 *   1. CSS（:has）— document-start で <style> を注入する。
 *      スペースへのリンクを持ち、投稿本体を含まないセルを消す。
 *      要素が生まれた瞬間から効くので、一瞬見えてから消えない。
 *
 *   2. リンク起点の探索 — a[href*="/i/spaces/"] から上へ辿り、
 *      投稿本体を含まない範囲の一番外側を帯とみなして消す。
 *      タイムラインのセル構造に依存しない。
 *
 *   3. 構造＋テキストの探索 — iPhone版のXは帯をリンクではなく
 *      ボタンで描くことがあり、href が無い。そこで
 *      「横に広く・縦に低く・投稿本体を含まず・スペース関連の語を持つ」
 *      という見た目の条件で帯を探す。
 *
 * 非表示は要素の削除ではなく display:none で行う。
 * 誤爆したときに DevTools で元の要素を確認できるようにするため。
 *
 * ■ 自動で消えないとき（iPhone だけで完結する）
 *   URL の末尾に #tmspaces を付けて開き、「タップで指定」を押してから
 *   消したい帯を指でタップする。その要素の居場所を覚えて以後は自動で消す。
 *   覚えた内容は localStorage に残るので、次に開いたときも効く。
 *   間違えたら「取り消し」または「全解除」。
 *
 * ■ iPhone で調べる方法
 *   URL の末尾に #tmspaces を付けて開くと、画面上に診断パネルが出る。
 *   （例: https://x.com/home#tmspaces ）
 *   「コピー」を押すとレポートがクリップボードに入るので、そのまま報告に使える。
 *   コンソールが使える環境なら __tmSpacesBar.dump() でも同じ情報が出る。
 */

(function () {
    'use strict';

    // ============================================================
    // 設定
    // ============================================================

    // true にするとコンソールに処理ログを出す
    const DEBUG = false;

    // 画面下部に居座る再生バー（オーディオドック）も隠すか
    const HIDE_AUDIO_DOCK = true;

    // リンクを持たない帯を、見た目とテキストで探すか
    const USE_SHAPE_FALLBACK = true;

    // 診断パネルを出す URL ハッシュ
    const DIAGNOSTIC_HASH = 'tmspaces';

    // DOM変化後の再処理までの待ち時間（ミリ秒）
    const REBUILD_DELAY = 250;

    // SPA遷移直後の再処理までの待ち時間（ミリ秒）
    const NAV_DELAY = 500;

    // スペースへのリンク
    const SPACE_LINK_SELECTOR = 'a[href*="/i/spaces/"]';

    /*
     * X はスペースを配信（broadcasts）側へ寄せつつある。
     * 帯が /i/broadcasts/ を指す場合もあるので両方見る
     */
    const BROADCAST_LINK_SELECTOR = 'a[href*="/i/broadcasts/"]';

    // タイムライン1件分の要素（上から順に試す）
    const CELL_SELECTORS = [
        'div[data-testid="cellInnerDiv"]',
        'section[role="region"] > div > div > div'
    ];

    // スペースの帯だと判断する目印
    const SPACE_MARK_SELECTORS = [
        SPACE_LINK_SELECTOR,
        'a[href^="/i/spaces"]',
        '[data-testid="audioSpaceRoot"]',
        '[data-testid="AudioSpacePill"]',
        '[data-testid="placementTracking"] a[href*="/i/spaces/"]',
        BROADCAST_LINK_SELECTOR,
        '[data-testid*="audiospace" i]',
        '[data-testid*="AudioSpace" i]'
    ];

    // 画面下部の再生バー
    const AUDIO_DOCK_SELECTORS = [
        'div[data-testid="AudioDock"]',
        'div[data-testid="audioDock"]',
        'div[data-testid="AudioDockSpace"]'
    ];

    // 投稿本体の要素（これを含む範囲は投稿なので隠さない）
    const TWEET_SELECTORS = [
        'article[data-testid="tweet"]',
        'article[role="article"]',
        'article'
    ];

    /*
     * 帯のテキスト判定。
     * 「スペース」だけだと投稿に誤爆するため、
     * 状態を表す語との組み合わせを要求する
     */
    const SPACE_WORDS = [
        'スペース',
        'Space'
    ];

    const STATE_WORDS = [
        'ライブ',
        'LIVE',
        'Live',
        '聞く',
        '再生',
        '録音',
        'リスナー',
        'ホスト',
        '開始'
    ];

    // 帯とみなすテキストの最大文字数（長い＝投稿）
    const BAR_MAX_LENGTH = 120;

    /*
     * スペースの帯は X が他で使わない紫で塗られている。
     * 文言も data-testid も当てにならなかったため、これを主な手がかりにする。
     *
     *   実機の例: 「+25 ・ ライトノベル雑談（このラノとか）」
     *   ——「スペース」の語が一度も出てこない
     */
    const SPACE_PURPLES = [
        [120, 86, 255],   // #7856FF 現行のスペース紫
        [110, 86, 226],   // 旧トーン
        [93, 60, 200]     // 暗めの派生
    ];

    // 紫と認めるRGB距離
    const PURPLE_TOLERANCE = 70;

    // 帯とみなす高さの範囲（ピクセル）
    const BAR_MIN_HEIGHT = 20;
    const BAR_MAX_HEIGHT = 220;

    // 帯とみなす幅（画面幅に対する割合）
    const BAR_MIN_WIDTH_RATIO = 0.5;

    // リンクから上へ辿る最大段数
    const MAX_CLIMB = 10;

    // 本スクリプトが非表示にした要素の目印
    const HIDDEN_ATTR = 'data-tm-space-hidden';

    // 注入する <style> の id
    const STYLE_ID = 'tm-hide-spaces-bar-style';

    // 診断パネルの id
    const PANEL_ID = 'tm-hide-spaces-bar-panel';

    // 手動で指定した帯の記憶先
    const STORAGE_KEY = 'tm-hide-spaces-bar-rules';

    // 記憶できる件数の上限
    const MAX_RULES = 20;

    // 診断パネルを開いている間の自動更新間隔（ミリ秒）
    const PANEL_REFRESH_MS = 1500;


    // ============================================================
    // 状態
    // ============================================================

    let rebuildTimer = null;

    // 最後に処理したパス（SPA遷移の検知に使う）
    let lastPath = location.pathname;

    let processing = false;
    let reprocessRequested = false;

    let styleElement = null;

    // 直近の判定結果（診断パネル用）
    let lastReport = null;

    // 手動指定モードか
    let pickingMode = false;

    // 診断パネルの自動更新タイマー
    let panelTimer = null;


    // ============================================================
    // 小物
    // ============================================================

    function log(...args) {

        if (DEBUG) {
            console.log('[Xスペース帯非表示]', ...args);
        }
    }


    /*
     * スペースそのものを開いているときは何も隠さない
     */
    function isSpacePage() {

        return location.pathname
            .startsWith('/i/spaces');
    }


    function queryAll(selectors) {

        const found = [];


        for (const selector of selectors) {

            try {

                found.push(
                    ...document.querySelectorAll(selector)
                );

            } catch {

                /*
                 * 未対応セレクタは黙って飛ばす
                 */
            }
        }


        return [...new Set(found)];
    }


    function hasTweet(element) {

        return TWEET_SELECTORS.some(
            selector =>
                element.querySelector(selector) ||
                element.closest?.(selector)
        );
    }


    /*
     * 帯は文字を持たず aria-label だけのことがある。
     * 判定にはラベルも足して見る
     */
    function signalTextOf(element) {

        const label =
            element.getAttribute?.('aria-label') || '';

        return (label + ' ' + textOf(element)).trim();
    }


    function textOf(element) {

        return (element.textContent || '')
            .replace(/\s+/g, ' ')
            .trim();
    }


    /*
     * スペースの帯らしい文言か
     */
    function looksLikeSpaceText(text) {

        if (!text || text.length > BAR_MAX_LENGTH) {
            return false;
        }


        const hasSpaceWord =
            SPACE_WORDS.some(
                word => text.includes(word)
            );

        if (!hasSpaceWord) {
            return false;
        }


        return STATE_WORDS.some(
            word => text.includes(word)
        );
    }


    /*
     * 帯らしい形か（横に広く、縦に低い）
     */
    function looksLikeBarShape(element) {

        const rect =
            element.getBoundingClientRect?.();

        if (!rect) {
            return false;
        }


        /*
         * 画面外・未描画のものは判定しない
         */
        if (!rect.width || !rect.height) {
            return false;
        }


        const viewportWidth =
            window.innerWidth ||
            document.documentElement.clientWidth ||
            0;

        if (!viewportWidth) {
            return false;
        }


        return (
            rect.width >=
                viewportWidth * BAR_MIN_WIDTH_RATIO &&

            rect.height >= BAR_MIN_HEIGHT &&

            rect.height <= BAR_MAX_HEIGHT
        );
    }


    // ============================================================
    // CSSによる先回り（:has）
    // ============================================================

    function supportsHas() {

        try {

            return CSS.supports('selector(:has(a))');

        } catch {

            return false;
        }
    }


    function buildCss() {

        const rules = [];


        for (const cellSelector of CELL_SELECTORS) {

            /*
             * 「スペースへのリンクを持ち、投稿本体を持たないセル」だけを隠す
             */
            rules.push(
                `${cellSelector}` +
                `:has(${SPACE_LINK_SELECTOR})` +
                `:not(:has(article))`
            );
        }


        rules.push(
            `[data-testid="placementTracking"]` +
            `:has(${SPACE_LINK_SELECTOR})` +
            `:not(:has(article))`
        );


        if (HIDE_AUDIO_DOCK) {
            rules.push(...AUDIO_DOCK_SELECTORS);
        }


        return (
            rules.join(',\n') +
            ' {\n    display: none !important;\n}\n'
        );
    }


    function ensureStyle() {

        if (!supportsHas()) {
            return;
        }


        const root =
            document.head ||
            document.documentElement;

        if (!root) {
            return;
        }


        if (
            styleElement &&
            styleElement.isConnected
        ) {
            return;
        }


        styleElement =
            document.getElementById(STYLE_ID);


        if (!styleElement) {

            styleElement =
                document.createElement('style');

            styleElement.id = STYLE_ID;

            /*
             * innerHTML は Trusted Types で弾かれるため使わない
             */
            styleElement.textContent = buildCss();
        }


        root.appendChild(styleElement);

        log('スタイルを注入');
    }


    function syncStyleEnabled() {

        if (!styleElement) {
            return;
        }


        styleElement.disabled = isSpacePage();
    }


    // ============================================================
    // 表示・非表示
    // ============================================================

    /*
     * X はスクロール時に同じ DOM 要素を別の項目に使い回す。
     * 一度隠した要素をそのままにすると、通常の投稿が消えてしまう。
     * そのため毎回すべて判定し直し、表示側にも戻す。
     */
    function setHidden(element, hidden) {

        const isHidden =
            element.hasAttribute(HIDDEN_ATTR);


        if (hidden && !isHidden) {

            element.setAttribute(HIDDEN_ATTR, '1');

            element.style.setProperty(
                'display',
                'none',
                'important'
            );

            return true;
        }


        if (!hidden && isHidden) {

            element.removeAttribute(HIDDEN_ATTR);

            element.style.removeProperty('display');

            return true;
        }


        return false;
    }


    function restoreAll() {

        let changed = 0;


        for (
            const element of
            document.querySelectorAll(`[${HIDDEN_ATTR}]`)
        ) {

            if (setHidden(element, false)) {
                changed++;
            }
        }


        return changed;
    }


    // ============================================================
    // 帯の探索
    // ============================================================

    /*
     * 起点から上へ辿り、
     * 投稿本体を含まない範囲の一番外側を帯とみなす。
     *
     * セル（cellInnerDiv）に当たればそこで止める。
     * タイムライン外に置かれた帯でも、
     * 形が崩れる手前まで広げて掴めるようにしている
     */
    function findBarRoot(start) {

        let current = start;
        let best = start;


        for (let i = 0; i < MAX_CLIMB; i++) {

            const parent = current.parentElement;


            if (
                !parent ||
                parent === document.body ||
                parent === document.documentElement
            ) {
                break;
            }


            if (hasTweet(parent)) {
                break;
            }


            /*
             * main や region まで広げると画面全体を消してしまう
             */
            if (
                parent.matches?.(
                    'main, [role="main"], [role="region"], header, nav'
                )
            ) {
                break;
            }


            const text = textOf(parent);

            if (text.length > BAR_MAX_LENGTH) {
                break;
            }


            best = parent;
            current = parent;


            /*
             * セルまで来たらそこが帯の単位
             */
            if (
                CELL_SELECTORS.some(
                    selector => parent.matches?.(selector)
                )
            ) {
                break;
            }
        }


        return best;
    }


    /*
     * 1. 目印のある要素（リンク等）から
     */
    function collectByMark() {

        const marks =
            queryAll(SPACE_MARK_SELECTORS);


        const roots = [];


        for (const mark of marks) {

            if (hasTweet(mark)) {
                continue;
            }


            roots.push(findBarRoot(mark));
        }


        return roots;
    }


    /*
     * 2. 見た目とテキストから（iPhone版のボタン描画対策）
     */
    function collectByShape() {

        if (!USE_SHAPE_FALLBACK) {
            return [];
        }


        const roots = [];


        /*
         * テキストを持つ末端付近の要素だけを見る。
         * 全要素を走査すると重いので、
         * ボタン・リンク・見出しに絞る
         */
        const candidates =
            queryAll([
                '[role="button"]',
                '[role="link"]',
                '[aria-label*="スペース"]',
                '[aria-label*="Space"]',
                '[data-testid="placementTracking"]',
                'a[href*="/i/spaces"]'
            ]);


        for (const candidate of candidates) {

            if (hasTweet(candidate)) {
                continue;
            }


            if (
                !looksLikeSpaceText(
                    signalTextOf(candidate)
                )
            ) {
                continue;
            }


            const root =
                findBarRoot(candidate);


            if (hasTweet(root)) {
                continue;
            }


            /*
             * 形が帯らしくないものは見送る。
             * 未描画（幅ゼロ）の場合も形が取れないので見送り、
             * 次の巡回に任せる
             */
            if (
                !looksLikeBarShape(root) &&
                !looksLikeBarShape(candidate)
            ) {
                continue;
            }


            roots.push(root);
        }


        return roots;
    }


    /*
     * 3. セル単位のテキストから
     *    （目印もリンクも無い帯の最終手段）
     */
    function collectByCellText() {

        if (!USE_SHAPE_FALLBACK) {
            return [];
        }


        const roots = [];


        for (const cell of queryAll(CELL_SELECTORS)) {

            if (hasTweet(cell)) {
                continue;
            }


            if (!looksLikeSpaceText(textOf(cell))) {
                continue;
            }


            roots.push(cell);
        }


        return roots;
    }


    function collectBars() {

        const roots = [
            ...collectByMark(),
            ...collectByShape(),
            ...collectByCellText(),
            ...collectByColor(),
            ...collectByRules()
        ];


        /*
         * 入れ子になったものは外側だけ残す
         */
        const unique = [...new Set(roots)];


        return unique.filter(
            root =>
                !unique.some(
                    other =>
                        other !== root &&
                        other.contains(root)
                )
        );
    }


    // ============================================================
    // 色による探索
    // ============================================================

    function parseRgb(value) {

        const matched =
            /rgba?\(([^)]+)\)/.exec(value || '');

        if (!matched) {
            return null;
        }


        const parts =
            matched[1]
                .split(',')
                .map(part => parseFloat(part));


        if (parts.length < 3) {
            return null;
        }


        /*
         * 透明なら塗られていないのと同じ
         */
        if (parts.length >= 4 && parts[3] < 0.5) {
            return null;
        }


        return parts.slice(0, 3);
    }


    function isSpacePurple(value) {

        const rgb = parseRgb(value);

        if (!rgb) {
            return false;
        }


        return SPACE_PURPLES.some(target => {

            const distance =
                Math.sqrt(
                    (rgb[0] - target[0]) ** 2 +
                    (rgb[1] - target[1]) ** 2 +
                    (rgb[2] - target[2]) ** 2
                );

            return distance <= PURPLE_TOLERANCE;
        });
    }


    /*
     * 紫に塗られた横長の帯を探す。
     *
     * 全要素に getComputedStyle をかけると重いので、
     * 背景色を持ちうる要素に絞ってから見る
     */
    function collectByColor() {

        const candidates =
            queryAll([
                '[style*="background"]',
                '[role="button"]',
                '[role="link"]',
                '[data-testid]',
                ...CELL_SELECTORS
            ]);


        const roots = [];


        for (const candidate of candidates) {

            if (hasTweet(candidate)) {
                continue;
            }


            let background;

            try {

                background =
                    getComputedStyle(candidate)
                        .backgroundColor;

            } catch {

                continue;
            }


            if (!isSpacePurple(background)) {
                continue;
            }


            if (!looksLikeBarShape(candidate)) {
                continue;
            }


            /*
             * 塗られている要素そのものが帯。
             * セルごと消せるならそちらを優先する
             */
            const cell =
                CELL_SELECTORS
                    .map(
                        selector =>
                            candidate.closest?.(selector)
                    )
                    .find(Boolean);


            const root =
                cell && !hasTweet(cell) ?
                    cell :
                    candidate;


            roots.push(root);
        }


        return roots;
    }


    // ============================================================
    // 手動で指定した帯の記憶
    // ============================================================

    /*
     * Xの DOM を当てにいくのをやめ、
     * 「これを消して」と指で示してもらった要素の居場所を覚える。
     *
     * 覚えるのは文言ではなく、
     * 「どの入れ子のどこに居るか」（親を遡った data-testid とタグの並び）と
     * role / aria-label。
     * 文言や配信者が変わっても効き続けるようにするため
     */
    function signatureOf(element) {

        const path = [];

        let current = element;


        for (let i = 0; i < 6 && current; i++) {

            const testid =
                current.getAttribute?.('data-testid');

            path.push(
                testid ?
                    `@${testid}` :
                    current.tagName.toLowerCase()
            );


            if (
                current.parentElement === document.body ||
                !current.parentElement
            ) {
                break;
            }

            current = current.parentElement;
        }


        return [
            path.join('<'),

            element.getAttribute?.('role') || '',

            element.getAttribute?.('aria-label') || ''
        ].join('|');
    }


    function loadRules() {

        try {

            const raw =
                localStorage.getItem(STORAGE_KEY);

            const parsed =
                raw ? JSON.parse(raw) : [];

            return Array.isArray(parsed) ? parsed : [];

        } catch {

            /*
             * 読めない環境（プライベートブラウズ等）では
             * 記憶なしとして動く
             */
            return [];
        }
    }


    function saveRules(rules) {

        try {

            localStorage.setItem(
                STORAGE_KEY,

                JSON.stringify(
                    rules.slice(-MAX_RULES)
                )
            );

            return true;

        } catch {

            return false;
        }
    }


    function addRule(element) {

        const rules = loadRules();


        const rule = {
            sig:
                signatureOf(element),

            memo:
                textOf(element).slice(0, 30),

            at:
                new Date().toISOString()
        };


        /*
         * 同じものは重ねない
         */
        if (
            rules.some(item => item.sig === rule.sig)
        ) {
            return rule;
        }


        rules.push(rule);

        saveRules(rules);


        return rule;
    }


    function removeLastRule() {

        const rules = loadRules();

        rules.pop();

        saveRules(rules);

        restoreAll();
    }


    function clearRules() {

        saveRules([]);

        restoreAll();
    }


    /*
     * 記憶した居場所に当てはまる要素を集める。
     *
     * 総当たりは重いので、候補を
     * 「目印を持つ要素・押せる要素・セル・画面に固定された要素」に絞る
     */
    function collectByRules() {

        const rules = loadRules();

        if (!rules.length) {
            return [];
        }


        const wanted =
            new Set(rules.map(rule => rule.sig));


        const candidates =
            queryAll([
                '[data-testid]',
                '[role="button"]',
                '[role="link"]',
                '[aria-label]',
                ...CELL_SELECTORS
            ]);


        const roots = [];


        for (const candidate of candidates) {

            if (!wanted.has(signatureOf(candidate))) {
                continue;
            }


            /*
             * 投稿が入ってきたものは、
             * 使い回しとみなして消さない
             */
            if (hasTweet(candidate)) {
                continue;
            }


            roots.push(candidate);
        }


        return roots;
    }


    // ============================================================
    // 手動指定モード
    // ============================================================

    /*
     * 次の1タップで、触れた要素を帯として覚える
     */
    function startPicking() {

        pickingMode = true;


        const overlay =
            document.getElementById(PANEL_ID);

        if (overlay) {

            /*
             * 指定中は小さくして、帯が隠れないようにする
             */
            overlay.style.opacity = '0.25';

            overlay.style.maxHeight = '52px';
        }


        const onPick = event => {

            event.preventDefault();
            event.stopPropagation();


            const point =
                event.touches?.[0] || event;


            const touched =
                document.elementFromPoint(
                    point.clientX,
                    point.clientY
                ) || event.target;


            /*
             * 診断パネル自身に触れた場合は指定として扱わない。
             * パネルが画面下半分を覆うため、
             * 帯が隠れていると誤って掴んでしまう
             */
            if (touched?.closest?.(`#${PANEL_ID}`)) {
                return;
            }


            document.removeEventListener(
                'click',
                onPick,
                true
            );

            pickingMode = false;


            if (!touched) {
                return;
            }


            const root =
                findBarRoot(touched);


            addRule(root);


            if (overlay) {

                overlay.style.opacity = '';

                overlay.style.maxHeight = '';
            }


            scheduleProcess(50);
        };


        /*
         * capture で拾い、X 側のタップ処理へ渡さない
         */
        document.addEventListener(
            'click',
            onPick,
            true
        );
    }


    // ============================================================
    // メイン
    // ============================================================

    function processBars() {

        const bars =
            collectBars();


        const wanted =
            new Set(bars);


        let changed = 0;


        /*
         * 帯でなくなった要素を表示へ戻す（セル使い回し対策）
         */
        for (
            const element of
            document.querySelectorAll(`[${HIDDEN_ATTR}]`)
        ) {

            if (
                !wanted.has(element) &&
                !AUDIO_DOCK_SELECTORS.some(
                    selector => element.matches?.(selector)
                )
            ) {

                if (setHidden(element, false)) {
                    changed++;
                }
            }
        }


        for (const bar of bars) {

            if (setHidden(bar, true)) {
                changed++;
            }
        }


        lastReport = {
            time: new Date().toISOString(),
            bars: bars.length
        };


        return changed;
    }


    function processAudioDock() {

        if (!HIDE_AUDIO_DOCK) {
            return 0;
        }


        const docks =
            queryAll(AUDIO_DOCK_SELECTORS);


        let changed = 0;


        for (const dock of docks) {

            if (setHidden(dock, true)) {
                changed++;
            }
        }


        return changed;
    }


    function process() {

        /*
         * 処理中に呼ばれたら、終了後に1回だけ追い実行する
         */
        if (processing) {

            reprocessRequested = true;

            return;
        }


        processing = true;


        try {

            ensureStyle();

            syncStyleEnabled();


            let changed = 0;


            if (isSpacePage()) {

                /*
                 * スペースのページでは全部表示へ戻す
                 */
                changed += restoreAll();

            } else {

                changed += processBars();
                changed += processAudioDock();
            }


            if (changed) {
                log('表示状態を変更:', changed, '件');
            }


            syncPanel();

        } catch (error) {

            console.warn(
                '[Xスペース帯非表示] 処理中にエラー:',
                error
            );

        } finally {

            processing = false;


            if (reprocessRequested) {

                reprocessRequested = false;

                scheduleProcess(REBUILD_DELAY);
            }
        }
    }


    function scheduleProcess(delay = REBUILD_DELAY) {

        clearTimeout(rebuildTimer);

        rebuildTimer =
            setTimeout(process, delay);
    }


    // ============================================================
    // 診断
    // ============================================================

    /*
     * iPhone ではコンソールが開けないので、
     * URL に #tmspaces を付けると画面上にレポートを出す
     */
    function wantsPanel() {

        return location.hash
            .toLowerCase()
            .includes(DIAGNOSTIC_HASH);
    }


    function describe(element) {

        const rect =
            element.getBoundingClientRect?.() ||
            { width: 0, height: 0 };


        const path = [];

        let current = element;

        for (let i = 0; i < 4 && current; i++) {

            path.push(
                current.tagName.toLowerCase() +
                (current.getAttribute?.('data-testid') ?
                    `[${current.getAttribute('data-testid')}]` :
                    '')
            );

            current = current.parentElement;
        }


        let background = '';

        try {

            background =
                getComputedStyle(element)
                    .backgroundColor;

        } catch {

            /*
             * 取れない場合は空のまま
             */
        }


        return {
            tag:
                element.tagName.toLowerCase(),

            bg:
                background +
                (isSpacePurple(background) ? '(紫)' : ''),

            testid:
                element.getAttribute?.('data-testid') || '',

            aria:
                element.getAttribute?.('aria-label') || '',

            role:
                element.getAttribute?.('role') || '',

            href:
                element.getAttribute?.('href') || '',

            w:
                Math.round(rect.width),

            h:
                Math.round(rect.height),

            hidden:
                element.hasAttribute(HIDDEN_ATTR),

            path:
                path.join(' < '),

            text:
                textOf(element).slice(0, 60)
        };
    }


    /*
     * 「スペース」という語を含む最小の要素を集める。
     * 帯が見つからないとき、何を手がかりにできるかを見るため
     */
    function findSpaceMentions(limit = 12) {

        const found = [];


        const walker =
            document.createTreeWalker(
                document.body,
                NodeFilter.SHOW_TEXT
            );


        while (walker.nextNode()) {

            const node = walker.currentNode;

            const text =
                (node.nodeValue || '').trim();


            if (
                !SPACE_WORDS.some(
                    word => text.includes(word)
                )
            ) {
                continue;
            }


            const element =
                node.parentElement;

            if (!element) {
                continue;
            }


            /*
             * ページのデータ部分は手がかりにならない
             */
            if (
                element.closest?.('script, style, noscript')
            ) {
                continue;
            }


            found.push(element);


            if (found.length >= limit) {
                break;
            }
        }


        return found;
    }


    /*
     * 語に頼らず、帯が居そうな場所を構造で列挙する。
     * 実機の構造が分からないうちは、こちらが手がかりになる
     */
    function collectStructuralHints() {

        const hints = [];


        // 先頭のセル（帯はたいてい一番上に入る）
        const cells =
            queryAll(CELL_SELECTORS);

        cells.slice(0, 4).forEach((cell, index) => {

            hints.push({
                種別: 'セル' + index,
                情報: describe(cell),
                内側:
                    [
                        ...cell.querySelectorAll('[data-testid]')
                    ]
                        .slice(0, 8)
                        .map(
                            el =>
                                el.getAttribute('data-testid')
                        )
            });
        });


        // それらしい testid を持つ要素
        const suspects =
            [...document.querySelectorAll('[data-testid]')]
                .filter(
                    el =>
                        /audio|space|dock|pill|live|broadcast|placement/i
                            .test(
                                el.getAttribute('data-testid') || ''
                            )
                )
                .slice(0, 12);

        for (const suspect of suspects) {

            hints.push({
                種別: 'testid該当',
                情報: describe(suspect)
            });
        }


        // 画面に固定されている低い要素（帯の典型）
        const pinned =
            [...document.querySelectorAll('div')]
                .filter(el => {

                    const style =
                        getComputedStyle(el);

                    if (
                        style.position !== 'fixed' &&
                        style.position !== 'sticky'
                    ) {
                        return false;
                    }

                    const rect =
                        el.getBoundingClientRect();

                    return (
                        rect.height >= BAR_MIN_HEIGHT &&
                        rect.height <= BAR_MAX_HEIGHT &&
                        rect.width >=
                            window.innerWidth *
                            BAR_MIN_WIDTH_RATIO
                    );
                })
                .slice(0, 8);

        for (const element of pinned) {

            hints.push({
                種別: '固定要素',
                情報: describe(element)
            });
        }


        // /i/ を指すリンク（spaces も broadcasts も拾う）
        const links =
            [...document.querySelectorAll('a[href*="/i/"]')]
                .slice(0, 12);

        for (const link of links) {

            hints.push({
                種別: 'iリンク',
                情報: describe(link)
            });
        }


        return hints;
    }


    function buildReport() {

        const bars =
            collectBars();


        const lines = [];


        lines.push('=== Xスペース帯非表示 診断 ===');

        lines.push(
            'URL: ' + location.pathname + location.hash
        );

        lines.push(
            'バージョン: 1.5.0' +
            ' / :has対応: ' + supportsHas() +
            ' / スタイル: ' +
            (styleElement?.isConnected ?
                (styleElement.disabled ? '無効' : '有効') :
                '未注入')
        );

        lines.push(
            '画面幅: ' + window.innerWidth
        );

        lines.push(
            'セル数: ' +
            queryAll(CELL_SELECTORS).length +
            ' / ドック: ' +
            queryAll(AUDIO_DOCK_SELECTORS).length +
            ' / スペースリンク: ' +
            document.querySelectorAll(
                SPACE_LINK_SELECTOR
            ).length
        );


        lines.push('');
        lines.push('■ 帯として検出（' + bars.length + '件）');

        if (!bars.length) {
            lines.push('（なし）');
        }

        for (const bar of bars) {
            lines.push(JSON.stringify(describe(bar)));
        }


        lines.push(
            '手動記憶: ' + loadRules().length + '件'
        );


        lines.push('');
        lines.push('■ 構造からの手がかり');

        const hints =
            collectStructuralHints();

        if (!hints.length) {
            lines.push('（なし）');
        }

        for (const hint of hints) {
            lines.push(JSON.stringify(hint));
        }


        lines.push('');
        lines.push('■「スペース」を含む要素');

        const mentions =
            findSpaceMentions();

        if (!mentions.length) {
            lines.push('（なし。帯が画面に出ていない可能性）');
        }

        for (const mention of mentions) {

            lines.push(JSON.stringify(describe(mention)));

            const root =
                findBarRoot(mention);

            if (root !== mention) {
                lines.push(
                    '  → 帯候補: ' +
                    JSON.stringify(describe(root))
                );
            }
        }


        return lines.join('\n');
    }


    function syncPanel() {

        const existing =
            document.getElementById(PANEL_ID);


        if (!wantsPanel()) {

            existing?.remove();

            return;
        }


        if (!document.body) {
            return;
        }


        const report =
            buildReport();


        let panel = existing;


        if (!panel) {

            panel =
                document.createElement('div');

            panel.id = PANEL_ID;


            Object.assign(
                panel.style,
                {
                    position: 'fixed',
                    left: '8px',
                    right: '8px',
                    bottom: '8px',
                    maxHeight: '60vh',
                    overflow: 'auto',
                    zIndex: '2147483647',
                    padding: '10px',
                    borderRadius: '10px',
                    border: '1px solid #888',
                    background: '#000',
                    color: '#fff',
                    font: '12px/1.5 -apple-system, sans-serif',
                    boxSizing: 'border-box'
                }
            );


            document.body.appendChild(panel);


            /*
             * 開いている間は定期的に取り直す。
             * 読み込み直後の古い内容のまま報告されるのを防ぐ
             */
            clearInterval(panelTimer);

            panelTimer =
                setInterval(
                    () => {

                        if (
                            !document.getElementById(PANEL_ID)
                        ) {

                            clearInterval(panelTimer);

                            panelTimer = null;

                            return;
                        }


                        if (!pickingMode) {
                            syncPanel();
                        }
                    },

                    PANEL_REFRESH_MS
                );
        }


        panel.replaceChildren();


        // --------------------------------------------------------
        // 操作ボタン
        // --------------------------------------------------------

        const bar =
            document.createElement('div');

        Object.assign(
            bar.style,
            {
                display: 'flex',
                gap: '8px',
                marginBottom: '8px'
            }
        );


        function makeButton(label, onClick) {

            const button =
                document.createElement('button');

            button.textContent = label;

            Object.assign(
                button.style,
                {
                    flex: '1',
                    padding: '10px',
                    borderRadius: '8px',
                    border: '1px solid #666',
                    background: '#222',
                    color: '#fff',
                    font: 'inherit'
                }
            );

            button.addEventListener('click', onClick);

            return button;
        }


        const copyButton =
            makeButton('コピー', async () => {

                try {

                    await navigator.clipboard
                        .writeText(report);

                    copyButton.textContent = 'コピーした';

                } catch {

                    /*
                     * 権限が無い場合は選択してもらう
                     */
                    const area =
                        panel.querySelector('textarea');

                    area?.focus();
                    area?.select();

                    copyButton.textContent = '長押しでコピー';
                }
            });


        bar.append(
            makeButton('タップで指定', () => {

                startPicking();
            }),

            copyButton,

            makeButton('閉じる', () => {

                clearInterval(panelTimer);

                panelTimer = null;

                panel.remove();
            })
        );


        panel.appendChild(bar);


        // --------------------------------------------------------
        // 記憶の管理
        // --------------------------------------------------------

        const rules = loadRules();


        const ruleBar =
            document.createElement('div');

        Object.assign(
            ruleBar.style,
            {
                display: 'flex',
                gap: '8px',
                alignItems: 'center',
                marginBottom: '8px'
            }
        );


        const ruleLabel =
            document.createElement('span');

        ruleLabel.textContent =
            '記憶: ' + rules.length + '件';

        ruleLabel.style.flex = '1';


        ruleBar.append(
            ruleLabel,

            makeButton('取り消し', () => {

                removeLastRule();

                scheduleProcess(50);
            }),

            makeButton('全解除', () => {

                clearRules();

                scheduleProcess(50);
            })
        );


        panel.appendChild(ruleBar);


        // --------------------------------------------------------
        // 本文
        // --------------------------------------------------------

        const guide =
            document.createElement('div');

        guide.textContent =
            pickingMode ?
                '消したい帯を1回タップしてください' :
                '自動で消えないときは「タップで指定」→ 帯をタップ';

        Object.assign(
            guide.style,
            {
                marginBottom: '6px',
                color: pickingMode ? '#ff8' : '#9cf'
            }
        );

        panel.appendChild(guide);


        const area =
            document.createElement('textarea');

        area.value = report;

        area.readOnly = true;

        Object.assign(
            area.style,
            {
                width: '100%',
                height: '40vh',
                background: '#111',
                color: '#eee',
                border: '1px solid #444',
                borderRadius: '6px',
                font: '11px/1.4 ui-monospace, monospace',
                boxSizing: 'border-box'
            }
        );


        panel.appendChild(area);
    }


    const diagnostics = {

        dump() {

            const report =
                buildReport();

            console.log(report);

            return report;
        },

        panel: syncPanel,

        css: buildCss,

        pick: startPicking,

        rules: loadRules,

        clear: clearRules,

        last: () => lastReport
    };


    try {

        window.__tmSpacesBar = diagnostics;

    } catch {

        /*
         * 参照できない環境では諦める
         */
    }


    // ============================================================
    // SPA遷移
    // ============================================================

    /*
     * X は history API で画面を切り替えるが、
     * pushState / replaceState のラップは使わない。
     *
     * iOS の Tampermonkey はスクリプトを isolated world で実行するため、
     * こちらで書き換えた history はページ側の呼び出しを捕捉できない。
     * 代わりに、DOM監視のついでに URL の変化を見る。
     */
    function locationChanged() {

        const path = location.pathname;

        if (path === lastPath) {
            return false;
        }

        lastPath = path;

        return true;
    }


    // ============================================================
    // DOM監視
    // ============================================================

    const observer =
        new MutationObserver(mutations => {

            if (locationChanged()) {

                scheduleProcess(NAV_DELAY);

                return;
            }


            for (const mutation of mutations) {

                if (mutation.type !== 'childList') {
                    continue;
                }


                if (!mutation.addedNodes.length) {
                    continue;
                }


                const target = mutation.target;


                /*
                 * 自分が隠した要素・診断パネルの中の変更は無視する
                 * （無限ループ防止）
                 */
                if (
                    target instanceof Element &&
                    (
                        target.closest?.(`[${HIDDEN_ATTR}]`) ||
                        target.closest?.(`#${PANEL_ID}`)
                    )
                ) {
                    continue;
                }


                scheduleProcess();

                return;
            }
        });


    function startObserver() {

        const root =
            document.body ||
            document.documentElement;

        if (!root) {
            return;
        }


        observer.observe(
            root,
            {
                childList: true,
                subtree: true
            }
        );
    }


    // ============================================================
    // 起動
    // ============================================================

    window.addEventListener(
        'popstate',
        () => scheduleProcess(NAV_DELAY)
    );


    window.addEventListener(
        'hashchange',
        () => scheduleProcess(100)
    );


    /*
     * スクロールで帯が現れる作りにも追従する
     */
    window.addEventListener(
        'scroll',
        () => scheduleProcess(400),
        { passive: true }
    );


    ensureStyle();


    if (document.body) {

        startObserver();

    } else {

        document.addEventListener(
            'DOMContentLoaded',
            () => {

                ensureStyle();

                startObserver();

                process();
            },
            { once: true }
        );
    }


    scheduleProcess(NAV_DELAY);

})();
