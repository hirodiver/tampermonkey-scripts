// ==UserScript==
// @name         YouTube 配信予定リスト v4.6
// @namespace    https://www.youtube.com/
// @version      4.6
// @description  登録チャンネルの本日開始・配信中・今後の配信を開始日時順に一覧表示（本日5時以降・区切り表示・前回リストの保持・キーワード強調）
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
    const COLLAPSE_KEY = 'tm-upcoming-stream-list-collapsed';
    const HIGHLIGHT_KEY = 'tm-upcoming-stream-list-highlight';
    const STORE_KEY = 'tm-upcoming-stream-list-items';
    const STORE_MAX = 300;
    const SECTION_TICK_MS = 60 * 1000;
    const CONCURRENCY = 6;
    const RETRY_MS = 5 * 60 * 1000;

    // videoId -> { date, isLiveContent, fetchedAt }
    const cache = new Map();
    const pending = new Map();

    let collapsed = loadCollapsed();
    let highlightText = loadHighlightText();
    let highlightTerms = parseHighlightTerms(highlightText);

    // 直近に描画した内容
    let lastItems = [];
    let lastLoading = false;

    // 一度でも件数のあるリストを出したか
    let hasShownList = false;

    // 強調ワード入力欄を開いているか
    let highlightOpen = false;

    let timer = null;
    let building = false;
    let rebuildRequested = false;

    const isSubscriptionsPage = () =>
        location.pathname === '/feed/subscriptions';

    function loadCollapsed() {
        try {
            return (
                localStorage.getItem(
                    COLLAPSE_KEY
                ) === '1'
            );
        } catch {
            return false;
        }
    }

    function saveCollapsed(value) {
        try {
            localStorage.setItem(
                COLLAPSE_KEY,
                value ? '1' : '0'
            );
        } catch {}
    }

    function loadHighlightText() {
        try {
            return (
                localStorage.getItem(
                    HIGHLIGHT_KEY
                ) || ''
            );
        } catch {
            return '';
        }
    }

    function saveHighlightText(value) {
        try {
            localStorage.setItem(
                HIGHLIGHT_KEY,
                value
            );
        } catch {}
    }

    function parseHighlightTerms(text) {
        return text
            .split(/\r?\n/)
            .map(line => line.trim().toLowerCase())
            .filter(Boolean);
    }


    /*
     * 取得済みリストの保持。
     *
     * 次回ページを開いたときに、
     * 取得を待たずにまず表示する。
     */
    function saveItems(items) {
        try {
            localStorage.setItem(
                STORE_KEY,
                JSON.stringify({
                    savedAt: Date.now(),

                    items: items
                        .slice(0, STORE_MAX)
                        .map(item => ({
                            videoId: item.videoId,
                            href: item.href,
                            title: item.title,
                            channel: item.channel,

                            /*
                             * 配信中かどうかは時間で
                             * 変わるので保存しない。
                             */
                            isLiveContent: true,

                            date:
                                item.date
                                    ? item.date.toISOString()
                                    : null
                        }))
                })
            );
        } catch {}
    }

    function getStoredMap() {
        return new Map(
            loadStoredItems().map(
                item => [item.videoId, item]
            )
        );
    }

    function loadStoredItems() {
        try {
            const raw =
                localStorage.getItem(STORE_KEY);

            if (!raw) return [];

            const data = JSON.parse(raw);

            if (!Array.isArray(data?.items)) {
                return [];
            }

            return data.items
                .map(item => {
                    const date =
                        item.date
                            ? new Date(item.date)
                            : null;

                    return {
                        videoId: item.videoId,
                        href: item.href,
                        title: item.title || 'タイトル不明',
                        channel: item.channel || 'チャンネル名不明',
                        isLive: false,
                        isLiveContent: true,

                        date:
                            date &&
                            !Number.isNaN(date.getTime())
                                ? date
                                : null
                    };
                })
                .filter(
                    item =>
                        item.videoId && item.href
                );
        } catch {
            return [];
        }
    }


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

    const DAY_START_HOUR = 5;

    function getJstMidnight(date) {
        const p = getJstParts(date);

        return new Date(
            Date.UTC(
                Number(p.year),
                Number(p.month) - 1,
                Number(p.day)
            ) -
            9 * 60 * 60 * 1000
        );
    }

    /*
     * 一覧の起点は「本日5:00 JST」。
     *
     * 深夜0:00〜5:00の間は、まだ前日の
     * 続きとみなして前日5:00を起点にする。
     */
    function getListStartJst() {
        const now = new Date();

        const p = getJstParts(now);

        const start =
            getJstMidnight(now).getTime() +
            DAY_START_HOUR * 60 * 60 * 1000;

        if (
            Number(p.hour) < DAY_START_HOUR
        ) {
            return new Date(
                start - 86400000
            );
        }

        return new Date(start);
    }

    function getJstDayIndex(date) {
        return Math.round(
            getJstMidnight(date).getTime() /
            86400000
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

        if (diffDays === -1) {
            return `昨日 ${time}`;
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
        const listStart =
            getListStartJst();

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
             * 本日5:00 JST以降に開始した
             * ライブ系コンテンツを表示。
             *
             * 終了済みでも残る。
             */
            return (
                item.date.getTime() >=
                listStart.getTime()
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

    const SECTION_LABELS = {
        started: '開始済み',
        today: 'これから（今日）',
        later: '明日以降'
    };

    /*
     * 開始済み / 今日これから / 明日以降
     * の3区分。
     */
    function getSection(item) {
        if (!item.date) return 'later';

        if (
            item.isLive ||
            item.date.getTime() <= Date.now()
        ) {
            return 'started';
        }

        if (
            getJstDayIndex(item.date) ===
            getJstDayIndex(new Date())
        ) {
            return 'today';
        }

        return 'later';
    }

    function makeSectionDivider(
        label,
        spaced
    ) {
        const el =
            document.createElement('div');

        el.textContent = label;

        Object.assign(
            el.style,
            {
                padding: '8px 12px 6px',

                marginTop:
                    spaced ? '14px' : '0',

                borderTop:
                    spaced
                        ? '1px solid var(--yt-spec-10-percent-layer)'
                        : 'none',

                fontSize: '13px',
                fontWeight: '700',
                letterSpacing: '0.04em',
                opacity: '0.6'
            }
        );

        return el;
    }

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

    const GRID_COLUMNS =
        '190px 270px minmax(0,1fr)';


    /*
     * パネルは一度だけ組み立て、
     * 以降は中身だけ差し替える。
     *
     * 入力欄のフォーカスや入力途中の
     * 内容を再描画で失わないため。
     */
    let els = null;

    function buildPanel() {
        const panel =
            document.createElement('section');

        panel.id = PANEL_ID;

        Object.assign(
            panel.style,
            {
                margin: '16px 24px 24px',
                padding: '18px 22px',
                borderRadius: '12px',

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


        const headingRow =
            document.createElement('div');

        Object.assign(
            headingRow.style,
            {
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                marginBottom: '14px'
            }
        );

        const heading =
            document.createElement('div');

        Object.assign(
            heading.style,
            {
                fontSize: '24px',
                fontWeight: '700',
                minWidth: '0',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
            }
        );

        const highlightButton =
            makeChipButton('強調ワード');

        const toggle =
            makeChipButton('リストを非表示');

        headingRow.append(
            heading,
            highlightButton,
            toggle
        );


        const highlightBox =
            document.createElement('div');

        Object.assign(
            highlightBox.style,
            {
                display: 'none',
                marginBottom: '14px'
            }
        );

        const highlightLabel =
            document.createElement('div');

        highlightLabel.textContent =
            '強調したい文字列を改行区切りで入力（タイトル・チャンネル名の部分一致）';

        Object.assign(
            highlightLabel.style,
            {
                fontSize: '13px',
                opacity: '0.65',
                marginBottom: '6px'
            }
        );

        const textarea =
            document.createElement('textarea');

        textarea.rows = 4;
        textarea.spellcheck = false;
        textarea.value = highlightText;

        textarea.placeholder =
            '例）\n〇〇ch\nゲリラ';

        Object.assign(
            textarea.style,
            {
                width: '100%',
                boxSizing: 'border-box',
                padding: '8px 10px',
                borderRadius: '8px',

                border:
                    '1px solid var(--yt-spec-10-percent-layer)',

                background:
                    'var(--yt-spec-badge-chip-background)',

                color:
                    'var(--yt-spec-text-primary)',

                fontFamily: 'inherit',
                fontSize: '14px',
                lineHeight: '1.6',
                resize: 'vertical'
            }
        );

        textarea.addEventListener(
            'input',
            () => {
                highlightText =
                    textarea.value;

                highlightTerms =
                    parseHighlightTerms(
                        highlightText
                    );

                saveHighlightText(
                    highlightText
                );

                applyHighlight();
            }
        );

        // 入力中のキーでページがスクロール等しないように
        textarea.addEventListener(
            'keydown',
            event =>
                event.stopPropagation()
        );

        highlightBox.append(
            highlightLabel,
            textarea
        );


        const body =
            document.createElement('div');


        highlightButton.onclick = () => {
            highlightOpen = !highlightOpen;

            applyCollapsed();

            if (highlightOpen) textarea.focus();
        };

        toggle.onclick = () => {
            collapsed = !collapsed;

            saveCollapsed(collapsed);

            applyCollapsed();
        };

        panel.append(
            headingRow,
            highlightBox,
            body
        );

        els = {
            panel,
            heading,
            toggle,
            highlightButton,
            highlightBox,
            textarea,
            body
        };

        applyCollapsed();

        return els;
    }

    function makeChipButton(label) {
        const el =
            document.createElement('button');

        el.type = 'button';
        el.textContent = label;

        Object.assign(
            el.style,
            {
                flex: '0 0 auto',
                padding: '6px 14px',
                borderRadius: '18px',

                border:
                    '1px solid var(--yt-spec-10-percent-layer)',

                background:
                    'var(--yt-spec-badge-chip-background)',

                color:
                    'var(--yt-spec-text-primary)',

                fontFamily: 'inherit',
                fontSize: '14px',
                fontWeight: '600',
                cursor: 'pointer'
            }
        );

        return el;
    }

    function applyCollapsed() {
        if (!els) return;

        els.toggle.textContent =
            collapsed
                ? 'リストを表示'
                : 'リストを非表示';

        els.toggle.setAttribute(
            'aria-expanded',
            collapsed ? 'false' : 'true'
        );

        els.highlightButton.style.marginLeft =
            'auto';

        els.body.style.display =
            collapsed ? 'none' : '';

        els.highlightButton.setAttribute(
            'aria-expanded',
            highlightOpen && !collapsed
                ? 'true'
                : 'false'
        );

        els.highlightBox.style.display =
            highlightOpen && !collapsed
                ? ''
                : 'none';
    }


    // ============================================================
    // 強調
    // ============================================================

    function isHighlighted(item) {
        if (!highlightTerms.length) {
            return false;
        }

        const haystack =
            `${item.title}\n${item.channel}`
                .toLowerCase();

        return highlightTerms.some(
            term =>
                haystack.includes(term)
        );
    }

    function styleRow(row, highlighted) {
        const base =
            highlighted
                ? 'rgba(255, 202, 40, 0.16)'
                : '';

        row.dataset.tmBase = base;

        row.style.background = base;

        row.style.boxShadow =
            highlighted
                ? 'inset 3px 0 0 0 #ffca28'
                : '';

        row.style.fontWeight =
            highlighted ? '600' : '';
    }

    /*
     * 行を作り直さずに強調だけ更新する。
     */
    function applyHighlight() {
        if (!els) return;

        for (const row of els.body.querySelectorAll(
            '[data-tm-row]'
        )) {
            const index =
                Number(row.dataset.tmRow);

            const item =
                lastItems[index];

            if (item) {
                styleRow(
                    row,
                    isHighlighted(item)
                );
            }
        }
    }


    // ============================================================
    // 描画
    // ============================================================

    function render(items, loading = false) {
        lastItems = items;
        lastLoading = loading;

        const target = findPanelTarget();
        if (!target) return;

        const el = els || buildPanel();

        if (items.length) {
            hasShownList = true;
        }

        el.heading.textContent =
            loading
                ? (
                    hasShownList
                        ? '本日以降の配信　更新中…'
                        : '本日以降の配信　取得中…'
                )
                : `本日以降の配信　${items.length}件`;

        el.body.replaceChildren();

        if (items.length) {
            const header =
                document.createElement('div');

            Object.assign(
                header.style,
                {
                    display: 'grid',
                    gridTemplateColumns: GRID_COLUMNS,
                    gap: '20px',
                    padding: '0 12px 8px',
                    opacity: '0.6',
                    fontWeight: '600'
                }
            );

            header.append(
                makeCell('配信日時'),
                makeCell('チャンネル'),
                makeCell('配信タイトル')
            );

            el.body.appendChild(header);
        }


        let currentSection = null;

        items.forEach((item, index) => {
            const section = getSection(item);

            if (section !== currentSection) {
                currentSection = section;

                el.body.appendChild(
                    makeSectionDivider(
                        SECTION_LABELS[section],
                        el.body.childElementCount > 0
                    )
                );
            }

            const row =
                document.createElement('a');

            row.href = item.href;
            row.dataset.tmRow = String(index);

            Object.assign(
                row.style,
                {
                    display: 'grid',
                    gridTemplateColumns: GRID_COLUMNS,
                    gap: '20px',
                    padding: '11px 12px',
                    borderRadius: '8px',
                    alignItems: 'center',
                    color: 'inherit',
                    textDecoration: 'none',
                    fontSize: '16px'
                }
            );

            styleRow(
                row,
                isHighlighted(item)
            );

            row.onmouseenter = () => {
                row.style.background =
                    'var(--yt-spec-badge-chip-background)';
            };

            row.onmouseleave = () => {
                row.style.background =
                    row.dataset.tmBase || '';
            };


            const dateText =
                item.isLive
                    ? `配信中　${formatDate(item.date)}`
                    : formatDate(item.date);

            row.append(
                makeCell(
                    dateText,
                    { fontWeight: '700' }
                ),

                makeCell(
                    item.channel,
                    { opacity: '0.75' }
                ),

                makeCell(item.title)
            );

            el.body.appendChild(row);
        });


        if (!loading && !items.length) {
            const empty =
                document.createElement('div');

            empty.textContent =
                '現在読み込まれている範囲に本日以降の配信はありません。';

            empty.style.opacity = '0.65';

            el.body.appendChild(empty);
        }


        if (el.panel.parentElement !== target) {
            target.prepend(el.panel);
        }
    }

    /*
     * 時間帯の区切りだけを今の時刻で
     * 引き直す。
     */
    function refreshSections() {
        if (
            !isSubscriptionsPage() ||
            !lastItems.length
        ) {
            return;
        }

        const items =
            filterItems(lastItems);

        sortItems(items);

        render(items, lastLoading);
    }


    // ============================================================
    // メイン
    // ============================================================

    async function build() {
        if (
            !isSubscriptionsPage()
        ) {
            (
                els?.panel ||
                document.getElementById(PANEL_ID)
            )?.remove();

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
            const stored = getStoredMap();

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

                            return { ...item };
                        }

                        /*
                         * 未取得のものは、保持している
                         * 前回の情報で暫定表示する。
                         * itemそのものは書き換えない。
                         */
                        const previous =
                            stored.get(item.videoId);

                        if (previous) {
                            return {
                                ...item,
                                date: previous.date,
                                isLiveContent: true
                            };
                        }

                        return { ...item };
                    })
                );

            sortItems(
                cachedItems
            );

            /*
             * 暫定表示が空になる場合は、
             * すでに出しているリストを残す。
             */
            render(
                cachedItems.length || !lastItems.length
                    ? cachedItems
                    : lastItems,
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

            saveItems(result);

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
        () => {
            if (isSubscriptionsPage()) {
                renderStored();
            }

            scheduleBuild(500);
        }
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

    /*
     * 保持しているリストを、今の時刻で
     * 区切り直して先に描画する。
     */
    function renderStored() {
        const stored = loadStoredItems();

        if (!stored.length) return;

        const items = filterItems(stored);

        sortItems(items);

        render(items, true);
    }

    function start() {
        setInterval(
            refreshSections,
            SECTION_TICK_MS
        );

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
            renderStored();
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
