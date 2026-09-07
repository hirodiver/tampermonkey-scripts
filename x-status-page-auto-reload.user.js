// ==UserScript==
// @name         X Status Page - Auto Reload on Stuck Loading
// @namespace    local.hiro.tools
// @version      1.0.0
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

  // 個別ポストページに遷移してから、この時間内に本文が表示されなければ
  // 自動更新する。短すぎると通常の回線遅延で誤発火するので余裕を持たせる。
  const STUCK_TIMEOUT_MS = 2500;

  // 保険のポーリング間隔（history APIを介さない遷移への対応）
  const POLL_INTERVAL_MS = 500;

  const STATUS_PATH_RE = /^\/[^/]+\/status\/\d+/;
  const RELOAD_FLAG_PREFIX = 'hiroStatusAutoReload:';

  function log(...args) {
    if (DEBUG) console.log('[hiroStatusAutoReload]', ...args);
  }

  let checkTimer = null;
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

  function scheduleCheck(path) {
    if (checkTimer) {
      clearTimeout(checkTimer);
    }

    checkTimer = setTimeout(() => {
      checkTimer = null;

      // タイマー発火時点で既に別ページへ移動していたら何もしない
      if (location.pathname !== path) return;

      if (hasTweetContent()) {
        log('content loaded, no reload needed', path);
        clearReloadFlag(path);
        return;
      }

      if (alreadyReloaded(path)) {
        log('already reloaded once for this path, giving up', path);
        return;
      }

      log('stuck loading detected, reloading', path);
      markReloaded(path);
      location.reload();
    }, STUCK_TIMEOUT_MS);
  }

  function onLocationChange() {
    const path = location.pathname;
    if (path === watchedPath) return;
    watchedPath = path;

    if (checkTimer) {
      clearTimeout(checkTimer);
      checkTimer = null;
    }

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
