// ==UserScript==
// @name         X アカウント切替 v1.0.0
// @namespace    local.hiro.tools
// @version      1.0.0
// @description  X のアカウント切替を、画面端のアイコンからワンタップで行う（X 本体の切替メニューを代わりに操作する。非公式APIは使わない）
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-end
// @noframes
// @grant        none
// @homepageURL  https://github.com/hirodiver/tampermonkey-scripts
// @supportURL   https://github.com/hirodiver/tampermonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-account-switcher.user.js
// @updateURL    https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-account-switcher.user.js
// ==/UserScript==

/*
 * 画面端に、ログイン中のアカウントのアイコンを並べた小さな帯（ドック）を出す。
 * アイコンを押すと、X 本体の切替メニューを開いて該当アカウントを押す。
 * 切替そのものは X 本体が行うので、非公式APIは叩かない。
 *
 * Grok が作った「TapShift」を元に、次の点を作り直したもの:
 *
 *   - アカウント一覧は「X の切替メニューの中」からだけ覚える。
 *     元版はページ全体の UserCell / menuitem を拾っていたため、
 *     フォロワー一覧やおすすめユーザー、ポストの「…」メニュー
 *     （「@xxxさんをフォロー」）の相手まで自分のアカウントとして登録していた
 *   - 切替先の探索も X の重なり層（#layers。メニュー・ドロワー・シートが
 *     描かれる場所）の中に限る。タイムラインに出ている同名ユーザーを
 *     押してプロフィールへ飛ぶことがない
 *   - innerHTML を使わない（Trusted Types で例外になるため）
 *   - 切替後にページが再読み込みされなかった場合も、ボタンが押せないまま
 *     固まらないようにする
 *   - 初回に勝手にドロワーを開かない（読み込みはメニューから手動）
 *
 * ■ 未確認の点
 *   iPhone の X（モバイル版ウェブ）のドロワーと、アカウント一覧シートの
 *   実際の DOM は確認できていない。testid ではなく
 *   「アバターと @ハンドルを持つ、押せる要素」「アカウント追加・ログアウトの
 *   リンクと同じ入れ物にある」という構造で狙っている。
 *
 * ■ 診断（iPhone でも使える）
 *   URL の末尾に #tmswitch を付けて開くと、画面下に診断パネルが出る。
 *   （例: https://x.com/home#tmswitch ）
 *   そのまま X の切替メニュー（左上のアイコン → アカウント一覧）を開いてから
 *   「コピー」を押すと、メニューの構造と直近の切替の記録が取れる。
 *   コンソールが使える環境なら __tmXSwitch.dump() でも同じものが出る。
 */

(function () {
    'use strict';

    // ============================================================
    // 設定
    // ============================================================

    const VERSION = '1.0.0';

    // 自作要素の id
    const ROOT_ID = 'tm-x-switch-root';

    const PANEL_ID = 'tm-x-switch-panel';

    // 保存キー（localStorage: 端末に残す / sessionStorage: タブ単位）
    const STORAGE_ACCOUNTS = 'tm-x-switch-accounts';

    const STORAGE_POSITION = 'tm-x-switch-position';

    const STORAGE_COLLAPSED = 'tm-x-switch-collapsed';

    const SESSION_HIDDEN = 'tm-x-switch-hidden';

    const SESSION_RETURN = 'tm-x-switch-return';

    // ドックの置き場所。先頭が既定
    const POSITIONS = [
        { key: 'left-bottom', label: '左下' },
        { key: 'right-bottom', label: '右下' },
        { key: 'left-top', label: '左上' },
        { key: 'right-top', label: '右上' }
    ];

    // DOM変化後の再処理までの待ち時間（ミリ秒）
    const CHECK_DELAY = 250;

    // 切替メニューの項目が出るまで待つ上限（ミリ秒）
    const MENU_WAIT_MS = 3000;

    // 待つ間の確認間隔（ミリ秒）
    const POLL_MS = 100;

    // 切替先を押したあと、確認シートが出るのを待つ上限（ミリ秒）
    const CONFIRM_WAIT_MS = 1200;

    // 切替先を押したあと、再読み込みが起きるのを待つ上限（ミリ秒）
    // これを過ぎても同じページに居たら、成否を確かめてボタンを戻す
    const RELOAD_TIMEOUT_MS = 8000;

    // 切替後に元のページへ戻す。false ならホームのまま
    const RETURN_TO_PREVIOUS_PAGE = true;

    // 切替前のページを覚えておく期間（ミリ秒）。これより古い記録は捨てる
    const RETURN_MAX_AGE_MS = 60 * 1000;

    // トーストの表示時間（ミリ秒）
    const TOAST_MS = 2200;

    // 切替の記録を何件残すか（診断用）
    const SWITCH_LOG_MAX = 40;

    // 診断パネル
    const DIAGNOSTIC_HASH = 'tmswitch';

    // 診断パネルを開いている間の更新間隔（ミリ秒）
    const PANEL_REFRESH_MS = 1500;

    // 重なり層の構造を記録する行数の上限（診断用）
    const SNAPSHOT_MAX_LINES = 160;

    /*
     * X のメニュー・ドロワー・シートが描かれる場所（上から順に試す）。
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

    /*
     * 切替メニューを直接開くボタン（デスクトップ幅の左下）。
     * testid は当たれば儲けもの。aria-label も並べておく
     */
    const MENU_OPENER_SELECTORS = [
        '[data-testid="SideNav_AccountSwitcher_Button"]',
        'button[aria-label="アカウントメニュー"]',
        'button[aria-label="Account menu"]'
    ];

    /*
     * ドロワーを開くボタン（モバイル幅の左上のアイコン）。
     * 当たらなければ、画面上端にある「自分のアバターを含む押せる要素」を使う
     */
    const DRAWER_OPENER_SELECTORS = [
        '[data-testid="DashButton_ProfileIcon_Link"]'
    ];

    // 構造で探すときの「画面上端」の範囲（px）
    const DRAWER_OPENER_MAX_TOP = 90;

    // 現在のアカウントを示すプロフィールへのリンク
    const PROFILE_LINK_SELECTORS = [
        'a[data-testid="AppTabBar_Profile_Link"]'
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
     * 切替メニューの目印。
     * これを含む入れ物だけを「アカウントの切替UI」と見なして一覧を覚える
     */
    const MARKER_HREFS = [
        '/i/flow/login',
        '/i/flow/signup',
        '/logout',
        '/account/add',
        '/account/switch'
    ];

    const MARKER_TEXT =
        /既存のアカウントを追加|アカウントを管理|新しいアカウントを作成|ログアウト|Add an existing account|Manage accounts|Create a new account|Log out/i;

    // 上の目印のうち「一覧がすべて出ている」ことを示すもの（アカウント追加）
    const FULL_LIST_HREFS = [
        '/i/flow/login',
        '/account/add'
    ];

    const FULL_LIST_TEXT =
        /既存のアカウントを追加|Add an existing account/i;

    // ドロワーの中の「アカウント一覧を開く」ボタン（aria-label の部分一致）
    const MORE_ACCOUNTS_LABEL =
        /アカウント|account/i;

    // アカウント一覧が独立したページとして開く場合のパス
    const SWITCH_PAGE_PATTERN = /^\/account\/switch\/?$/;

    // 切替後の確認シートの「はい」
    const CONFIRM_SELECTORS = [
        '[data-testid="confirmationSheetConfirm"]'
    ];

    // 開いたメニューやドロワーを閉じる要素（重なり層の中だけで探す）
    const CLOSE_SELECTORS = [
        '[data-testid="mask"]',
        '[data-testid="app-bar-close"]',
        '[aria-label="閉じる"]',
        '[aria-label="Close"]'
    ];

    // ドックを出さないページ（ログイン・ログアウトの流れ）
    const HIDDEN_PATHS = [
        /^\/i\/flow\//,
        /^\/login/,
        /^\/logout/,
        /^\/account\/(add|access)/
    ];

    // X のユーザー名（1〜15文字の英数字と _）
    const HANDLE_PATTERN = /@([A-Za-z0-9_]{1,15})/;

    // アバター画像
    const AVATAR_IMG_SELECTOR =
        'img[src*="profile_images"], img[src*="default_profile"]';

    const AVATAR_CONTAINER_PREFIX = 'UserAvatar-Container-';


    // ============================================================
    // 状態
    // ============================================================

    let root = null;
    let dock = null;
    let listEl = null;
    let menuEl = null;
    let toastEl = null;

    let busy = false;
    let checkTimer = null;
    let toastTimer = null;
    let reloadTimer = null;
    let panelTimer = null;

    let renderedSignature = '';

    const switchLog = [];

    let lastSnapshot = null;


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


    function biggerAvatar(url) {

        return String(url || '')
            .replace(/_(normal|mini|reasonably_small)(\.|$)/, '_bigger$2');
    }


    function log(step, detail) {

        switchLog.push({
            時刻: new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' }),
            段階: step,
            詳細: detail || ''
        });


        if (switchLog.length > SWITCH_LOG_MAX) {
            switchLog.shift();
        }
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


    function loadAccounts() {

        const list = readJson(localStorage, STORAGE_ACCOUNTS, []);

        if (!Array.isArray(list)) {
            return [];
        }


        return list.filter(
            account => account && typeof account.screenName === 'string' && account.screenName
        );
    }


    function saveAccounts(list) {

        writeJson(localStorage, STORAGE_ACCOUNTS, list);
    }


    function getPosition() {

        const saved = readJson(localStorage, STORAGE_POSITION, '');

        return POSITIONS.some(p => p.key === saved) ?
            saved :
            POSITIONS[0].key;
    }


    function isCollapsed() {

        return readJson(localStorage, STORAGE_COLLAPSED, false) === true;
    }


    // ============================================================
    // アカウントの読み取り
    // ============================================================

    /*
     * 要素が指しているアカウントのハンドルを取る。
     *
     * 1. アバターの入れ物の testid（UserAvatar-Container-ハンドル）
     * 2. aria-label の @ハンドル
     * 3. 表示テキストの @ハンドル
     *
     * ドロワーの「他のアカウント」はアバターだけで文字を持たないことがあるため、
     * テキストより先に 1・2 を見る
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

            if (/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
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


    function avatarOf(element) {

        const img = element.querySelector(AVATAR_IMG_SELECTOR);

        return img ? biggerAvatar(img.getAttribute('src')) : '';
    }


    function hasAvatar(element) {

        return !!(
            element.querySelector(AVATAR_IMG_SELECTOR) ||
            element.querySelector(`[data-testid^="${AVATAR_CONTAINER_PREFIX}"]`) ||
            element.matches(`[data-testid^="${AVATAR_CONTAINER_PREFIX}"]`)
        );
    }


    function nameOf(element, handle) {

        const text = textOf(element);

        const at = text.toLowerCase().indexOf('@' + handle.toLowerCase());

        const name = at > 0 ? text.slice(0, at).trim() : '';

        return name || handle;
    }


    /*
     * 現在ログインしているアカウント。
     * 取れた経路も返す（診断用）
     */
    function currentAccount() {

        const profile = queryFirst(PROFILE_LINK_SELECTORS);

        if (profile) {

            const match =
                /^\/([A-Za-z0-9_]{1,15})(?:\/|$)/.exec(profile.getAttribute('href') || '');

            if (match && !['i', 'home', 'explore'].includes(match[1])) {
                return { handle: match[1], source: 'プロフィールへのリンク' };
            }
        }


        for (const opener of [queryFirst(MENU_OPENER_SELECTORS), findDrawerOpener()]) {

            if (!opener) {
                continue;
            }


            const found = handleOf(opener);

            if (found) {
                return { handle: found.handle, source: '切替ボタン（' + found.source + '）' };
            }
        }


        return null;
    }


    function currentHandle() {

        const current = currentAccount();

        return current ? normalizeHandle(current.handle) : '';
    }


    // ============================================================
    // X の重なり層（メニュー・ドロワー・シート）
    // ============================================================

    /*
     * アカウント一覧が重なり層ではなく独立したページ（/account/switch）として
     * 開く場合に備え、そのページに居る間は本文も探す対象に入れる
     */
    function isSwitchPage() {

        return SWITCH_PAGE_PATTERN.test(location.pathname);
    }


    function layerRoots() {

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


    function isMarker(element) {

        const href = element.getAttribute('href') || '';

        if (MARKER_HREFS.some(path => href === path || href.startsWith(path + '?'))) {
            return true;
        }


        const testid = element.getAttribute('data-testid') || '';

        if (/^AccountSwitcher_/.test(testid)) {
            return true;
        }


        return MARKER_TEXT.test(textOf(element));
    }


    function isFullListMarker(element) {

        const href = element.getAttribute('href') || '';

        if (FULL_LIST_HREFS.some(path => href === path || href.startsWith(path + '?'))) {
            return true;
        }


        return FULL_LIST_TEXT.test(textOf(element));
    }


    /*
     * 押すとプロフィールへ飛ぶだけのリンク（/ハンドル）。
     * ドロワーの自分のアイコンなど。切替には使えない
     */
    function isProfileLink(element, handle) {

        if (element.tagName !== 'A') {
            return false;
        }


        const href = (element.getAttribute('href') || '').toLowerCase();

        return href === '/' + handle.toLowerCase();
    }


    /*
     * 入れ物の中の「アカウントを指す押せる要素」を集める。
     * 同じアカウントを指す要素が入れ子になっていたら外側を採る
     */
    function accountEntries(scope) {

        const entries = [];


        for (const element of scope.querySelectorAll(CLICKABLE_SELECTOR)) {

            if (element.closest(`#${ROOT_ID}, #${PANEL_ID}`)) {
                continue;
            }


            if (!hasAvatar(element)) {
                continue;
            }


            if (isMarker(element)) {
                continue;
            }


            const found = handleOf(element);

            if (!found) {
                continue;
            }


            if (isProfileLink(element, found.handle)) {
                continue;
            }


            entries.push({
                element,
                handle: found.handle,
                source: found.source
            });
        }


        return entries.filter(entry =>
            !entries.some(other =>
                other !== entry &&
                normalizeHandle(other.handle) === normalizeHandle(entry.handle) &&
                other.element.contains(entry.element)
            )
        );
    }


    /*
     * 目印（アカウント追加・ログアウト）を含む入れ物を探す。
     * 入れ物 = 目印の最も近い menu / dialog。無ければ重なり層の直下の子
     */
    function switcherContexts() {

        const contexts = new Map();


        for (const layer of layerRoots()) {

            for (const marker of layer.querySelectorAll('a[href], [role="menuitem"], [role="button"], [role="link"], [data-testid^="AccountSwitcher_"]')) {

                if (!isMarker(marker)) {
                    continue;
                }


                let container =
                    marker.closest('[role="menu"], [role="dialog"], [aria-modal="true"]');

                if (!container || !layer.contains(container)) {

                    container = marker;

                    while (container.parentElement && container.parentElement !== layer) {
                        container = container.parentElement;
                    }
                }


                const context =
                    contexts.get(container) ||
                    { container, markers: [], fullList: false };

                context.markers.push(marker);

                context.fullList = context.fullList || isFullListMarker(marker);

                contexts.set(container, context);
            }
        }


        return [...contexts.values()];
    }


    /*
     * 切替先を探す。重なり層の中だけを見る（タイムラインの同名ユーザーを押さない）
     */
    function findTarget(handle) {

        const wanted = normalizeHandle(handle);


        for (const layer of layerRoots()) {

            const hit =
                accountEntries(layer)
                    .find(entry => normalizeHandle(entry.handle) === wanted && isVisible(entry.element));

            if (hit) {
                return hit;
            }
        }


        return null;
    }


    function findDrawerOpener() {

        const byTestid = queryFirst(DRAWER_OPENER_SELECTORS);

        if (byTestid) {
            return byTestid;
        }


        /*
         * 構造で探す: 画面上端にあり、アバターを含む押せる要素。
         * 重なり層の中のもの（ドロワー内の自分のアイコン等）と、
         * 投稿の中のもの（投稿者のアイコン。押すとプロフィールへ飛ぶ）は除く
         */
        const layers = layerRoots();

        for (const element of document.querySelectorAll(CLICKABLE_SELECTOR)) {

            if (layers.some(layer => layer.contains(element))) {
                continue;
            }


            if (element.closest('article, [data-testid="cellInnerDiv"], [data-testid="UserCell"]')) {
                continue;
            }


            if (!element.querySelector(AVATAR_IMG_SELECTOR)) {
                continue;
            }


            const rect = element.getBoundingClientRect();

            if (rect.width > 0 && rect.top >= 0 && rect.top < DRAWER_OPENER_MAX_TOP) {
                return element;
            }
        }


        return null;
    }


    /*
     * ドロワーの中の「アカウント一覧を開く」ボタン。
     * 切替メニューの目印を持つリンク（/account/switch 等）か、
     * aria-label に「アカウント」を含み、アカウントそのものを指していない押せる要素
     */
    function findMoreAccountsButton() {

        for (const layer of layerRoots()) {

            for (const element of layer.querySelectorAll(CLICKABLE_SELECTOR)) {

                const href = element.getAttribute('href') || '';

                if (href === '/account/switch') {
                    return element;
                }


                const label = element.getAttribute('aria-label') || '';

                if (
                    MORE_ACCOUNTS_LABEL.test(label) &&
                    !HANDLE_PATTERN.test(label) &&
                    !isFullListMarker(element) &&
                    !/ログアウト|Log out/i.test(label) &&
                    isVisible(element)
                ) {
                    return element;
                }
            }
        }


        return null;
    }


    function hasOpenLayer() {

        if (isSwitchPage()) {
            return true;
        }


        return layerRoots().some(layer =>
            layer.querySelector('[role="menu"], [role="dialog"], [aria-modal="true"]')
        );
    }


    function closeLayers() {

        /*
         * 一覧が独立したページとして開いていたら、元のページへ戻る
         */
        if (isSwitchPage()) {
            history.back();
        }


        const target = document.activeElement || document.body;

        target.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Escape',
                code: 'Escape',
                keyCode: 27,
                bubbles: true,
                cancelable: true
            })
        );


        for (const layer of layerRoots()) {

            const closer = queryFirst(CLOSE_SELECTORS, layer);

            if (closer) {
                closer.click();
            }
        }
    }


    // ============================================================
    // 一覧を覚える
    // ============================================================

    /*
     * 開いている切替メニューからアカウント一覧を読む。
     * 「既存のアカウントを追加」がある入れ物は一覧がすべて出ているので、
     * 保存済みの一覧を置き換える（ログアウトしたアカウントが残らない）。
     * それ以外は足すだけ
     */
    function harvest() {

        const contexts = switcherContexts();

        if (!contexts.length) {
            return false;
        }


        const found = [];
        let fullList = false;


        for (const context of contexts) {

            const entries = accountEntries(context.container);

            if (!entries.length) {
                continue;
            }


            fullList = fullList || context.fullList;


            for (const entry of entries) {

                found.push({
                    screenName: entry.handle,
                    name: nameOf(entry.element, entry.handle),
                    avatar: avatarOf(entry.element)
                });
            }
        }


        if (!found.length) {
            return false;
        }


        const current = currentAccount();

        if (current) {

            found.push({
                screenName: current.handle,
                name: current.handle,
                avatar: ''
            });
        }


        return remember(found, fullList);
    }


    function remember(found, replace) {

        const saved = loadAccounts();

        const byHandle = new Map();


        for (const account of found) {

            const key = normalizeHandle(account.screenName);

            const previous =
                byHandle.get(key) ||
                saved.find(s => normalizeHandle(s.screenName) === key) ||
                {};


            byHandle.set(key, {
                screenName: account.screenName || previous.screenName,
                name:
                    (account.name && account.name !== account.screenName) ?
                        account.name :
                        (previous.name || account.name),
                avatar: account.avatar || previous.avatar || ''
            });
        }


        /*
         * 並び順は保存済みを優先し、新しいものは末尾へ
         */
        const next = [];

        for (const account of saved) {

            const key = normalizeHandle(account.screenName);

            if (byHandle.has(key)) {

                next.push(byHandle.get(key));

                byHandle.delete(key);

            } else if (!replace) {

                next.push(account);
            }
        }


        next.push(...byHandle.values());


        if (JSON.stringify(next) === JSON.stringify(saved)) {
            return false;
        }


        saveAccounts(next);

        return true;
    }


    // ============================================================
    // 切替メニューを開く
    // ============================================================

    /*
     * X 本体の切替UIを開き、want() が何かを返すまで待つ。
     *
     *   デスクトップ幅: 左下のアカウントボタン → メニュー
     *   モバイル幅:     左上のアイコン → ドロワー（→ アカウント一覧）
     */
    async function openSwitcher(want) {

        const already = want();

        if (already) {

            log('既に開いている');

            return already;
        }


        const menuOpener = queryFirst(MENU_OPENER_SELECTORS);

        if (menuOpener && isVisible(menuOpener)) {

            log('メニューを開く', describe(menuOpener));

            menuOpener.click();


            const found = await waitFor(want, MENU_WAIT_MS);

            if (found) {
                return found;
            }
        }


        const drawerOpener = findDrawerOpener();

        if (!drawerOpener) {

            log('開くボタンが見つからない');

            return null;
        }


        log('ドロワーを開く', describe(drawerOpener));

        drawerOpener.click();


        const first =
            await waitFor(
                () => want() || findMoreAccountsButton(),
                MENU_WAIT_MS
            );

        if (!first) {

            log('ドロワーの中に何も見つからない');

            return null;
        }


        const direct = want();

        if (direct) {
            return direct;
        }


        log('アカウント一覧を開く', describe(first));

        first.click();


        return waitFor(want, MENU_WAIT_MS);
    }


    // ============================================================
    // 切替
    // ============================================================

    async function switchTo(account) {

        const handle = normalizeHandle(account.screenName);


        if (!handle || handle === currentHandle()) {
            return;
        }


        if (busy) {
            return;
        }


        busy = true;

        render(true);

        toast('@' + account.screenName + ' に切替中…');

        log('切替開始', '@' + account.screenName);


        writeJson(sessionStorage, SESSION_RETURN, {
            path: location.pathname + location.search,
            handle,
            at: Date.now()
        });


        try {

            const target = await openSwitcher(() => findTarget(handle));


            if (!target) {
                throw new Error('切替メニューに @' + account.screenName + ' が見つからない');
            }


            log('切替先を押す', describe(target.element) + '（' + target.source + '）');

            target.element.click();


            /*
             * 確認シートが出る場合だけ押す
             */
            const confirm =
                await waitFor(
                    () => {
                        const found = layerRoots()
                            .map(layer => queryFirst(CONFIRM_SELECTORS, layer))
                            .find(Boolean);

                        return found && isVisible(found) ? found : null;
                    },
                    CONFIRM_WAIT_MS
                );

            if (confirm) {

                log('確認シートを押す');

                confirm.click();
            }


            waitForReload(handle);

        } catch (error) {

            log('失敗', error.message);

            sessionStorage.removeItem(SESSION_RETURN);

            if (hasOpenLayer()) {
                closeLayers();
            }


            finishSwitch(
                '切り替えられませんでした。メニューの「アカウントを読み込む」で一覧を読み直してください'
            );
        }
    }


    /*
     * 通常は X がページを読み込み直すので、ここには戻ってこない。
     * 読み込み直さなかった場合は、切り替わったかを確かめてボタンを戻す
     */
    function waitForReload(handle) {

        clearTimeout(reloadTimer);


        reloadTimer =
            setTimeout(() => {

                if (currentHandle() === handle) {

                    log('再読み込みなしで切り替わった');

                    sessionStorage.removeItem(SESSION_RETURN);

                    finishSwitch('切り替えました');

                    return;
                }


                log('切替を確認できない', '現在: @' + (currentHandle() || '不明'));

                sessionStorage.removeItem(SESSION_RETURN);

                finishSwitch('切替を確認できませんでした');
            }, RELOAD_TIMEOUT_MS);
    }


    function finishSwitch(message) {

        busy = false;

        render(true);

        toast(message);
    }


    /*
     * 切替後、X はホームを開き直す。
     * 切替前に居たページへ戻す
     */
    function restorePathIfNeeded() {

        const pending = readJson(sessionStorage, SESSION_RETURN, null);

        if (!pending) {
            return;
        }


        sessionStorage.removeItem(SESSION_RETURN);


        if (!RETURN_TO_PREVIOUS_PAGE) {
            return;
        }


        if (!pending.path || Date.now() - (pending.at || 0) > RETURN_MAX_AGE_MS) {
            return;
        }


        const here = location.pathname + location.search;

        if (pending.path === here) {
            return;
        }


        if (location.pathname === '/home' || location.pathname === '/') {
            location.replace(pending.path);
        }
    }


    // ============================================================
    // 一覧の読み込み（メニューから手動）
    // ============================================================

    async function loadFromNative() {

        if (busy) {
            return;
        }


        busy = true;

        render(true);

        log('読み込み開始');


        const withEntries = (fullOnly) =>
            switcherContexts().some(context =>
                (!fullOnly || context.fullList) &&
                accountEntries(context.container).length
            ) ?
                true :
                null;


        /*
         * 一覧すべて（「既存のアカウントを追加」がある入れ物）が出るまで進む。
         * ドロワーに他のアカウントが一部だけ見えている段階では止まらない。
         * 最後まで出なかったら、見えている分だけ覚える
         */
        const opened =
            await openSwitcher(() => withEntries(true)) ||
            withEntries(false);


        if (opened) {

            harvest();

            log('読み込み完了', loadAccounts().map(a => '@' + a.screenName).join(' '));

        } else {

            log('読み込み失敗');
        }


        if (hasOpenLayer()) {
            closeLayers();
        }


        busy = false;

        render(true);


        toast(
            opened ?
                loadAccounts().length + '件のアカウントを覚えました' :
                'アカウント一覧を開けませんでした。X の切替メニューを一度手で開いてください'
        );
    }


    // ============================================================
    // ドックの描画
    // ============================================================

    function dockCss() {

        return `
:host { all: initial; }
.dock, .toast {
    font-family: -apple-system, BlinkMacSystemFont, 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif;
}
.dock {
    position: fixed;
    z-index: 2147483646;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 8px 6px;
    border-radius: 22px;
    background: rgba(10, 10, 11, 0.88);
    border: 1px solid rgba(244, 244, 245, 0.12);
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.4);
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
}
.dock.left-bottom  { left: max(10px, env(safe-area-inset-left));  bottom: calc(62px + env(safe-area-inset-bottom, 0px)); }
.dock.right-bottom { right: max(10px, env(safe-area-inset-right)); bottom: calc(62px + env(safe-area-inset-bottom, 0px)); }
.dock.left-top     { left: max(10px, env(safe-area-inset-left));  top: calc(58px + env(safe-area-inset-top, 0px)); }
.dock.right-top    { right: max(10px, env(safe-area-inset-right)); top: calc(58px + env(safe-area-inset-top, 0px)); }
.list {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
}
.dock.collapsed .list .av:not(.current) { display: none; }
.av {
    appearance: none;
    border: 0;
    padding: 0;
    width: 44px;
    height: 44px;
    border-radius: 999px;
    background: #1a1a1e;
    overflow: hidden;
    display: grid;
    place-items: center;
    color: #f4f4f5;
    font-size: 15px;
    font-weight: 600;
}
.av img { width: 100%; height: 100%; object-fit: cover; display: block; }
.av.current { box-shadow: 0 0 0 2px #0a0a0b, 0 0 0 3.5px #f4f4f5; }
.av:active { transform: scale(0.92); }
.av[disabled] { opacity: 0.45; }
.load {
    appearance: none;
    border: 1px dashed rgba(244, 244, 245, 0.4);
    background: transparent;
    color: rgba(244, 244, 245, 0.8);
    width: 44px;
    height: 44px;
    border-radius: 999px;
    font-size: 11px;
}
.icon {
    appearance: none;
    border: 0;
    background: transparent;
    color: rgba(244, 244, 245, 0.7);
    width: 28px;
    height: 28px;
    border-radius: 999px;
    display: grid;
    place-items: center;
}
.icon:active { background: rgba(244, 244, 245, 0.08); color: #f4f4f5; }
.menu {
    display: none;
    flex-direction: column;
    gap: 2px;
    min-width: 176px;
    padding: 6px;
    border-radius: 12px;
    background: #121214;
    border: 1px solid rgba(244, 244, 245, 0.12);
}
.menu.open { display: flex; }
.menu button {
    appearance: none;
    border: 0;
    background: transparent;
    color: #f4f4f5;
    font-size: 13px;
    text-align: left;
    padding: 9px 10px;
    border-radius: 8px;
}
.menu button:active { background: rgba(244, 244, 245, 0.08); }
.menu button[aria-pressed="true"]::after { content: ' ✓'; }
.toast {
    position: fixed;
    z-index: 2147483647;
    left: 50%;
    transform: translateX(-50%);
    bottom: calc(120px + env(safe-area-inset-bottom, 0px));
    max-width: min(86vw, 420px);
    background: rgba(10, 10, 11, 0.94);
    color: #f4f4f5;
    border: 1px solid rgba(244, 244, 245, 0.12);
    padding: 8px 14px;
    border-radius: 16px;
    font-size: 12px;
    line-height: 1.5;
    text-align: center;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.15s ease;
}
.toast.show { opacity: 1; }
@media (prefers-reduced-motion: reduce) {
    .av:active { transform: none; }
    .toast { transition: none; }
}
`;
    }


    function moreIcon() {

        const ns = 'http://www.w3.org/2000/svg';

        const svg = document.createElementNS(ns, 'svg');

        svg.setAttribute('width', '16');
        svg.setAttribute('height', '16');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'currentColor');


        for (const cy of [6, 12, 18]) {

            const dot = document.createElementNS(ns, 'circle');

            dot.setAttribute('cx', '12');
            dot.setAttribute('cy', String(cy));
            dot.setAttribute('r', '1.6');

            svg.appendChild(dot);
        }


        return svg;
    }


    function toast(message) {

        if (!toastEl) {
            return;
        }


        toastEl.textContent = message;

        toastEl.classList.add('show');


        clearTimeout(toastTimer);

        toastTimer =
            setTimeout(
                () => toastEl.classList.remove('show'),
                TOAST_MS
            );
    }


    function shouldShowDock() {

        if (sessionStorage.getItem(SESSION_HIDDEN) === '1') {
            return false;
        }


        return !HIDDEN_PATHS.some(pattern => pattern.test(location.pathname));
    }


    function buildMenu() {

        const menu = document.createElement('div');

        menu.className = 'menu';


        const add = (label, onClick, pressed) => {

            const button = document.createElement('button');

            button.type = 'button';

            button.textContent = label;


            if (pressed !== undefined) {
                button.setAttribute('aria-pressed', String(pressed));
            }


            button.addEventListener('click', () => {

                menu.classList.remove('open');

                onClick();
            });


            menu.appendChild(button);
        };


        for (const position of POSITIONS) {

            add(
                position.label,
                () => {
                    writeJson(localStorage, STORAGE_POSITION, position.key);

                    render(true);
                },
                getPosition() === position.key
            );
        }


        add(
            isCollapsed() ? '展開する' : '最小化する',
            () => {
                writeJson(localStorage, STORAGE_COLLAPSED, !isCollapsed());

                render(true);
            }
        );


        add('アカウントを読み込む', loadFromNative);


        add('一覧を消去', () => {

            saveAccounts([]);

            render(true);

            toast('一覧を消去しました');
        });


        add('このタブでは隠す', () => {

            sessionStorage.setItem(SESSION_HIDDEN, '1');

            unmount();
        });


        return menu;
    }


    function mount() {

        if (root && root.isConnected) {
            return;
        }


        root = document.createElement('div');

        root.id = ROOT_ID;


        const shadow = root.attachShadow({ mode: 'open' });


        const style = document.createElement('style');

        style.textContent = dockCss();


        dock = document.createElement('div');

        dock.className = 'dock';


        listEl = document.createElement('div');

        listEl.className = 'list';


        const more = document.createElement('button');

        more.type = 'button';

        more.className = 'icon';

        more.setAttribute('aria-label', '位置と操作');

        more.appendChild(moreIcon());


        more.addEventListener('click', () => {

            const opening = !menuEl.classList.contains('open');

            /*
             * 開くたびに作り直し、現在の設定（✓）を反映する
             */
            const fresh = buildMenu();

            menuEl.replaceWith(fresh);

            menuEl = fresh;

            menuEl.classList.toggle('open', opening);
        });


        menuEl = buildMenu();


        dock.append(listEl, more, menuEl);


        toastEl = document.createElement('div');

        toastEl.className = 'toast';

        toastEl.setAttribute('role', 'status');


        shadow.append(style, dock, toastEl);


        document.documentElement.appendChild(root);


        renderedSignature = '';
    }


    function unmount() {

        root?.remove();

        root = null;
    }


    function letterOf(account) {

        return (account.name || account.screenName || '?')
            .charAt(0)
            .toUpperCase();
    }


    function render(force) {

        if (!shouldShowDock()) {

            unmount();

            return;
        }


        mount();


        const accounts = loadAccounts();

        const current = currentHandle();

        const position = getPosition();

        const collapsed = isCollapsed();


        const signature =
            JSON.stringify([accounts, current, position, collapsed, busy]);

        if (!force && signature === renderedSignature) {
            return;
        }


        renderedSignature = signature;


        dock.className =
            'dock ' + position + (collapsed ? ' collapsed' : '');


        listEl.replaceChildren();


        if (!accounts.length) {

            const load = document.createElement('button');

            load.type = 'button';

            load.className = 'load';

            load.textContent = '読込';

            load.setAttribute('aria-label', 'アカウントを読み込む');

            load.disabled = busy;

            load.addEventListener('click', loadFromNative);


            listEl.appendChild(load);

            return;
        }


        for (const account of accounts) {

            const button = document.createElement('button');

            button.type = 'button';

            button.className = 'av';

            button.dataset.handle = account.screenName;


            if (normalizeHandle(account.screenName) === current) {
                button.classList.add('current');
            }


            const label =
                (account.name && account.name !== account.screenName ? account.name + ' ' : '') +
                '@' + account.screenName;

            button.title = label;

            button.setAttribute('aria-label', label);

            button.disabled = busy;


            if (account.avatar) {

                const img = document.createElement('img');

                img.src = account.avatar;

                img.alt = '';


                img.addEventListener('error', () => {

                    img.remove();

                    button.textContent = letterOf(account);
                });


                button.appendChild(img);

            } else {

                button.textContent = letterOf(account);
            }


            button.addEventListener('click', () => switchTo(account));


            listEl.appendChild(button);
        }
    }


    // ============================================================
    // 監視
    // ============================================================

    function scheduleCheck() {

        clearTimeout(checkTimer);


        checkTimer =
            setTimeout(
                () => {

                    const changed = harvest();

                    if (wantsPanel()) {
                        takeSnapshot();
                    }


                    render(changed);
                },
                CHECK_DELAY
            );
    }


    function startObserver() {

        /*
         * 自作ドックは Shadow DOM の中なので、ここには変更が上がってこない。
         * 診断パネルの更新だけ無視する
         */
        const observer =
            new MutationObserver(mutations => {

                const onlyPanel = mutations.every(mutation =>
                    mutation.target.closest?.(`#${PANEL_ID}`) ||
                    mutation.target.parentElement?.closest(`#${PANEL_ID}`)
                );

                if (!onlyPanel) {
                    scheduleCheck();
                }
            });


        observer.observe(
            document.body,
            {
                childList: true,
                subtree: true
            }
        );


        /*
         * 別タブで覚えた一覧・設定を反映する
         */
        window.addEventListener('storage', event => {

            if ([STORAGE_ACCOUNTS, STORAGE_POSITION, STORAGE_COLLAPSED].includes(event.key)) {
                render(false);
            }
        });


        /*
         * ドックの外を押したらメニューを閉じる
         */
        document.addEventListener(
            'click',
            event => {

                if (menuEl && root && !event.composedPath().includes(root)) {
                    menuEl.classList.remove('open');
                }
            },
            true
        );
    }


    // ============================================================
    // 診断
    // ============================================================

    function describe(element) {

        if (!element) {
            return '（なし）';
        }


        const parts = [element.tagName.toLowerCase()];

        for (const attribute of ['role', 'data-testid', 'aria-label', 'href']) {

            const value = element.getAttribute(attribute);

            if (value) {
                parts.push(`${attribute}="${value.slice(0, 40)}"`);
            }
        }


        const text = textOf(element).slice(0, 30);

        return '<' + parts.join(' ') + '>' + (text ? ' 「' + text + '」' : '');
    }


    /*
     * 重なり層の骨格を残す。role / testid / aria-label / href / アバター画像を
     * 持つ要素だけを、入れ子の深さ付きで並べる。
     * ドロワーを閉じた後でもコピーできるよう、中身があるときに取っておく
     */
    function takeSnapshot() {

        const lines = [];


        const walk = (element, depth) => {

            if (lines.length >= SNAPSHOT_MAX_LINES) {
                return;
            }


            const interesting =
                element.hasAttribute('role') ||
                element.hasAttribute('data-testid') ||
                element.hasAttribute('aria-label') ||
                element.hasAttribute('href') ||
                element.matches(AVATAR_IMG_SELECTOR) ||
                element.tagName === 'BUTTON';


            if (interesting) {

                const own =
                    [...element.childNodes]
                        .filter(node => node.nodeType === Node.TEXT_NODE)
                        .map(node => node.textContent.trim())
                        .join(' ')
                        .slice(0, 30);


                let line = '  '.repeat(Math.min(depth, 20)) + describe(element).replace(/ 「.*」$/, '');

                if (own) {
                    line += ' 「' + own + '」';
                }


                if (element.matches(AVATAR_IMG_SELECTOR)) {
                    line += ' [アバター]';
                }


                lines.push(line);
            }


            for (const child of element.children) {
                walk(child, interesting ? depth + 1 : depth);
            }
        };


        for (const layer of layerRoots()) {
            walk(layer, 0);
        }


        if (lines.length > 1) {

            lastSnapshot = {
                at: new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' }),
                lines
            };
        }
    }


    function buildReport() {

        const lines = [];


        lines.push('=== X アカウント切替 診断 ===');

        lines.push('バージョン: ' + VERSION + ' / ページ: ' + location.pathname);

        lines.push('画面: ' + window.innerWidth + '×' + window.innerHeight);


        const current = currentAccount();

        lines.push('');

        lines.push(
            '■ 現在のアカウント: ' +
            (current ? '@' + current.handle + '（' + current.source + '）' : '取得できない')
        );


        lines.push(
            '■ 覚えている一覧: ' +
            (loadAccounts().map(a => '@' + a.screenName).join(' ') || '（なし）')
        );


        lines.push('');

        lines.push('■ 開くボタン');

        const menuOpener = queryFirst(MENU_OPENER_SELECTORS);

        lines.push(
            '  メニュー: ' + describe(menuOpener) +
            (menuOpener ? (isVisible(menuOpener) ? '（表示）' : '（非表示）') : '')
        );

        lines.push('  ドロワー: ' + describe(findDrawerOpener()));

        lines.push('  アカウント一覧: ' + describe(findMoreAccountsButton()));


        const layers = layerRoots();

        lines.push('');

        lines.push('■ 重なり層: ' + layers.length + '件（' + layers.map(layer => describe(layer).slice(0, 40)).join(', ') + '）');


        const contexts = switcherContexts();

        lines.push('■ 切替メニューと判定した入れ物: ' + contexts.length + '件');

        contexts.forEach((context, index) => {

            lines.push(
                '  [' + index + '] ' + describe(context.container).slice(0, 60) +
                (context.fullList ? '（一覧すべて）' : '')
            );

            for (const marker of context.markers.slice(0, 4)) {
                lines.push('      目印: ' + describe(marker));
            }


            for (const entry of accountEntries(context.container)) {
                lines.push('      @' + entry.handle + '（' + entry.source + '）' + describe(entry.element));
            }
        });


        lines.push('■ 重なり層の中の、切替に使える候補');

        for (const layer of layers) {

            for (const entry of accountEntries(layer)) {
                lines.push('  @' + entry.handle + '（' + entry.source + '）' + describe(entry.element));
            }
        }


        lines.push('');

        lines.push('■ 直近の切替の記録');

        if (!switchLog.length) {
            lines.push('  （なし）');
        }

        for (const entry of switchLog) {
            lines.push('  ' + entry.時刻 + ' ' + entry.段階 + (entry.詳細 ? ': ' + entry.詳細 : ''));
        }


        lines.push('');

        if (lastSnapshot) {

            lines.push('■ 重なり層の構造（' + lastSnapshot.at + ' 時点、' + lastSnapshot.lines.length + '行）');

            lines.push(...lastSnapshot.lines);

        } else {

            lines.push('■ 重なり層の構造: まだ記録なし（切替メニューを開くと記録される）');
        }


        return lines.join('\n');
    }


    function wantsPanel() {

        return location.hash
            .toLowerCase()
            .includes(DIAGNOSTIC_HASH);
    }


    function makePanelButton(label, onClick) {

        const button = document.createElement('button');

        button.type = 'button';

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


        takeSnapshot();


        const report = buildReport();

        let panel = document.getElementById(PANEL_ID);


        if (!panel) {

            panel = document.createElement('div');

            panel.id = PANEL_ID;


            Object.assign(
                panel.style,
                {
                    position: 'fixed',
                    left: '8px',
                    right: '8px',
                    top: '8px',
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


            clearInterval(panelTimer);

            panelTimer = setInterval(renderPanel, PANEL_REFRESH_MS);
        }


        /*
         * コピー直後に作り直すと「コピーした」表示が消えるので、本文だけ差し替える
         */
        const existingArea = panel.querySelector('textarea');

        if (existingArea) {

            existingArea.value = report;

            return;
        }


        const buttons = document.createElement('div');

        Object.assign(
            buttons.style,
            {
                display: 'flex',
                gap: '8px',
                marginBottom: '8px'
            }
        );


        const copyButton =
            makePanelButton('コピー', async () => {

                const area = panel.querySelector('textarea');

                try {

                    await navigator.clipboard.writeText(area.value);

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
            makePanelButton('閉じる', closePanel)
        );


        const area = document.createElement('textarea');

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

        window.__tmXSwitch = {

            dump() {

                takeSnapshot();

                const report = buildReport();

                console.log(report);


                console.table(
                    layerRoots().flatMap(layer =>
                        accountEntries(layer).map(entry => ({
                            ハンドル: '@' + entry.handle,
                            取得元: entry.source,
                            要素: describe(entry.element)
                        }))
                    )
                );


                return report;
            },

            accounts: loadAccounts,

            forget() {

                saveAccounts([]);

                render(true);
            },

            switchTo(handle) {

                return switchTo({ screenName: normalizeHandle(handle) });
            }
        };

    } catch {

        /*
         * 参照できない環境では諦める
         */
    }


    // ============================================================
    // 起動
    // ============================================================

    function boot() {

        if (document.getElementById(ROOT_ID)) {
            return;
        }


        restorePathIfNeeded();

        harvest();

        render(true);

        startObserver();

        renderPanel();


        window.addEventListener('hashchange', renderPanel);
    }


    if (document.body) {

        boot();

    } else {

        document.addEventListener('DOMContentLoaded', boot, { once: true });
    }

})();
