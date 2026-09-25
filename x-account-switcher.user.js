// ==UserScript==
// @name         X アカウント切替 v1.2.0
// @namespace    local.hiro.tools
// @version      1.2.0
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
 *   - 初回に勝手にドロワーを開かない（読み込みは「読込」ボタンから手動）
 *
 * ■ iPhone の実機診断で分かったこと（v1.0.1）
 *   - モバイル幅では、上のバー（TopNavBar）・下のタブ（BottomBar）・投稿ボタンも
 *     #layers の中に常にある。#layers ＝ メニューだけの場所ではない
 *   - 左上のアイコン（DashButton_ProfileIcon_Link）のアバターの testid は
 *     UserAvatar-Container-unknown で、ハンドルを持たない。
 *     aria-label も「プロフィールメニュー 表示名」で、@ハンドルは無い
 *   - 個別ポスト等では左上がアイコンではなく「戻る」になり、ドロワーを開けない
 *     （v1.0.1 で、ホームでは動き、個別ポストでは動かないと報告あり）。
 *     このときは下のタブの「ホーム」でいったんホームへ移ってから開き、
 *     終わったら元のページへ戻る（v1.0.2）
 *
 * ■ 未確認の点
 *   ドロワーとアカウント一覧シートの実際の DOM は確認できていない。testid ではなく
 *   「アバターと @ハンドルを持つ、押せる要素」「アカウント追加・ログアウトの
 *   リンクと同じ入れ物にある」という構造で狙っている。
 *
 * ■ 診断（iPhone でも使える）
 *   URL の末尾に #tmswitch を付けて開くと、画面下に診断パネルが出る。
 *   （例: https://x.com/home#tmswitch ）
 *   パネルの「読込を試す」を押し、終わってから「コピー」を押すと、
 *   開いたドロワーの構造と、どこで止まったかの記録が取れる。
 *   記録はタブを閉じるまで残るので、失敗した後で #tmswitch を開いてもよい。
 *   コンソールが使える環境なら __tmXSwitch.dump() でも同じものが出る。
 */

(function () {
    'use strict';

    // ============================================================
    // 設定
    // ============================================================

    const VERSION = '1.2.0';

    // 自作要素の id
    const ROOT_ID = 'tm-x-switch-root';

    const PANEL_ID = 'tm-x-switch-panel';

    // 保存キー（localStorage: 端末に残す / sessionStorage: タブ単位）
    const STORAGE_ACCOUNTS = 'tm-x-switch-accounts';

    const STORAGE_POSITION = 'tm-x-switch-position';

    /*
     * ドックを画面端のつまみにしまっているか。
     * v1.0 の「最小化」（tm-x-switch-collapsed）と「このタブでは隠す」
     * （tm-x-switch-hidden）は廃止し、これにまとめた
     */
    const STORAGE_TUCKED = 'tm-x-switch-tucked';

    const SESSION_RETURN = 'tm-x-switch-return';

    // 最後に確かめられた現在のアカウント（左上のアイコンが無いページで使う）
    const SESSION_CURRENT = 'tm-x-switch-current';

    // 診断の記録（再読み込みしても残す）
    const SESSION_LOG = 'tm-x-switch-log';

    const SESSION_SNAPSHOT = 'tm-x-switch-snapshot';

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
    // X はドロワーや一覧の部品を初めて開くときに読み込むので、長めに取る
    const MENU_WAIT_MS = 5000;

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

    // 履歴で戻ったあと、元のページに着いたかを確かめるまでの待ち時間（ミリ秒）
    // 着いていなければ元のページを開き直す
    const RETURN_CHECK_MS = 600;

    // トーストの表示時間（ミリ秒）
    const TOAST_MS = 2200;

    // 読み込みに失敗したときの案内の表示時間（ミリ秒）。「記録をコピー」を押せるよう長めに
    const FAILURE_TOAST_MS = 12000;

    // 切替の記録を何件残すか（診断用）
    const SWITCH_LOG_MAX = 40;

    // 診断パネル
    const DIAGNOSTIC_HASH = 'tmswitch';

    // 診断パネルを開いている間の更新間隔（ミリ秒）
    const PANEL_REFRESH_MS = 1500;

    // 重なり層の構造を記録する行数の上限（診断用）
    const SNAPSHOT_MAX_LINES = 300;

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
     * 重なり層に常に居るもの（実機診断で確認）。
     * メニューではないので、切替先や「アカウント」ボタンを探すときは除く
     */
    const PERSISTENT_SELECTORS = [
        '[data-testid="TopNavBar"]',
        '[data-testid="BottomBar"]',
        '[data-testid="FloatingActionButtonBase"]',
        'aside[role="complementary"]'
    ];

    // 診断の構造記録では、上に加えてこれも省く（タブ・新着ピル）
    const SNAPSHOT_SKIP_SELECTORS = [
        ...PERSISTENT_SELECTORS,
        'div[role="grid"]',
        '[role="status"]'
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

    /*
     * 左上のアイコンが無いページ（個別ポスト等）で、ホームへ移るためのリンク。
     * 下のタブのホーム（実機診断で確認）
     */
    const HOME_LINK_SELECTORS = [
        'a[data-testid="AppTabBar_Home_Link"]',
        'a[href="/home"]'
    ];

    // 構造で左上のアイコンを探すときの範囲（上のバー）
    const TOP_BAR_SELECTORS = [
        '[data-testid="TopNavBar"]',
        'header',
        '[role="banner"]'
    ];

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

    /*
     * 切替メニューの中の、アカウントそのものを指す項目（実機で確認、v1.1.1 の診断）。
     * testid は AccountSwitcher_ で始まるので目印も兼ねるが、切替先として扱う。
     * /account/switch のページでは、現在のアカウントは押せない li、他は button
     */
    const ACCOUNT_ITEM_SELECTOR = '[data-testid="AccountSwitcher_Switch_Button"]';

    // 上の目印のうち「一覧がすべて出ている」ことを示すもの（アカウント追加）
    const FULL_LIST_HREFS = [
        '/i/flow/login',
        '/account/add'
    ];

    const FULL_LIST_TEXT =
        /既存のアカウントを追加|Add an existing account/i;

    // ドロワーの中の「アカウント一覧を開く」ボタン（aria-label の部分一致）
    const MORE_ACCOUNTS_LABEL =
        /アカウント|account|切り替|切替|switch/i;

    // 上に当たっても「一覧を開く」ボタンではないもの
    const MORE_ACCOUNTS_EXCLUDE =
        /管理|作成|追加|ログアウト|Manage|Create|Add|Log out/i;

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

    // アバターの testid に入る、ハンドルではない値（実機で確認）
    const PLACEHOLDER_HANDLES = [
        'unknown'
    ];


    // ============================================================
    // 状態
    // ============================================================

    let root = null;
    let dock = null;
    let listEl = null;
    let menuEl = null;
    let tabEl = null;
    let tuckEl = null;
    let toastEl = null;

    let busy = false;
    let checkTimer = null;
    let toastTimer = null;
    let reloadTimer = null;
    let panelTimer = null;

    let renderedSignature = '';

    // 切替UIを開くためにホームへ移ったか（終わったら元のページへ戻る）
    let movedHome = false;

    // 切替UIを開く途中で止まった段階（読み込み失敗の案内に出す）
    let openFailure = '';

    /*
     * 読み込みに失敗し、ドロワー等を開いたまま手での操作を待っているか。
     * その間に一覧を覚えたら知らせる
     */
    let waitingForManual = false;

    const switchLog = [];

    let lastSnapshot = null;

    /*
     * 前回までの記録を引き継ぐ（失敗した後で診断を開いても見えるように）
     */
    (function restoreDiagnostics() {

        const savedLog = readJsonEarly(SESSION_LOG);

        if (Array.isArray(savedLog)) {
            switchLog.push(...savedLog.slice(-SWITCH_LOG_MAX));
        }


        const savedSnapshot = readJsonEarly(SESSION_SNAPSHOT);

        if (savedSnapshot && Array.isArray(savedSnapshot.lines)) {
            lastSnapshot = savedSnapshot;
        }
    })();


    function readJsonEarly(key) {

        try {

            return JSON.parse(sessionStorage.getItem(key) || 'null');

        } catch {

            return null;
        }
    }


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

            ページ: location.pathname,
            段階: step,
            詳細: detail || ''
        });


        if (switchLog.length > SWITCH_LOG_MAX) {
            switchLog.shift();
        }


        writeJson(sessionStorage, SESSION_LOG, switchLog);
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


    function isTucked() {

        return readJson(localStorage, STORAGE_TUCKED, false) === true;
    }


    function setTucked(tucked) {

        writeJson(localStorage, STORAGE_TUCKED, tucked);

        render(true);
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


    function avatarOf(element) {

        const img = element.querySelector(AVATAR_IMG_SELECTOR);

        return img ? biggerAvatar(img.getAttribute('src')) : '';
    }


    /*
     * アバター画像の URL から大きさの違いを除いたもの。
     * 同じアカウントなら _normal / _bigger などが違っても一致する
     */
    function avatarKey(url) {

        return String(url || '')
            .replace(/[?#].*$/, '')
            .replace(/_(normal|bigger|mini|reasonably_small|x96|\d+x\d+)(\.[a-z]+)?$/i, '')
            .replace(/\.[a-z]+$/i, '');
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

        const found = detectCurrentAccount();


        if (found) {

            if (readJson(sessionStorage, SESSION_CURRENT, '') !== found.handle) {
                writeJson(sessionStorage, SESSION_CURRENT, found.handle);
            }


            return found;
        }


        /*
         * 左上のアイコンが無いページ（個別ポスト等）では、
         * 同じタブで最後に確かめられた値を使う
         */
        const memo = readJson(sessionStorage, SESSION_CURRENT, '');

        return memo ?
            { handle: memo, source: '直前に確認した値', memo: true } :
            null;
    }


    function detectCurrentAccount() {

        const profile = queryFirst(PROFILE_LINK_SELECTORS);

        if (profile) {

            const match =
                /^\/([A-Za-z0-9_]{1,15})(?:\/|$)/.exec(profile.getAttribute('href') || '');

            if (match && !['i', 'home', 'explore'].includes(match[1])) {
                return { handle: match[1], source: 'プロフィールへのリンク' };
            }
        }


        const drawerOpener = findDrawerOpener();


        for (const opener of [queryFirst(MENU_OPENER_SELECTORS), drawerOpener]) {

            if (!opener) {
                continue;
            }


            const found = handleOf(opener);

            if (found) {
                return { handle: found.handle, source: '切替ボタン（' + found.source + '）' };
            }
        }


        const fromDrawer = currentFromOpenDrawer();

        if (fromDrawer) {
            return { handle: fromDrawer.handle, source: '開いているドロワーのプロフィール' };
        }


        /*
         * モバイル幅の左上のアイコンはハンドルを持たない（実機で確認）。
         * 覚えている一覧と、アバター画像・表示名で突き合わせる
         */
        if (drawerOpener) {

            const accounts = loadAccounts();

            const img = drawerOpener.querySelector(AVATAR_IMG_SELECTOR);

            const key = img ? avatarKey(img.getAttribute('src')) : '';


            if (key) {

                const byAvatar =
                    accounts.filter(account => account.avatar && avatarKey(account.avatar) === key);

                if (byAvatar.length === 1) {
                    return { handle: byAvatar[0].screenName, source: '左上のアイコンの画像' };
                }
            }


            const label = drawerOpener.getAttribute('aria-label') || '';

            const byName =
                accounts.filter(account =>
                    account.name &&
                    account.name !== account.screenName &&
                    label.endsWith(' ' + account.name)
                );

            if (byName.length === 1) {
                return { handle: byName[0].screenName, source: '左上のアイコンの表示名' };
            }
        }


        return null;
    }


    /*
     * ドロワーが開いていれば、その中の「自分のプロフィール」
     * （/ハンドル へのリンクで、@ハンドルを表示しているもの）から取る
     */
    function currentFromOpenDrawer() {

        for (const overlay of openOverlays()) {

            for (const link of overlay.querySelectorAll('a[href]')) {

                const match =
                    /^\/([A-Za-z0-9_]{1,15})$/.exec(link.getAttribute('href') || '');

                if (!match) {
                    continue;
                }


                if (textOf(link).toLowerCase().includes('@' + match[1].toLowerCase())) {

                    return {
                        handle: match[1],
                        name: nameOf(link, match[1]),
                        avatar: avatarOf(link)
                    };
                }
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


    function isPersistent(element) {

        return !!element.closest(PERSISTENT_SELECTORS.join(','));
    }


    /*
     * いま開いているメニュー・ドロワー・シート
     */
    function openOverlays() {

        const overlays = [];


        for (const layer of layerRoots()) {

            if (layer.matches(LAYER_FALLBACK_SELECTORS.join(','))) {

                overlays.push(layer);

                continue;
            }


            for (const element of layer.querySelectorAll(LAYER_FALLBACK_SELECTORS.join(','))) {

                if (!overlays.some(o => o.contains(element)) && !isPersistent(element)) {
                    overlays.push(element);
                }
            }
        }


        if (isSwitchPage()) {

            const main = document.querySelector('main');

            if (main && !overlays.includes(main)) {
                overlays.push(main);
            }
        }


        return overlays;
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


        for (const element of scope.querySelectorAll(CLICKABLE_SELECTOR + ',' + ACCOUNT_ITEM_SELECTOR)) {

            if (element.closest(`#${ROOT_ID}, #${PANEL_ID}`)) {
                continue;
            }


            if (isPersistent(element)) {
                continue;
            }


            if (!hasAvatar(element)) {
                continue;
            }


            if (isMarker(element) && !element.matches(ACCOUNT_ITEM_SELECTOR)) {
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
         * 開いているメニュー・ドロワーの中のもの（ドロワー内の自分のアイコン等）と、
         * 投稿の中のもの（投稿者のアイコン。押すとプロフィールへ飛ぶ）は除く。
         * モバイル幅の上のバーは #layers の中にあるので、#layers 全体は除かない
         */
        const overlays = openOverlays();

        for (const element of document.querySelectorAll(CLICKABLE_SELECTOR)) {

            if (overlays.some(overlay => overlay.contains(element))) {
                continue;
            }


            if (element.closest(`#${ROOT_ID}, #${PANEL_ID}`)) {
                continue;
            }


            if (element.closest('article, [data-testid="cellInnerDiv"], [data-testid="UserCell"]')) {
                continue;
            }


            /*
             * 上のバーの中に限る。プロフィールページの大きなアイコン等を拾わないため
             */
            if (!element.closest(TOP_BAR_SELECTORS.join(','))) {
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

        /*
         * 開いているドロワーの中を探す。
         * ドロワーが dialog 等の役割を持たない場合に備え、
         * 見つからなければ重なり層全体（常に居るバーは除く）も見る
         */
        const overlays = openOverlays();

        const scopes = overlays.length ? overlays : layerRoots();


        for (const scope of scopes) {

            for (const element of scope.querySelectorAll(CLICKABLE_SELECTOR)) {

                if (isPersistent(element) || !isVisible(element)) {
                    continue;
                }


                const href = element.getAttribute('href') || '';

                if (href === '/account/switch') {
                    return element;
                }


                const label =
                    element.getAttribute('aria-label') ||
                    (textOf(element).length <= 20 ? textOf(element) : '');

                if (
                    MORE_ACCOUNTS_LABEL.test(label) &&
                    !MORE_ACCOUNTS_EXCLUDE.test(label) &&
                    !HANDLE_PATTERN.test(label) &&
                    !isFullListMarker(element)
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


    /*
     * 切替UIのために移ったページから、元のページへ戻る。
     *
     *   ホームへ移った（個別ポスト等に左上のアイコンが無いため）: 1段
     *   一覧が独立したページ（/account/switch）として開いた:      1段
     *
     * 両方なら2段まとめて戻る（back() を続けて呼ぶと2回目が無視されうる）
     */
    function leaveTemporaryPages(startPath) {

        const steps =
            (isSwitchPage() ? 1 : 0) +
            (movedHome ? 1 : 0);


        movedHome = false;


        if (steps) {

            log('元のページへ戻る', steps + '段');

            history.go(-steps);
        }


        /*
         * X が途中のページを置き換える（/account/switch → /home 等）と、
         * 段数どおりに戻っても元のページに着かない。確かめて、だめなら開き直す
         */
        if (!startPath) {
            return;
        }


        setTimeout(() => {

            if (location.pathname + location.search !== startPath) {

                log('履歴で戻れなかったので開き直す', startPath);

                location.replace(startPath);
            }
        }, RETURN_CHECK_MS);
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

        /*
         * ドロワーが開いていたら、そこに出ている自分のアカウントを覚える。
         * 左上のアイコンはハンドルを持たないので、以後は画像で突き合わせる
         */
        const drawerSelf = currentFromOpenDrawer();

        let learnedSelf = false;

        if (drawerSelf) {

            const opener = findDrawerOpener();

            learnedSelf =
                remember(
                    [{
                        screenName: drawerSelf.handle,
                        name: drawerSelf.name,
                        avatar: drawerSelf.avatar || (opener ? avatarOf(opener) : '')
                    }],
                    false
                );
        }


        learnedSelf = repairCurrent() || learnedSelf;


        const contexts = switcherContexts();

        if (!contexts.length) {
            return learnedSelf;
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
            return learnedSelf;
        }


        /*
         * 現在のアカウントは、切替メニューの中で押せない項目になっていることがある
         * （デスクトップ・iPad）。押せる要素だけを集めた上では拾えないので足す。
         * アイコンと表示名もメニューの中か切替ボタンから取る
         */
        const current = currentAccount();

        if (current) {

            const details =
                currentDetails(current.handle, contexts.map(context => context.container));

            found.push({
                screenName: current.handle,
                name: details.name || current.handle,
                avatar: details.avatar
            });
        }


        return remember(found, fullList) || learnedSelf;
    }


    /*
     * 現在のアカウントのアイコンと表示名。
     *   1. scopes（切替メニュー等）の中の、そのハンドルのアバター（押せない項目でもよい）
     *   2. 切替ボタン（デスクトップ幅の左下。アバターと「表示名 @ハンドル」を持つ）
     * 取れなければ空文字を返す
     */
    function currentDetails(handle, scopes) {

        const key = normalizeHandle(handle);


        for (const scope of scopes) {

            for (const container of scope.querySelectorAll(`[data-testid^="${AVATAR_CONTAINER_PREFIX}"]`)) {

                if (container.closest(`#${ROOT_ID}, #${PANEL_ID}`) || isPersistent(container)) {
                    continue;
                }


                const testidHandle =
                    container.getAttribute('data-testid').slice(AVATAR_CONTAINER_PREFIX.length);

                const img = container.querySelector(AVATAR_IMG_SELECTOR);

                if (normalizeHandle(testidHandle) !== key || !img) {
                    continue;
                }


                /*
                 * 表示名は、@ハンドルを含む最も近い入れ物から取る
                 */
                let holder = container.parentElement;

                while (
                    holder &&
                    holder !== scope &&
                    !textOf(holder).toLowerCase().includes('@' + key)
                ) {
                    holder = holder.parentElement;
                }


                const name =
                    holder && holder !== scope ? nameOf(holder, handle) : '';

                return {
                    avatar: biggerAvatar(img.getAttribute('src')),
                    name: name === handle ? '' : name
                };
            }
        }


        const opener = queryFirst(MENU_OPENER_SELECTORS);

        const found = opener ? handleOf(opener) : null;

        if (found && normalizeHandle(found.handle) === key) {

            const name = nameOf(opener, found.handle);

            return {
                avatar: avatarOf(opener),
                name: name === found.handle ? '' : name
            };
        }


        return { avatar: '', name: '' };
    }


    /*
     * v1.1.2 までに、アイコン無し・表示名がハンドルのまま覚えた現在のアカウントを、
     * 読み込み直さなくても直す
     */
    function repairCurrent() {

        const current = detectCurrentAccount();

        if (!current) {
            return false;
        }


        const saved =
            loadAccounts()
                .find(account => normalizeHandle(account.screenName) === normalizeHandle(current.handle));

        if (!saved || (saved.avatar && saved.name && saved.name !== saved.screenName)) {
            return false;
        }


        const details = currentDetails(current.handle, layerRoots());

        if (!details.avatar && !details.name) {
            return false;
        }


        return remember(
            [{
                screenName: saved.screenName,
                name: details.name || saved.name,
                avatar: details.avatar
            }],
            false
        );
    }


    function remember(found, replace) {

        const saved = loadAccounts();

        const byHandle = new Map();


        for (const account of found) {

            const key = normalizeHandle(account.screenName);

            if (!key || PLACEHOLDER_HANDLES.includes(key)) {
                continue;
            }

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

        movedHome = false;

        openFailure = '';


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


        let drawerOpener = findDrawerOpener();


        /*
         * 個別ポスト等では左上が「戻る」になり、アイコンが無い。
         * いったんホームへ移ってから開く
         */
        if (!drawerOpener || !isVisible(drawerOpener)) {
            drawerOpener = await goHomeForOpener();
        }


        if (!drawerOpener) {

            openFailure = '左上のアイコンが見つからない';

            return null;
        }


        log('ドロワーを開く', describe(drawerOpener));

        drawerOpener.click();


        const first =
            await waitFor(
                () => want() || findMoreAccountsButton(),
                MENU_WAIT_MS
            );

        takeSnapshot();


        if (!first) {

            openFailure =
                openOverlays().length ?
                    'ドロワーの中に「アカウント」ボタンが見つからない' :
                    'ドロワーが開かない';

            log(
                'ドロワーの中に切替先も「アカウント」ボタンも見つからない',
                '開いている入れ物: ' + openOverlays().length + '件' +
                ' / 中の候補: ' +
                (openOverlays()
                    .flatMap(overlay => accountEntries(overlay))
                    .map(entry => '@' + entry.handle)
                    .join(' ') || 'なし')
            );

            return null;
        }


        const direct = want();

        if (direct) {
            return direct;
        }


        log('アカウント一覧を開く', describe(first));

        first.click();


        const found = await waitFor(want, MENU_WAIT_MS);

        takeSnapshot();


        if (!found) {

            openFailure = 'アカウント一覧が出ない';

            log('アカウント一覧の中に見つからない', 'ページ: ' + location.pathname);
        }


        return found;
    }


    async function goHomeForOpener() {

        const overlays = openOverlays();

        let link = null;


        for (const selector of HOME_LINK_SELECTORS) {

            link =
                [...document.querySelectorAll(selector)]
                    .find(element =>
                        isVisible(element) &&
                        !overlays.some(overlay => overlay.contains(element))
                    );

            if (link) {
                break;
            }
        }


        if (!link) {

            log('左上のアイコンもホームへのリンクも見つからない', location.pathname);

            return null;
        }


        log('左上のアイコンが無いので、ホームへ移る', location.pathname + ' / ' + describe(link));

        link.click();

        movedHome = true;


        const opener =
            await waitFor(
                () => {
                    const found = findDrawerOpener();

                    return found && isVisible(found) ? found : null;
                },
                MENU_WAIT_MS
            );


        if (!opener) {
            log('ホームでも左上のアイコンが見つからない', location.pathname);
        }


        return opener;
    }


    // ============================================================
    // 切替
    // ============================================================

    async function switchTo(account) {

        const handle = normalizeHandle(account.screenName);

        const current = currentAccount();


        if (!handle) {
            return;
        }


        /*
         * 「直前に確認した値」は古いことがあるので、それが同じでも止めない
         */
        if (current && !current.memo && normalizeHandle(current.handle) === handle) {
            return;
        }


        if (busy) {
            return;
        }


        busy = true;

        render(true);

        toast('@' + account.screenName + ' に切替中…');

        log('切替開始', '@' + account.screenName);


        const startPath = location.pathname + location.search;

        writeJson(sessionStorage, SESSION_RETURN, {
            path: startPath,
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
             * 切替後は元のページ（左上のアイコンが無いことがある）へ戻るので、
             * 切替先を現在のアカウントとして記録しておく
             */
            writeJson(sessionStorage, SESSION_CURRENT, handle);


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


            waitForReload(handle, startPath);

        } catch (error) {

            log('失敗', error.message);

            takeSnapshot();

            sessionStorage.removeItem(SESSION_RETURN);

            if (hasOpenLayer()) {
                closeLayers();
            }


            leaveTemporaryPages(startPath);


            finishSwitch(
                '切り替えられませんでした。X の切替メニューを一度開くと、一覧を覚え直します'
            );
        }
    }


    /*
     * 通常は X がページを読み込み直すので、ここには戻ってこない。
     * 読み込み直さなかった場合は、切り替わったかを確かめてボタンを戻す
     */
    function waitForReload(handle, startPath) {

        clearTimeout(reloadTimer);


        reloadTimer =
            setTimeout(() => {

                if (currentHandle() === handle) {

                    log('再読み込みなしで切り替わった');

                    sessionStorage.removeItem(SESSION_RETURN);

                    leaveTemporaryPages(startPath);

                    finishSwitch('切り替えました');

                    return;
                }


                log('切替を確認できない', '現在: @' + (currentHandle() || '不明'));

                sessionStorage.removeItem(SESSION_RETURN);

                leaveTemporaryPages(startPath);

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
    // 一覧の読み込み（「読込」ボタンから手動）
    // ============================================================

    async function loadFromNative() {

        if (busy) {
            return;
        }


        busy = true;

        render(true);

        log('読み込み開始');


        const startPath = location.pathname + location.search;


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
        let opened =
            await openSwitcher(() => withEntries(true)) ||
            withEntries(false);


        /*
         * 一覧を開けなかった場合、開いているドロワーに他のアカウントの
         * アイコンが見えていれば、その分だけ覚える（足すだけ）
         */
        if (!opened) {

            const visible =
                openOverlays().flatMap(overlay => accountEntries(overlay));

            if (visible.length) {

                log('ドロワーに見えている分だけ覚える', visible.map(entry => '@' + entry.handle).join(' '));

                remember(
                    visible.map(entry => ({
                        screenName: entry.handle,
                        name: nameOf(entry.element, entry.handle),
                        avatar: avatarOf(entry.element)
                    })),
                    false
                );

                opened = true;
            }
        }


        if (opened) {

            harvest();

            log('読み込み完了', loadAccounts().map(a => '@' + a.screenName).join(' '));


            if (hasOpenLayer()) {
                closeLayers();
            }


            leaveTemporaryPages(startPath);


            busy = false;

            render(true);

            toast(loadAccounts().length + '件のアカウントを覚えました');

            return;
        }


        const reason = openFailure || '切替メニューを開けない';

        log('読み込み失敗', reason);

        takeSnapshot();


        /*
         * 手で開けば覚えられるので、途中まで開いたドロワー等は閉じずに残し、
         * 続きを押してもらう（開いた一覧は監視でその場で覚える）
         */
        const leftOpen = hasOpenLayer();


        if (!leftOpen) {
            leaveTemporaryPages(startPath);
        } else {
            movedHome = false;
        }


        waitingForManual = leftOpen;

        busy = false;

        render(true);


        toast(
            (leftOpen ?
                '自動で開けませんでした（' + reason + '）。続きを手で開くと、その場で覚えます' :
                'アカウント一覧を開けませんでした（' + reason + '）。X の切替メニューを一度手で開いてください'),
            {
                label: '記録をコピー',
                onClick: copyReport
            }
        );
    }


    /*
     * 診断の記録をクリップボードへ写す（失敗の案内から1タップで取れるように）
     */
    async function copyReport() {

        takeSnapshot();


        try {

            await navigator.clipboard.writeText(buildReport());

            toast('記録をコピーしました。そのまま貼り付けて送ってください');

        } catch {

            toast('コピーできませんでした。URL の末尾に #tmswitch を付けて開くと記録が見られます');
        }
    }


    // ============================================================
    // ドックの描画
    // ============================================================

    function dockCss() {

        return `
:host { all: initial; }
.dock, .toast, .tab {
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
.dock.tucked { display: none; }
.tab {
    position: fixed;
    z-index: 2147483646;
    display: none;
    place-items: center;
    appearance: none;
    width: 24px;
    height: 56px;
    padding: 0;
    border: 1px solid rgba(244, 244, 245, 0.12);
    background: rgba(10, 10, 11, 0.72);
    color: rgba(244, 244, 245, 0.85);
    font-size: 16px;
    line-height: 1;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
}
.tab.show { display: grid; }
.tab:active { background: rgba(10, 10, 11, 0.95); }
.tab.left-bottom, .tab.left-top   { left: env(safe-area-inset-left, 0px);  border-left: 0;  border-radius: 0 12px 12px 0; }
.tab.right-bottom, .tab.right-top { right: env(safe-area-inset-right, 0px); border-right: 0; border-radius: 12px 0 0 12px; }
.tab.left-bottom, .tab.right-bottom { bottom: calc(62px + env(safe-area-inset-bottom, 0px)); }
.tab.left-top, .tab.right-top       { top: calc(58px + env(safe-area-inset-top, 0px)); }
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
.icon.tuck { font-size: 18px; line-height: 1; padding: 0; }
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
.toast.actionable.show { pointer-events: auto; }
.toast button {
    appearance: none;
    display: block;
    margin: 8px auto 0;
    padding: 6px 14px;
    border: 1px solid rgba(244, 244, 245, 0.3);
    border-radius: 999px;
    background: transparent;
    color: #f4f4f5;
    font: inherit;
}
.toast button:active { background: rgba(244, 244, 245, 0.12); }
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


    /*
     * action を渡すと、押せるボタンを添えて長めに出す
     */
    function toast(message, action) {

        if (!toastEl) {
            return;
        }


        toastEl.replaceChildren(document.createTextNode(message));


        if (action) {

            const button = document.createElement('button');

            button.type = 'button';

            button.textContent = action.label;

            button.addEventListener('click', () => {

                toastEl.classList.remove('show');

                action.onClick();
            });

            toastEl.appendChild(button);
        }


        toastEl.classList.toggle('actionable', !!action);

        toastEl.classList.add('show');


        clearTimeout(toastTimer);

        toastTimer =
            setTimeout(
                () => toastEl.classList.remove('show'),
                action ? FAILURE_TOAST_MS : TOAST_MS
            );
    }


    function shouldShowDock() {

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


        return menu;
    }


    function tuck() {

        setTucked(true);

        toast('画面端のつまみを押すと戻ります');
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

        more.className = 'icon more';

        more.setAttribute('aria-label', '置き場所');

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


        /*
         * 「しまう」は常にドックに出しておく（メニューを開かずに押せる）。
         * 矢印はしまう向き（画面端の側）を指す
         */
        tuckEl = document.createElement('button');

        tuckEl.type = 'button';

        tuckEl.className = 'icon tuck';

        tuckEl.setAttribute('aria-label', 'しまう');

        tuckEl.title = 'しまう';

        tuckEl.addEventListener('click', tuck);


        dock.append(listEl, more, tuckEl, menuEl);


        /*
         * しまったときに画面端に残すつまみ。押すとドックを戻す
         */
        tabEl = document.createElement('button');

        tabEl.type = 'button';

        tabEl.className = 'tab';

        tabEl.setAttribute('aria-label', 'アカウント切替を出す');

        tabEl.addEventListener('click', () => setTucked(false));


        toastEl = document.createElement('div');

        toastEl.className = 'toast';

        toastEl.setAttribute('role', 'status');


        shadow.append(style, dock, tabEl, toastEl);


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

        const tucked = isTucked();


        const signature =
            JSON.stringify([accounts, current, position, tucked, busy]);

        if (!force && signature === renderedSignature) {
            return;
        }


        renderedSignature = signature;


        dock.className =
            'dock ' + position + (tucked ? ' tucked' : '');


        tabEl.className =
            'tab ' + position + (tucked ? ' show' : '');

        tabEl.textContent =
            position.startsWith('left') ? '›' : '‹';

        tuckEl.textContent =
            position.startsWith('left') ? '‹' : '›';


        if (tucked) {
            menuEl.classList.remove('open');
        }


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

                    takeSnapshot();


                    render(changed);


                    /*
                     * 読み込みに失敗して手での操作を待っている間に覚えたら知らせる
                     */
                    if (waitingForManual && changed) {
                        toast(loadAccounts().length + '件のアカウントを覚えました');
                    }


                    if (waitingForManual && !hasOpenLayer()) {
                        waitingForManual = false;
                    }
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

            if ([STORAGE_ACCOUNTS, STORAGE_POSITION, STORAGE_TUCKED].includes(event.key)) {
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
     * 持つ要素と、@ハンドルを含む文字を、入れ子の深さ付きで並べる。
     *
     * モバイル幅では上下のバーが常に重なり層に居る（実機で確認）ので、それは省く。
     * 省いた後に何か残っていれば、メニューやドロワーが開いているとみなして記録する。
     * 閉じた後・再読み込みした後でもコピーできるよう、タブ単位で保存する
     */
    function takeSnapshot() {

        const lines = [];

        const skip = SNAPSHOT_SKIP_SELECTORS.join(',');


        const walk = (element, depth) => {

            if (lines.length >= SNAPSHOT_MAX_LINES) {
                return;
            }


            if (element.matches(skip)) {
                return;
            }


            const clickable = element.matches(CLICKABLE_SELECTOR);

            const own =
                [...element.childNodes]
                    .filter(node => node.nodeType === Node.TEXT_NODE)
                    .map(node => node.textContent.trim())
                    .join(' ')
                    .slice(0, 30);


            const interesting =
                clickable ||
                element.hasAttribute('role') ||
                element.hasAttribute('data-testid') ||
                element.hasAttribute('aria-label') ||
                element.hasAttribute('href') ||
                element.matches(AVATAR_IMG_SELECTOR) ||
                own.includes('@');


            if (interesting) {

                let line =
                    '  '.repeat(Math.min(depth, 20)) +
                    describe(element).replace(/ 「.*」$/, '');


                /*
                 * 押せる要素は中の文字をまとめて出す（名前や @ハンドルが入れ子の奥にあるため）
                 */
                const text = clickable ? textOf(element).slice(0, 40) : own;

                if (text) {
                    line += ' 「' + text + '」';
                }


                if (element.matches(AVATAR_IMG_SELECTOR)) {
                    line += ' [アバター ' + (element.getAttribute('src') || '').split('/').slice(-2).join('/') + ']';
                }


                lines.push(line);
            }


            for (const child of element.children) {
                walk(child, interesting ? depth + 1 : depth);
            }
        };


        for (const layer of layerRoots()) {

            for (const child of layer.children) {
                walk(child, 0);
            }
        }


        if (!lines.length) {
            return;
        }


        /*
         * メニュー・ドロワーを写した記録は、小さな通知などで上書きしない
         * （同じくメニュー・ドロワーを写したときか、1分経ったときだけ差し替える）
         */
        const overlay = openOverlays().length > 0;

        if (
            lastSnapshot &&
            lastSnapshot.overlay &&
            !overlay &&
            Date.now() - (lastSnapshot.savedAt || 0) < 60 * 1000
        ) {
            return;
        }


        lastSnapshot = {
            at: new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' }),
            savedAt: Date.now(),
            page: location.pathname,
            overlay,
            lines
        };


        writeJson(sessionStorage, SESSION_SNAPSHOT, lastSnapshot);
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

        const overlays = openOverlays();

        lines.push('■ いま開いているメニュー・ドロワー: ' + overlays.length + '件');

        for (const overlay of overlays) {
            lines.push('  ' + describe(overlay).slice(0, 80));
        }


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

        let candidates = 0;

        for (const layer of layers) {

            for (const entry of accountEntries(layer)) {

                candidates++;

                lines.push('  @' + entry.handle + '（' + entry.source + '）' + describe(entry.element));
            }
        }


        if (!candidates) {
            lines.push('  （なし）');
        }


        lines.push('');

        lines.push('■ 直近の切替の記録');

        if (!switchLog.length) {
            lines.push('  （なし）');
        }

        for (const entry of switchLog) {
            lines.push(
                '  ' + entry.時刻 +
                (entry.ページ ? ' [' + entry.ページ + ']' : '') +
                ' ' + entry.段階 +
                (entry.詳細 ? ': ' + entry.詳細 : '')
            );
        }


        lines.push('');

        if (lastSnapshot) {

            lines.push(
                '■ 最後に開いていたメニュー・ドロワーの構造（' + lastSnapshot.at + ' 時点' +
                (lastSnapshot.page ? '、' + lastSnapshot.page : '') +
                '、' + lastSnapshot.lines.length + '行。上下のバーは省略）'
            );

            lines.push(...lastSnapshot.lines);

        } else {

            lines.push('■ メニュー・ドロワーの構造: まだ記録なし（「読込を試す」か、左上のアイコンを押すと記録される）');
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
                    bottom: '8px',
                    maxHeight: '40vh',
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


        /*
         * 左上のアイコンを隠さないよう、パネルは画面下に置く。
         * 下にあるドックの「読込」を覆うので、同じ操作をここにも置く
         */
        buttons.append(
            copyButton,
            makePanelButton('読込を試す', loadFromNative),
            makePanelButton('閉じる', closePanel)
        );


        const area = document.createElement('textarea');

        area.value = report;

        area.readOnly = true;


        Object.assign(
            area.style,
            {
                width: '100%',
                height: '24vh',
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

            load: loadFromNative,

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
