// ==UserScript==
// @name         Ctrl+D ブックマーク無効 v1.0.0
// @namespace    local.hiro.tools
// @version      1.0.0
// @description  Ctrl+D を押してもブックマークに追加しない（Chrome の「ブックマークに追加」を打ち消す）。サイト側の Ctrl+D の働きはそのまま残す。Claude（claude.ai）では「Claude 音声入力キー」が Ctrl+D を使う
// @match        *://*/*
// @grant        none
// @run-at       document-start
// @homepageURL  https://github.com/hirodiver/tampermonkey-scripts
// @supportURL   https://github.com/hirodiver/tampermonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/block-ctrl-d-bookmark.user.js
// @updateURL    https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/block-ctrl-d-bookmark.user.js
// ==/UserScript==

/*
 * Ctrl+D を押したときの Chrome の「ブックマークに追加」を止める。
 *
 * - キーの既定動作だけを打ち消す（preventDefault）。サイト側のキー処理には渡すので、
 *   サイトが Ctrl+D に割り当てた働きは残る
 * - 日本語の変換中も打ち消す
 * - Ctrl+Shift+D（すべてのタブをブックマーク）など、ほかのキーは触らない
 * - 埋め込みの枠（iframe）の中にカーソルがあるときも止めるため、@noframes は付けない
 *
 * 止められないページ（ユーザースクリプトが動かないため）:
 *   新しいタブ、chrome:// のページ、Chrome ウェブストア、PDF ビューア、
 *   ページの読み込みが始まる前の一瞬
 */

(function () {
    'use strict';

    // ============================================================
    // 設定
    // ============================================================

    const VERSION = '1.0.0';

    /*
     * 打ち消すキー。
     * code は KeyboardEvent.code（キー配列に左右されない物理キー。D なら 'KeyD'）
     */
    const SHORTCUT = {
        code: 'KeyD',
        ctrl: true,
        alt: false,
        shift: false,
        meta: false
    };


    // ============================================================
    // 状態（診断用）
    // ============================================================

    let blockedCount = 0;

    let lastBlockedAt = null;

    let lastBlockedTarget = '';


    // ============================================================
    // キー
    // ============================================================

    function matchesShortcut(event, shortcut) {

        return event.code === shortcut.code &&
            event.ctrlKey === shortcut.ctrl &&
            event.altKey === shortcut.alt &&
            event.shiftKey === shortcut.shift &&
            event.metaKey === shortcut.meta;
    }


    function describe(element) {

        if (!element || !element.tagName) {
            return '（なし）';
        }


        const id = element.id ? '#' + element.id : '';

        return element.tagName.toLowerCase() + id;
    }


    function onKeyDown(event) {

        if (!matchesShortcut(event, SHORTCUT)) {
            return;
        }


        // 既定動作（ブックマークに追加）だけを止め、サイト側には渡す
        event.preventDefault();


        blockedCount += 1;

        lastBlockedAt = new Date();

        lastBlockedTarget = describe(event.target);
    }


    // ============================================================
    // 診断
    // ============================================================

    function dump() {

        const row = {
            'バージョン': VERSION,
            'ページ': location.href,
            '枠の中': window !== window.top,
            '打ち消した回数': blockedCount,
            '最後に打ち消した時刻': lastBlockedAt ? lastBlockedAt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '（まだ無い）',
            '最後のキーの宛先': lastBlockedTarget || '（まだ無い）'
        };

        console.table([row]);

        return row;
    }


    // ============================================================
    // 起動
    // ============================================================

    // window のキャプチャで、サイトより先に受け取る
    window.addEventListener('keydown', onKeyDown, true);

    window.__tmBlockCtrlD = {
        version: VERSION,
        dump
    };
})();
