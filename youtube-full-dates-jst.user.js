// ==UserScript==
// @name         YouTube Full Dates (JST)
// @namespace    local.hiro.tools
// @version      3.8.1
// @description  YouTubeの「1年前」等の相対表示を、JST基準の絶対日付に置換する。今週/今年/昨年以前を色分け表示。Trusted Types対応。
// @author       hirodiver (fork of Solomon / InMirrors "YouTube Full Dates v3")
// @match        https://www.youtube.com/*
// @icon         https://www.youtube.com/s/desktop/814d40a6/img/favicon_144x144.png
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @license      MIT
// @homepageURL  https://github.com/hirodiver/tampermonkey-scripts
// @supportURL   https://github.com/hirodiver/tampermonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/youtube-full-dates-jst.user.js
// @updateURL    https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/youtube-full-dates-jst.user.js
// ==/UserScript==

// -----------------------------------------------------------------------------
// 本スクリプトは Greasy Fork の "YouTube Full Dates (v3)" (script id 564941) を元にした
// 独立フォークである。@name / @namespace / 更新URL をすべて差し替えているため、
// 本家の更新は反映されない。更新元はこのリポジトリの main ブランチのみ。
// 更新を配信するときは必ず @version を上げること（Tampermonkey は版番号で更新判定する）。
// -----------------------------------------------------------------------------

(function() {
    'use strict';

    const LANGUAGES = {
        en: {
            name: 'English',
            monthsShort: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
            monthsFull: ['January','February','March','April','May','June','July','August','September','October','November','December'],
            daysShort: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],
            daysFull: ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'],
            agoKeywords: ['ago','Streamed','just now','yesterday','today','Premiere','Premieres','Updated','Edited','Pinned'],
            dateKeywords: ['second','minute','hour','day','week','month','year']
        },
        ja: {
            name: '日本語',
            monthsShort: ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'],
            monthsFull: ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'],
            daysShort: ['日','月','火','水','木','金','土'],
            daysFull: ['日曜日','月曜日','火曜日','水曜日','木曜日','金曜日','土曜日'],
            agoKeywords: ['前','昨日','今日','プレミア','配信済み'],
            dateKeywords: ['秒','分','時間','日','週間','か月','年']
        },
        es: { name:'Español', monthsShort:['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'], monthsFull:['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'], daysShort:['dom','lun','mar','mié','jue','vie','sáb'], daysFull:['domingo','lunes','martes','miércoles','jueves','viernes','sábado'], agoKeywords:['hace','ayer','hoy','Estreno'], dateKeywords:['segundo','minuto','hora','día','semana','mes','año'] },
        fr: { name:'Français', monthsShort:['janv','févr','mars','avr','mai','juin','juil','août','sept','oct','nov','déc'], monthsFull:['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'], daysShort:['dim','lun','mar','mer','jeu','ven','sam'], daysFull:['dimanche','lundi','mardi','mercredi','jeudi','vendredi','samedi'], agoKeywords:["il y a",'hier',"aujourd'hui",'Première'], dateKeywords:['seconde','minute','heure','jour','semaine','mois','an','année'] },
        de: { name:'Deutsch', monthsShort:['Jan','Feb','März','Apr','Mai','Juni','Juli','Aug','Sep','Okt','Nov','Dez'], monthsFull:['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'], daysShort:['So','Mo','Di','Mi','Do','Fr','Sa'], daysFull:['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'], agoKeywords:['vor','gestern','heute','Premiere'], dateKeywords:['Sekunde','Minute','Stunde','Tag','Woche','Monat','Jahr'] },
        pt: { name:'Português', monthsShort:['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'], monthsFull:['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'], daysShort:['dom','seg','ter','qua','qui','sex','sáb'], daysFull:['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'], agoKeywords:['há','ontem','hoje','Estreia'], dateKeywords:['segundo','minuto','hora','dia','semana','mês','ano'] },
        it: { name:'Italiano', monthsShort:['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic'], monthsFull:['gennaio','febbraio','marzo','aprile','maggio','giugno','luglio','agosto','settembre','ottobre','novembre','dicembre'], daysShort:['dom','lun','mar','mer','gio','ven','sab'], daysFull:['domenica','lunedì','martedì','mercoledì','giovedì','venerdì','sabato'], agoKeywords:['fa','ieri','oggi','Prima'], dateKeywords:['secondo','minuto','ora','giorno','settimana','mese','anno'] },
        ru: { name:'Русский', monthsShort:['янв','февр','март','апр','май','июнь','июль','авг','сент','окт','нояб','дек'], monthsFull:['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'], daysShort:['вс','пн','вт','ср','чт','пт','сб'], daysFull:['воскресенье','понедельник','вторник','среда','четверг','пятница','суббота'], agoKeywords:['назад','вчера','сегодня','Премьера'], dateKeywords:['секунд','минут','час','день','дней','недел','месяц','год','лет'] },
        zh: { name:'中文', monthsShort:['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'], monthsFull:['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'], daysShort:['日','一','二','三','四','五','六'], daysFull:['星期日','星期一','星期二','星期三','星期四','星期五','星期六'], agoKeywords:['前','昨天','今天','首播'], dateKeywords:['秒','分','时','時','天','日','周','週','月','年'] },
        ko: { name:'한국어', monthsShort:['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'], monthsFull:['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'], daysShort:['일','월','화','수','목','금','토'], daysFull:['일요일','월요일','화요일','수요일','목요일','금요일','토요일'], agoKeywords:['전','어제','오늘','프리미어'], dateKeywords:['초','분','시간','일','주','개월','년'] },
        ar: { name:'العربية', monthsShort:['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'], monthsFull:['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'], daysShort:['أحد','إثنين','ثلاثاء','أربعاء','خميس','جمعة','سبت'], daysFull:['الأحد','الإثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'], agoKeywords:['قبل','منذ','أمس','اليوم','العرض'], dateKeywords:['ثانية','دقيقة','ساعة','يوم','أسبوع','شهر','سنة'] }
    };

    const DEFAULT_CONFIG = {
        dateFormat: 'yyyy年MM月dd日',
        language: 'ja',
        smartYear: false,          // 廃止（年は常に4桁表示）
        highlightOldVideos: true,
        thisWeekEmoji: true,
        thisWeekBadge: '🆕',
        thisYearBadge: true,
        processComments: true,
        processDescription: true,
        processPosts: true,
        debugMode: false
    };
    const savedSettings = GM_getValue('settings', {});
    const SETTINGS = { ...DEFAULT_CONFIG, ...savedSettings };

    const PROCESSED_ATTR = 'data-ytfd-done';
    const dateCache = new Map();
    let isProcessing = false, pendingRequests = 0, lastUrl = window.location.href;
    const MAX_CONCURRENT = 8, requestQueue = [];

    const log = (...args) => SETTINGS.debugMode && console.log('📅 [YTFD-JST]', ...args);

    // ── 書式の年トークン正規化 ────────────────────────
    // yy / yyyy をすべて yyyy（西暦4桁）に統一し、年トークンが無い書式には先頭に付与する。
    // 曜日（wwww / ww）・月・日・時刻トークンはそのまま維持する。
    const YEAR_SENTINEL = String.fromCharCode(1);
    function normalizeYearFormat(fmt) {
        let f = String(fmt || '');
        f = f.replace(/yyyy/g, YEAR_SENTINEL)
             .replace(/yy/g, YEAR_SENTINEL)
             .replace(new RegExp(YEAR_SENTINEL, 'g'), 'yyyy');
        if (!f.includes('yyyy')) f = (f.includes('月') || f.includes('日') ? 'yyyy年' : 'yyyy ') + f;
        return f;
    }

    // ── 日付フォーマット ──────────────────────────────
    function formatDate(date) {
        const raw = new Date(date);
        if (isNaN(raw.getTime())) return { text: '', tier: 'none' };

        // JST固定で年月日時分秒を取得（APIはUTC-7等で返すため必須）
        const jstStr = raw.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' });
        const d = new Date(jstStr);

        const lang = LANGUAGES[SETTINGS.language] || LANGUAGES.ja;
        const pad = n => String(n).padStart(2,'0');

        // 「今」もJSTで比較
        const nowJst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
        const currentYear = nowJst.getFullYear();
        const videoYear   = d.getFullYear();

        const isThisWeek = (nowJst - d) / (1000*60*60*24) < 7 && (nowJst - d) >= 0;
        const isThisYear = currentYear === videoYear && !isThisWeek;
        const isOldYear  = videoYear < currentYear;

        // テキストは常に dateFormat で生成（年は常に西暦4桁）
        const hours24 = d.getHours(), hours12 = hours24 % 12 || 12, ampm = hours24 < 12 ? 'AM' : 'PM';
        const tokens = {
            yyyy: d.getFullYear(), yy: String(d.getFullYear()).slice(-2),
            MMMM: lang.monthsFull[d.getMonth()], MMM: lang.monthsShort[d.getMonth()],
            MM: pad(d.getMonth()+1), dd: pad(d.getDate()),
            wwww: lang.daysFull[d.getDay()], ww: lang.daysShort[d.getDay()],
            HH: pad(hours24), hh: pad(hours12), mm: pad(d.getMinutes()), ss: pad(d.getSeconds()), ap: ampm
        };
        let result = normalizeYearFormat(SETTINGS.dateFormat);
        result = result.replace(/wwww|ww|yyyy|yy|MMMM|MMM|MM|dd|HH|hh|mm|ss|ap/g, m => tokens[m]);
        result = result.replace(/,/g,'').replace(/\s+/g,' ').trim();

        // 今週は色（緑）を付ける。絵文字バッジは設定に応じて先頭に付与
        if (isThisWeek) {
            const badge = SETTINGS.thisWeekEmoji && SETTINGS.thisWeekBadge ? SETTINGS.thisWeekBadge + ' ' : '';
            return { text: badge + result, tier: 'thisWeek' };
        }
        if (isThisYear) return { text: result, tier: 'thisYear' };
        if (isOldYear)  return { text: result, tier: 'oldYear' };
        return { text: result, tier: 'none' };
    }

    // ── ビデオID抽出 ──────────────────────────────────
    function getVideoId(url) {
        if (!url) return null;
        let m = url.match(/\/shorts\/([^/?&#]+)/) || url.match(/[?&]v=([^&#]+)/) ||
                url.match(/\/embed\/([^/?&#]+)/) || url.match(/\/live\/([^/?&#]+)/);
        return m ? m[1] : null;
    }

    // ── 相対日付検出 ──────────────────────────────────
    function hasRelativeDate(text) {
        if (!text) return false;
        const agoKw  = Object.values(LANGUAGES).flatMap(l => l.agoKeywords);
        const dateKw = Object.values(LANGUAGES).flatMap(l => l.dateKeywords);
        const t = text.toLowerCase();
        return agoKw.some(k => t.includes(k.toLowerCase())) && dateKw.some(k => t.includes(k.toLowerCase()));
    }
    function hasYouTubeFullDate(text) {
        if (!text) return false;
        return /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December)[a-z]*\.?\s+\d{1,2}/i.test(text);
    }
    function extractDateFromText(text) {
        if (!text) return null;
        const monthMap = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11,january:0,february:1,march:2,april:3,june:5,july:6,august:7,september:8,october:9,november:10,december:11};
        let m = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|January|February|March|April|May|June|July|August|September|October|November|December)[a-z]*\.?\s+(\d{1,2}),?\s*(\d{4})?\b/i);
        if (m) {
            const mo = monthMap[m[1].toLowerCase().replace(/[^a-z]/g,'').substring(0,3)];
            if (mo !== undefined) {
                const year = m[3] ? parseInt(m[3]) : new Date().getFullYear();
                return new Date(year, mo, parseInt(m[2]));
            }
        }
        return null;
    }
    function needsProcessing(el) {
        if (el.hasAttribute(PROCESSED_ATTR)) return false;
        const text = el.textContent;
        return text && (hasRelativeDate(text) || hasYouTubeFullDate(text));
    }
    function isRelativeDateText(text) {
        if (!text) return false;
        const t = text.trim().toLowerCase();
        const agoKw  = Object.values(LANGUAGES).flatMap(l => l.agoKeywords);
        const dateKw = Object.values(LANGUAGES).flatMap(l => l.dateKeywords);
        return agoKw.some(k => t.includes(k.toLowerCase())) || dateKw.some(k => t.includes(k.toLowerCase()));
    }

    // ── APIフェッチ ───────────────────────────────────
    async function fetchUploadDate(videoId) {
        if (dateCache.has(videoId)) return dateCache.get(videoId);
        try {
            const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20240416.01.00' } }, videoId })
            });
            if (!res.ok) throw new Error('Network error');
            const data = await res.json(), info = data?.microformat?.playerMicroformatRenderer;
            const live = info?.liveBroadcastDetails;
            let uploadDate;
            if (live?.startTimestamp) {
                // ライブ配信はstartTimestampがYouTubeUI表示と一致（現在配信中・アーカイブとも）
                uploadDate = live.startTimestamp;
            } else {
                uploadDate = info?.publishDate || info?.uploadDate;
            }
            if (uploadDate) dateCache.set(videoId, uploadDate);
            return uploadDate;
        } catch(e) { log('❌ Fetch error:', e); return null; }
    }

    function calculateDateFromRelative(text) {
        if (!text) return null;
        const t = text.trim().toLowerCase(), now = new Date();
        let m;
        m = t.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/);
        if (m) {
            const val = parseInt(m[1]), unit = m[2], d = new Date(now);
            ({second:()=>d.setSeconds(d.getSeconds()-val),minute:()=>d.setMinutes(d.getMinutes()-val),hour:()=>d.setHours(d.getHours()-val),day:()=>d.setDate(d.getDate()-val),week:()=>d.setDate(d.getDate()-val*7),month:()=>d.setMonth(d.getMonth()-val),year:()=>d.setFullYear(d.getFullYear()-val)})[unit]?.();
            return d.toISOString();
        }
        // 日本語: X秒前/X分前/X時間前/X日前/X週間前/Xか月前/X年前
        m = t.match(/(\d+)\s*(秒|分|時間|日|週間|か月|年)\s*前/);
        if (m) {
            const val = parseInt(m[1]), unit = m[2], d = new Date(now);
            ({秒:()=>d.setSeconds(d.getSeconds()-val),分:()=>d.setMinutes(d.getMinutes()-val),時間:()=>d.setHours(d.getHours()-val),日:()=>d.setDate(d.getDate()-val),週間:()=>d.setDate(d.getDate()-val*7),か月:()=>d.setMonth(d.getMonth()-val),年:()=>d.setFullYear(d.getFullYear()-val)})[unit]?.();
            return d.toISOString();
        }
        m = t.match(/il y a\s*(\d+)\s*(seconde|minute|heure|jour|semaine|mois|an|année)s?/);
        if (m) { const val=parseInt(m[1]),unit=m[2],d=new Date(now),map={seconde:'second',minute:'minute',heure:'hour',jour:'day',semaine:'week',mois:'month',an:'year',année:'year'};({second:()=>d.setSeconds(d.getSeconds()-val),minute:()=>d.setMinutes(d.getMinutes()-val),hour:()=>d.setHours(d.getHours()-val),day:()=>d.setDate(d.getDate()-val),week:()=>d.setDate(d.getDate()-val*7),month:()=>d.setMonth(d.getMonth()-val),year:()=>d.setFullYear(d.getFullYear()-val)})[map[unit]]?.();return d.toISOString(); }
        m = t.match(/hace\s*(\d+)\s*(segundo|minuto|hora|día|dia|semana|mes|meses|año)s?/);
        if (m) { const val=parseInt(m[1]),unit=m[2],d=new Date(now),map={segundo:'second',minuto:'minute',hora:'hour',día:'day',dia:'day',semana:'week',mes:'month',meses:'month',año:'year'};({second:()=>d.setSeconds(d.getSeconds()-val),minute:()=>d.setMinutes(d.getMinutes()-val),hour:()=>d.setHours(d.getHours()-val),day:()=>d.setDate(d.getDate()-val),week:()=>d.setDate(d.getDate()-val*7),month:()=>d.setMonth(d.getMonth()-val),year:()=>d.setFullYear(d.getFullYear()-val)})[map[unit]]?.();return d.toISOString(); }
        m = t.match(/vor\s*(\d+)\s*(sekunde|minute|stunde|tag|tage|woche|monat|jahr)n?e?n?/i);
        if (m) { const val=parseInt(m[1]),unit=m[2].toLowerCase(),d=new Date(now),map={sekunde:'second',minute:'minute',stunde:'hour',tag:'day',tage:'day',woche:'week',monat:'month',jahr:'year'};({second:()=>d.setSeconds(d.getSeconds()-val),minute:()=>d.setMinutes(d.getMinutes()-val),hour:()=>d.setHours(d.getHours()-val),day:()=>d.setDate(d.getDate()-val),week:()=>d.setDate(d.getDate()-val*7),month:()=>d.setMonth(d.getMonth()-val),year:()=>d.setFullYear(d.getFullYear()-val)})[map[unit]]?.();return d.toISOString(); }
        return null;
    }

    // ── キュー ────────────────────────────────────────
    async function processQueue() {
        while (requestQueue.length > 0 && pendingRequests < MAX_CONCURRENT) {
            const task = requestQueue.shift();
            pendingRequests++;
            try { await task(); } catch(e) { log('❌ Task error:', e); }
            pendingRequests--;
        }
    }
    function applyDateToElement(element, result) {
        element.textContent = result.text;
        element.setAttribute(PROCESSED_ATTR, 'true');
        element.classList.remove('ytfd-old-video','ytfd-this-week','ytfd-this-year');
        if      (result.tier === 'thisWeek')                              element.classList.add('ytfd-this-week');
        else if (result.tier === 'oldYear'  && SETTINGS.highlightOldVideos) element.classList.add('ytfd-old-video');
        else if (result.tier === 'thisYear' && SETTINGS.thisYearBadge)    element.classList.add('ytfd-this-year');
    }
    function queueDateUpdate(videoId, element, originalText) {
        element.setAttribute(PROCESSED_ATTR, 'pending');
        requestQueue.push(async () => {
            let uploadDate = null;
            if (hasYouTubeFullDate(originalText)) {
                const extracted = extractDateFromText(originalText);
                if (extracted) uploadDate = extracted.toISOString();
            }
            if (!uploadDate) uploadDate = await fetchUploadDate(videoId);
            if (!uploadDate) { element.removeAttribute(PROCESSED_ATTR); return; }
            const result = formatDate(uploadDate);
            if (!result.text) { element.removeAttribute(PROCESSED_ATTR); return; }
            applyDateToElement(element, result);
        });
        processQueue();
    }
    function queueRelativeDateUpdate(element, originalText) {
        element.setAttribute(PROCESSED_ATTR, 'pending');
        requestQueue.push(async () => {
            const calculatedDate = calculateDateFromRelative(originalText);
            if (!calculatedDate) { element.removeAttribute(PROCESSED_ATTR); return; }
            const result = formatDate(calculatedDate);
            if (!result.text) { element.removeAttribute(PROCESSED_ATTR); return; }
            applyDateToElement(element, result);
        });
        processQueue();
    }

    // ── 要素検索 ──────────────────────────────────────
    // タイトル・チャンネル名など誤検出しやすい親クラスを除外
    function isExcludedEl(el) {
        let node = el.parentElement;
        while (node) {
            if (node.classList?.contains('ytLockupMetadataViewModelTitle')) return true;
            if (node.classList?.contains('ytLockupMetadataViewModelSubtitle')) return true;
            if (node.tagName === 'H3' || node.tagName === 'H4') return true;
            if (node.id === 'video-title') return true;
            node = node.parentElement;
        }
        return false;
    }

    function findDateElement(container) {
        const selectors = [
            // 新UI: メタデータ行（視聴回数・日付が並ぶ行）のspan — 最優先
            '.ytContentMetadataViewModelMetadataRow span',
            'yt-content-metadata-view-model span',
            // 旧UI
            '#metadata-line > span',
            '.inline-metadata-item',
            // その他旧UI
            '#video-info > span',
            'ytd-video-meta-block #metadata-line span',
            '.metadata-stats span',
            '#byline-container span'
        ];
        for (const selector of selectors) {
            for (const el of container.querySelectorAll(selector)) {
                if (needsProcessing(el) && !isExcludedEl(el)) return el;
            }
        }
        return null;
    }
    function findVideoLink(container) {
        const selectors = ['a#thumbnail','a#video-title-link','h3 > a','.yt-lockup-view-model__content-image','a[href*="watch"]','a[href*="shorts"]','a[href*="live"]'];
        for (const selector of selectors) {
            const el = container.querySelector(selector);
            if (el?.href) return el.href;
        }
        return null;
    }

    // ── メイン処理 ────────────────────────────────────
    function processAllVideos() {
        const containerSelectors = [
            'ytd-rich-item-renderer','ytd-video-renderer','ytd-compact-video-renderer',
            'ytd-playlist-video-renderer','ytd-grid-video-renderer','ytd-rich-grid-media',
            'yt-lockup-view-model','ytd-reel-item-renderer','ytd-playlist-panel-video-renderer'
        ];
        containerSelectors.forEach(selector => {
            document.querySelectorAll(selector).forEach(container => {
                const dateEl = findDateElement(container);
                if (!dateEl) return;
                const href = findVideoLink(container);
                const videoId = getVideoId(href);
                if (!videoId) return;
                queueDateUpdate(videoId, dateEl, dateEl.textContent.trim());
            });
        });
    }
    function processDescription() {
        if (!SETTINGS.processDescription || !window.location.pathname.startsWith('/watch')) return;
        ['#info-strings yt-formatted-string','ytd-watch-metadata #info-strings span','#upload-info span'].forEach(selector => {
            document.querySelectorAll(selector).forEach(el => {
                if (needsProcessing(el)) {
                    const videoId = getVideoId(window.location.href);
                    if (videoId) queueDateUpdate(videoId, el, el.textContent.trim());
                }
            });
        });
    }
    function processPosts() {
        if (!SETTINGS.processPosts) return;
        ['ytd-backstage-post-renderer','ytd-post-renderer','ytd-backstage-post-thread-renderer'].forEach(selector => {
            document.querySelectorAll(selector).forEach(post => {
                ['#published-time-text a','#published-time-text','.published-time-text'].forEach(ds => {
                    const dateEl = post.querySelector(ds);
                    if (dateEl && !dateEl.hasAttribute(PROCESSED_ATTR)) {
                        const text = dateEl.textContent.trim();
                        if (isRelativeDateText(text)) queueRelativeDateUpdate(dateEl, text);
                    }
                });
            });
        });
    }
    function processComments() {
        if (!SETTINGS.processComments) return;
        ['ytd-comment-renderer','ytd-comment-view-model'].forEach(selector => {
            document.querySelectorAll(selector).forEach(comment => {
                ['#published-time-text','a.yt-simple-endpoint[href*="lc="]','.published-time-text a','span.published-time-text'].forEach(ds => {
                    const dateEl = comment.querySelector(ds);
                    if (dateEl && !dateEl.hasAttribute(PROCESSED_ATTR)) {
                        const text = dateEl.textContent.trim();
                        if (isRelativeDateText(text)) queueRelativeDateUpdate(dateEl, text);
                    }
                });
            });
        });
    }
    function processShorts() {
        if (!window.location.pathname.startsWith('/shorts')) return;
        const videoId = getVideoId(window.location.href);
        if (!videoId) return;
        ['ytd-reel-video-renderer #channel-info #metadata span','.reel-player-overlay-renderer #metadata span'].forEach(selector => {
            document.querySelectorAll(selector).forEach(el => {
                if (needsProcessing(el)) queueDateUpdate(videoId, el, el.textContent.trim());
            });
        });
    }

    function clearAllMarkers() {
        document.querySelectorAll('[' + PROCESSED_ATTR + ']').forEach(el => {
            el.removeAttribute(PROCESSED_ATTR);
            el.classList.remove('ytfd-old-video','ytfd-this-week','ytfd-this-year');
        });
    }
    function runProcessors() {
        if (isProcessing) return;
        isProcessing = true;
        try { processAllVideos(); processDescription(); processPosts(); processComments(); processShorts(); }
        catch(e) { log('❌ Error:', e); }
        isProcessing = false;
    }

    // ── CSS ───────────────────────────────────────────
    GM_addStyle(`
        .ytfd-old-video  { background:#ffeb3b!important;padding:2px 6px!important;border-radius:4px!important;color:#000!important;font-weight:600!important;display:inline!important;line-height:1.2!important; }
        .ytfd-this-week  { background:#81c784!important;padding:2px 6px!important;border-radius:4px!important;color:#000!important;font-weight:600!important;display:inline!important;line-height:1.2!important; }
        .ytfd-this-year  { background:#b39ddb!important;padding:2px 6px!important;border-radius:4px!important;color:#000!important;font-weight:600!important;display:inline!important;line-height:1.2!important; }
        html[dark] .ytfd-old-video  { background:#ffd600!important; }
        html[dark] .ytfd-this-week  { background:#66bb6a!important; }
        html[dark] .ytfd-this-year  { background:#9575cd!important;color:#fff!important; }
        .ytfd-panel { position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.3);z-index:99999;width:380px;max-height:85vh;overflow:hidden;opacity:0;visibility:hidden;transition:all .2s ease; }
        html[dark] .ytfd-panel { background:#212121;color:#fff; }
        .ytfd-panel.visible { opacity:1;visibility:visible; }
        .ytfd-header { background:#cc0000;color:#fff;padding:14px;display:flex;justify-content:space-between;align-items:center; }
        .ytfd-header h2 { margin:0;font-size:15px; }
        .ytfd-close { background:rgba(255,255,255,.2);border:none;color:#fff;width:26px;height:26px;border-radius:50%;cursor:pointer;font-size:14px; }
        .ytfd-content { padding:14px;max-height:60vh;overflow-y:auto; }
        .ytfd-section { margin-bottom:14px; }
        .ytfd-section-title { font-size:11px;font-weight:600;color:#666;margin-bottom:6px;text-transform:uppercase; }
        html[dark] .ytfd-section-title { color:#aaa; }
        .ytfd-input-group { margin-bottom:8px; }
        .ytfd-input-group label { display:block;font-size:12px;margin-bottom:3px;color:#333; }
        html[dark] .ytfd-input-group label { color:#ddd; }
        .ytfd-input-group input,.ytfd-input-group select { width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:12px;box-sizing:border-box; }
        html[dark] .ytfd-input-group input,html[dark] .ytfd-input-group select { background:#333;border-color:#444;color:#fff; }
        .ytfd-toggle-row { display:flex;justify-content:space-between;align-items:center;padding:6px 0; }
        .ytfd-toggle-label { font-size:12px;color:#333; }
        html[dark] .ytfd-toggle-label { color:#ddd; }
        .ytfd-toggle { width:36px;height:18px;background:#ccc;border-radius:9px;position:relative;cursor:pointer;flex-shrink:0; }
        .ytfd-toggle::after { content:'';position:absolute;width:14px;height:14px;background:#fff;border-radius:50%;top:2px;left:2px;transition:transform .2s; }
        .ytfd-toggle.on { background:#cc0000; }
        .ytfd-toggle.on::after { transform:translateX(18px); }
        .ytfd-footer { padding:10px 14px;background:#f5f5f5;display:flex;justify-content:flex-end;gap:6px; }
        html[dark] .ytfd-footer { background:#1a1a1a; }
        .ytfd-btn { padding:6px 12px;border:none;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer; }
        .ytfd-btn-primary { background:#cc0000;color:#fff; }
        .ytfd-btn-secondary { background:#ddd;color:#333; }
        html[dark] .ytfd-btn-secondary { background:#444;color:#fff; }
        .ytfd-help { font-size:10px;color:#888;line-height:1.4; }
    `);

    // ── 設定パネル（innerHTML不使用・Trusted Types対応）────
    function ce(tag, attrs={}, ...children) {
        const el = document.createElement(tag);
        Object.entries(attrs).forEach(([k,v]) => {
            if (k === 'className') el.className = v;
            else if (k === 'textContent') el.textContent = v;
            else el.setAttribute(k, v);
        });
        children.forEach(c => c && el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
        return el;
    }
    function makeToggle(key, label) {
        const row  = ce('div', {className:'ytfd-toggle-row'});
        const span = ce('span',{className:'ytfd-toggle-label', textContent: label});
        const tog  = ce('div', {className:'ytfd-toggle' + (SETTINGS[key] ? ' on':''), 'data-key': key});
        tog.addEventListener('click', () => tog.classList.toggle('on'));
        row.appendChild(span); row.appendChild(tog);
        return row;
    }
    function makeSection(title, ...children) {
        const sec = ce('div',{className:'ytfd-section'});
        sec.appendChild(ce('div',{className:'ytfd-section-title', textContent: title}));
        children.forEach(c => sec.appendChild(c));
        return sec;
    }
    function makeInputGroup(labelText, inputEl) {
        const grp   = ce('div',{className:'ytfd-input-group'});
        const label = ce('label',{textContent: labelText});
        grp.appendChild(label); grp.appendChild(inputEl);
        return grp;
    }

    function createSettingsPanel() {
        const panel = ce('div',{className:'ytfd-panel'});

        // ヘッダー
        const header = ce('div',{className:'ytfd-header'});
        const h2     = ce('h2', {textContent:'📅 YouTube Full Dates (JST)'});
        const closeBtn = ce('button',{className:'ytfd-close', textContent:'✕'});
        closeBtn.addEventListener('click', () => panel.classList.remove('visible'));
        header.appendChild(h2); header.appendChild(closeBtn);

        // コンテンツ
        const content = ce('div',{className:'ytfd-content'});

        // 言語セレクト
        const langSel = ce('select',{id:'ytfd-language'});
        Object.entries(LANGUAGES).forEach(([code,lang]) => {
            const opt = ce('option',{value:code, textContent:lang.name});
            if (code === SETTINGS.language) opt.setAttribute('selected','selected');
            langSel.appendChild(opt);
        });

        // フォーマット入力
        const fmtInput = ce('input',{type:'text', id:'ytfd-format', value:SETTINGS.dateFormat});

        // 書式プリセット
        const presetSel = ce('select',{id:'ytfd-preset'});
        [
            ['', '（プリセットから選ぶ）'],
            ['yyyy年MM月dd日', '2026年08月28日'],
            ['yyyy年MM月dd日(ww)', '2026年08月28日(金)'],
            ['yyyy年MM月dd日 wwww', '2026年08月28日 金曜日'],
            ['yyyy/MM/dd', '2026/08/28'],
            ['yyyy/MM/dd HH:mm', '2026/08/28 20:57'],
            ['yyyy年MM月dd日 HH:mm', '2026年08月28日 20:57']
        ].forEach(([v,label]) => presetSel.appendChild(ce('option',{value:v, textContent:label})));
        presetSel.addEventListener('change', () => { if (presetSel.value) fmtInput.value = presetSel.value; });

        // ヘルプ
        const help1 = ce('div',{className:'ytfd-help', textContent:'wwww=月曜日, ww=月, MMMM=1月, MMM=1月, MM=08, dd=05, yyyy=2026 / HH=18, hh=06, mm=30, ss=45, ap=PM'});
        const help0 = ce('div',{className:'ytfd-help', textContent:'※ 年は常に西暦4桁で表示されます（yy と書いても yyyy 扱い。年トークンが無い場合は自動で先頭に付与）。'});
        const help2 = ce('div',{className:'ytfd-help', textContent:'🟢 Green = 今週 (<7日) / 🟣 Purple = 今年 / 🟡 Yellow = 昨年以前'});

        content.appendChild(makeSection('言語・フォーマット',
            makeInputGroup('言語', langSel),
            makeInputGroup('プリセット', presetSel),
            makeInputGroup('日付フォーマット', fmtInput),
            help1,
            help0
        ));
        content.appendChild(makeSection('バッジ設定',
            makeToggle('highlightOldVideos','🟡 昨年以前を黄色'),
            makeToggle('thisWeekEmoji',     '🟢 今週を緑'),
            makeToggle('thisYearBadge',     '🟣 今年を紫')
        ));
        content.appendChild(makeSection('処理対象',
            makeToggle('processComments',   '💬 コメントの日付'),
            makeToggle('processDescription','📝 動画説明欄の日付'),
            makeToggle('processPosts',      '📣 コミュニティ投稿')
        ));
        content.appendChild(makeSection('カラーガイド', help2));

        // フッター
        const footer   = ce('div',{className:'ytfd-footer'});
        const resetBtn = ce('button',{className:'ytfd-btn ytfd-btn-secondary', id:'ytfd-reset', textContent:'リセット'});
        const saveBtn  = ce('button',{className:'ytfd-btn ytfd-btn-primary',   id:'ytfd-save',  textContent:'保存'});

        const isOn = key => {
            const el = panel.querySelector('[data-key="' + key + '"]');
            return el ? el.classList.contains('on') : !!SETTINGS[key];
        };

        saveBtn.addEventListener('click', () => {
            const newSettings = {
                dateFormat:          normalizeYearFormat(fmtInput.value),
                language:            langSel.value,
                smartYear:           false,
                highlightOldVideos:  isOn('highlightOldVideos'),
                thisWeekEmoji:       isOn('thisWeekEmoji'),
                thisYearBadge:       isOn('thisYearBadge'),
                processComments:     isOn('processComments'),
                processDescription:  isOn('processDescription'),
                processPosts:        isOn('processPosts'),
                thisWeekBadge:       SETTINGS.thisWeekBadge,
                debugMode:           SETTINGS.debugMode
            };
            GM_setValue('settings', newSettings);
            alert('保存しました。ページをリロードして反映します。');
            panel.classList.remove('visible');
        });
        resetBtn.addEventListener('click', () => {
            GM_setValue('settings', {});
            alert('リセットしました。ページをリロードして反映します。');
            panel.classList.remove('visible');
        });

        footer.appendChild(resetBtn); footer.appendChild(saveBtn);
        panel.appendChild(header); panel.appendChild(content); panel.appendChild(footer);

        document.addEventListener('keydown', e => { if (e.key === 'Escape') panel.classList.remove('visible'); });
        document.body.appendChild(panel);
        return panel;
    }

    // ── 初期化 ────────────────────────────────────────
    let settingsPanel = null;
    function initPanel() {
        if (!settingsPanel) settingsPanel = createSettingsPanel();
    }

    GM_registerMenuCommand('⚙️ 設定', () => {
        initPanel();
        settingsPanel.classList.add('visible');
    });

    // ── イベント・オブザーバー ────────────────────────
    let debounceTimer = null;
    function debouncedRun(delay=200) { clearTimeout(debounceTimer); debounceTimer = setTimeout(runProcessors, delay); }

    document.addEventListener('click', e => {
        const chip = e.target.closest('yt-chip-cloud-chip-renderer,[role="tab"],tp-yt-paper-item,ytd-feed-filter-chip-bar-renderer yt-chip-cloud-chip-renderer');
        if (chip) {
            setTimeout(() => { clearAllMarkers(); runProcessors(); }, 500);
            setTimeout(() => { clearAllMarkers(); runProcessors(); }, 1500);
        }
    }, true);

    const observer = new MutationObserver(mutations => {
        let shouldRun = false;
        for (const m of mutations) {
            if (m.addedNodes.length > 0) {
                for (const n of m.addedNodes) {
                    if (n.nodeType === 1 && (
                        n.matches?.('ytd-rich-item-renderer,ytd-video-renderer,ytd-compact-video-renderer,ytd-comment-renderer,ytd-comment-view-model,ytd-backstage-post-renderer,ytd-reel-item-renderer,#contents,#comments,ytd-section-list-renderer') ||
                        n.querySelector?.('ytd-rich-item-renderer,ytd-video-renderer,ytd-comment-renderer,ytd-backstage-post-renderer')
                    )) { shouldRun = true; break; }
                }
            }
        }
        if (shouldRun) debouncedRun(100);
    });
    if (document.body) {
        observer.observe(document.body, { childList:true, subtree:true });
    } else {
        document.addEventListener("DOMContentLoaded", () => {
            observer.observe(document.body, { childList:true, subtree:true });
        });
    }

    setInterval(() => {
        if (window.location.href !== lastUrl) {
            lastUrl = window.location.href;
            clearAllMarkers();
            debouncedRun(300);
        }
    }, 500);

    window.addEventListener('yt-navigate-finish', () => {
        dateCache.clear();
        lastUrl = window.location.href;
        clearAllMarkers();
        debouncedRun(300);
    });

    window.addEventListener('scroll', () => debouncedRun(150), { passive:true });
    setInterval(runProcessors, 3000);

    setTimeout(runProcessors, 500);
    setTimeout(runProcessors, 1500);
    setTimeout(runProcessors, 3000);
    setTimeout(runProcessors, 6000);

    console.log('📅 YouTube Full Dates (JST) v3.8.0 loaded!');
})();
