const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// youtube-hide-chat-users.user.js の検証用ハーネス。
//
// 実機（YouTubeのライブチャット）の代わりに、
// チャット欄の構造を模したDOMへスクリプトを流し込み、
// 「指定した相手だけが消え、他は残る」ことを確認する。
//
//   NODE_PATH=$(npm root -g) node test/youtube-hide-chat-users.test.js
//
// YouTubeの実DOMそのものは再現できないため、
// これに通ることは実機で動くことを保証しない。

const SCRIPT = fs.readFileSync(
  process.env.SCRIPT_PATH ||
    path.join(__dirname, '..', 'youtube-hide-chat-users.user.js'),
  'utf8'
);

const HTML = `<!doctype html><html dark><meta charset="utf-8"><title>live-chat-mock</title>
<body>
<yt-live-chat-header-renderer id="header" style="display:block;height:64px;"></yt-live-chat-header-renderer>
<div id="items"></div>
</body></html>`;

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra && !cond ? '  -> ' + JSON.stringify(extra) : ''));
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.route('https://www.youtube.com/**', (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML })
  );
  await page.goto('https://www.youtube.com/live_chat?v=abc');

  await page.evaluate(() => {
    const items = document.getElementById('items');

    // 通常の発言
    window.mkMessage = (id, channelId, authorName, text) => {
      const el = document.createElement('yt-live-chat-text-message-renderer');
      el.id = id;
      if (channelId) el.setAttribute('author-external-channel-id', channelId);
      const name = document.createElement('span');
      name.id = 'author-name';
      name.textContent = authorName;
      const body = document.createElement('span');
      body.id = 'message';
      body.textContent = text;
      el.appendChild(name);
      el.appendChild(body);
      items.appendChild(el);
      return el;
    };

    // スーパーチャット
    window.mkPaid = (id, channelId, authorName) => {
      const el = document.createElement('yt-live-chat-paid-message-renderer');
      el.id = id;
      el.setAttribute('author-external-channel-id', channelId);
      const name = document.createElement('span');
      name.id = 'author-name';
      name.textContent = authorName;
      el.appendChild(name);
      items.appendChild(el);
      return el;
    };

    // 上部のティッカー（属性を持たず、データだけが手がかり）
    window.mkTicker = (id, channelId) => {
      const el = document.createElement('yt-live-chat-ticker-paid-message-item-renderer');
      el.id = id;
      el.__data = { data: { showItemEndpoint: { item: { authorExternalChannelId: channelId } } } };
      items.appendChild(el);
      return el;
    };
  });

  // スクリプト本体を流し込む
  await page.evaluate(SCRIPT);
  await page.waitForTimeout(100);

  const shown = (id) =>
    page.evaluate((x) => {
      const el = document.getElementById(x);
      if (!el) return null;
      return getComputedStyle(el).display !== 'none';
    }, id);

  // --- 初期状態 ---
  await page.evaluate(() => {
    window.mkMessage('m1', 'UC_AAA', 'あらし', 'うるさい発言');
    window.mkMessage('m2', 'UC_BBB', 'ふつうの人', 'こんばんは');
  });
  await page.waitForTimeout(150);
  check('初期: 何も登録していなければ全部見える', (await shown('m1')) === true && (await shown('m2')) === true);

  // --- ボタンの設置 ---
  check('ボタン: 発言ごとに「非表示」ボタンが付く', await page.evaluate(() => !!document.querySelector('#m1 > .tm-ychide-btn-all')));
  check('ボタン: 発言ごとに「文だけ」ボタンが付く', await page.evaluate(() => !!document.querySelector('#m1 > .tm-ychide-btn-text')));

  // --- ボタンで追加（まるごと消す） ---
  await page.evaluate(() => document.querySelector('#m1 > .tm-ychide-btn-all').click());
  await page.waitForTimeout(150);
  check('追加: 押した相手の発言が消える', (await shown('m1')) === false);
  check('追加: 他人の発言は残る', (await shown('m2')) === true);
  check('保存: localStorage に残る', await page.evaluate(() => (localStorage.getItem('tm-yt-chat-hide-users') || '').includes('UC_AAA')));

  // --- 後から来た発言 ---
  await page.evaluate(() => {
    window.mkMessage('m3', 'UC_AAA', 'あらし', '続きの発言');
    window.mkMessage('m4', 'UC_CCC', '別の人', 'はじめまして');
  });
  await page.waitForTimeout(200);
  check('新着: 同じ相手の新しい発言も消える', (await shown('m3')) === false);
  check('新着: 無関係な新着は残る', (await shown('m4')) === true);

  // --- スパチャ・ティッカー ---
  await page.evaluate(() => {
    window.mkPaid('p1', 'UC_AAA', 'あらし');
    window.mkPaid('p2', 'UC_BBB', 'ふつうの人');
    window.mkTicker('t1', 'UC_AAA');
    window.mkTicker('t2', 'UC_BBB');
  });
  await page.waitForTimeout(200);
  check('スパチャ: 対象者のスパチャも消える', (await shown('p1')) === false);
  check('スパチャ: 他人のスパチャは残る', (await shown('p2')) === true);
  check('ティッカー: 対象者の上部表示も消える', (await shown('t1')) === false);
  check('ティッカー: 他人の上部表示は残る', (await shown('t2')) === true);

  // --- 表示名だけでの指定（チャンネルIDが取れない相手の保険） ---
  await page.evaluate(() => {
    window.mkMessage('m5', '', '名無しさん', 'IDが取れない発言');
    window.__tmChatHide.add('', '名無しさん');
  });
  await page.waitForTimeout(200);
  check('表示名: IDが無い相手は名前で消せる', (await shown('m5')) === false);

  // --- 一時解除 ---
  await page.evaluate(() => window.__tmChatHide.pause(true));
  await page.waitForTimeout(150);
  check('一時解除: 消していた発言が戻る', (await shown('m1')) === true && (await shown('t1')) === true);

  await page.evaluate(() => window.__tmChatHide.pause(false));
  await page.waitForTimeout(150);
  check('一時解除の解除: また消える', (await shown('m1')) === false);

  // --- 名前を残して本文だけ消す ---
  await page.evaluate(() => {
    window.mkMessage('t1msg', 'UC_EEE', '本文だけ消す人', '消える本文');
  });
  await page.waitForTimeout(150);
  await page.evaluate(() => document.querySelector('#t1msg > .tm-ychide-btn-text').click());
  await page.waitForTimeout(200);
  check('文だけ: 発言そのものは残る', (await shown('t1msg')) === true);
  check('文だけ: 名前は見える', await page.evaluate(() => {
    const el = document.querySelector('#t1msg #author-name');
    return !!el && getComputedStyle(el).display !== 'none';
  }));
  check('文だけ: 本文は消える', await page.evaluate(() => {
    const el = document.querySelector('#t1msg #message');
    return !!el && getComputedStyle(el).display === 'none';
  }));
  check('文だけ: 代わりに（非表示）が出る', await page.evaluate(() => {
    const el = document.querySelector('#t1msg .tm-ychide-mask');
    return !!el && getComputedStyle(el).display !== 'none' && el.textContent === '（非表示）';
  }));

  // 同じ相手に「非表示」を押したら、二重登録ではなく切り替えになる
  const beforeSwitch = await page.evaluate(() => window.__tmChatHide.list().length);
  await page.evaluate(() => document.querySelector('#t1msg > .tm-ychide-btn-all').click());
  await page.waitForTimeout(200);
  check('切替: 文だけ→全部に変えると発言ごと消える', (await shown('t1msg')) === false);
  check('切替: 二重登録にならない', (await page.evaluate(() => window.__tmChatHide.list().length)) === beforeSwitch);

  // --- パネル ---
  check('パネル: 開くボタンがある', await page.evaluate(() => !!document.querySelector('.tm-ychide-open')));
  await page.evaluate(() => document.querySelector('.tm-ychide-open').click());
  await page.waitForTimeout(100);
  check('パネル: 登録した人数が並ぶ', (await page.evaluate(() => document.querySelectorAll('#tm-ychide-panel .tm-ychide-row').length)) === 3);
  check('位置: ボタンが画面の上側にある', await page.evaluate(() => {
    const r = document.querySelector('.tm-ychide-open').getBoundingClientRect();
    return r.top < window.innerHeight / 2;
  }));
  check('位置: ボタンが見出し帯より下にある', await page.evaluate(() => {
    const head = document.getElementById('header').getBoundingClientRect();
    const btn = document.querySelector('.tm-ychide-open').getBoundingClientRect();
    return btn.top >= head.bottom;
  }), await page.evaluate(() => ({
    headerBottom: document.getElementById('header').getBoundingClientRect().bottom,
    buttonTop: document.querySelector('.tm-ychide-open').getBoundingClientRect().top
  })));
  check('位置: パネルがボタンより下にある', await page.evaluate(() => {
    const btn = document.querySelector('.tm-ychide-open').getBoundingClientRect();
    const p = document.getElementById('tm-ychide-panel').getBoundingClientRect();
    return p.top >= btn.top;
  }));
  check('パネル: 消し方の切り替えボタンがある', await page.evaluate(() => {
    const row = document.querySelectorAll('#tm-ychide-panel .tm-ychide-row')[0];
    const btn = row.querySelector('.tm-ychide-mode');
    return !!btn && (btn.textContent === '全部' || btn.textContent === '文だけ');
  }));

  // --- 見出し帯の高さが変わったら追従する ---
  await page.evaluate(() => {
    document.getElementById('header').style.height = '120px';
    document.getElementById('items').appendChild(document.createElement('div'));
  });
  await page.waitForTimeout(1200);
  check('位置: 帯が高くなるとボタンも下がる', await page.evaluate(() => {
    const head = document.getElementById('header').getBoundingClientRect();
    const btn = document.querySelector('.tm-ychide-open').getBoundingClientRect();
    return btn.top >= head.bottom;
  }));

  // --- 解除 ---
  await page.evaluate(() => {
    const rows = document.querySelectorAll('#tm-ychide-panel .tm-ychide-row');
    rows[0].querySelector('.tm-ychide-remove').click();
  });
  await page.waitForTimeout(200);
  check('解除: 発言が表示に戻る', (await shown('m1')) === true && (await shown('m3')) === true);
  check('解除: リストからも消える', (await page.evaluate(() => window.__tmChatHide.list().length)) === 2, await page.evaluate(() => window.__tmChatHide.list()));

  // --- 重複追加 ---
  await page.evaluate(() => {
    window.__tmChatHide.add('UC_DDD', '重複テスト');
    window.__tmChatHide.add('UC_DDD', '重複テスト');
  });
  check('重複: 同じ相手を二重に登録しない', (await page.evaluate(() => window.__tmChatHide.list().filter((e) => e.id === 'UC_DDD').length)) === 1);

  // --- 診断関数 ---
  check('診断: __tmChatHide.dump() が動く', await page.evaluate(() => Array.isArray(window.__tmChatHide.dump())));

  // --- 再読み込み後も残る ---
  await page.reload();
  await page.evaluate(SCRIPT);
  await page.evaluate(() => {
    // リロードでヘルパは消えるので、ここでは直接組み立てる
    const el = document.createElement('yt-live-chat-text-message-renderer');
    el.id = 'm6';
    el.setAttribute('author-external-channel-id', 'UC_DDD');
    document.getElementById('items').appendChild(el);
  });
  await page.waitForTimeout(200);
  check('再読み込み: 設定が引き継がれる', (await shown('m6')) === false);

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通過');
  process.exit(failed.length ? 1 : 0);
})();
