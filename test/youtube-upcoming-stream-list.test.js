const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// youtube-upcoming-stream-list.user.js の検証用ハーネス。
//
// 登録チャンネルフィードを模したDOMへスクリプトを流し込み、
// ヘッドレスChromiumでパネルの描画・区切り・強調・保持を確認する。
//
//   NODE_PATH=$(npm root -g) node test/youtube-upcoming-stream-list.test.js
//
// youtubei の player API はモックしている。
// 実際のYouTubeのDOMそのものは再現できないため、
// これに通ることは実機で動くことを保証しない。

const SCRIPT = fs.readFileSync(
  process.env.SCRIPT_PATH ||
    path.join(__dirname, '..', 'youtube-upcoming-stream-list.user.js'),
  'utf8'
);

// JSTでの本日8:00を基準時刻にする（起点5:00より後）。
const NOW = new Date('2026-09-11T08:00:00+09:00');

const VIDEOS = {
  past1: { start: '2026-09-11T06:00:00+09:00', title: '朝の雑談配信', channel: 'あさチャンネル' },
  soon1: { start: '2026-09-11T21:00:00+09:00', title: '夜のゲリラ配信', channel: 'よるチャンネル' },
  next1: { start: '2026-09-12T20:00:00+09:00', title: '明日の歌枠', channel: 'あしたチャンネル' },
  plain: { start: null, title: 'ただの動画', channel: 'どうがチャンネル' }
};

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<ytd-browse page-subtype="subscriptions">
  <ytd-rich-grid-renderer>
    ${Object.entries(VIDEOS)
      .map(
        ([id, v]) => `
    <ytd-rich-item-renderer>
      <a id="thumbnail" href="/watch?v=${id}"></a>
      <yt-lockup-metadata-view-model>
        <h3 class="ytLockupMetadataViewModelTitle">${v.title}</h3>
        <a href="/@${id}">${v.channel}</a>
      </yt-lockup-metadata-view-model>
    </ytd-rich-item-renderer>`
      )
      .join('')}
  </ytd-rich-grid-renderer>
</ytd-browse>
</body></html>`;

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `\n      ${detail}`}`);
}

async function openPage(browser) {
  const page = await browser.newPage();

  await page.route('**/*', route => {
    const url = route.request().url();

    if (url.includes('/youtubei/v1/player')) {
      const id = JSON.parse(route.request().postData() || '{}').videoId;
      const start = VIDEOS[id]?.start;

      return route.fulfill({
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(
          start
            ? {
                microformat: {
                  playerMicroformatRenderer: {
                    liveBroadcastDetails: { startTimestamp: start }
                  }
                }
              }
            : {}
        )
      });
    }

    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE_HTML });
  });

  // Date を固定してから本体を読み込む。
  await page.addInitScript(fixedNow => {
    const Real = Date;
    const fixed = new Real(fixedNow).getTime();

    class FakeDate extends Real {
      constructor(...args) {
        super(...(args.length ? args : [fixed]));
      }
      static now() {
        return fixed;
      }
    }

    window.Date = FakeDate;
  }, NOW.toISOString());

  await page.goto('https://www.youtube.com/feed/subscriptions');
  await page.addScriptTag({ content: SCRIPT });

  return page;
}

async function readPanel(page) {
  await page.waitForFunction(
    () =>
      document
        .getElementById('tm-upcoming-stream-list')
        ?.textContent.includes('件'),
    null,
    { timeout: 10000 }
  );

  return page.evaluate(() => {
    const panel = document.getElementById('tm-upcoming-stream-list');

    return {
      heading: panel.querySelector('div').textContent,
      lines: [...panel.querySelectorAll('div,a')]
        .filter(el => el.dataset.tmRow !== undefined || /^(開始済み|これから（今日）|明日以降)$/.test(el.textContent.trim()))
        .map(el =>
          el.dataset.tmRow !== undefined
            ? `行: ${el.textContent}`
            : `区切り: ${el.textContent.trim()}`
        ),
      highlighted: [...panel.querySelectorAll('[data-tm-row]')]
        .filter(el => el.dataset.tmBase)
        .map(el => el.textContent),
      stored: JSON.parse(localStorage.getItem('tm-upcoming-stream-list-items') || 'null')
    };
  });
}

(async () => {
  const browser = await chromium.launch();
  const context = browser;

  const page = await openPage(context);
  const first = await readPanel(page);

  check('ライブ以外の動画を除外して3件表示する', first.heading.includes('3件'), first.heading);

  check(
    '開始済み / これから（今日）/ 明日以降 の区切りが入る',
    ['開始済み', 'これから（今日）', '明日以降'].every(label =>
      first.lines.includes(`区切り: ${label}`)
    ),
    first.lines.join('\n      ')
  );

  check(
    '開始日時順に並ぶ',
    first.lines.filter(l => l.startsWith('行: ')).map(l => l.includes('朝の雑談') ? 'a' : l.includes('夜のゲリラ') ? 'b' : 'c').join('') === 'abc',
    first.lines.join('\n      ')
  );

  check('取得したリストを保存する', first.stored?.items?.length === 3, JSON.stringify(first.stored?.items?.length));

  // 強調
  await page.evaluate(() => {
    const panel = document.getElementById('tm-upcoming-stream-list');
    const textarea = panel.querySelector('textarea');
    textarea.value = 'ゲリラ\nあさチャンネル';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });

  const highlighted = await page.evaluate(() =>
    [...document.querySelectorAll('#tm-upcoming-stream-list [data-tm-row]')]
      .filter(el => el.dataset.tmBase)
      .map(el => el.textContent)
  );

  check(
    '改行区切りの複数ワードで部分一致の行を強調する',
    highlighted.length === 2 &&
      highlighted.some(t => t.includes('夜のゲリラ配信')) &&
      highlighted.some(t => t.includes('朝の雑談配信')),
    JSON.stringify(highlighted)
  );

  // 保持 — 同じプロファイルで開き直し、取得前の表示を見る
  const page2 = await browser.newPage();
  await page2.route('**/*', route =>
    route.request().url().includes('/youtubei/v1/player')
      ? new Promise(() => {}) // 取得は返さない
      : route.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE_HTML })
  );
  await page2.addInitScript(
    ([fixedNow, stored, highlight]) => {
      const Real = Date;
      const fixed = new Real(fixedNow).getTime();
      class FakeDate extends Real {
        constructor(...args) {
          super(...(args.length ? args : [fixed]));
        }
        static now() {
          return fixed;
        }
      }
      window.Date = FakeDate;
      localStorage.setItem('tm-upcoming-stream-list-items', stored);
      localStorage.setItem('tm-upcoming-stream-list-highlight', highlight);
    },
    [NOW.toISOString(), JSON.stringify(first.stored), 'ゲリラ']
  );

  await page2.goto('https://www.youtube.com/feed/subscriptions');
  await page2.addScriptTag({ content: SCRIPT });

  await page2.waitForFunction(
    () => document.querySelectorAll('#tm-upcoming-stream-list [data-tm-row]').length >= 3,
    null,
    { timeout: 10000 }
  );

  const restored = await page2.evaluate(() => {
    const panel = document.getElementById('tm-upcoming-stream-list');
    return {
      heading: panel.querySelector('div').textContent,
      rows: panel.querySelectorAll('[data-tm-row]').length,
      dividers: [...panel.querySelectorAll('div')]
        .map(el => el.textContent.trim())
        .filter(t => /^(開始済み|これから（今日）|明日以降)$/.test(t)),
      highlighted: [...panel.querySelectorAll('[data-tm-row]')].filter(el => el.dataset.tmBase).length
    };
  });

  check('取得前に保持したリストを表示する', restored.rows === 3, JSON.stringify(restored));

  check('取得中は「更新中」と表示する', restored.heading.includes('更新中'), restored.heading);

  check(
    '保持したリストにも時間帯の区切りを引き直す',
    ['開始済み', 'これから（今日）', '明日以降'].every(l => restored.dividers.includes(l)),
    JSON.stringify(restored.dividers)
  );

  check('保存した強調ワードを復元する', restored.highlighted === 1, String(restored.highlighted));

  await browser.close();

  const failed = checks.filter(c => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  process.exit(failed ? 1 : 0);
})();
