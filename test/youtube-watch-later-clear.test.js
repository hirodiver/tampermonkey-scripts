const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// youtube-watch-later-clear.user.js の検証用ハーネス。
//
// 「後で見る」の一覧（100本ずつ読み込まれる）と、「︙」メニューを模したDOMに
// スクリプトを流し込み、
// 「ボタンが出る／確認で断ると何も消えない／全部消える（続きの読み込み分も）／
//   一覧の外の動画は残る／止められる／消せない行は飛ばす／
//   ほかの再生リストではボタンが出ない／消した動画の記録がテキストで保存される」を確認する。
//
//   NODE_PATH=$(npm root -g) node test/youtube-watch-later-clear.test.js
//
// YouTube の実DOMそのものではないため、実機確認の代わりにはならない。

const SCRIPT = fs.readFileSync(
    path.join(__dirname, '..', 'youtube-watch-later-clear.user.js'),
    'utf8'
);

// first: 最初に見えている本数 / more: 続きで読み込まれる本数 / broken: 削除項目が無い行の番号
function html(opts) {
    return `<!doctype html><html><head><meta charset="utf-8">
<style>
  ytd-playlist-video-renderer { display:block; height:60px; }
  tp-yt-iron-dropdown { display:none; position:fixed; top:10px; left:10px; background:#fff; }
  tp-yt-iron-dropdown.open { display:block; }
  ytd-continuation-item-renderer { display:block; height:20px; }
  #spacer { height:1500px; }
</style></head><body>
<ytd-app>
  <ytd-browse page-subtype="playlist">
    <ytd-playlist-video-list-renderer>
      <div id="contents"></div>
    </ytd-playlist-video-list-renderer>
  </ytd-browse>
  <div id="secondary">
    <ytd-compact-video-renderer id="related"><a href="/watch?v=rel1">関連動画</a>
      <ytd-menu-renderer><yt-icon-button><button aria-label="操作メニュー">︙</button></yt-icon-button></ytd-menu-renderer>
    </ytd-compact-video-renderer>
  </div>
</ytd-app>
<ytd-popup-container>
  <tp-yt-iron-dropdown>
    <ytd-menu-popup-renderer>
      <ytd-menu-service-item-renderer id="item-save"><tp-yt-paper-item>再生リストに保存</tp-yt-paper-item></ytd-menu-service-item-renderer>
      <ytd-menu-service-item-renderer id="item-remove"><tp-yt-paper-item>[後で見る]から削除</tp-yt-paper-item></ytd-menu-service-item-renderer>
    </ytd-menu-popup-renderer>
  </tp-yt-iron-dropdown>
</ytd-popup-container>
<script>
  const opts = ${JSON.stringify(opts)};
  const contents = document.getElementById('contents');
  const dropdown = document.querySelector('tp-yt-iron-dropdown');
  const removeItem = document.getElementById('item-remove');
  let target = null;
  let serial = 0;
  window.removed = [];

  function addRow() {
    serial += 1;
    const n = serial;
    const row = document.createElement('ytd-playlist-video-renderer');
    row.dataset.n = String(n);
    const a = document.createElement('a');
    a.id = 'video-title';
    a.href = '/watch?v=vid' + n + '&list=WL&index=' + n;
    a.title = '動画' + n;
    a.textContent = '動画' + n;
    const menu = document.createElement('div');
    menu.id = 'menu';
    const icon = document.createElement('yt-icon-button');
    const btn = document.createElement('button');
    btn.setAttribute('aria-label', '操作メニュー');
    btn.textContent = '︙';
    btn.addEventListener('click', () => {
      target = row;
      removeItem.style.display = opts.broken.includes(n) ? 'none' : '';
      setTimeout(() => dropdown.classList.add('open'), 30);
    });
    icon.appendChild(btn);
    menu.appendChild(icon);
    const thumb = document.createElement('ytd-thumbnail-overlay-time-status-renderer');
    const time = document.createElement('span');
    time.id = 'text';
    time.textContent = '  1' + n + ':0' + (n % 10) + '  ';
    thumb.appendChild(time);
    const channel = document.createElement('ytd-channel-name');
    const ca = document.createElement('a');
    ca.href = '/@ch' + n;
    ca.textContent = 'チャンネル' + n;
    channel.appendChild(ca);
    const info = document.createElement('div');
    info.id = 'video-info';
    ['1' + n + '万 回視聴', '•', n + '日前'].forEach((t) => {
      const span = document.createElement('span');
      span.textContent = t;
      info.appendChild(span);
    });
    row.append(thumb, a, channel, info, menu);
    contents.appendChild(row);
  }

  for (let i = 0; i < opts.first; i++) addRow();

  if (opts.more > 0) {
    const cont = document.createElement('ytd-continuation-item-renderer');
    const spacer = document.createElement('div');
    spacer.id = 'spacer';
    contents.parentElement.append(spacer, cont);
    new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && cont.isConnected) {
        setTimeout(() => {
          for (let i = 0; i < opts.more; i++) addRow();
          cont.remove();
          spacer.remove();
        }, 150);
      }
    }).observe(cont);
  }

  removeItem.querySelector('tp-yt-paper-item').addEventListener('click', () => {
    dropdown.classList.remove('open');
    const row = target;
    setTimeout(() => {
      window.removed.push(Number(row.dataset.n));
      row.remove();
    }, 60);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') dropdown.classList.remove('open');
  });
</script>
</body></html>`;
}

const results = [];

function check(name, cond, extra) {
    results.push({ name, ok: !!cond });
    console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (!cond && extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
}

async function openPage(browser, url, opts, confirmAnswer) {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('dialog', (d) => (confirmAnswer ? d.accept() : d.dismiss()));
    await page.route('https://www.youtube.com/**', (route) =>
        route.fulfill({ contentType: 'text/html; charset=utf-8', body: html(opts) })
    );
    await page.addInitScript(SCRIPT);
    await page.goto(url);
    await page.waitForTimeout(400);
    return { context, page };
}

const rowCount = (page) => page.evaluate(() => document.querySelectorAll('ytd-playlist-video-renderer').length);
const statusText = (page) => page.evaluate(() => (document.getElementById('tm-ywlc-status') || {}).textContent || '');

async function waitIdle(page, timeout) {
    await page.waitForFunction(
        () => !/停止/.test(document.getElementById('tm-ywlc-button').textContent),
        null,
        { timeout }
    );
}

(async () => {
    const browser = await chromium.launch();
    const WL = 'https://www.youtube.com/playlist?list=WL';

    // ---------------- 全部消す（続きの読み込みを含む）
    {
        const { context, page } = await openPage(browser, WL, { first: 4, more: 3, broken: [] }, true);

        check('後で見るのページにボタンが出る', await page.isVisible('#tm-ywlc-button'));
        check('ボタンの文字', (await page.textContent('#tm-ywlc-button')) === '後で見るを全部削除');

        const downloadPromise = page.waitForEvent('download', { timeout: 30000 });

        await page.click('#tm-ywlc-button');
        await page.waitForTimeout(300);
        check('実行中はボタンが「停止」になる', /停止/.test(await page.textContent('#tm-ywlc-button')));
        check('実行中は「記録を保存」を出さない', !(await page.isVisible('#tm-ywlc-save')));

        await waitIdle(page, 30000);

        check('一覧が空になる（続きの3本も）', (await rowCount(page)) === 0, await rowCount(page));
        check('7本消えた', (await page.evaluate(() => window.removed.length)) === 7,
            await page.evaluate(() => window.removed));
        check('一覧の外の関連動画は残る', await page.evaluate(() => !!document.getElementById('related')));
        check('終わりの表示に件数が出る', /完了：7件削除/.test(await statusText(page)), await statusText(page));

        // 終わったら記録のテキストが自動で保存される
        const download = await downloadPromise;
        const file = fs.readFileSync(await download.path(), 'utf8');
        check('記録のファイル名', /^youtube-watch-later-removed_\d{8}-\d{4}\.txt$/.test(download.suggestedFilename()), download.suggestedFilename());
        check('記録に件数が出る', file.includes('削除 7件 / 失敗 0件'));
        check('記録にタイトルが出る', file.includes('1. 動画1') && file.includes('7. 動画7'));
        check('記録にチャンネル名が出る', file.includes('チャンネル: チャンネル3'));
        check('記録の URL は list を外した形', file.includes('URL: https://www.youtube.com/watch?v=vid5\r\n'));
        check('記録に長さが出る', file.includes('長さ: 12:02'));
        check('記録に再生回数・投稿時期が出る', file.includes('再生回数・投稿: 14万 回視聴 / 4日前'));
        check('記録に削除日時が出る', /削除: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}/.test(file));
        check('記録は BOM 付き', file.charCodeAt(0) === 0xFEFF);

        check('終わったら「記録を保存（7件）」が出る', (await page.textContent('#tm-ywlc-save')) === '記録を保存（7件）');

        // 再読み込みしても前回の記録を保存し直せる
        await page.reload();
        await page.waitForTimeout(400);
        check('再読み込み後も「記録を保存」が出る', await page.isVisible('#tm-ywlc-save'));

        const again = page.waitForEvent('download', { timeout: 5000 });
        await page.click('#tm-ywlc-save');
        const file2 = fs.readFileSync(await (await again).path(), 'utf8');
        check('前回の記録を保存し直せる', file2.includes('削除 7件 / 失敗 0件'));

        await context.close();
    }

    // ---------------- 確認で断ると何も消えない
    {
        const { context, page } = await openPage(browser, WL, { first: 3, more: 0, broken: [] }, false);

        await page.click('#tm-ywlc-button');
        await page.waitForTimeout(800);
        check('確認で断ると何も消えない', (await rowCount(page)) === 3);

        await context.close();
    }

    // ---------------- 途中で止める
    {
        const { context, page } = await openPage(browser, WL, { first: 10, more: 0, broken: [] }, true);

        await page.click('#tm-ywlc-button');
        await page.waitForFunction(() => window.removed.length >= 2, null, { timeout: 10000 });
        await page.click('#tm-ywlc-button');
        await waitIdle(page, 10000);

        const left = await rowCount(page);
        check('止めると途中で止まる', left > 0 && left < 10, left);
        check('止めたと表示される', /停止しました/.test(await statusText(page)), await statusText(page));

        const log = await page.evaluate(() => window.__tmYtWatchLaterClear.log());
        check('止めたときも消した分は記録に残る', log.entries.length === 10 - left && !!log.finishedAt, log);

        await context.close();
    }

    // ---------------- 消せない行は飛ばして続ける
    {
        const { context, page } = await openPage(browser, WL, { first: 4, more: 0, broken: [2] }, true);

        await page.click('#tm-ywlc-button');
        await waitIdle(page, 30000);

        const left = await page.evaluate(() =>
            Array.from(document.querySelectorAll('ytd-playlist-video-renderer')).map((r) => r.dataset.n));
        check('消せない行だけ残る', JSON.stringify(left) === '["2"]', left);
        check('失敗件数が出る', /3件削除（失敗1件）/.test(await statusText(page)), await statusText(page));

        const text = await page.evaluate(() => window.__tmYtWatchLaterClear.text());
        check('記録に消せなかった動画が分けて出る', /消せなかった動画[\s\S]*動画2[\s\S]*失敗: /.test(text), text);
        check('失敗後にメニューは閉じている', await page.evaluate(() =>
            !document.querySelector('tp-yt-iron-dropdown').classList.contains('open')));

        const rows = await page.evaluate(() => window.__tmYtWatchLaterClear.dump());
        check('診断 dump が表を返す', Array.isArray(rows) && rows.length === 1 && rows[0]['失敗済み'] === '★', rows);

        await context.close();
    }

    // ---------------- ほかの再生リスト・トップではボタンが出ない
    {
        const { context, page } = await openPage(browser, 'https://www.youtube.com/playlist?list=PLabc', { first: 3, more: 0, broken: [] }, true);

        check('ほかの再生リストではボタンが出ない', !(await page.$('#tm-ywlc-button')));

        // SPA 遷移で後で見るへ来たら出る
        await page.evaluate(() => {
            history.pushState({}, '', '/playlist?list=WL');
            document.dispatchEvent(new Event('yt-navigate-finish'));
        });
        await page.waitForTimeout(400);
        check('SPA 遷移で後で見るへ来たら出る', await page.isVisible('#tm-ywlc-button'));

        await page.evaluate(() => {
            history.pushState({}, '', '/');
            document.dispatchEvent(new Event('yt-navigate-finish'));
        });
        await page.waitForTimeout(400);
        check('離れたら消える', !(await page.$('#tm-ywlc-button')));

        await context.close();
    }

    await browser.close();

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
})();
