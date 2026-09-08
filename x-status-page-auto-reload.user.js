// ==UserScript==
// @name         X Status Auto Reload
// @namespace    local.hiro.tools
// @version      1.2.0
// @description  タイムラインから個別ポストへ遷移した際に読み込みが固まったら自動で更新する（Control Panel for Twitter等の拡張との競合対策）
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-start
// @inject-into  page
// @noframes
// @homepageURL  https://github.com/hirodiver/tampermonkey-scripts
// @supportURL   https://github.com/hirodiver/tampermonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-status-page-auto-reload.user.js
// @updateURL    https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-status-page-auto-reload.user.js
// ==/UserScript==

(function () {
  'use strict';

  // -----------------------------------------------------------------------
  // 背景
  // -----------------------------------------------------------------------
  //
  // X はタイムライン→個別ポストの遷移をフルページロードではなく、
  // SPA内のクライアントサイドルーティング（history API + 内部フェッチ）で
  // 行っている。Control Panel for Twitter 等、タイムラインのDOMを常時
  // 監視・改変する拡張と組み合わさると、この内部遷移が固まって
  // 個別ポストがいつまでも読み込まれないことがある（フルリロードすれば直る）。
  //
  // 根本原因の拡張側の修正を待つ代わりに、個別ポストのURLに遷移したのに
  // 一定時間コンテンツが表示されない場合、自動で「更新」相当の
  // location.reload() を発行することで対症療法とする。

  const DEBUG = false;

  // 遷移後、画面内のDOMに一切変化がないままこの時間が経過したら、
  // 「完全に固まっている」とみなして早期にリロードする。
  // 正常な読み込み中は（回線が遅くても）通常DOMが動き続けるので、
  // ここは誤発火のリスクが低く、思い切って短くできる。
  const NO_ACTIVITY_TIMEOUT_MS = 700;

  // DOMは動いている（＝読み込み中の兆候がある）が、この時間経っても
  // 本文が表示されない場合の最終判定として使う保険のタイムアウト。
  const STUCK_TIMEOUT_MS = 2500;

  // 保険のポーリング間隔（history APIを介さない遷移への対応）
  const POLL_INTERVAL_MS = 500;

  const STATUS_PATH_RE = /^\/[^/]+\/status\/\d+/;
  const RELOAD_FLAG_PREFIX = 'hiroStatusAutoReload:';

  function log(...args) {
    if (DEBUG) console.log('[hiroStatusAutoReload]', ...args);
  }

  let checkTimer = null;
  let noActivityTimer = null;
  let mutationObserver = null;
  let hasActivity = false;
  let watchedPath = null;

  function isStatusPage(pathname) {
    return STATUS_PATH_RE.test(pathname);
  }

  function hasTweetContent() {
    // タイムラインと個別ポストページで共通して使われるツイート本体の要素
    return !!document.querySelector(
      'article[data-testid="tweet"], article[data-testid="tweetDetail"]'
    );
  }

  function stopWatching() {
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
    if (noActivityTimer) {
      clearTimeout(noActivityTimer);
      noActivityTimer = null;
    }
    if (checkTimer) {
      clearTimeout(checkTimer);
      checkTimer = null;
    }
  }

  function reloadKey(path) {
    return RELOAD_FLAG_PREFIX + path;
  }

  function clearReloadFlag(path) {
    try {
      sessionStorage.removeItem(reloadKey(path));
    } catch (e) {
      /* no-op */
    }
  }

  function alreadyReloaded(path) {
    try {
      return sessionStorage.getItem(reloadKey(path)) === '1';
    } catch (e) {
      return false;
    }
  }

  function markReloaded(path) {
    try {
      sessionStorage.setItem(reloadKey(path), '1');
    } catch (e) {
      /* no-op */
    }
  }

  function finishWatching(path) {
    log('content loaded, no reload needed', path);
    clearReloadFlag(path);
    stopWatching();
  }

  function reloadNow(path, reason) {
    if (alreadyReloaded(path)) {
      log('already reloaded once for this path, giving up', path);
      stopWatching();
      return;
    }

    log(reason, path);
    markReloaded(path);
    stopWatching();
    location.reload();
  }

  function scheduleCheck(path) {
    stopWatching();
    hasActivity = false;

    mutationObserver = new MutationObserver(() => {
      hasActivity = true;
    });
    // document-start 実行時は document.body がまだ存在しないことがあるため、
    // 常に存在する documentElement を監視する（subtree指定なのでbody追加も拾える）
    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    // 第1段階: 画面が完全に無反応のまま短時間経過したら早期にリロード
    noActivityTimer = setTimeout(() => {
      noActivityTimer = null;
      if (location.pathname !== path) return;

      if (hasTweetContent()) {
        finishWatching(path);
        return;
      }

      if (!hasActivity) {
        reloadNow(path, 'no DOM activity detected, reloading early');
      }
      // hasActivity が true の場合は読み込み中の兆候ありとみなし、
      // 下の第2段階（STUCK_TIMEOUT_MS）の判定に委ねる
    }, NO_ACTIVITY_TIMEOUT_MS);

    // 第2段階: DOMは動いているが本文が出ない場合の最終判定
    checkTimer = setTimeout(() => {
      checkTimer = null;
      if (location.pathname !== path) return;

      if (hasTweetContent()) {
        finishWatching(path);
        return;
      }

      reloadNow(path, 'stuck loading detected, reloading');
    }, STUCK_TIMEOUT_MS);
  }

  function onLocationChange() {
    const path = location.pathname;
    if (path === watchedPath) return;
    watchedPath = path;

    stopWatching();

    if (!isStatusPage(path)) return;

    log('navigated to status page', path);
    scheduleCheck(path);
  }

  // SPA内遷移（history.pushState / replaceState）を検知する
  const rawPushState = history.pushState;
  const rawReplaceState = history.replaceState;

  history.pushState = function (...args) {
    const result = rawPushState.apply(this, args);
    onLocationChange();
    return result;
  };

  history.replaceState = function (...args) {
    const result = rawReplaceState.apply(this, args);
    onLocationChange();
    return result;
  };

  window.addEventListener('popstate', onLocationChange);

  // 保険: history APIを介さない遷移にも対応するためポーリングも併用
  setInterval(onLocationChange, POLL_INTERVAL_MS);

  // 初回ロード時点で既に個別ポストページを開いている場合も監視対象にする
  onLocationChange();
})();
