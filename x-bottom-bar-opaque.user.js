// ==UserScript==
// @name         X 下部メニュー不透明化 v1.0.0
// @namespace    local.hiro.tools
// @version      1.0.0
// @description  X のタイムラインをスクロールすると下部のホーム/検索/通知/DM帯が半透明になる挙動を止め、常に不透明にする
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-start
// @noframes
// @homepageURL  https://github.com/hirodiver/tampermonkey-scripts
// @supportURL   https://github.com/hirodiver/tampermonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-bottom-bar-opaque.user.js
// @updateURL    https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-bottom-bar-opaque.user.js
// ==/UserScript==

/*
 * X のタイムラインをスクロールすると、下部のホーム/検索/通知/DM帯が
 * 半透明になる。これを常に不透明のまま固定する。
 *
 * document-start で <style> を注入し、opacity:1 !important を
 * 先に効かせる。要素が生まれた瞬間から効くので、スクロール中に
 * 一瞬透けて見えるコマ落ちが起きない。
 *
 * data-testid がXのアプリ更新で変わった場合の保険として、
 * 「画面下端に固定・横幅いっぱい・ナビリンク3〜8個」という構造で
 * 下部メニュー帯を探し、見つけた要素には目印の属性を付ける。
 * その属性にも同じCSSルールを当てているので、インラインstyleの
 * 上書き合戦を起こさずに保護できる。
 *
 * (JS側でインラインstyleに直接 opacity:1 !important を書く方式は
 *  採らない。一度書いても、Xが後から important 無しの値で
 *  上書きすると宣言ごと入れ替わり、importantフラグが消えて
 *  元の木阿弥になるため)
 *
 * 効かない・帯が見つからない場合は、コンソールで次を実行すると
 * 判定結果が出る。
 *
 *   __tmBottomBar.dump()
 */

(function () {
    'use strict';

    // ============================================================
    // 設定
    // ============================================================

    // trueにするとコンソールに処理ログを出す
    const DEBUG = false;

    // DOM変化後の再走査までの待ち時間(ミリ秒)
    const SCAN_DELAY = 200;

    // 下部メニュー帯のテストID(新旧セレクタを順に試す)
    const BOTTOM_BAR_SELECTORS = [
        '[data-testid="BottomBar"]'   // 現行(2024〜)
    ];

    // 構造検出で見つけた要素に付ける目印の属性
    const MARK_ATTR = 'data-tm-bottombar-marked';

    // 注入する<style>のid
    const STYLE_ID = 'tm-bottombar-opaque-style';


    // ============================================================
    // 小物
    // ============================================================

    function log(...args) {

        if (DEBUG) {
            console.log('[X下部メニュー不透明化]', ...args);
        }
    }


    // ============================================================
    // CSSによる先回り
    // ============================================================

    function buildCss() {

        return [
            '[data-testid="BottomBar"],',
            '[' + MARK_ATTR + '] {',
            '    opacity: 1 !important;',
            '}',
            '[data-testid="BottomBar"] *,',
            '[' + MARK_ATTR + '] * {',
            '    opacity: 1 !important;',
            '}'
        ].join('\n');
    }


    function ensureStyle() {

        const root =
            document.head ||
            document.documentElement;

        if (!root) {

            /*
             * document-start直後は documentElement(<html>)すら
             * まだ存在しない瞬間があるため、出現を待って再試行する
             */
            const rootObserver =
                new MutationObserver((mutations, observer) => {

                    if (document.documentElement) {

                        observer.disconnect();

                        ensureStyle();
                    }
                });

            rootObserver.observe(document, { childList: true });

            return;
        }

        if (document.getElementById(STYLE_ID)) {
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

        log('スタイルを注入');
    }


    // ============================================================
    // 下部メニュー帯の検出
    // ============================================================

    function findByTestId() {

        for (const selector of BOTTOM_BAR_SELECTORS) {

            const el =
                document.querySelector(selector);

            if (el) {
                return el;
            }
        }

        return null;
    }


    /*
     * テストIDが変わった場合の保険。
     * 「画面下端に固定され、横幅いっぱいで、ナビ用リンクを3〜8個持つ帯」
     * という構造で狙う。#react-root直下の浅い階層だけを見て、
     * タイムライン全体を舐める重い処理にしない。
     */
    function findByStructure() {

        const root =
            document.getElementById('react-root') ||
            document.body;

        if (!root) {
            return null;
        }

        const shallow =
            root.querySelectorAll(
                ':scope > *, :scope > * > *, :scope > * > * > *'
            );

        for (const el of shallow) {

            const computed =
                getComputedStyle(el);

            if (computed.position !== 'fixed') {
                continue;
            }

            const rect =
                el.getBoundingClientRect();

            /*
             * 画面下端に接している帯だけを対象にする
             */
            if (Math.abs(rect.bottom - window.innerHeight) > 6) {
                continue;
            }

            /*
             * 横幅いっぱいの帯だけを対象にする(小さいボタン等を除外)
             */
            if (rect.width < window.innerWidth * 0.6) {
                continue;
            }

            const links =
                el.querySelectorAll('a[href], [role="link"], [role="tab"]');

            if (links.length >= 3 && links.length <= 8) {
                return el;
            }
        }

        return null;
    }


    // ============================================================
    // 走査
    // ============================================================

    function markIfNeeded(el) {

        if (!el || el.hasAttribute(MARK_ATTR)) {
            return;
        }

        el.setAttribute(MARK_ATTR, '');

        log('目印を付与(構造検出)', el);
    }


    function scan() {

        ensureStyle();

        /*
         * data-testidで見つかれば、CSSで既に保護されているので何もしない
         */
        const byTestId =
            findByTestId();

        if (byTestId) {

            log('data-testidで下部メニュー帯を検出', byTestId);

            return;
        }

        /*
         * テストIDが変わった場合の保険
         */
        const byStructure =
            findByStructure();

        if (byStructure) {

            markIfNeeded(byStructure);

            log('構造検出で下部メニュー帯を検出', byStructure);

            return;
        }

        log('下部メニュー帯が見つからない');
    }


    // ============================================================
    // DOM監視
    // ============================================================

    let scanTimer = null;

    function scheduleScan(delay = SCAN_DELAY) {

        clearTimeout(scanTimer);

        scanTimer =
            setTimeout(scan, delay);
    }


    const observer =
        new MutationObserver(() => scheduleScan());


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
    // 診断
    // ============================================================

    /*
     * うまくいかないときの調査用。
     * コンソールで __tmBottomBar.dump() を実行する
     */
    const diagnostics = {

        dump() {

            const byTestId =
                findByTestId();

            const byStructure =
                findByStructure();

            const rows = [
                {
                    検出方式: 'data-testid',

                    検出: !!byTestId,

                    opacity:
                        byTestId ?
                            getComputedStyle(byTestId).opacity :
                            '-'
                },
                {
                    検出方式: '構造(position:fixed等)',

                    検出: !!byStructure,

                    opacity:
                        byStructure ?
                            getComputedStyle(byStructure).opacity :
                            '-'
                }
            ];

            console.table(rows);

            return rows;
        },

        css: buildCss
    };


    try {

        window.__tmBottomBar = diagnostics;

    } catch {

        /*
         * 参照できない環境では諦める
         */
    }


    // ============================================================
    // 起動
    // ============================================================

    ensureStyle();

    if (document.body) {

        startObserver();

    } else {

        document.addEventListener(
            'DOMContentLoaded',
            () => {

                ensureStyle();

                startObserver();

                scan();
            },
            { once: true }
        );
    }

    scan();

})();
