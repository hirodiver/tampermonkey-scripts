// ==UserScript==
// @name         X YouTube Card - Open in Browser
// @namespace    local.hiro.tools
// @version      3.3.0
// @description  X(Twitter)のYouTubeカードに「YouTubeで開く」ボタンを追加し、X内プレイヤーではなくブラウザで開けるようにする
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      cdn.syndication.twimg.com
// @connect      publish.x.com
// @connect      publish.twitter.com
// @connect      x.com
// @connect      *
// @inject-into  page
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // -----------------------------------------------------------------------
  // 設定
  // -----------------------------------------------------------------------

  const DEBUG = false;

  // 'browser' … 常にSafariで開く（iOSのUniversal Linkを発火させない）
  // 'app'     … 可能ならYouTubeアプリで開く
  const OPEN_TARGET = 'browser';

  // カードが表示領域に近づいた時点でURL取得を先行させる
  const PREFETCH_ON_VIEW = true;
  const MAX_INFLIGHT = 3;
  const BTN_LABEL = '▶ YouTubeで開く';
  const PREFIX = 'hiroYtOpen';
  const SCAN_DELAY = 200;
  const REQ_TIMEOUT = 8000;

  const CLASS = {
    button: `${PREFIX}-btn`,
    overlay: `${PREFIX}-overlay`,
    host: `${PREFIX}-host`,
  };

  const SELECTOR = {
    card: '[data-testid="card.wrapper"]',
    youtubeLink:
      'a[href*="youtube.com/watch"], ' +
      'a[href*="youtu.be/"], ' +
      'a[href*="youtube.com/shorts"], ' +
      'a[href*="youtube.com/live/"]',
    youtubeAnyLink:
      'a[href*="youtube.com"], ' +
      'a[href*="youtu.be"]',
    youtubeIframe: 'iframe[src*="youtube.com"]',
    youtubeEmbedIframe: 'iframe[src*="youtube.com/embed/"]',
    tcoLink: 'a[href^="https://t.co/"]',
    statusLink: 'a[href*="/status/"]',
    tweetText: '[data-testid="tweetText"]',
  };

  const YT_RE =
    /https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?|live\/|shorts\/|embed\/)[^\s"'\\]*|youtu\.be\/[^\s"'\\]+)/;

  const STATUS_RE =
    /^https?:\/\/(?:[\w-]+\.)?(?:x|twitter)\.com\/([^/]+)\/status\/(\d+)/;

  // カード下部のドメイン表記。「YouTube」を含むだけのタイトルと区別する。
  const YT_DOMAIN_RE = /^(?:www\.|m\.)?(?:youtube\.com|youtu\.be)$/i;

  const log = (...args) => {
    if (DEBUG) {
      console.log(`[${PREFIX}]`, ...args);
    }
  };

  // -----------------------------------------------------------------------
  // スタイル
  // -----------------------------------------------------------------------

  function injectStyle() {
    const style = document.createElement('style');

    style.setAttribute(`data-${PREFIX}`, 'style');

    // 配色はXのテーマ変数（--color-…は存在しないため）ではなく
    // color-scheme に追従させる。ライト／ダークいずれでも視認できる青。
    style.textContent = `
.${CLASS.button} {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 0 0 6px 0;
  padding: 4px 10px;
  border: none;
  border-radius: 5px;
  background: #3b5bdb;
  color: #fff;
  cursor: pointer;
  font-family: "Noto Sans JP", sans-serif;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.4;
  text-decoration: none;
  -webkit-tap-highlight-color: transparent;
  opacity: .85;
  transition: opacity .14s, background .14s;
}

.${CLASS.button}:hover,
.${CLASS.button}:focus-visible {
  opacity: 1;
  background: #2f4ac4;
  text-decoration: none;
}

@media (prefers-color-scheme: dark) {
  .${CLASS.button} {
    background: #4c6ef5;
    box-shadow: 0 0 0 1px rgba(255,255,255,.14) inset;
  }

  .${CLASS.button}:hover,
  .${CLASS.button}:focus-visible {
    background: #5c7cfa;
  }
}

/* 展開前：カード右上に重ねる */
.${CLASS.button}.${CLASS.overlay} {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 5;
  margin: 0;
  opacity: .78;
  box-shadow: 0 1px 3px rgba(30,40,80,.25);
}

.${CLASS.host} {
  position: relative;
}
`;

    (document.head || document.documentElement).appendChild(style);
  }

  // -----------------------------------------------------------------------
  // React内部stateからのURL抽出
  // -----------------------------------------------------------------------

  /**
   * オブジェクトを深さ制限付きで再帰探索し、
   * 最初に見つかったYouTube URLを返す。
   *
   * seen は探索の起点ごとに新規作成する。
   * 使い回すと、深さ上限で打ち切った枝が「訪問済み」として残り、
   * 別の起点から浅い深さで到達できたはずのURLを取りこぼす。
   */
  function findYtUrlDeep(obj, depth, seen) {
    if (obj == null || depth > 6) {
      return null;
    }

    if (typeof obj === 'string') {
      const match = obj.match(YT_RE);
      return match ? match[0] : null;
    }

    if (typeof obj !== 'object') {
      return null;
    }

    if (seen.has(obj)) {
      return null;
    }

    seen.add(obj);

    if (Array.isArray(obj)) {
      const length = Math.min(obj.length, 60);

      for (let i = 0; i < length; i++) {
        const url = findYtUrlDeep(obj[i], depth + 1, seen);

        if (url) {
          return url;
        }
      }

      return null;
    }

    // 巨大なReact内部オブジェクトを避けるためキー数で足切り
    const keys = Object.keys(obj);

    if (keys.length > 120) {
      return null;
    }

    for (const key of keys) {
      if (
        key === 'stateNode' ||
        key === '_owner' ||
        key === 'return' ||
        key === 'child'
      ) {
        continue;
      }

      let value;

      try {
        value = obj[key];
      } catch {
        continue;
      }

      const url = findYtUrlDeep(value, depth + 1, seen);

      if (url) {
        return url;
      }
    }

    return null;
  }

  function reactKey(element, prefix) {
    for (const key in element) {
      if (key.indexOf(prefix) === 0) {
        return key;
      }
    }

    return null;
  }

  /**
   * 要素から上位DOM要素を遡り、
   * React props / fiber 内のYouTube URLを探す。
   *
   * stopAt を渡すと、その要素より上へは遡らない。
   * 1つの article に複数カードがある場合、
   * article まで遡ると隣のカードのURLを拾ってしまうため。
   *
   * ページコンテキストで実行されていないと
   * __reactProps$ / __reactFiber$ は参照できず、常にnullを返す。
   */
  function urlFromReact(element, stopAt) {
    let node = element;

    for (let up = 0; node && up < 12; up++) {
      const propsKey = reactKey(node, '__reactProps$');

      if (propsKey) {
        const url = findYtUrlDeep(node[propsKey], 0, new WeakSet());

        if (url) {
          return url;
        }
      }

      const fiberKey = reactKey(node, '__reactFiber$');

      if (fiberKey) {
        let fiber = node[fiberKey];

        for (let i = 0; fiber && i < 20; i++) {
          const url = findYtUrlDeep(fiber.memoizedProps, 0, new WeakSet());

          if (url) {
            return url;
          }

          fiber = fiber.return;
        }
      }

      if (stopAt && node === stopAt) {
        return null;
      }

      node = node.parentElement;
    }

    return null;
  }

  // -----------------------------------------------------------------------
  // URL正規化
  // -----------------------------------------------------------------------

  /**
   * embed / live / shorts / youtu.be を watch?v= 形式へ揃える。
   *
   * 再生位置の t / start は引き継ぐ。
   * si 等のトラッキングパラメータは落とす。
   * watch形式やそれ以外はそのまま返す。
   */
  function normalizeYtUrl(url) {
    if (!url) {
      return url;
    }

    const match = url.match(
      /(?:youtube\.com\/(?:embed|live|shorts)\/|youtu\.be\/)([\w-]{6,})/
    );

    if (!match) {
      return url;
    }

    let t = null;

    try {
      const params = new URL(url, location.origin).searchParams;

      // embedでは start=秒 が使われる場合がある
      t = params.get('t') || params.get('start');
    } catch {
      // 解析できなければ位置指定なし
    }

    const normalized = `https://www.youtube.com/watch?v=${match[1]}`;

    return t ? `${normalized}&t=${encodeURIComponent(t)}` : normalized;
  }

  function isYtUrl(url) {
    return typeof url === 'string' && YT_RE.test(url);
  }

  // -----------------------------------------------------------------------
  // 通信
  // -----------------------------------------------------------------------

  function gmRequest(url) {
    return new Promise((resolve) => {
      const request =
        typeof GM_xmlhttpRequest === 'function'
          ? GM_xmlhttpRequest
          : (typeof GM !== 'undefined' && GM && GM.xmlHttpRequest)
            ? GM.xmlHttpRequest.bind(GM)
            : null;

      if (!request) {
        log('GM_xmlhttpRequestが利用できない');
        resolve(null);
        return;
      }

      try {
        request({
          method: 'GET',
          url,
          timeout: REQ_TIMEOUT,
          onload: (res) => {
            if (res.status >= 200 && res.status < 300) {
              resolve(res.responseText);
              return;
            }

            log('HTTPエラー', res.status, url);
            resolve(null);
          },
          onerror: (e) => {
            log('通信エラー', url, e);
            resolve(null);
          },
          ontimeout: () => {
            log('タイムアウト', url);
            resolve(null);
          },
        });
      } catch (e) {
        log('リクエスト送出に失敗', e);
        resolve(null);
      }
    });
  }

  // -----------------------------------------------------------------------
  // syndication API（主経路）
  // -----------------------------------------------------------------------

  // react-tweet と同じ算出式。検証は緩く、値が多少ずれても通る。
  function syndicationToken(id) {
    return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
  }

  /**
   * ツイートJSONからYouTube URLを取り出す。
   *
   * entities.urls[].expanded_url は t.co 展開済みなので、
   * ここで取れればt.coの推測が一切不要になる。
   *
   * 1ツイートに複数のYouTubeリンクがある場合に備え、
   * 見つかったものを順序どおりすべて返す。
   * 呼び出し側がカードの位置に対応する1件を選ぶ。
   */
  function pickYtFromTweetJson(json) {
    const found = [];
    const push = (url) => {
      if (url && found.indexOf(url) === -1) {
        found.push(url);
      }
    };

    const urls = (json && json.entities && json.entities.urls) || [];

    for (const entry of urls) {
      const expanded = entry && entry.expanded_url;

      if (isYtUrl(expanded)) {
        push(expanded.match(YT_RE)[0]);
      }
    }

    // カードのbinding_values等に入っている場合の保険
    try {
      const text = JSON.stringify(json);
      const global = new RegExp(YT_RE.source, 'g');
      let match;

      while ((match = global.exec(text)) !== null) {
        push(match[0]);
      }
    } catch {
      // 循環参照等は無視
    }

    return found;
  }

  function fetchFromSyndication(id) {
    const url =
      'https://cdn.syndication.twimg.com/tweet-result' +
      `?id=${encodeURIComponent(id)}` +
      '&lang=ja' +
      `&token=${encodeURIComponent(syndicationToken(id))}`;

    return gmRequest(url).then((text) => {
      if (!text) {
        return [];
      }

      try {
        return pickYtFromTweetJson(JSON.parse(text));
      } catch (e) {
        log('syndicationのJSON解析に失敗', e);
        return [];
      }
    });
  }

  // -----------------------------------------------------------------------
  // oEmbed（第2フォールバック）
  // -----------------------------------------------------------------------

  function fetchFromOembed(permalink) {
    const url =
      'https://publish.x.com/oembed?omit_script=1&url=' +
      encodeURIComponent(permalink);

    return gmRequest(url).then((text) => {
      if (!text) {
        return [];
      }

      try {
        const html = JSON.parse(text).html || '';

        // 本文中のYouTube直URL、無ければ t.co を拾う
        const direct = html.match(new RegExp(YT_RE.source, 'g'));

        if (direct) {
          return direct;
        }

        const tco = html.match(/https:\/\/t\.co\/\w+/g);

        return tco || [];
      } catch (e) {
        log('oEmbedのJSON解析に失敗', e);
        return [];
      }
    });
  }

  // -----------------------------------------------------------------------
  // 取得結果のキャッシュ
  // -----------------------------------------------------------------------

  // in-flight の Promise ごと共有し、連打でも1リクエストに収める。
  // 失敗はキャッシュしない（一時的な遮断で永久に失敗し続けるのを防ぐ）。
  const fetchCache = new Map();

  /**
   * ツイートIDから、そのツイートに含まれるYouTube URLの一覧を返す。
   * 1件も取れなければ空配列。
   */
  function fetchTweetUrls(id, permalink) {
    if (fetchCache.has(id)) {
      return fetchCache.get(id);
    }

    const task = fetchFromSyndication(id)
      .then((found) => {
        if (found.length) {
          return found;
        }

        return permalink ? fetchFromOembed(permalink) : [];
      })
      .then((found) => {
        if (!found.length) {
          fetchCache.delete(id);
          return [];
        }

        return found.map(normalizeYtUrl);
      })
      .catch((e) => {
        log('取得処理で例外', e);
        fetchCache.delete(id);
        return [];
      });

    fetchCache.set(id, task);

    return task;
  }

  // -----------------------------------------------------------------------
  // ツイート特定
  // -----------------------------------------------------------------------

  function findStatus(article) {
    if (!article) {
      return null;
    }

    const anchors = article.querySelectorAll(SELECTOR.statusLink);

    for (const anchor of anchors) {
      const match = anchor.href.match(STATUS_RE);

      if (match) {
        return {
          id: match[2],
          permalink: `https://x.com/${match[1]}/status/${match[2]}`,
        };
      }
    }

    return null;
  }

  // -----------------------------------------------------------------------
  // YouTubeカード判定
  // -----------------------------------------------------------------------

  /**
   * ドメイン表記（カード下部の "youtube.com" 等）を厳密に見る。
   * textContent 全体の緩い判定だと、
   * タイトルに「YouTube」を含む別ドメインのカードを誤検出する。
   */
  function hasYouTubeDomainLabel(card) {
    const spans = card.querySelectorAll('span, div');

    for (const span of spans) {
      if (span.childElementCount > 0) {
        continue;
      }

      const text = (span.textContent || '').trim();

      if (text && text.length <= 24 && YT_DOMAIN_RE.test(text)) {
        return true;
      }
    }

    return false;
  }

  function isYouTubeCard(card) {
    if (card.querySelector(SELECTOR.youtubeAnyLink)) {
      return true;
    }

    if (card.querySelector(SELECTOR.youtubeIframe)) {
      return true;
    }

    return hasYouTubeDomainLabel(card);
  }

  // -----------------------------------------------------------------------
  // URL解決（DOM／React）
  // -----------------------------------------------------------------------

  /**
   * 戻り値: { url, weak } / null
   *
   * weak:true は t.co のような「YouTube URLと確定していない」結果。
   * ボタンは出せるが、非同期経路の結果で上書きしてよい。
   *
   * 優先順位：
   * 1. カード内のYouTube直リンク
   * 2. カード内のYouTube iframe
   * 3. React内部state（カードより上へは遡らない）
   * 4. カード内 t.co（weak）
   * 5. ツイート本文内 t.co（weak・本文中に1本だけの場合のみ）
   */
  function resolveFromDom(card, article) {
    const direct = card.querySelector(SELECTOR.youtubeLink);

    if (direct) {
      return { url: normalizeYtUrl(direct.href), weak: false };
    }

    const iframe = card.querySelector(SELECTOR.youtubeEmbedIframe);

    if (iframe) {
      const match = iframe.src.match(/\/embed\/([\w-]{6,})/);

      if (match) {
        return {
          url: `https://www.youtube.com/watch?v=${match[1]}`,
          weak: false,
        };
      }
    }

    const fromReact = urlFromReact(card, card.parentElement);

    if (fromReact) {
      return { url: normalizeYtUrl(fromReact), weak: false };
    }

    const tcoInCard = card.querySelector(SELECTOR.tcoLink);

    if (tcoInCard) {
      return { url: tcoInCard.href, weak: true };
    }

    // 本文の t.co は、どのリンクがこのカードのものか特定できない。
    // 候補が1本のときだけ採用する。
    if (article) {
      const text = article.querySelector(SELECTOR.tweetText);
      const scope = text || article;
      const tcos = scope.querySelectorAll(SELECTOR.tcoLink);

      if (tcos.length === 1) {
        return { url: tcos[0].href, weak: true };
      }
    }

    return null;
  }

  // -----------------------------------------------------------------------
  // カード単位の状態
  // -----------------------------------------------------------------------

  /**
   * 状態は card.wrapper 単位で WeakMap に持つ。
   *
   * article の data 属性に持たせると、
   *   - 1 article 内に複数カードがある構成で先行カードのURLが共用される
   *   - Xの仮想リストがDOMを再利用したとき古いURLが張り付く
   * という2つの不具合が同時に出る。
   *
   * tweetId を併記し、再利用で別ツイートになった場合は状態を捨てる。
   */
  const cardState = new WeakMap();

  function stateOf(card, article) {
    const status = findStatus(article);
    const id = status ? status.id : null;

    let state = cardState.get(card);

    if (state && state.tweetId !== id) {
      // DOM再利用で別のツイートに化けた
      log('状態を破棄（ツイート変化）', state.tweetId, '->', id);
      state = null;
    }

    if (!state) {
      state = {
        tweetId: id,
        permalink: status ? status.permalink : null,
        url: null,
        weak: false,
        tried: false,
        watched: false,
      };

      cardState.set(card, state);
    }

    // 遅れて status リンクが現れる場合がある
    if (!state.tweetId && id) {
      state.tweetId = id;
      state.permalink = status.permalink;
    }

    return state;
  }

  /** そのarticle内で、このカードが何番目のYouTubeカードか */
  function cardIndex(card, article) {
    if (!article) {
      return 0;
    }

    const cards = Array.from(article.querySelectorAll(SELECTOR.card)).filter(
      isYouTubeCard
    );

    const index = cards.indexOf(card);

    return index < 0 ? 0 : index;
  }

  function applyFetched(card, article, state, urls) {
    if (!urls.length) {
      return null;
    }

    const index = cardIndex(card, article);
    const picked = urls[index] || urls[0];

    state.url = picked;
    state.weak = false;

    return picked;
  }

  // -----------------------------------------------------------------------
  // タブを開く
  // -----------------------------------------------------------------------

  /**
   * reserved:
   *   クリック時に同期的に確保しておいた空タブ。
   *   非同期取得のあとに window.open を呼ぶとブロックされるため、
   *   先に確保しておいてURLを流し込む。
   */
  function openUrl(url, reserved) {
    // ブラウザ固定：
    // 遷移をユーザー操作の外へ追い出すとUniversal Linkが発火せず、
    // YouTubeアプリへ奪われずにSafariで開く。
    if (OPEN_TARGET === 'browser') {
      const tab =
        reserved && !reserved.closed ? reserved : window.open('', '_blank');

      if (!tab) {
        window.setTimeout(() => {
          location.href = url;
        }, 0);

        return;
      }

      window.setTimeout(() => {
        tab.location = url;
      }, 0);

      return;
    }

    // アプリ優先：
    // ユーザー操作内の window.open ならUniversal Linkが発火する。
    if (!reserved) {
      const opened = window.open(url, '_blank');

      if (opened) {
        try {
          opened.opener = null;
        } catch {
          // 参照できなくても問題ない
        }

        return;
      }

      location.href = url;
      return;
    }

    // 非同期取得後は確保済みタブへ流し込むしかなく、
    // この経路だけはUniversal Linkが発火せずSafariで開く。
    if (!reserved.closed) {
      reserved.location = url;
      return;
    }

    location.href = url;
  }

  // -----------------------------------------------------------------------
  // 先読み
  // -----------------------------------------------------------------------

  let inflight = 0;

  function prefetch(card) {
    if (!PREFETCH_ON_VIEW || !card.isConnected) {
      return;
    }

    const article = card.closest('article');
    const state = stateOf(card, article);

    // weak（t.co止まり）なら、確定URLを取りに行く価値がある
    if ((state.url && !state.weak) || state.tried) {
      return;
    }

    if (inflight >= MAX_INFLIGHT || !state.tweetId) {
      return;
    }

    state.tried = true;
    inflight++;

    fetchTweetUrls(state.tweetId, state.permalink).then((urls) => {
      inflight--;

      const found = applyFetched(card, article, state, urls);

      if (found) {
        syncHref(card, found);
        log('prefetched', found);
      }
    });
  }

  const viewObserver =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (entry.isIntersecting) {
                prefetch(entry.target);
              }
            }
          },
          { rootMargin: '400px 0px' }
        )
      : null;

  function watchForPrefetch(card, state) {
    if (!viewObserver || state.watched) {
      return;
    }

    state.watched = true;
    viewObserver.observe(card);
  }

  // -----------------------------------------------------------------------
  // ボタン
  // -----------------------------------------------------------------------

  // ボタン → 対応するカード
  const buttonCard = new WeakMap();
  // カード → 設置済みボタン
  const cardButton = new WeakMap();

  function syncHref(card, url) {
    const button = cardButton.get(card);

    if (button && url && isYtUrl(url)) {
      button.href = url;
    }
  }

  function showFailure(button, label) {
    button.textContent = label;

    window.setTimeout(() => {
      if (button.isConnected) {
        button.textContent = BTN_LABEL;
      }
    }, 1800);
  }

  /**
   * target:
   *   ボタン設置の基準要素
   *
   * overlay:
   *   true  → target内右上に重ねる
   *   false → target直前に挿入
   *
   * 要素は <a href> にしてある。
   * URLが確定していれば中クリック・長押しでのリンクコピーが効く。
   * 通常クリックだけは openUrl() の経路（Safari固定）に流す。
   */
  function addButton(card, target, article, overlay) {
    const state = stateOf(card, article);
    const button = document.createElement('a');

    button.className = overlay
      ? `${CLASS.button} ${CLASS.overlay}`
      : CLASS.button;

    button.textContent = BTN_LABEL;
    button.setAttribute('role', 'button');
    button.setAttribute('aria-label', 'YouTubeをブラウザで開く');
    button.setAttribute('target', '_blank');
    button.setAttribute('rel', 'noopener noreferrer');

    if (state.url && isYtUrl(state.url)) {
      button.href = state.url;
    }

    buttonCard.set(button, card);
    cardButton.set(card, button);

    // カード／ツイート本体へのクリック伝播を防ぐ。
    // あわせて、押した時点で取得を先行させておく。
    const onPointerDown = (event) => {
      event.stopPropagation();

      const current = stateOf(card, article);

      if (current.url && !current.weak) {
        return;
      }

      if (current.tweetId) {
        fetchTweetUrls(current.tweetId, current.permalink).then((urls) => {
          const found = applyFetched(card, article, current, urls);

          if (found) {
            syncHref(card, found);
          }
        });
      }
    };

    button.addEventListener('mousedown', (e) => e.stopPropagation(), true);
    button.addEventListener('pointerdown', onPointerDown, true);

    button.addEventListener(
      'click',
      (event) => {
        // 中クリック・修飾キー付きはブラウザ既定に任せる
        // （href が入っていれば新規タブで開く）
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          event.stopPropagation();
          return;
        }

        event.preventDefault();
        event.stopPropagation();

        const current = stateOf(card, article);

        // 記録済みURL、無ければその場でDOM／Reactから解決
        let ready = current.url;

        if (!ready) {
          const resolved = resolveFromDom(card, article);

          if (resolved) {
            current.url = resolved.url;
            current.weak = resolved.weak;
            ready = resolved.url;
            syncHref(card, ready);
          }
        }

        if (ready) {
          log('open', ready);
          openUrl(ready, null);
          return;
        }

        if (!current.tweetId) {
          showFailure(button, '取得失敗(リンク)');
          log('ツイートIDが見つからない', card);
          return;
        }

        // 非同期取得の前に同期でタブを確保しておく
        const reserved = window.open('', '_blank');

        button.textContent = '取得中…';

        fetchTweetUrls(current.tweetId, current.permalink).then((urls) => {
          if (button.isConnected) {
            button.textContent = BTN_LABEL;
          }

          const found = applyFetched(card, article, current, urls);

          if (!found) {
            if (reserved && !reserved.closed) {
              reserved.close();
            }

            showFailure(button, '取得失敗(API)');
            log('APIからURLを取得できない', current.tweetId);
            return;
          }

          syncHref(card, found);
          log('open (api)', found);
          openUrl(found, reserved);
        });
      },
      true
    );

    if (overlay) {
      target.classList.add(CLASS.host);
      target.appendChild(button);
      return;
    }

    // インライン設置では重ね配置用の指定を残さない
    target.classList.remove(CLASS.host);
    target.parentElement.insertBefore(button, target);
  }

  // -----------------------------------------------------------------------
  // 設置先判定
  // -----------------------------------------------------------------------

  /**
   * 展開前：カード右上にoverlay
   * 展開後：カード直上にinline
   *
   * 展開してもcard.wrapper自体は残り、中身だけiframeへ差し替わる。
   */
  function pickTarget(card) {
    if (card.querySelector('iframe') && card.parentElement) {
      return { el: card, overlay: false };
    }

    return { el: card, overlay: true };
  }

  // -----------------------------------------------------------------------
  // 走査
  // -----------------------------------------------------------------------

  function isOurNode(node) {
    return (
      node &&
      node.nodeType === 1 &&
      (node.classList.contains(CLASS.button) ||
        node.getAttribute(`data-${PREFIX}`) === 'style')
    );
  }

  function scan() {
    document.querySelectorAll(SELECTOR.card).forEach((card) => {
      if (!isYouTubeCard(card)) {
        return;
      }

      const article = card.closest('article');
      const state = stateOf(card, article);

      watchForPrefetch(card, state);

      // URLが取れなくてもボタンは出す。
      // 解決はクリック時にsyndication APIへフォールバックする。
      if (!state.url) {
        const resolved = resolveFromDom(card, article);

        if (resolved) {
          state.url = resolved.url;
          state.weak = resolved.weak;
        }
      }

      const target = pickTarget(card);
      const existing = cardButton.get(card);

      if (existing && existing.isConnected) {
        const isOverlay = existing.classList.contains(CLASS.overlay);
        // overlayはカードの内側、inlineはカードの外側（直前）にある
        const placedInside = card.contains(existing);

        // 展開状態に対して形態も位置も正しいなら作り直さない
        if (isOverlay === target.overlay && placedInside === target.overlay) {
          syncHref(card, state.url);
          return;
        }

        existing.remove();
      }

      addButton(card, target.el, article, target.overlay);

      log('button added', target.overlay ? 'overlay' : 'inline', state.url || '(URL未解決)');
    });
  }

  // -----------------------------------------------------------------------
  // DOM監視
  // -----------------------------------------------------------------------

  let timer = null;

  function schedule() {
    if (timer) {
      return;
    }

    timer = window.setTimeout(() => {
      timer = null;
      scan();
    }, SCAN_DELAY);
  }

  /**
   * 自分が入れたボタン／スタイルだけの変化なら走査しない。
   * scan() は冪等なので実害はないが、無駄な全走査を1回省ける。
   */
  function isSelfInflicted(records) {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!isOurNode(node)) {
          return false;
        }
      }

      for (const node of record.removedNodes) {
        if (!isOurNode(node)) {
          return false;
        }
      }

      if (!record.addedNodes.length && !record.removedNodes.length) {
        return false;
      }
    }

    return true;
  }

  const observer = new MutationObserver((records) => {
    if (isSelfInflicted(records)) {
      return;
    }

    schedule();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // -----------------------------------------------------------------------
  // 初期化
  // -----------------------------------------------------------------------

  injectStyle();
  scan();
})();
