// ==UserScript==
// @name         X スペース帯非表示 v2.4.0
// @namespace    local.hiro.tools
// @version      2.4.0
// @description  X のタイムライン上部（タブの下）に出る音声スペースの帯を非表示にする
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
 * タブの下に出る音声スペースの帯（紫のピル）を隠す。
 *
 * 帯の構造は iPhone の実機診断で確認したもの:
 *
 *   nav > div > div[ScrollSnap-SwipeableList] > div[ScrollSnap-List]
 *       > div[placementTracking] > button > div > div[pill-contents-container]
 *         「+23・ライトノベル雑談（このラノとか）」
 *
 * タイムラインのセルではなく、ヘッダの nav の中にある横スクロールのピル。
 * 文中に「スペース」の語は出てこず、スペースへのリンク（/i/spaces/）も無い。
 *
 * 消すのは CSS（:has）だけで行う。document-start で <style> を注入するので、
 * 描画された瞬間から消えていて、一瞬見えることがない。
 * JS で DOM を走査しないので、スクロール中の負荷もかからない。
 *
 * 同じピルの仕組みで出る「新しいポストを表示」（pillLabel）は残す。
 *
 * ■ 残る空白について（調査中）
 *   帯を消すと、その分の空白が残る。帯の中身は消えているが、
 *   帯専用の枠（高さ56px前後）がヘッダ側に残っているため。
 *   どの要素が枠なのかを診断で特定してから消す。推測では足さない。
 *
 * ■ 診断（iPhone でも使える）
 *   URL の末尾に #tmspaces を付けて開くと、画面下に診断パネルが出る。
 *   （例: https://x.com/home#tmspaces ）
 *   「コピー」を押すとレポートがクリップボードに入る。
 *   コンソールが使える環境なら __tmSpacesBar.dump() でも同じものが出る。
 */

(function () {
    'use strict';

    // ============================================================
    // 設定
    // ============================================================

    const VERSION = '2.4.0';

    // 帯の中身（実機で確認）
    const PILL_SELECTOR = '[data-testid="pill-contents-container"]';

    // 帯を包む要素（実機で確認）
    const PILL_TRACK_SELECTOR = '[data-testid="placementTracking"]';

    const PILL_LIST_SELECTORS = [
        '[data-testid="ScrollSnap-SwipeableList"]',
        '[data-testid="ScrollSnap-List"]'
    ];

    /*
     * 同じピルの仕組みで出るが、残すもの。
     * これを含む入れ物は消さない
     */
    const KEEP_SELECTORS = [
        '[data-testid="pillLabel"]',
        '[aria-label*="新しいポスト"]',
        '[aria-label*="New posts"]'
    ];

    // 帯の枠の高さ（実機診断で確認、px）
    const BAR_FRAME_HEIGHT = 56;

    // 注入する <style> の id
    const STYLE_ID = 'tm-hide-spaces-bar-style';

    // 診断パネル
    const DIAGNOSTIC_HASH = 'tmspaces';

    const PANEL_ID = 'tm-hide-spaces-bar-panel';

    // 診断パネルを開いている間の更新間隔（ミリ秒）
    const PANEL_REFRESH_MS = 1500;

    // 祖先を遡る上限（診断用）
    const MAX_ANCESTORS = 16;

    /*
     * 帯専用の枠を越えたあと、さらに何段見るか（診断用）。
     * 枠の親（ヘッダ本体）がどう高さを決めているかも見たい
     */
    const EXTRA_ANCESTORS = 3;


    // ============================================================
    // 状態
    // ============================================================

    let panelTimer = null;


    // ============================================================
    // CSS
    // ============================================================

    /*
     * 帯は必ず nav の中にある（実機で確認）。
     * nav の外（タイムラインの広告セル等）の placementTracking を
     * 巻き込まないよう、すべてのルールを nav の中に限定する
     */
    function buildCss() {

        const condition =
            `:has(${PILL_SELECTOR})` +
            KEEP_SELECTORS
                .map(selector => `:not(:has(${selector}))`)
                .join('');


        const rules = [

            // nav 直下の帯（実機では 402×52 の div）
            `nav > div${condition}`,

            // 以下は構造が少し変わったときの保険
            ...PILL_LIST_SELECTORS.map(
                selector => `nav ${selector}${condition}`
            ),

            `nav ${PILL_TRACK_SELECTOR}${condition}`
        ];


        /*
         * 帯専用の枠（実機診断 v2.2.0 で確定）。
         *
         *   深さ12: absolute, 56px   ← 枠の一番外側
         *   深さ11: relative, 56px, overflow hidden
         *   深さ10: div[role=grid], absolute, padding-top 56px, 112px
         *   深さ9:  div
         *   深さ8:  nav
         *
         * 中身を消しても枠は56pxのまま残り、空白になっていた。
         * 枠の高さそのものを0にする。本当に大きさが変わるので、
         * Xが枠の大きさを見てタイムラインの位置を決めているなら追従する
         */
        /*
         * :has() は入れ子にできない（入れ子にするとルールごと無効になる）。
         * 帯の有無は子孫セレクタで見て、残すものの除外は外側に付ける
         */
        const framePath =
            `div[role="grid"] > div > nav > div ${PILL_SELECTOR}`;

        const keepOutside =
            KEEP_SELECTORS
                .map(selector => `:not(:has(${selector}))`)
                .join('');

        /*
         * 深さ11（grid の親）と深さ12（その親）だけ。
         * もう1段上（深さ13）はタブを含むヘッダ本体なので絶対に触らない
         */
        const frameRules = [
            `div:has(> ${framePath})${keepOutside}`,
            `div:has(> div > ${framePath})${keepOutside}`
        ];


        /*
         * 投稿を押し下げている領域（実機診断 v2.3.0 で確定）。
         *
         *   header[role=banner]: relative, 162px（＝ヘッダ106 + 帯の枠56）
         *   最初の投稿の上端: y162
         *
         * 枠を0にしても、この header が帯の分を含めた高さを保つので
         * 投稿の位置が変わらなかった。帯があるときだけ下マージンで56px詰める。
         *
         * 条件は :has() を入れ子にせず、残すもの（pillLabel）が
         * 帯の nav に居るときは外側の :not(:has()) で外す
         */
        const bannerRule =
            `body:has(${framePath})` +
            `:not(:has(div[role="grid"] > div > nav [data-testid="pillLabel"]))` +
            ` header[role="banner"]`;


        return (
            rules.join(',\n') +
            ' {\n    display: none !important;\n}\n\n' +
            bannerRule +
            ` {\n    margin-bottom: -${BAR_FRAME_HEIGHT}px !important;\n}\n\n` +
            frameRules.join(',\n') +
            ' {\n    height: 0 !important;\n' +
            '    min-height: 0 !important;\n' +
            '    padding-top: 0 !important;\n' +
            '    overflow: hidden !important;\n}\n'
        );
    }


    function supportsHas() {

        try {

            return CSS.supports('selector(:has(a))');

        } catch {

            return false;
        }
    }


    function ensureStyle() {

        if (document.getElementById(STYLE_ID)) {
            return;
        }


        const root =
            document.head ||
            document.documentElement;

        if (!root) {
            return;
        }


        const style =
            document.createElement('style');

        style.id = STYLE_ID;

        /*
         * innerHTML は Trusted Types で弾かれるため使わない
         */
        style.textContent = buildCss();


        root.appendChild(style);
    }


    // ============================================================
    // 診断: 小物
    // ============================================================

    function textOf(element) {

        return (element.textContent || '')
            .replace(/\s+/g, ' ')
            .trim();
    }


    function round(value) {

        return Math.round(value * 10) / 10;
    }


    /*
     * 要素の寸法と、高さを決めていそうな値をまとめて取る。
     *
     * 以前の診断はインラインの style.height しか見ておらず、
     * クラスで指定された高さを取り逃していた。
     * 計算後の height / top / bottom まで出す
     */
    function describeBox(element) {

        const rect =
            element.getBoundingClientRect();


        let computed = null;

        try {

            computed =
                getComputedStyle(element);

        } catch {

            /*
             * 取れない場合は寸法だけ出す
             */
        }


        const children =
            [...element.children]
                .slice(0, 8)
                .map(child => {

                    let display = '';

                    try {

                        display =
                            getComputedStyle(child).display;

                    } catch {

                        display = '?';
                    }


                    return (
                        round(child.getBoundingClientRect().height) +
                        (display === 'none' ? '(none)' : '')
                    );
                });


        return {
            tag:
                element.tagName.toLowerCase(),

            testid:
                element.getAttribute('data-testid') || '',

            role:
                element.getAttribute('role') || '',

            実測:
                `${round(rect.width)}×${round(rect.height)}` +
                ` @y${round(rect.top)}`,

            ...(computed ?
                {
                    display:
                        computed.display,

                    position:
                        computed.position,

                    height:
                        computed.height,

                    minHeight:
                        computed.minHeight,

                    'top/bottom':
                        `${computed.top} / ${computed.bottom}`,

                    padding:
                        `${computed.paddingTop} / ${computed.paddingBottom}`,

                    margin:
                        `${computed.marginTop} / ${computed.marginBottom}`,

                    overflow:
                        computed.overflow
                } :
                {}),

            子:
                children,

            子の数:
                element.children.length
        };
    }


    // ============================================================
    // 診断: 本体
    // ============================================================

    /*
     * 帯から上へ辿り、各祖先を出す。
     *
     * 「テキストが帯の文言だけ」の祖先は帯専用の入れ物。
     * その一番外側が、空白として残っている枠の候補になる。
     * 枠を越えた先も数段見て、ヘッダ本体の高さの決まり方を確かめる
     */
    function reportAncestors(pill, lines) {

        const pillText =
            textOf(pill);


        let current = pill;
        let beyond = 0;
        let outermostOwn = null;
        let outermostDepth = -1;


        for (
            let depth = 0;
            depth < MAX_ANCESTORS && current;
            depth++
        ) {

            const own =
                textOf(current) === pillText;


            if (own) {

                outermostOwn = current;

                outermostDepth = depth;
            }


            lines.push(
                JSON.stringify({
                    深さ: depth,
                    帯専用: own,
                    ...describeBox(current)
                })
            );


            if (!own) {

                beyond++;

                if (beyond > EXTRA_ANCESTORS) {
                    break;
                }
            }


            if (
                !current.parentElement ||
                current.parentElement === document.body
            ) {
                break;
            }


            current = current.parentElement;
        }


        return outermostOwn ?
            { element: outermostOwn, depth: outermostDepth } :
            null;
    }


    /*
     * ヘッダとタイムラインの間（空白が見えている場所）に
     * 実際に何が描かれているかを、画面中央の縦一列で調べる
     */
    function reportGap(lines) {

        const firstCell =
            document.querySelector(
                'div[data-testid="cellInnerDiv"]'
            );


        const bottom =
            firstCell ?
                Math.min(
                    firstCell.getBoundingClientRect().top,
                    window.innerHeight * 0.6
                ) :
                window.innerHeight * 0.4;


        lines.push(
            '最初の投稿セルの上端: ' +
            (firstCell ?
                round(firstCell.getBoundingClientRect().top) :
                '（なし）')
        );


        const seen = new Set();

        const x = window.innerWidth / 2;


        for (let y = 0; y < bottom; y += 8) {

            const stack =
                document.elementsFromPoint(x, y)
                    .filter(
                        el => !el.closest(`#${PANEL_ID}`)
                    );


            const top = stack[0];

            if (!top || seen.has(top)) {
                continue;
            }


            seen.add(top);


            lines.push(
                JSON.stringify({
                    y,

                    重なり:
                        stack
                            .slice(0, 4)
                            .map(
                                el =>
                                    el.tagName.toLowerCase() +
                                    (el.getAttribute('data-testid') ?
                                        `[${el.getAttribute('data-testid')}]` :
                                        '')
                            )
                            .join(' > '),

                    ...describeBox(top),

                    text:
                        textOf(top).slice(0, 30)
                })
            );
        }
    }


    function buildReport() {

        const lines = [];


        lines.push('=== Xスペース帯非表示 診断 ===');

        lines.push(
            'バージョン: ' + VERSION +
            ' / :has対応: ' + supportsHas() +
            ' / スタイル: ' +
            (document.getElementById(STYLE_ID) ? '有効' : '未注入')
        );

        lines.push(
            '画面: ' +
            window.innerWidth + '×' + window.innerHeight +
            ' / スクロール: ' + round(window.scrollY)
        );


        // --------------------------------------------------------
        // 帯
        // --------------------------------------------------------

        const pills = [
            ...document.querySelectorAll(PILL_SELECTOR)
        ];


        lines.push('');
        lines.push('■ 帯（' + pills.length + '件）');


        if (!pills.length) {
            lines.push('（なし。帯が出ていない）');
        }


        pills.forEach((pill, index) => {

            lines.push('');

            lines.push(
                '[' + index + '] ' +
                textOf(pill).slice(0, 40)
            );


            const frame =
                reportAncestors(pill, lines);


            if (frame) {

                lines.push(
                    '→ 帯専用の一番外側: 深さ ' + frame.depth
                );
            }
        });


        // --------------------------------------------------------
        // 空白の場所に何があるか
        // --------------------------------------------------------

        lines.push('');
        lines.push('■ 画面中央の縦一列（上から）');

        reportGap(lines);


        return lines.join('\n');
    }


    // ============================================================
    // 診断パネル
    // ============================================================

    function wantsPanel() {

        return location.hash
            .toLowerCase()
            .includes(DIAGNOSTIC_HASH);
    }


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


    function closePanel() {

        clearInterval(panelTimer);

        panelTimer = null;

        document.getElementById(PANEL_ID)?.remove();
    }


    function renderPanel() {

        if (!wantsPanel()) {

            closePanel();

            return;
        }


        if (!document.body) {
            return;
        }


        const report =
            buildReport();


        let panel =
            document.getElementById(PANEL_ID);


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
                    maxHeight: '45vh',
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
                    renderPanel,
                    PANEL_REFRESH_MS
                );
        }


        /*
         * コピー直後に作り直すと「コピーした」表示が消えるので、
         * 本文だけ差し替える
         */
        const existingArea =
            panel.querySelector('textarea');

        if (existingArea) {

            existingArea.value = report;

            return;
        }


        panel.replaceChildren();


        const buttons =
            document.createElement('div');

        Object.assign(
            buttons.style,
            {
                display: 'flex',
                gap: '8px',
                marginBottom: '8px'
            }
        );


        const copyButton =
            makeButton('コピー', async () => {

                const area =
                    panel.querySelector('textarea');

                try {

                    await navigator.clipboard
                        .writeText(area.value);

                    copyButton.textContent = 'コピーした';

                } catch {

                    /*
                     * 権限が無い場合は選択してもらう
                     */
                    area.focus();
                    area.select();

                    copyButton.textContent = '長押しでコピー';
                }
            });


        buttons.append(
            copyButton,
            makeButton('閉じる', closePanel)
        );


        const area =
            document.createElement('textarea');

        area.value = report;

        area.readOnly = true;

        Object.assign(
            area.style,
            {
                width: '100%',
                height: '28vh',
                background: '#111',
                color: '#eee',
                border: '1px solid #444',
                borderRadius: '6px',
                font: '11px/1.4 ui-monospace, monospace',
                boxSizing: 'border-box'
            }
        );


        panel.append(buttons, area);
    }


    try {

        window.__tmSpacesBar = {

            dump() {

                const report = buildReport();

                console.log(report);

                return report;
            },

            css: buildCss
        };

    } catch {

        /*
         * 参照できない環境では諦める
         */
    }


    // ============================================================
    // 起動
    // ============================================================

    ensureStyle();


    /*
     * document-start では <head> がまだ無いことがある。
     * その場合は <html> 直下に入れているので、そのままで効く。
     * 念のため DOM 構築後にも確認する
     */
    document.addEventListener(
        'DOMContentLoaded',
        () => {

            ensureStyle();

            renderPanel();
        },
        { once: true }
    );


    window.addEventListener(
        'hashchange',
        renderPanel
    );


    if (document.readyState !== 'loading') {
        renderPanel();
    }

})();
