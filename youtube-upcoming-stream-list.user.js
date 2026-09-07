// ==UserScript==
// @name         YouTube 登録チャンネル 配信予定リスト
// @namespace    https://www.youtube.com/
// @version      4.1
// @description  登録チャンネルの本日開始・配信中・今後の配信を開始日時順に一覧表示
// @match        https://www.youtube.com/*
// @grant        none
// @run-at       document-idle
// @homepageURL  https://github.com/hirodiver/tampermonkey-scripts
// @supportURL   https://github.com/hirodiver/tampermonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/youtube-upcoming-stream-list.user.js
// @updateURL    https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/youtube-upcoming-stream-list.user.js
// ==/UserScript==

(() => {
    'use strict';

    const PANEL_ID = 'tm-upcoming-stream-list';
    const CONCURRENCY = 6;
    const RETRY_MS = 5 * 60 * 1000;

    // videoId -> { date, isLiveContent, fetchedAt }
    const cache = new Map();
    const pending = new Map();

    let timer = null;
    let building = false;
    let rebuildRequested = false;

    const isSubscriptionsPage = () =>
        location.pathname === '/feed/subscriptions';


    // ============================================================
    // カード情報
    // ============================================================

    function getVideoId(url) {
        try {
            const u = new URL(url, location.origin);

            if (u.pathname === '/watch') {
                return u.searchParams.get('v');
            }

            return (
                u.pathname.match(/^\/live\/([^/?#]+)/)?.[1] ||
                null
            );
        } catch {
            return null;
        }
    }

    function findFirst(card, selectors) {
        for (const selector of selectors) {
            const el = card.querySelector(selector);
            if (el) return el;
        }

        return null;
    }

    function findVideoLink(card) {
        return (
            findFirst(card, [
                'a.ytLockupViewModelContentImage[href*="/watch"]',
                'a.yt-lockup-view-model__content-image[href*="/watch"]',
                'a#thumbnail[href*="/watch"]',
                'a#video-title-link[href*="/watch"]',
                'a#video-title[href*="/watch"]',
                'a[href*="/watch?v="]',
                'a[href*="/live/"]'
            ])?.href ||
            null
        );
    }

    function findTitle(card) {
        const el = findFirst(card, [
            '.ytLockupMetadataViewModelTitle',
            '.yt-lockup-metadata-view-model__title',
            'yt-lockup-metadata-view-model h3',
            '#video-title'
        ]);

        if (el) {
            return (
                el.getAttribute('title') ||
                el.textContent?.trim() ||
                'タイトル不明'
            );
        }

        return (
            card
                .querySelector('a[href*="/watch"][aria-label]')
                ?.getAttribute('aria-label') ||
            'タイトル不明'
        );
    }

    function findChannel(card) {
        const el = findFirst(card, [
            'yt-lockup-metadata-view-model a[href^="/@"]',
            'yt-lockup-metadata-view-model a[href^="/channel/"]',
            '.ytContentMetadataViewModelMetadataRow a[href^="/@"]',
            '.ytContentMetadataViewModelMetadataRow a[href^="/channel/"]',
            'ytd-channel-name a',
            '#channel-name a'
        ]);

        return (
            el?.textContent?.trim() ||
            'チャンネル名不明'
        );
    }


    // ============================================================
    // 現在配信中判定
    // タイトル中の「LIVE」「配信中」は見ない
    // ============================================================

    function isLive(card) {
        if (
            card.querySelector(
                '[overlay-style="LIVE"], [data-style="LIVE"]'
            )
        ) {
            return true;
        }

        const badges = card.querySelectorAll(
            [
                'yt-thumbnail-overlay-badge-view-model',
                'yt-badge-shape',
                '.yt-badge-shape__text'
            ].join(',')
        );

        return [...badges].some(el => {
            const text = el.textContent?.trim();

            return (
                text === 'ライブ配信中' ||
                text === '配信中' ||
                text === 'LIVE' ||
                text === 'Live'
            );
        });
    }

    function getInfo(card) {
        const href = findVideoLink(card);
        if (!href) return null;

        const videoId = getVideoId(href);
        if (!videoId) return null;

        const cached = cache.get(videoId);

        return {
            videoId,
            href,
            title: findTitle(card),
            channel: findChannel(card),
            isLive: isLive(card),
            date: cached?.date || null,
            isLiveContent:
                cached?.isLiveContent ?? null
        };
    }


    // ============================================================
    // YouTube内部API
    // ============================================================

    function getInnertubeContext() {
        try {
            const context =
                window.ytcfg?.get?.(
                    'INNERTUBE_CONTEXT'
                ) ||
                window.yt?.config_
                    ?.INNERTUBE_CONTEXT;

            if (context) return context;
        } catch {}

        return {
            client: {
                clientName: 'WEB',
                clientVersion: '2.20240416.01.00'
            }
        };
    }

    async function fetchLiveInfo(videoId) {
        const cached = cache.get(videoId);

        if (
            cached &&
            (
                cached.isLiveContent === true ||
                (
                    cached.isLiveContent === false &&
                    Date.now() - cached.fetchedAt < RETRY_MS
                )
            )
        ) {
            return cached;
        }

        if (pending.has(videoId)) {
            return pending.get(videoId);
        }

        const promise = (async () => {
            try {
                const response = await fetch(
                    'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type':
                                'application/json'
                        },
                        body: JSON.stringify({
                            context:
                                getInnertubeContext(),
                            videoId
                        })
                    }
                );

                if (!response.ok) {
                    throw new Error(
                        `HTTP ${response.status}`
                    );
                }

                const data =
                    await response.json();

                const details =
                    data
                        ?.microformat
                        ?.playerMicroformatRenderer
                        ?.liveBroadcastDetails;

                const timestamp =
                    details?.startTimestamp;

                const date =
                    timestamp
                        ? new Date(timestamp)
                        : null;

                const validDate =
                    date &&
                    !Number.isNaN(date.getTime())
                        ? date
                        : null;

                const result = {
                    date: validDate,

                    // liveBroadcastDetails が存在すれば
                    // ライブ配信・プレミア等として扱う
                    isLiveContent: !!details,

                    fetchedAt: Date.now()
                };

                cache.set(videoId, result);

                return result;

            } catch (error) {
                console.warn(
                    '[YT Streams] 情報取得失敗:',
                    videoId,
                    error
                );

                const result = {
                    date: null,
                    isLiveContent: false,
                    fetchedAt: Date.now()
                };

                cache.set(videoId, result);

                return result;

            } finally {
                pending.delete(videoId);
            }
        })();

        pending.set(videoId, promise);

        return promise;
    }


    // ============================================================
    // JST
    // ============================================================

    function getJstParts(date) {
        const parts =
            new Intl.DateTimeFormat(
                'ja-JP',
                {
                    timeZone: 'Asia/Tokyo',
                    year: 'numeric',
                    month: 'numeric',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false
                }
            ).formatToParts(date);

        return Object.fromEntries(
            parts
                .filter(
                    part =>
                        part.type !== 'literal'
                )
                .map(
                    part =>
                        [part.type, part.value]
                )
        );
    }

    function getTodayStartJst() {
        const p =
            getJstParts(new Date());

        return new Date(
            Date.UTC(
                Number(p.year),
                Number(p.month) - 1,
                Number(p.day)
            ) -
            9 * 60 * 60 * 1000
        );
    }

    function formatDate(date) {
        const p =
            getJstParts(date);

        const now =
            getJstParts(new Date());

        const today =
            Date.UTC(
                Number(now.year),
                Number(now.month) - 1,
                Number(now.day)
            );

        const target =
            Date.UTC(
                Number(p.year),
                Number(p.month) - 1,
                Number(p.day)
            );

        const diffDays =
            Math.round(
                (target - today) /
                86400000
            );

        const time =
            `${p.hour}:${p.minute}`;

        if (diffDays === 0) {
            return `今日 ${time}`;
        }

        if (diffDays === 1) {
            return `明日 ${time}`;
        }

        return `${p.month}/${p.day} ${time}`;
    }


    // ============================================================
    // 収集・取得・絞り込み
    // ============================================================

    function collectItems() {
        const cards = [
            ...document.querySelectorAll(
                'ytd-rich-item-renderer'
            )
        ];

        /*
         * ここではUPCOMING/LIVEだけに絞らない。
         *
         * 終了済みの本日ライブも拾うため、
         * フィード上の動画カードをすべて候補にする。
         */
        const items =
            cards
                .map(getInfo)
                .filter(Boolean);

        return [
            ...new Map(
                items.map(
                    item =>
                        [item.videoId, item]
                )
            ).values()
        ];
    }

    async function fillLiveInfo(items) {
        let cursor = 0;

        async function worker() {
            while (cursor < items.length) {
                const item =
                    items[cursor++];

                const info =
                    await fetchLiveInfo(
                        item.videoId
                    );

                item.date =
                    info.date;

                item.isLiveContent =
                    info.isLiveContent;
            }
        }

        await Promise.all(
            Array.from(
                {
                    length:
                        Math.min(
                            CONCURRENCY,
                            items.length
                        )
                },
                worker
            )
        );
    }

    function filterItems(items) {
        const todayStart =
            getTodayStartJst();

        return items.filter(item => {
            /*
             * 本当に現在配信中なら、
             * 昨日以前に開始していても残す。
             */
            if (item.isLive) {
                return true;
            }

            /*
             * 通常動画は除外。
             */
            if (!item.isLiveContent) {
                return false;
            }

            /*
             * 開始日時が取れないものも除外。
             */
            if (!item.date) {
                return false;
            }

            /*
             * 本日0:00 JST以降に開始した
             * ライブ系コンテンツを表示。
             *
             * 終了済みでも残る。
             */
            return (
                item.date.getTime() >=
                todayStart.getTime()
            );
        });
    }

    function sortItems(items) {
        items.sort((a, b) => {
            /*
             * 全体として開始日時順。
             *
             * 配信中を無条件に最上段にせず、
             * 本日の履歴も時系列で読めるようにする。
             */
            if (a.date && b.date) {
                return (
                    a.date.getTime() -
                    b.date.getTime()
                );
            }

            if (a.date) return -1;
            if (b.date) return 1;

            return (
                a.channel.localeCompare(
                    b.channel,
                    'ja'
                )
            );
        });
    }


    // ============================================================
    // 表示
    // ============================================================

    function makeCell(text, style = {}) {
        const el =
            document.createElement('span');

        el.textContent = text;

        Object.assign(
            el.style,
            {
                minWidth: '0',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                ...style
            }
        );

        return el;
    }

    function findPanelTarget() {
        return (
            document.querySelector(
                'ytd-browse[page-subtype="subscriptions"] ytd-rich-grid-renderer'
            ) ||
            document.querySelector(
                'ytd-rich-grid-renderer'
            ) ||
            document.querySelector(
                'ytd-browse'
            )
        );
    }

    function render(items, loading = false) {
        const target =
            findPanelTarget();

        if (!target) return;

        let panel =
            document.getElementById(
                PANEL_ID
            );

        if (!panel) {
            panel =
                document.createElement(
                    'section'
                );

            panel.id = PANEL_ID;

            Object.assign(
                panel.style,
                {
                    margin:
                        '16px 24px 24px',

                    padding:
                        '18px 22px',

                    borderRadius:
                        '12px',

                    border:
                        '1px solid var(--yt-spec-10-percent-layer)',

                    background:
                        'var(--yt-spec-base-background)',

                    color:
                        'var(--yt-spec-text-primary)',

                    fontFamily:
                        'Roboto, Arial, sans-serif'
                }
            );
        }

        // Trusted Types対応
        panel.replaceChildren();

        const heading =
            document.createElement(
                'div'
            );

        heading.textContent =
            loading
                ? '本日以降の配信　取得中…'
                : `本日以降の配信　${items.length}件`;

        Object.assign(
            heading.style,
            {
                fontSize: '24px',
                fontWeight: '700',
                marginBottom: '14px'
            }
        );

        panel.appendChild(
            heading
        );


        if (items.length) {
            const header =
                document.createElement(
                    'div'
                );

            Object.assign(
                header.style,
                {
                    display: 'grid',

                    gridTemplateColumns:
                        '190px 270px minmax(0,1fr)',

                    gap: '20px',

                    padding:
                        '0 12px 8px',

                    opacity: '0.6',

                    fontWeight: '600'
                }
            );

            header.append(
                makeCell('配信日時'),
                makeCell('チャンネル'),
                makeCell('配信タイトル')
            );

            panel.appendChild(
                header
            );
        }


        for (const item of items) {
            const row =
                document.createElement(
                    'a'
                );

            row.href =
                item.href;

            Object.assign(
                row.style,
                {
                    display: 'grid',

                    gridTemplateColumns:
                        '190px 270px minmax(0,1fr)',

                    gap: '20px',

                    padding:
                        '11px 12px',

                    borderRadius:
                        '8px',

                    alignItems:
                        'center',

                    color:
                        'inherit',

                    textDecoration:
                        'none',

                    fontSize:
                        '16px'
                }
            );

            row.onmouseenter = () => {
                row.style.background =
                    'var(--yt-spec-badge-chip-background)';
            };

            row.onmouseleave = () => {
                row.style.background = '';
            };


            const dateText =
                item.isLive
                    ? `配信中　${formatDate(item.date)}`
                    : formatDate(item.date);


            row.append(
                makeCell(
                    dateText,
                    {
                        fontWeight:
                            '700'
                    }
                ),

                makeCell(
                    item.channel,
                    {
                        opacity:
                            '0.75'
                    }
                ),

                makeCell(
                    item.title
                )
            );

            panel.appendChild(
                row
            );
        }


        if (
            !loading &&
            !items.length
        ) {
            const empty =
                document.createElement(
                    'div'
                );

            empty.textContent =
                '現在読み込まれている範囲に本日以降の配信はありません。';

            empty.style.opacity =
                '0.65';

            panel.appendChild(
                empty
            );
        }


        if (
            panel.parentElement !==
            target
        ) {
            target.prepend(
                panel
            );
        }
    }


    // ============================================================
    // メイン
    // ============================================================

    async function build() {
        if (
            !isSubscriptionsPage()
        ) {
            document
                .getElementById(
                    PANEL_ID
                )
                ?.remove();

            return;
        }

        if (building) {
            rebuildRequested = true;
            return;
        }

        building = true;

        try {
            const items =
                collectItems();

            /*
             * キャッシュ済みのものだけで
             * まず現在分を描画。
             */
            const cachedItems =
                filterItems(
                    items.map(item => {
                        const cached =
                            cache.get(
                                item.videoId
                            );

                        if (cached) {
                            item.date =
                                cached.date;

                            item.isLiveContent =
                                cached.isLiveContent;
                        }

                        return item;
                    })
                );

            sortItems(
                cachedItems
            );

            render(
                cachedItems,
                true
            );


            /*
             * 未判定動画を含めて
             * ライブ情報を取得。
             */
            await fillLiveInfo(
                items
            );

            if (
                !isSubscriptionsPage()
            ) {
                return;
            }


            const result =
                filterItems(items);

            sortItems(
                result
            );

            render(
                result,
                false
            );

        } finally {
            building = false;

            if (rebuildRequested) {
                rebuildRequested = false;
                scheduleBuild(300);
            }
        }
    }

    function scheduleBuild(
        delay = 600
    ) {
        clearTimeout(timer);

        timer =
            setTimeout(
                build,
                delay
            );
    }


    // ============================================================
    // YouTube SPA / 無限スクロール
    // ============================================================

    document.addEventListener(
        'yt-navigate-finish',
        () =>
            scheduleBuild(500)
    );

    const observer =
        new MutationObserver(
            mutations => {
                if (
                    !isSubscriptionsPage()
                ) {
                    return;
                }

                const changed =
                    mutations.some(
                        mutation =>
                            [
                                ...mutation.addedNodes
                            ].some(
                                node =>
                                    node instanceof
                                        Element &&
                                    (
                                        node.matches?.(
                                            'ytd-rich-item-renderer'
                                        ) ||
                                        node.querySelector?.(
                                            'ytd-rich-item-renderer'
                                        )
                                    )
                            )
                    );

                if (changed) {
                    scheduleBuild();
                }
            }
        );

    function start() {
        observer.observe(
            document.body,
            {
                childList: true,
                subtree: true
            }
        );

        if (
            isSubscriptionsPage()
        ) {
            scheduleBuild(700);
        }
    }

    if (document.body) {
        start();
    } else {
        document.addEventListener(
            'DOMContentLoaded',
            start,
            { once: true }
        );
    }

})();
