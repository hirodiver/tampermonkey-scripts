const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// youtube-chat-highlight.user.js の検証用ハーネス。
//
// チャット欄の構造を模したDOMへスクリプトを流し込み、
// 「強調ワードを名前・チャンネルID・本文のどこかに含む発言だけが
// 強調される」ことを確認する。
//
//   NODE_PATH=$(npm root -g) node test/youtube-chat-highlight.test.js
//
// YouTubeの実DOMそのものは再現できないため、
// これに通ることは実機で動くことを保証しない。

const SCRIPT = fs.readFileSync(
  process.env.SCRIPT_PATH ||
    path.join(__dirname, '..', 'youtube-chat-highlight.user.js'),
  'utf8'
);

const HIDE_SCRIPT = fs.readFileSync(
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

const HELPERS = () => {
  const items = document.getElementById('items');

  window.mkMessage = (id, channelId, authorName, text, emojiAlt) => {
    const el = document.createElement('yt-live-chat-text-message-renderer');
    el.id = id;
    if (channelId) el.setAttribute('author-external-channel-id', channelId);
    const name = document.createElement('span');
    name.id = 'author-name';
    name.textContent = authorName;
    const body = document.createElement('span');
    body.id = 'message';
    body.textContent = text;
    if (emojiAlt) {
      const img = document.createElement('img');
      img.setAttribute('alt', emojiAlt);
      body.appendChild(img);
    }
    el.appendChild(name);
    el.appendChild(body);
    items.appendChild(el);
    return el;
  };

  window.mkPaid = (id, channelId, authorName, text) => {
    const el = document.createElement('yt-live-chat-paid-message-renderer');
    el.id = id;
    el.setAttribute('author-external-channel-id', channelId);
    const name = document.createElement('span');
    name.id = 'author-name';
    name.textContent = authorName;
    const body = document.createElement('div');
    body.id = 'message';
    body.textContent = text;
    el.appendChild(name);
    el.appendChild(body);
    items.appendChild(el);
    return el;
  };

  window.mkTicker = (id, channelId) => {
    const el = document.createElement('yt-live-chat-ticker-paid-message-item-renderer');
    el.id = id;
    el.__data = { data: { showItemEndpoint: { item: { authorExternalChannelId: channelId } } } };
    items.appendChild(el);
    return el;
  };
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.route('https://www.youtube.com/**', (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML })
  );
  await page.goto('https://www.youtube.com/live_chat?v=abc');
  await page.evaluate(HELPERS);

  await page.evaluate(SCRIPT);
  await page.waitForTimeout(100);

  const hit = (id) =>
    page.evaluate((x) => {
      const el = document.getElementById(x);
      return el ? el.classList.contains('tm-ychl-hit') : null;
    }, id);

  await page.evaluate(() => {
    window.mkMessage('m1', 'UC_AAA', '@たろう', 'こんばんは');
    window.mkMessage('m2', 'UC_BBB', '@はなこ', '初見です！よろしく');
    window.mkMessage('m3', 'UC_CCC', '@Guest', 'hello WORLD');
    window.mkMessage('m4', 'UC_DDD', '@emoji', 'いいね', ':partying_face:');
  });
  await page.waitForTimeout(150);

  check('初期: 何も入れていなければ強調しない',
    (await hit('m1')) === false && (await hit('m2')) === false);

  // --- 入力欄から設定 ---
  await page.click('.tm-ychl-open');
  check('パネル: ボタンで入力欄が開く', await page.evaluate(() => !document.getElementById('tm-ychl-panel').hidden));
  check('パネル: 開いたら入力欄にフォーカスが移る', await page.evaluate(() => document.activeElement && document.activeElement.tagName === 'TEXTAREA'));

  await page.fill('#tm-ychl-panel textarea', '初見');
  await page.waitForTimeout(150);
  check('本文: 本文に含む発言が強調される', (await hit('m2')) === true);
  check('本文: 含まない発言は強調されない', (await hit('m1')) === false && (await hit('m3')) === false);
  check('保存: localStorage に残る', await page.evaluate(() => localStorage.getItem('tm-yt-chat-highlight-words') === '初見'));
  check('件数: 強調中の件数が出る', await page.evaluate(() => document.querySelector('#tm-ychl-panel .tm-ychl-count').textContent.includes('1 件')));

  await page.fill('#tm-ychl-panel textarea', 'たろう');
  await page.waitForTimeout(150);
  check('名前: 名前に含む発言が強調される', (await hit('m1')) === true);
  check('入れ替え: 外れた語の発言は強調が外れる', (await hit('m2')) === false);

  await page.fill('#tm-ychl-panel textarea', 'uc_ccc');
  await page.waitForTimeout(150);
  check('ID: チャンネルIDで強調される（大文字小文字を区別しない）', (await hit('m3')) === true);

  await page.fill('#tm-ychl-panel textarea', 'ｗｏｒｌｄ');
  await page.waitForTimeout(150);
  check('全角: 全角英字でも半角の発言に当たる', (await hit('m3')) === true);

  await page.fill('#tm-ychl-panel textarea', 'partying');
  await page.waitForTimeout(150);
  check('絵文字: 絵文字の代替テキストでも当たる', (await hit('m4')) === true);

  await page.fill('#tm-ychl-panel textarea', 'たろう\n\n  はなこ  \n');
  await page.waitForTimeout(150);
  check('複数: 改行区切りの複数語のどれかで強調（空行・前後の空白は無視）',
    (await hit('m1')) === true && (await hit('m2')) === true && (await hit('m3')) === false && (await hit('m4')) === false);

  // --- 後から来た発言・スパチャ・ティッカー ---
  await page.evaluate(() => {
    window.mkMessage('m5', 'UC_EEE', '@whoever', 'たろうさん来た');
    window.mkPaid('p1', 'UC_FFF', '@rich', 'はなこへ');
    window.mkTicker('t1', 'UC_AAA');
  });
  await page.waitForTimeout(150);
  check('新着: 後から来た発言も強調される', (await hit('m5')) === true);
  check('スパチャ: スーパーチャットも強調される', (await hit('p1')) === true);
  await page.evaluate(() => window.__tmChatHighlight.set('uc_aaa'));
  await page.waitForTimeout(150);
  check('ティッカー: データ内のチャンネルIDで強調される', (await hit('t1')) === true);

  // --- 要素の使い回し ---
  await page.evaluate(() => window.__tmChatHighlight.set('たろう'));
  await page.evaluate(() => {
    const el = document.getElementById('m1');
    el.querySelector('#author-name').textContent = '@じろう';
    el.setAttribute('author-external-channel-id', 'UC_ZZZ');
  });
  await page.waitForTimeout(1200);
  check('使い回し: 中身が変わった要素は強調が外れる', (await hit('m1')) === false);

  // --- 見た目 ---
  check('見た目: 強調した発言に黄色い帯が付く', await page.evaluate(() =>
    getComputedStyle(document.getElementById('m5')).boxShadow.includes('255, 202, 40')));

  // --- 空にしたら全部外れる ---
  await page.fill('#tm-ychl-panel textarea', '');
  await page.waitForTimeout(150);
  check('空: 空にすると強調がすべて外れる',
    await page.evaluate(() => document.querySelectorAll('.tm-ychl-hit').length === 0));

  // --- 無限ループしない（件数表示の書き換えで監視が再発火し続けない） ---
  const loops = await page.evaluate(async () => {
    let n = 0;
    const obs = new MutationObserver(() => n++);
    obs.observe(document.getElementById('tm-ychl-panel'), { childList: true, subtree: true, characterData: true });
    await new Promise((r) => setTimeout(r, 300));
    obs.disconnect();
    return n;
  });
  check('安定: 何も起きていないときパネルが書き換わり続けない', loops === 0, loops);

  // --- 再読み込み後も残る ---
  await page.evaluate(() => window.__tmChatHighlight.set('初見'));
  await page.reload();
  await page.evaluate(HELPERS);
  await page.evaluate(SCRIPT);
  await page.evaluate(() => window.mkMessage('r1', 'UC_X', '@x', '初見です'));
  await page.waitForTimeout(200);
  check('再読み込み: 設定が引き継がれる', (await hit('r1')) === true);
  check('再読み込み: 入力欄にも前回の語が入っている', await page.evaluate(() => document.querySelector('#tm-ychl-panel textarea').value === '初見'));

  // --- 非表示スクリプトと併用したときボタンが重ならない ---
  await page.evaluate(HIDE_SCRIPT);
  await page.waitForTimeout(1200);
  const overlap = await page.evaluate(() => {
    const a = document.querySelector('.tm-ychl-open').getBoundingClientRect();
    const b = document.querySelector('.tm-ychide-open').getBoundingClientRect();
    return { overlap: a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom, a: a.toJSON(), b: b.toJSON() };
  });
  check('併用: 「非表示リスト」ボタンと重ならない', !overlap.overlap, overlap);
  check('位置: ボタンが見出し帯より下に出る', await page.evaluate(() =>
    document.querySelector('.tm-ychl-open').getBoundingClientRect().top >= 64));

  check('診断: __tmChatHighlight.dump() が動く', await page.evaluate(() => Array.isArray(window.__tmChatHighlight.dump())));

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通過');
  process.exit(failed.length ? 1 : 0);
})();
