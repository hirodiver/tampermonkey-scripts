// ==UserScript==
// @name         X タブ別アカウント v1.0.0
// @namespace    local.hiro.tools
// @version      1.0.0
// @description  X のアカウントをタブごとに覚え、タブを開き直したときにそのアカウントとページへ戻す（擬似的に複数アカウントを同時に使う。デスクトップの Chrome 向け）
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-end
// @noframes
// @grant        none
// @homepageURL  https://github.com/hirodiver/tampermonkey-scripts
// @supportURL   https://github.com/hirodiver/tampermonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-tab-account.user.js
// @updateURL    https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-tab-account.user.js
// ==/UserScript==

/*
 * X のログイン中のアカウントは、ブラウザの全タブで1つしかない（Cookie が共通）。
 * このスクリプトは、タブごとに「そのタブで使っていたアカウントとページ」を覚え、
 * タブを開き直した（前面に出した）ときに、そのアカウントへ切り替えてページも戻す。
 *
 *   タブA（@alice で閲覧） → タブB で @bob に切替 → タブA を開くと @alice に戻る
 *
 * 切替そのものは X 本体の切替メニュー（左下のアカウントボタン）を代わりに押して行う。
 * 非公式APIは叩かない。x-account-switcher.user.js（ドック）とは独立して動く。
 *
 * ■ 覚える場所
 *   タブごと（sessionStorage）: そのタブのアカウントとページ
 *   全タブ共通（localStorage）: いまブラウザで有効なアカウント
 *
 * ■ 別タブで切り替えた後のタブは、表示が古い
 *   タブA の画面は @alice のまま残るが、実際は @bob でログインしている。
 *   この状態で X の切替メニューを開くと @alice が「現在」扱いで押せないので、
 *   いったん読み込み直して表示を実際のアカウントに揃えてから切り替える。
 *   そのため、戻すときは最大3回ページが読み込まれる（読み込み直し → 切替 → 元のページ）
 *
 * ■ 裏のタブでは切り替えない
 *   前面のタブで作業中に、裏のタブが勝手にアカウントを変えると、前面のタブは
 *   表示が古いまま別アカウントになり、誤って別アカウントで投稿しかねない。
 *   切り替えるのは、タブが前面にあり、かつ入力を受け付けている（フォーカスがある）間だけ
 *
 * ■ 診断
 *   コンソールで __tmXTabAccount.dump() を実行すると、覚えている内容と直近の記録が出る。
 *   __tmXTabAccount.forget() でこのタブの記憶を消す（いまのアカウントで覚え直す）
 */

(function () {
    'use strict';

    // ============================================================
    // 設定
    // ============================================================

    const VERSION = '1.0.0';

    // 自作要素の id（トースト）
    const ROOT_ID = 'tm-x-tabacct-root';

    // 二重起動よけの印（<html> の data 属性）
    const BOOT_FLAG = 'tmXTabAccount';

    // 全タブ共通: いまブラウザで有効なアカウント { handle, at }
    const STORAGE_ACTIVE = 'tm-x-tabacct-active';

    // タブごと: このタブのアカウントとページ { handle, url, at }
    const SESSION_TAB = 'tm-x-tabacct-tab';

    // タブごと: 戻している途中の印 { handle, url, step, at }
    const SESSION_RESTORE = 'tm-x-tabacct-restore';

    // タブごと: 読み込み直した後に出す知らせ
    const SESSION_NOTICE = 'tm-x-tabacct-notice';

    // タブごと: 診断の記録（再読み込みしても残す）
    const SESSION_LOG = 'tm-x-tabacct-log';

    // 起動時に、現在のアカウントが画面に出るまで待つ上限（ミリ秒）
    const DETECT_WAIT_MS = 8000;

    // 切替メニューの項目が出るまで待つ上限（ミリ秒）
    const MENU_WAIT_MS = 5000;

    // 切替先を押したあと、確認シートが出るのを待つ上限（ミリ秒）
    const CONFIRM_WAIT_MS = 1200;

    // 切替先を押したあと、再読み込みか表示の切り替わりを待つ上限（ミリ秒）
    const RELOAD_TIMEOUT_MS = 8000;

    // 戻している途中の印を有効とみなす期間（ミリ秒）。これより古い印は捨てる
    const RESTORE_MAX_AGE_MS = 60 * 1000;

    // 読み込み直した直後、フォーカスが戻るのを待つ上限（ミリ秒）
    const ACTIVE_WAIT_MS = 1000;

    // 待つ間の確認間隔（ミリ秒）
    const POLL_MS = 100;

    // DOM変化後の再処理までの待ち時間（ミリ秒）
    const CHECK_DELAY = 300;

    // タブを前面に出したあと、確かめるまでの待ち時間（ミリ秒）
    // visibilitychange と focus が続けて来るので、1回にまとめる
    const ACTIVATE_DELAY = 150;

    // トーストの表示時間（ミリ秒）
    const TOAST_MS = 2500;

    // 失敗の知らせの表示時間（ミリ秒）
    const FAILURE_TOAST_MS = 8000;

    // 記録を何件残すか（診断用）
    const LOG_MAX = 40;

    // 現在のアカウントを示すプロフィールへのリンク（デスクトップ幅の左のメニュー）
    const PROFILE_LINK_SELECTORS = [
        'a[data-testid="AppTabBar_Profile_Link"]'
    ];

    /*
     * 切替メニューを開くボタン（デスクトップ幅の左下）。
     * testid は当たれば儲けもの。aria-label も並べておく
     */
    const MENU_OPENER_SELECTORS = [
        '[data-testid="SideNav_AccountSwitcher_Button"]',
        'button[aria-label="アカウントメニュー"]',
        'button[aria-label="Account menu"]',
        '[role="button"][aria-label="アカウントメニュー"]',
        '[role="button"][aria-label="Account menu"]'
    ];

    /*
     * X のメニュー・シートが描かれる場所（上から順に試す）。
     * 見つからないときは dialog / menu を直接探す
     */
    const LAYER_SELECTORS = [
        '#layers'
    ];

    const LAYER_FALLBACK_SELECTORS = [
        '[role="dialog"]',
        '[role="menu"]',
        '[aria-modal="true"]'
    ];

    // 重なり層に常に居るもの（モバイル幅の上下のバー等）。切替先を探すときは除く
    const PERSISTENT_SELECTORS = [
        '[data-testid="TopNavBar"]',
        '[data-testid="BottomBar"]',
        '[data-testid="FloatingActionButtonBase"]',
        'aside[role="complementary"]'
    ];

    // 押せる要素
    const CLICKABLE_SELECTOR = [
        '[role="button"]',
        '[role="menuitem"]',
        '[role="menuitemradio"]',
        '[role="link"]',
        'button',
        'a[href]'
    ].join(',');

    /*
     * 切替メニューの中の、アカウントそのものを指す項目（x-account-switcher の実機診断で確認）。
     * /account/switch のページでは、現在のアカウントは押せない li、他は button
     */
    const ACCOUNT_ITEM_SELECTOR = '[data-testid="AccountSwitcher_Switch_Button"]';

    // アカウントではない項目（アカウント追加・ログアウト等）
    const NOT_ACCOUNT_TEXT =
        /既存のアカウントを追加|アカウントを管理|新しいアカウントを作成|ログアウト|すべてのアカウントを表示|Add an existing account|Manage accounts|Create a new account|Log out|Show all accounts/i;

    const NOT_ACCOUNT_HREFS = [
        '/i/flow/login',
        '/i/flow/signup',
        '/logout',
        '/account/add',
        '/account/switch'
    ];

    /*
     * メニューに切替先が出ていないとき（アカウントが多い等）に開く、
     * アカウント一覧のページへのリンク
     */
    const SWITCH_PAGE_LINK_SELECTORS = [
        'a[data-testid="switcher"]',
        'a[href="/account/switch"]'
    ];

    // アカウント一覧が独立したページとして開く場合のパス
    const SWITCH_PAGE_PATTERN = /^\/account\/switch\/?$/;

    // 切替後の確認シートの「はい」
    const CONFIRM_SELECTORS = [
        '[data-testid="confirmationSheetConfirm"]'
    ];

    // 何もしない・ページとして覚えないパス（ログイン・ログアウトの流れ、切替の一覧）
    const IGNORED_PATHS = [
        /^\/i\/flow\//,
        /^\/login/,
        /^\/logout/,
        /^\/account\//
    ];

    // X のユーザー名（1〜15文字の英数字と _）
    const HANDLE_PATTERN = /@([A-Za-z0-9_]{1,15})/;

    // アバター
    const AVATAR_IMG_SELECTOR =
        'img[src*="profile_images"], img[src*="default_profile"]';

    const AVATAR_CONTAINER_PREFIX = 'UserAvatar-Container-';

    // アバターの testid に入る、ハンドルではない値（実機で確認）
    const PLACEHOLDER_HANDLES = [
        'unknown'
    ];

    // プロフィールへのリンクに出ても、ハンドルではないパス
    const RESERVED_PATHS = [
        'i',
        'home',
        'explore',
        'notifications',
        'messages',
        'settings',
        'search'
    ];


    // ============================================================
    // 状態
    // ============================================================

    // このページで最後に画面から読んだアカウント（小文字）
    let pageAccount = '';

    // 戻している途中か（この間はタブの記憶を書き換えない）
    let restoring = false;

    let checkTimer = null;
    let activateTimer = null;
    let toastTimer = null;

    let root = null;
    let toastEl = null;

    const logEntries = [];


    // ============================================================
    // 小物
    // ============================================================

    function sleep(ms) {

        return new Promise(resolve => setTimeout(resolve, ms));
    }


    async function waitFor(find, timeout) {

        const deadline = Date.now() + timeout;


        for (;;) {

            const found = find();

            if (found) {
                return found;
            }


            if (Date.now() >= deadline) {
                return null;
            }


            await sleep(POLL_MS);
        }
    }


    function textOf(element) {

        return (element.textContent || '')
            .replace(/\s+/g, ' ')
            .trim();
    }


    function isVisible(element) {

        if (!element || !element.isConnected) {
            return false;
        }


        const rect = element.getBoundingClientRect();

        return rect.width > 0 && rect.height > 0;
    }


    function queryFirst(selectors, scope) {

        for (const selector of selectors) {

            const found =
                (scope || document).querySelector(selector);

            if (found) {
                return found;
            }
        }


        return null;
    }


    function normalizeHandle(handle) {

        return String(handle || '')
            .replace(/^@/, '')
            .toLowerCase();
    }


    // ページの場所（パスとクエリ）。ハッシュは覚えない
    function currentUrl() {

        return location.pathname + location.search;
    }


    function isIgnoredPath(path) {

        const pathname = String(path || '').split('?')[0];

        return IGNORED_PATHS.some(pattern => pattern.test(pathname));
    }


    /*
     * このタブが「使われている」か。
     * 前面にあり、かつフォーカスがある（2つのウインドウを並べていても、
     * 操作している側だけが当たる）
     */
    function isActiveTab() {

        return document.visibilityState === 'visible' && document.hasFocus();
    }


    function log(step, detail) {

        logEntries.push({
            時刻: new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' }),

            ページ: location.pathname,
            段階: step,
            詳細: detail || ''
        });


        while (logEntries.length > LOG_MAX) {
            logEntries.shift();
        }


        writeJson(sessionStorage, SESSION_LOG, logEntries);
    }


    // ============================================================
    // 保存
    // ============================================================

    function readJson(storage, key, fallback) {

        try {

            const raw = storage.getItem(key);

            return raw ? JSON.parse(raw) : fallback;

        } catch {

            return fallback;
        }
    }


    function writeJson(storage, key, value) {

        try {

            storage.setItem(key, JSON.stringify(value));

        } catch {

            /*
             * 容量超過・プライベートモードなどは諦める
             */
        }
    }


    function removeKey(storage, key) {

        try {

            storage.removeItem(key);

        } catch {

            /*
             * 参照できない環境では諦める
             */
        }
    }


    // いまブラウザで有効なアカウント（全タブ共通）
    function readActive() {

        const active = readJson(localStorage, STORAGE_ACTIVE, null);

        return active && typeof active.handle === 'string' ?
            normalizeHandle(active.handle) :
            '';
    }


    function writeActive(handle) {

        if (readActive() === handle) {
            return;
        }


        writeJson(localStorage, STORAGE_ACTIVE, {
            handle,
            at: Date.now()
        });
    }


    // このタブのアカウントとページ
    function readTab() {

        const tab = readJson(sessionStorage, SESSION_TAB, null);

        if (!tab || typeof tab.handle !== 'string' || !tab.handle) {
            return null;
        }


        return {
            handle: normalizeHandle(tab.handle),
            url: typeof tab.url === 'string' ? tab.url : ''
        };
    }


    function writeTab(handle, url) {

        writeJson(sessionStorage, SESSION_TAB, {
            handle,
            url,
            at: Date.now()
        });
    }


    function readRestore() {

        const marker = readJson(sessionStorage, SESSION_RESTORE, null);

        return marker && typeof marker.handle === 'string' ?
            marker :
            null;
    }


    function writeRestore(marker) {

        writeJson(sessionStorage, SESSION_RESTORE, marker);
    }


    // ============================================================
    // 現在のアカウント（画面から読む）
    // ============================================================

    /*
     * 要素が指しているアカウントのハンドルを取る。
     *
     * 1. アバターの入れ物の testid（UserAvatar-Container-ハンドル）
     * 2. aria-label の @ハンドル
     * 3. 表示テキストの @ハンドル
     */
    function handleOf(element) {

        const container =
            element.matches(`[data-testid^="${AVATAR_CONTAINER_PREFIX}"]`) ?
                element :
                element.querySelector(`[data-testid^="${AVATAR_CONTAINER_PREFIX}"]`);

        if (container) {

            const handle =
                container.getAttribute('data-testid')
                    .slice(AVATAR_CONTAINER_PREFIX.length);

            if (
                /^[A-Za-z0-9_]{1,15}$/.test(handle) &&
                !PLACEHOLDER_HANDLES.includes(handle.toLowerCase())
            ) {
                return { handle, source: 'アバターのtestid' };
            }
        }


        const label =
            HANDLE_PATTERN.exec(element.getAttribute('aria-label') || '');

        if (label) {
            return { handle: label[1], source: 'aria-label' };
        }


        const text =
            HANDLE_PATTERN.exec(textOf(element));

        if (text) {
            return { handle: text[1], source: '表示テキスト' };
        }


        return null;
    }


    /*
     * いま画面に出ているアカウント。
     * 別タブで切り替えた後は、読み込み直すまで古い値のまま（画面が古いため）
     */
    function detectCurrent() {

        const profile = queryFirst(PROFILE_LINK_SELECTORS);

        if (profile) {

            const match =
                /^\/([A-Za-z0-9_]{1,15})(?:\/|$)/.exec(profile.getAttribute('href') || '');

            if (match && !RESERVED_PATHS.includes(match[1].toLowerCase())) {
                return { handle: normalizeHandle(match[1]), source: 'プロフィールへのリンク' };
            }
        }


        const opener = queryFirst(MENU_OPENER_SELECTORS);

        if (opener) {

            const found = handleOf(opener);

            if (found) {
                return { handle: normalizeHandle(found.handle), source: '左下のアカウントボタン（' + found.source + '）' };
            }
        }


        return null;
    }


    // ============================================================
    // X の切替メニュー
    // ============================================================

    function isSwitchPage() {

        return SWITCH_PAGE_PATTERN.test(location.pathname);
    }


    /*
     * 切替先を探す範囲。重なり層（メニュー）の中だけ。
     * タイムラインに出ている同名ユーザーを押してプロフィールへ飛ばないため。
     * アカウント一覧のページ（/account/switch）に居るときは本文も入れる
     */
    function searchRoots() {

        const roots = [];

        const layer = queryFirst(LAYER_SELECTORS);


        if (layer) {

            roots.push(layer);

        } else {

            roots.push(...document.querySelectorAll(LAYER_FALLBACK_SELECTORS.join(',')));
        }


        if (isSwitchPage()) {

            const main = document.querySelector('main');

            if (main && !roots.some(r => r.contains(main))) {
                roots.push(main);
            }
        }


        return roots;
    }


    function hasAvatar(element) {

        return !!(
            element.querySelector(AVATAR_IMG_SELECTOR) ||
            element.querySelector(`[data-testid^="${AVATAR_CONTAINER_PREFIX}"]`) ||
            element.matches(`[data-testid^="${AVATAR_CONTAINER_PREFIX}"]`)
        );
    }


    function isNotAccount(element) {

        if (element.matches(ACCOUNT_ITEM_SELECTOR)) {
            return false;
        }


        const href = element.getAttribute('href') || '';

        if (NOT_ACCOUNT_HREFS.some(path => href === path || href.startsWith(path + '?'))) {
            return true;
        }


        return NOT_ACCOUNT_TEXT.test(textOf(element));
    }


    /*
     * 押すとプロフィールへ飛ぶだけのリンク（/ハンドル）。切替には使えない
     */
    function isProfileLink(element, handle) {

        if (element.tagName !== 'A') {
            return false;
        }


        return (element.getAttribute('href') || '').toLowerCase() === '/' + handle;
    }


    /*
     * 切替先の要素を探す。
     * 「アバターと @ハンドルを持つ押せる要素」で狙い、入れ子なら外側を採る
     */
    function findTarget(handle) {

        const hits = [];


        for (const scope of searchRoots()) {

            for (const element of scope.querySelectorAll(CLICKABLE_SELECTOR + ',' + ACCOUNT_ITEM_SELECTOR)) {

                if (element.closest(`#${ROOT_ID}`)) {
                    continue;
                }


                if (element.closest(PERSISTENT_SELECTORS.join(','))) {
                    continue;
                }


                if (!hasAvatar(element) || isNotAccount(element)) {
                    continue;
                }


                const found = handleOf(element);

                if (!found || normalizeHandle(found.handle) !== handle) {
                    continue;
                }


                if (isProfileLink(element, handle) || !isVisible(element)) {
                    continue;
                }


                hits.push({ element, source: found.source });
            }
        }


        return hits.find(hit =>
            !hits.some(other => other !== hit && other.element.contains(hit.element))
        ) || null;
    }


    function findSwitchPageLink() {

        for (const scope of searchRoots()) {

            const link = queryFirst(SWITCH_PAGE_LINK_SELECTORS, scope);

            if (link && isVisible(link)) {
                return link;
            }
        }


        return null;
    }


    function findConfirm() {

        for (const scope of searchRoots()) {

            const found = queryFirst(CONFIRM_SELECTORS, scope);

            if (found && isVisible(found)) {
                return found;
            }
        }


        return null;
    }


    function closeMenus() {

        (document.activeElement || document.body).dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Escape',
                code: 'Escape',
                keyCode: 27,
                bubbles: true,
                cancelable: true
            })
        );
    }


    // ============================================================
    // タブの記憶
    // ============================================================

    /*
     * 画面から読んだアカウントを反映する（起動時と、表示が切り替わったとき）。
     *
     * 起動直後やページ内で切り替わった直後の画面は、実際のアカウントを表している。
     * これを全タブ共通の「有効なアカウント」に書く。
     *
     * このタブの記憶を書き換えるのは、このタブが前面にあり、
     * かつ「有効なアカウント」と違う値が出たとき（＝このタブで切り替えた）だけ。
     * 別タブで切り替えた後なら「有効なアカウント」は既に同じ値になっている。
     *
     * ここではフォーカスまでは見ない。切替後に X が読み込み直した直後は
     * フォーカスが一瞬外れていることがあり、見落とすと自分で切り替えたのに
     * 次にフォーカスが来たとき元のアカウントへ戻してしまう
     */
    function onAccountSeen(handle, why) {

        const before = readActive();

        const tab = readTab();


        if (!restoring) {

            if (!tab) {

                writeTab(handle, isIgnoredPath(currentUrl()) ? '' : currentUrl());

                log('このタブのアカウントを覚える', '@' + handle + '（' + why + '）');

            } else if (tab.handle !== handle && before !== handle && document.visibilityState === 'visible') {

                writeTab(handle, isIgnoredPath(currentUrl()) ? tab.url : currentUrl());

                log('このタブで切り替えた', '@' + tab.handle + ' → @' + handle + '（' + why + '）');
            }
        }


        writeActive(handle);
    }


    /*
     * このタブで見ているページを覚える。
     * 前面にある間だけ（裏のタブを X が別のページへ動かしても、それは覚えない）。
     * タブを裏に回した瞬間は force で覚える
     */
    function recordUrl(force) {

        if (restoring) {
            return;
        }


        if (!force && document.visibilityState !== 'visible') {
            return;
        }


        const tab = readTab();

        const url = currentUrl();


        if (!tab || tab.url === url || isIgnoredPath(url)) {
            return;
        }


        writeTab(tab.handle, url);
    }


    // ============================================================
    // 戻す
    // ============================================================

    /*
     * タブを前面に出したとき・起動したときに確かめる。
     * このタブのアカウントが、いま有効なアカウントと違えば戻す
     */
    function checkTab(why) {

        if (restoring || !isActiveTab() || isIgnoredPath(currentUrl())) {
            return;
        }


        const tab = readTab();

        const active = readActive();


        if (!tab || !active || tab.handle === active) {
            return;
        }


        startRestore(tab, active, why);
    }


    function startRestore(tab, active, why) {

        restoring = true;

        const marker = {
            handle: tab.handle,
            url: tab.url || '/home',
            step: 'reload',
            at: Date.now()
        };


        log('戻し始める', '@' + active + ' → @' + tab.handle + ' / ' + marker.url + '（' + why + '）');

        toast('このタブのアカウント @' + tab.handle + ' に戻しています…');


        const shown = detectCurrent();


        /*
         * 画面が有効なアカウントと食い違っていれば、画面が古い（別タブで切り替えた後）。
         * 古い画面の切替メニューでは戻したいアカウントが「現在」扱いで押せないので、
         * 読み込み直して表示を揃えてから切り替える
         */
        if (!shown || shown.handle !== active) {

            log('画面が古いので読み込み直す', '画面: @' + (shown ? shown.handle : '不明') + ' / 有効: @' + active);

            writeRestore(marker);

            reloadTo(marker.url);

            return;
        }


        switchBack(marker);
    }


    /*
     * 起動時: 戻している途中なら続ける。続けたら true
     */
    async function continueRestore(marker, shown) {

        if (Date.now() - (marker.at || 0) > RESTORE_MAX_AGE_MS) {

            log('古い印を捨てる', marker.step);

            removeKey(sessionStorage, SESSION_RESTORE);

            return false;
        }


        /*
         * 途中で別のタブへ移った（裏に回った）なら、ここでは切り替えない。
         * 次に前面に出したときに、初めからやり直す
         */
        if (!await waitFor(isActiveTab, ACTIVE_WAIT_MS)) {

            log('裏に回ったので中断する', marker.step);

            removeKey(sessionStorage, SESSION_RESTORE);

            return false;
        }


        restoring = true;

        toast('このタブのアカウント @' + marker.handle + ' に戻しています…');


        if (shown.handle === marker.handle) {

            finishRestore(marker);

            return true;
        }


        if (marker.step === 'switched') {

            failRestore(marker, '切り替えた後も @' + shown.handle + ' のまま');

            return true;
        }


        await switchBack(marker);

        return true;
    }


    /*
     * X の切替メニューを開いて、覚えていたアカウントを押す
     */
    async function switchBack(marker) {

        marker.step = 'switch';

        writeRestore(marker);


        const opener = queryFirst(MENU_OPENER_SELECTORS);

        if (!opener || !isVisible(opener)) {

            failRestore(marker, '左下のアカウントボタンが見つからない（ウインドウが狭いと出ない）');

            return;
        }


        log('切替メニューを開く');

        opener.click();


        const shown =
            await waitFor(
                () => findTarget(marker.handle) || findSwitchPageLink(),
                MENU_WAIT_MS
            );


        let target = shown && shown.element ? shown : null;


        /*
         * メニューに無いときは、アカウント一覧のページへのリンクを押す。
         * リンクが先に描かれただけのこともあるので、少し待って本命を探し直してから
         */
        if (shown && !target) {

            target = await waitFor(() => findTarget(marker.handle), POLL_MS * 3);


            if (!target) {

                log('メニューに無いので、アカウント一覧を開く');

                shown.click();

                target = await waitFor(() => findTarget(marker.handle), MENU_WAIT_MS);
            }
        }


        if (!target) {

            closeMenus();

            if (isSwitchPage()) {
                history.back();
            }

            failRestore(marker, '切替メニューに @' + marker.handle + ' が見つからない（ログアウトした？）');

            return;
        }


        /*
         * 押す直前にもう一度確かめる。待つ間に別のタブへ移っていたら切り替えない
         */
        if (!isActiveTab()) {

            closeMenus();

            log('裏に回ったので中断する', '切替先を押す前');

            removeKey(sessionStorage, SESSION_RESTORE);

            restoring = false;

            return;
        }


        marker.step = 'switched';

        writeRestore(marker);

        log('切替先を押す', '@' + marker.handle + '（' + target.source + '）');

        target.element.click();


        const confirm = await waitFor(findConfirm, CONFIRM_WAIT_MS);

        if (confirm) {

            log('確認シートを押す');

            confirm.click();
        }


        /*
         * 通常は X が読み込み直すので、ここには戻ってこない（起動時に続きをやる）。
         * 読み込み直さずに表示が切り替わった場合は、ここで仕上げる
         */
        const switched =
            await waitFor(
                () => {
                    const shown = detectCurrent();

                    return shown && shown.handle === marker.handle;
                },
                RELOAD_TIMEOUT_MS
            );


        if (switched) {

            log('読み込み直さずに切り替わった');

            finishRestore(marker);

            return;
        }


        failRestore(marker, '切り替わったことを確かめられない');
    }


    function finishRestore(marker) {

        pageAccount = marker.handle;

        writeActive(marker.handle);

        writeTab(marker.handle, marker.url);

        removeKey(sessionStorage, SESSION_RESTORE);


        const message = '@' + marker.handle + ' に戻しました';


        if (currentUrl() !== marker.url) {

            log('元のページを開く', marker.url);

            writeJson(sessionStorage, SESSION_NOTICE, message);

            location.replace(marker.url);

            return;
        }


        log('戻し終わった', '@' + marker.handle + ' / ' + marker.url);

        restoring = false;

        toast(message);
    }


    /*
     * 戻せなかったときは、このタブをいまのアカウントで覚え直す。
     * 覚えたままだと、前面に出すたびに失敗を繰り返すため
     */
    function failRestore(marker, reason) {

        log('戻せなかった', reason);

        removeKey(sessionStorage, SESSION_RESTORE);


        const shown = detectCurrent();


        if (shown) {

            pageAccount = shown.handle;

            writeActive(shown.handle);

            writeTab(shown.handle, isIgnoredPath(currentUrl()) ? marker.url : currentUrl());
        }


        restoring = false;


        toast(
            '@' + marker.handle + ' に戻せませんでした（' + reason + '）。' +
            (shown ? 'このタブは @' + shown.handle + ' のまま使います' : ''),
            FAILURE_TOAST_MS
        );
    }


    function reloadTo(url) {

        if (currentUrl() === url) {

            location.reload();

        } else {

            location.replace(url);
        }
    }


    // ============================================================
    // トースト
    // ============================================================

    function mount() {

        if (root && root.isConnected) {
            return;
        }


        root = document.createElement('div');

        root.id = ROOT_ID;


        const shadow = root.attachShadow({ mode: 'open' });

        const style = document.createElement('style');

        style.textContent = `
            .toast {
                position: fixed;
                top: 12px;
                left: 50%;
                transform: translateX(-50%);
                z-index: 2147483647;
                max-width: min(560px, calc(100vw - 32px));
                padding: 10px 16px;
                border-radius: 8px;
                background: rgba(15, 20, 25, 0.92);
                color: #fff;
                font: 14px/1.5 -apple-system, "Segoe UI", "Hiragino Sans", "Meiryo", sans-serif;
                box-shadow: 0 2px 12px rgba(0, 0, 0, 0.3);
                pointer-events: none;
                opacity: 0;
                transition: opacity 0.2s;
            }

            .toast.show {
                opacity: 1;
            }
        `;


        toastEl = document.createElement('div');

        toastEl.className = 'toast';

        toastEl.setAttribute('role', 'status');


        shadow.append(style, toastEl);

        document.body.appendChild(root);
    }


    function toast(message, duration) {

        mount();

        toastEl.textContent = message;

        toastEl.classList.add('show');


        clearTimeout(toastTimer);

        toastTimer =
            setTimeout(
                () => toastEl.classList.remove('show'),
                duration || TOAST_MS
            );
    }


    // ============================================================
    // 監視
    // ============================================================

    /*
     * DOM が変わったら: 表示のアカウントが変わったか・ページが移ったかを見る
     */
    function scheduleCheck() {

        clearTimeout(checkTimer);


        checkTimer =
            setTimeout(
                () => {

                    const shown = detectCurrent();


                    if (shown && pageAccount && shown.handle !== pageAccount) {

                        pageAccount = shown.handle;

                        onAccountSeen(shown.handle, '表示が切り替わった');
                    }


                    recordUrl(false);
                },
                CHECK_DELAY
            );
    }


    function scheduleActivate(why) {

        clearTimeout(activateTimer);


        activateTimer =
            setTimeout(
                () => checkTab(why),
                ACTIVATE_DELAY
            );
    }


    function startObserver() {

        /*
         * 自作のトーストは Shadow DOM の中なので、ここには変更が上がってこない
         */
        new MutationObserver(scheduleCheck)
            .observe(
                document.body,
                {
                    childList: true,
                    subtree: true
                }
            );


        window.addEventListener('popstate', () => scheduleCheck());


        document.addEventListener('visibilitychange', () => {

            if (document.visibilityState === 'hidden') {

                /*
                 * 裏に回る瞬間のページを覚える
                 */
                recordUrl(true);

                return;
            }


            scheduleActivate('タブを前面に出した');
        });


        window.addEventListener('focus', () => scheduleActivate('ウインドウに戻った'));


        window.addEventListener('pageshow', event => {

            if (event.persisted) {
                scheduleActivate('戻る・進むで表示した');
            }
        });


        window.addEventListener('pagehide', () => recordUrl(true));
    }


    // ============================================================
    // 診断
    // ============================================================

    function buildReport() {

        const tab = readTab();

        const shown = detectCurrent();

        const marker = readRestore();


        const lines = [
            '=== X タブ別アカウント 診断 ===',
            'バージョン: ' + VERSION + ' / ページ: ' + currentUrl(),
            '',
            '■ このタブのアカウント: ' + (tab ? '@' + tab.handle + ' / ページ: ' + (tab.url || '（なし）') : '（未記憶）'),
            '■ 有効なアカウント（全タブ共通）: ' + (readActive() ? '@' + readActive() : '（なし）'),
            '■ 画面のアカウント: ' + (shown ? '@' + shown.handle + '（' + shown.source + '）' : '取得できない'),
            '■ 前面・フォーカス: ' + document.visibilityState + ' / ' + (document.hasFocus() ? 'あり' : 'なし'),
            '■ 戻している途中: ' + (marker ? '@' + marker.handle + ' / ' + marker.step : 'いいえ') + (restoring ? '（処理中）' : ''),
            '',
            '■ 直近の記録'
        ];


        if (!logEntries.length) {
            lines.push('  （なし）');
        }


        for (const entry of logEntries) {

            lines.push(
                '  ' + entry.時刻 +
                ' [' + entry.ページ + '] ' +
                entry.段階 +
                (entry.詳細 ? ': ' + entry.詳細 : '')
            );
        }


        return lines.join('\n');
    }


    function exposeApi() {

        try {

            window.__tmXTabAccount = {

                version: VERSION,

                dump() {

                    const report = buildReport();

                    console.log(report);

                    console.table([{
                        このタブ: readTab() ? '@' + readTab().handle : '',
                        ページ: readTab() ? readTab().url : '',
                        有効なアカウント: readActive() ? '@' + readActive() : '',
                        画面: detectCurrent() ? '@' + detectCurrent().handle : '',
                        途中: readRestore() ? readRestore().step : ''
                    }]);


                    return report;
                },

                state() {

                    return {
                        tab: readTab(),
                        active: readActive(),
                        shown: detectCurrent(),
                        restore: readRestore(),
                        restoring
                    };
                },

                forget() {

                    removeKey(sessionStorage, SESSION_TAB);

                    removeKey(sessionStorage, SESSION_RESTORE);

                    const shown = detectCurrent();

                    if (shown) {
                        onAccountSeen(shown.handle, '覚え直し');
                    }
                }
            };

        } catch {

            /*
             * 参照できない環境では諦める
             */
        }
    }


    // ============================================================
    // 起動
    // ============================================================

    async function init() {

        const notice = readJson(sessionStorage, SESSION_NOTICE, '');

        if (notice) {

            removeKey(sessionStorage, SESSION_NOTICE);

            toast(notice);
        }


        const marker = readRestore();


        if (isIgnoredPath(currentUrl()) && !marker) {
            return;
        }


        const shown = await waitFor(detectCurrent, DETECT_WAIT_MS);


        if (!shown) {

            /*
             * ログアウト中や、狭いウインドウ（左のメニューが無い）など
             */
            if (marker) {

                removeKey(sessionStorage, SESSION_RESTORE);

                log('戻せなかった', '画面から現在のアカウントを読めない');

                toast('@' + marker.handle + ' に戻せませんでした（現在のアカウントが読めない）', FAILURE_TOAST_MS);
            }


            return;
        }


        pageAccount = shown.handle;


        if (marker && await continueRestore(marker, shown)) {
            return;
        }


        onAccountSeen(shown.handle, '起動');

        recordUrl(false);

        checkTab('起動');
    }


    function boot() {

        const html = document.documentElement;

        if (html.dataset[BOOT_FLAG]) {
            return;
        }


        html.dataset[BOOT_FLAG] = VERSION;


        const savedLog = readJson(sessionStorage, SESSION_LOG, []);

        if (Array.isArray(savedLog)) {
            logEntries.push(...savedLog.slice(-LOG_MAX));
        }


        exposeApi();

        startObserver();

        init();
    }


    if (document.body) {

        boot();

    } else {

        document.addEventListener('DOMContentLoaded', boot, { once: true });
    }

})();
