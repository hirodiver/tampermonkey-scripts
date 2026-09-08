const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// x-youtube-card-open-in-browser.user.js の検証用ハーネス。
//
// 実機（iOS Safari + Tampermonkey）の代わりに、
// Xのカード構造を模したDOMへスクリプトを流し込み、
// ヘッドレスChromiumで検出・URL解決・ボタン設置の挙動を確認する。
//
//   NODE_PATH=$(npm root -g) node test/x-youtube-card.test.js
//
// GM_xmlhttpRequest / window.open はモックしている。
// Xの実DOMやReactの内部構造そのものは再現できないため、
// これに通ることは実機で動くことを保証しない。

const SCRIPT = fs.readFileSync(
  process.env.SCRIPT_PATH ||
    path.join(__dirname, '..', 'x-youtube-card-open-in-browser.user.js'),
  'utf8'
);

// X のカード構造を模した DOM
const HTML = `<!doctype html><meta charset="utf-8"><title>x-mock</title><body>
<div id="timeline"></div>
</body>`;

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  -> ' + JSON.stringify(extra) : ''));
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(HTML);

  // --- テスト用フィクスチャ ---
  await page.evaluate(() => {
    window.__opened = [];
    window.__fetched = [];
    const realOpen = window.open;
    window.open = (url, target) => {
      window.__opened.push(url);
      return {
        closed: false,
        close() { this.closed = true; },
        set location(v) { window.__opened.push('LOC:' + v); },
        get location() { return ''; },
      };
    };

    // syndication / oEmbed のモック
    window.__api = {}; // id -> {youtube:[...]}
    window.GM_xmlhttpRequest = (opts) => {
      window.__fetched.push(opts.url);
      const m = opts.url.match(/[?&]id=(\d+)/);
      const id = m && m[1];
      setTimeout(() => {
        if (opts.url.indexOf('cdn.syndication.twimg.com') === 0 ||
            opts.url.indexOf('https://cdn.syndication') === 0) {
          const entry = window.__api[id];
          if (!entry) { opts.onload({ status: 404, responseText: '' }); return; }
          opts.onload({
            status: 200,
            responseText: JSON.stringify({
              entities: { urls: entry.map((u) => ({ expanded_url: u })) },
            }),
          });
          return;
        }
        opts.onload({ status: 404, responseText: '' });
      }, 5);
    };

    // --- カード生成ヘルパ ---
    window.mkTweet = (opts) => {
      const art = document.createElement('article');
      art.innerHTML =
        '<a href="https://x.com/' + opts.user + '/status/' + opts.id + '">time</a>' +
        '<div data-testid="tweetText">' + (opts.text || '') + '</div>';
      (opts.cards || []).forEach((c) => {
        const w = document.createElement('div');
        w.setAttribute('data-testid', 'card.wrapper');
        w.innerHTML = c;
        art.appendChild(w);
      });
      document.getElementById('timeline').appendChild(art);
      return art;
    };
  });

  await page.addScriptTag({ content: SCRIPT });

  const rescan = async () => {
    // MutationObserver のデバウンス(200ms)を待つ
    await page.waitForTimeout(320);
  };

  // ===================================================================
  // 1. 直リンクのある通常カード
  // ===================================================================
  await page.evaluate(() => {
    window.mkTweet({
      user: 'alice', id: '1000000000000000001',
      cards: ['<a href="https://www.youtube.com/watch?v=ABCDEFGHIJK&si=xx">t</a><span>youtube.com</span>'],
    });
  });
  await rescan();
  check('1: 直リンクカードにボタンが出る',
    await page.locator('.hiroYtOpen-btn').count() === 1);
  check('1: href が正規化済み',
    (await page.locator('.hiroYtOpen-btn').first().getAttribute('href')) ===
      'https://www.youtube.com/watch?v=ABCDEFGHIJK&si=xx',
    { href: await page.locator('.hiroYtOpen-btn').first().getAttribute('href') });
  check('1: overlay 形態で カード内に設置',
    await page.evaluate(() => {
      const b = document.querySelector('.hiroYtOpen-btn');
      const c = document.querySelector('[data-testid="card.wrapper"]');
      return b.classList.contains('hiroYtOpen-overlay') && c.contains(b);
    }));

  // ===================================================================
  // 2. 「YouTube」を含むタイトルの他ドメインカード → ボタンを出さない
  // ===================================================================
  await page.evaluate(() => {
    document.getElementById('timeline').innerHTML = '';
    window.mkTweet({
      user: 'bob', id: '1000000000000000002',
      cards: ['<span>YouTubeで話題の動画まとめ</span><span>example.com</span>'],
    });
  });
  await rescan();
  check('2: 他ドメインカードにボタンを出さない',
    await page.locator('.hiroYtOpen-btn').count() === 0,
    { count: await page.locator('.hiroYtOpen-btn').count() });

  // ===================================================================
  // 3. 配信前ライブカード（アンカー無し・ドメイン表記のみ）
  // ===================================================================
  await page.evaluate(() => {
    document.getElementById('timeline').innerHTML = '';
    window.__api['1000000000000000003'] = ['https://www.youtube.com/live/LIVEID12345'];
    window.mkTweet({
      user: 'carol', id: '1000000000000000003',
      text: '今夜配信します',
      cards: ['<span>配信タイトル</span><span>youtube.com</span>'],
    });
  });
  await rescan();
  check('3: 配信前カードを検出しボタンを出す',
    await page.locator('.hiroYtOpen-btn').count() === 1);
  // prefetch を発火（IntersectionObserver 相当）
  await page.evaluate(() => {
    // ヘッドレスでは交差判定が走らない場合があるのでクリックで確認する
  });
  await page.locator('.hiroYtOpen-btn').first().click();
  await page.waitForTimeout(200);
  check('3: クリックで syndication から解決して開く',
    await page.evaluate(() => window.__opened.some((u) => String(u).indexOf('LIVEID12345') >= 0)),
    await page.evaluate(() => window.__opened));

  // ===================================================================
  // 4. 1 article に YouTube カード 2 枚
  // ===================================================================
  await page.evaluate(() => {
    document.getElementById('timeline').innerHTML = '';
    window.__opened = [];
    window.__api['1000000000000000004'] = [
      'https://www.youtube.com/watch?v=FIRSTVIDEO',
      'https://www.youtube.com/watch?v=SECONDVIDE',
    ];
    window.mkTweet({
      user: 'dave', id: '1000000000000000004',
      cards: [
        '<span>A</span><span>youtube.com</span>',
        '<span>B</span><span>youtube.com</span>',
      ],
    });
  });
  await rescan();
  check('4: 2枚ともボタンが出る',
    await page.locator('.hiroYtOpen-btn').count() === 2,
    { count: await page.locator('.hiroYtOpen-btn').count() });
  await page.locator('.hiroYtOpen-btn').nth(1).click();
  await page.waitForTimeout(200);
  check('4: 2枚目は2本目のURLで開く',
    await page.evaluate(() => window.__opened.some((u) => String(u).indexOf('SECONDVIDE') >= 0)),
    await page.evaluate(() => window.__opened));

  // ===================================================================
  // 5. 展開後（iframe あり）→ inline 形態に切り替わる
  // ===================================================================
  await page.evaluate(() => {
    document.getElementById('timeline').innerHTML = '';
    window.mkTweet({
      user: 'erin', id: '1000000000000000005',
      cards: ['<span>x</span><span>youtube.com</span>'],
    });
  });
  await rescan();
  check('5: 展開前は overlay',
    await page.evaluate(() =>
      document.querySelector('.hiroYtOpen-btn').classList.contains('hiroYtOpen-overlay')));
  await page.evaluate(() => {
    const c = document.querySelector('[data-testid="card.wrapper"]');
    const f = document.createElement('iframe');
    f.src = 'https://www.youtube.com/embed/EMBEDID1234?autoplay=1';
    c.appendChild(f);
  });
  await rescan();
  check('5: 展開後は inline でカード外',
    await page.evaluate(() => {
      const b = document.querySelector('.hiroYtOpen-btn');
      const c = document.querySelector('[data-testid="card.wrapper"]');
      return b && !b.classList.contains('hiroYtOpen-overlay') && !c.contains(b);
    }));
  check('5: 展開後は host クラスが残らない',
    await page.evaluate(() =>
      !document.querySelector('[data-testid="card.wrapper"]').classList.contains('hiroYtOpen-host')));
  check('5: 展開後の href が embed から解決される',
    (await page.locator('.hiroYtOpen-btn').first().getAttribute('href')) ===
      'https://www.youtube.com/watch?v=EMBEDID1234',
    { href: await page.locator('.hiroYtOpen-btn').first().getAttribute('href') });

  // ===================================================================
  // 6. 仮想リストの DOM 再利用（同じカード要素が別ツイートに化ける）
  // ===================================================================
  await page.evaluate(() => {
    document.getElementById('timeline').innerHTML = '';
    window.mkTweet({
      user: 'frank', id: '1000000000000000006',
      cards: ['<a href="https://www.youtube.com/watch?v=OLDVIDEO111">t</a><span>youtube.com</span>'],
    });
  });
  await rescan();
  const before = await page.locator('.hiroYtOpen-btn').first().getAttribute('href');
  await page.evaluate(() => {
    // 同じ article / card 要素を使い回し、中身だけ別ツイートに差し替える
    const art = document.querySelector('article');
    art.querySelector('a[href*="/status/"]').href =
      'https://x.com/frank/status/1000000000000000007';
    const card = art.querySelector('[data-testid="card.wrapper"]');
    // 新しいツイートは配信前ライブ（直リンク無し）
    card.querySelector('a').remove();
  });
  await rescan();
  const after = await page.locator('.hiroYtOpen-btn').first().getAttribute('href');
  check('6: DOM再利用後に古い href が残らない',
    after !== 'https://www.youtube.com/watch?v=OLDVIDEO111',
    { before, after });

  // ===================================================================
  // 7. React 内部 state からの解決
  // ===================================================================
  await page.evaluate(() => {
    document.getElementById('timeline').innerHTML = '';
    window.mkTweet({
      user: 'gina', id: '1000000000000000008',
      cards: ['<span>y</span><span>youtube.com</span>'],
    });
    const card = document.querySelector('[data-testid="card.wrapper"]');
    card['__reactProps$abc123'] = {
      card: { url: 'https://youtu.be/REACTVID99?si=drop' },
    };
  });
  await rescan();
  check('7: React props から解決して正規化',
    (await page.locator('.hiroYtOpen-btn').first().getAttribute('href')) ===
      'https://www.youtube.com/watch?v=REACTVID99',
    { href: await page.locator('.hiroYtOpen-btn').first().getAttribute('href') });

  // ===================================================================
  // 8. 隣カードのURL混入（React探索が上へ遡らないこと）
  // ===================================================================
  await page.evaluate(() => {
    document.getElementById('timeline').innerHTML = '';
    const art = window.mkTweet({
      user: 'hana', id: '1000000000000000009',
      cards: ['<span>A</span><span>youtube.com</span>', '<span>B</span><span>youtube.com</span>'],
    });
    art['__reactProps$abc123'] = { url: 'https://www.youtube.com/watch?v=ARTICLEURL' };
  });
  await rescan();
  check('8: article の React props を拾わない',
    await page.evaluate(() =>
      Array.from(document.querySelectorAll('.hiroYtOpen-btn')).every(
        (b) => (b.getAttribute('href') || '').indexOf('ARTICLEURL') < 0)),
    await page.evaluate(() =>
      Array.from(document.querySelectorAll('.hiroYtOpen-btn')).map((b) => b.getAttribute('href'))));

  // ===================================================================
  // 9. 本文 t.co が複数あるとき、本文 t.co を採用しない
  // ===================================================================
  await page.evaluate(() => {
    document.getElementById('timeline').innerHTML = '';
    window.__opened = [];
    window.__api['1000000000000000010'] = ['https://www.youtube.com/watch?v=APIRESOLVED'];
    window.mkTweet({
      user: 'ivan', id: '1000000000000000010',
      text: '<a href="https://t.co/aaaa">l1</a><a href="https://t.co/bbbb">l2</a>',
      cards: ['<span>z</span><span>youtube.com</span>'],
    });
  });
  await rescan();
  await page.locator('.hiroYtOpen-btn').first().click();
  await page.waitForTimeout(200);
  check('9: 本文 t.co を使わず API 結果で開く',
    await page.evaluate(() => window.__opened.some((u) => String(u).indexOf('APIRESOLVED') >= 0) &&
      !window.__opened.some((u) => String(u).indexOf('t.co') >= 0)),
    await page.evaluate(() => window.__opened));

  // ===================================================================
  // 10. API が空振り → 取得失敗表示
  // ===================================================================
  await page.evaluate(() => {
    document.getElementById('timeline').innerHTML = '';
    window.mkTweet({
      user: 'judy', id: '1000000000000000011',
      cards: ['<span>w</span><span>youtube.com</span>'],
    });
  });
  await rescan();
  await page.locator('.hiroYtOpen-btn').first().click();
  await page.waitForTimeout(300);
  check('10: 失敗時に 取得失敗(API) を表示',
    (await page.locator('.hiroYtOpen-btn').first().textContent()).indexOf('取得失敗') >= 0,
    { text: await page.locator('.hiroYtOpen-btn').first().textContent() });

  // ===================================================================
  // 11. 失敗はキャッシュしない（再クリックで再リクエスト）
  // ===================================================================
  const n1 = await page.evaluate(() => window.__fetched.length);
  await page.waitForTimeout(1700);
  await page.locator('.hiroYtOpen-btn').first().click();
  await page.waitForTimeout(300);
  const n2 = await page.evaluate(() => window.__fetched.length);
  check('11: 失敗はキャッシュせず再取得する', n2 > n1, { n1, n2 });

  // ===================================================================
  // 12. 中クリック／修飾キーはブラウザ既定に委ねる
  // ===================================================================
  await page.evaluate(() => {
    document.getElementById('timeline').innerHTML = '';
    window.__opened = [];
    window.mkTweet({
      user: 'ken', id: '1000000000000000012',
      cards: ['<a href="https://www.youtube.com/watch?v=MIDDLECLICK">t</a><span>youtube.com</span>'],
    });
  });
  await rescan();
  const defaultPrevented = await page.evaluate(() => {
    const b = document.querySelector('.hiroYtOpen-btn');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 1 });
    b.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  check('12: 中クリックで preventDefault しない', defaultPrevented === false, { defaultPrevented });

  // ===================================================================
  // 13. カード1枚なら祖先の React props からも解決できる
  // ===================================================================
  await page.evaluate(() => {
    document.getElementById('timeline').innerHTML = '';
    const art = window.mkTweet({
      user: 'liz', id: '1000000000000000013',
      cards: ['<span>single</span><span>youtube.com</span>'],
    });
    art['__reactProps$abc123'] = { url: 'https://www.youtube.com/watch?v=ANCESTOR11' };
  });
  await rescan();
  check('13: カード1枚なら祖先 props から解決する',
    (await page.locator('.hiroYtOpen-btn').first().getAttribute('href')) ===
      'https://www.youtube.com/watch?v=ANCESTOR11',
    { href: await page.locator('.hiroYtOpen-btn').first().getAttribute('href') });

  // ===================================================================
  // 14. カード子孫の React props からも解決できる
  // ===================================================================
  await page.evaluate(() => {
    document.getElementById('timeline').innerHTML = '';
    window.mkTweet({
      user: 'mia', id: '1000000000000000014',
      cards: ['<div id="inner"><span>d</span></div><span>youtube.com</span>',
              '<span>other</span><span>youtube.com</span>'],
    });
    document.getElementById('inner')['__reactProps$abc123'] =
      { url: 'https://www.youtube.com/watch?v=DESCEND111' };
  });
  await rescan();
  check('14: 子孫 props から解決する（複数カードでも）',
    (await page.locator('.hiroYtOpen-btn').first().getAttribute('href')) ===
      'https://www.youtube.com/watch?v=DESCEND111',
    { href: await page.locator('.hiroYtOpen-btn').first().getAttribute('href') });
  check('14: 隣カードには混入しない',
    (await page.locator('.hiroYtOpen-btn').nth(1).getAttribute('href')) === null,
    { href: await page.locator('.hiroYtOpen-btn').nth(1).getAttribute('href') });

  // ===================================================================
  // 15. 先読み（IntersectionObserver）が DOM再利用後も再発火する
  // ===================================================================
  await page.evaluate(() => {
    document.getElementById('timeline').innerHTML = '';
    window.__api['1000000000000000015'] = ['https://www.youtube.com/watch?v=PREFETCH01'];
    window.__api['1000000000000000016'] = ['https://www.youtube.com/watch?v=PREFETCH02'];
    window.mkTweet({
      user: 'nao', id: '1000000000000000015',
      cards: ['<span>p</span><span>youtube.com</span>'],
    });
  });
  await rescan();
  await page.waitForTimeout(300);
  check('15: 先読みで href が入る',
    (await page.locator('.hiroYtOpen-btn').first().getAttribute('href')) ===
      'https://www.youtube.com/watch?v=PREFETCH01',
    { href: await page.locator('.hiroYtOpen-btn').first().getAttribute('href') });

  await page.evaluate(() => {
    // 仮想リストの差し替えを模す（childList 変化を伴う）
    const art = document.querySelector('article');
    const old = art.querySelector('a[href*="/status/"]');
    const fresh = document.createElement('a');
    fresh.href = 'https://x.com/nao/status/1000000000000000016';
    fresh.textContent = 'time';
    old.replaceWith(fresh);
  });
  await rescan();
  await page.waitForTimeout(400);
  check('15: DOM再利用後も先読みが再発火して新しいURLになる',
    (await page.locator('.hiroYtOpen-btn').first().getAttribute('href')) ===
      'https://www.youtube.com/watch?v=PREFETCH02',
    { href: await page.locator('.hiroYtOpen-btn').first().getAttribute('href') });

  // ===================================================================
  // 16. ドメイン表記の表記ゆれ
  // ===================================================================
  await page.evaluate(() => {
    document.getElementById('timeline').innerHTML = '';
    window.__labels = [
      ['youtube.com', true],
      ['www.youtube.com', true],
      ['youtu.be', true],
      ['YouTube.com', true],
      [' youtube.com ', true],
      ['From youtube.com', true],
      ['youtube.com から', true],
      ['\u{1F517}youtube.com', true],
      ['YouTubeで話題の動画', false],
      ['notyoutube.com', false],
      ['example.com', false],
      ['youtube', false],
    ];
    window.__labels.forEach((pair, i) => {
      const art = document.createElement('article');
      art.innerHTML = '<a href="https://x.com/u/status/' + (5000000000000000000 + i) + '">t</a>';
      const w = document.createElement('div');
      w.setAttribute('data-testid', 'card.wrapper');
      w.innerHTML = '<span>タイトル</span><span>' + pair[0] + '</span>';
      art.appendChild(w);
      document.getElementById('timeline').appendChild(art);
    });
  });
  await rescan();
  const labelResult = await page.evaluate(() =>
    window.__labels
      .map((pair, i) => {
        const has = !!document.querySelectorAll('article')[i].querySelector('.hiroYtOpen-btn');
        return has === pair[1] ? null : pair[0] + ' => ' + has;
      })
      .filter(Boolean));
  check('16: ドメイン表記の判定（12パターン）', labelResult.length === 0, labelResult);

  // ===================================================================
  // 17. 引用ツイート内のカードは引用側のツイートIDで解決する
  // ===================================================================
  await page.evaluate(() => {
    document.getElementById('timeline').innerHTML = '';
    window.__opened = [];
    window.__api['3000000000000000001'] = ['https://www.youtube.com/watch?v=OUTERTWEET'];
    window.__api['3000000000000000002'] = ['https://www.youtube.com/watch?v=QUOTEDTWET'];
    const art = document.createElement('article');
    art.innerHTML =
      '<a href="https://x.com/outer/status/3000000000000000001">time</a>' +
      '<div data-testid="tweetText">本文</div>' +
      '<div role="link">' +
        '<a href="https://x.com/inner/status/3000000000000000002">quoted</a>' +
        '<div data-testid="card.wrapper"><span>Q</span><span>youtube.com</span></div>' +
      '</div>';
    document.getElementById('timeline').appendChild(art);
  });
  await rescan();
  await page.locator('.hiroYtOpen-btn').first().click();
  await page.waitForTimeout(250);
  check('17: 引用ツイート内カードは引用側のURLで開く',
    await page.evaluate(() => window.__opened.some((u) => String(u).indexOf('QUOTEDTWET') >= 0)),
    await page.evaluate(() => window.__opened));

  // ===================================================================
  // 18. 本体カード＋引用カードで、それぞれ自分のツイートで解決する
  // ===================================================================
  await page.evaluate(() => {
    document.getElementById('timeline').innerHTML = '';
    window.__opened = [];
    window.__api['3000000000000000003'] = ['https://www.youtube.com/watch?v=MAINCARD11'];
    window.__api['3000000000000000004'] = ['https://www.youtube.com/watch?v=QUOTECARD1'];
    const art = document.createElement('article');
    art.innerHTML =
      '<a href="https://x.com/outer/status/3000000000000000003">time</a>' +
      '<div data-testid="card.wrapper"><span>M</span><span>youtube.com</span></div>' +
      '<div role="link">' +
        '<a href="https://x.com/inner/status/3000000000000000004">quoted</a>' +
        '<div data-testid="card.wrapper"><span>Q</span><span>youtube.com</span></div>' +
      '</div>';
    document.getElementById('timeline').appendChild(art);
  });
  await rescan();
  await page.locator('.hiroYtOpen-btn').nth(1).click();
  await page.waitForTimeout(250);
  check('18: 引用側カードは引用側のURLで開く（本体と混同しない）',
    await page.evaluate(() => window.__opened.some((u) => String(u).indexOf('QUOTECARD1') >= 0)),
    await page.evaluate(() => window.__opened));
  await page.evaluate(() => { window.__opened = []; });
  await page.locator('.hiroYtOpen-btn').first().click();
  await page.waitForTimeout(250);
  check('18: 本体カードは本体のURLで開く',
    await page.evaluate(() => window.__opened.some((u) => String(u).indexOf('MAINCARD11') >= 0)),
    await page.evaluate(() => window.__opened));

  // ===================================================================
  // 19. t.co 止まり（weak）のカードには href を付けない
  // ===================================================================
  await page.evaluate(() => {
    document.getElementById('timeline').innerHTML = '';
    const art = document.createElement('article');
    art.innerHTML =
      '<a href="https://x.com/u/status/4000000000000000001">time</a>' +
      '<div data-testid="card.wrapper"><a href="https://t.co/zzzz">c</a><span>youtube.com</span></div>';
    document.getElementById('timeline').appendChild(art);
  });
  await rescan();
  check('19: weak(t.co) のとき href を付けない',
    (await page.locator('.hiroYtOpen-btn').first().getAttribute('href')) === null,
    { href: await page.locator('.hiroYtOpen-btn').first().getAttribute('href') });

  // ===================================================================
  // 20. 展開でドメイン表記が消えても、カードを見失わない
  // ===================================================================
  //
  // 実機報告: カードをクリックして展開すると、ボタンがどこにも
  // 見えなくなる（デスクトップChrome / iOS Safari 双方）。
  //
  // 原因: scan() が毎回 isYouTubeCard() を再判定していたため、
  // 展開後にドメイン表記が消えてiframeも未挿入の一瞬に判定が
  // false へ反転し、そのカードを丸ごと無視していた
  // （React再描画で古いボタンは既に消えている）。
  await page.evaluate(() => {
    document.getElementById('timeline').innerHTML = '';
    window.mkTweet({
      user: 'oscar', id: '1000000000000000020',
      cards: ['<span>タイトル</span><span>youtube.com</span>'],
    });
  });
  await rescan();
  check('20: 展開前はボタンが出る',
    await page.locator('.hiroYtOpen-btn').count() === 1);

  // 展開の瞬間: ドメイン表記も直リンクも消える（iframeはまだ無い）
  await page.evaluate(() => {
    document.querySelector('[data-testid="card.wrapper"]').innerHTML =
      '<div class="loading">読み込み中</div>';
  });
  await rescan();
  check('20: 展開直後（iframe挿入前）もボタンが残る',
    await page.locator('.hiroYtOpen-btn').count() === 1,
    { count: await page.locator('.hiroYtOpen-btn').count() });

  // ===================================================================
  // 21. 展開後の iframe が youtube-nocookie.com でも解決できる
  // ===================================================================
  await page.evaluate(() => {
    const card = document.querySelector('[data-testid="card.wrapper"]');
    const f = document.createElement('iframe');
    f.src = 'https://www.youtube-nocookie.com/embed/NOCOOKIEID1?autoplay=1';
    card.appendChild(f);
  });
  await rescan();
  check('21: nocookie iframe からも href が解決される',
    (await page.locator('.hiroYtOpen-btn').first().getAttribute('href')) ===
      'https://www.youtube.com/watch?v=NOCOOKIEID1',
    { href: await page.locator('.hiroYtOpen-btn').first().getAttribute('href') });
  check('21: nocookie 展開後は inline 配置になる',
    await page.evaluate(() =>
      !document.querySelector('.hiroYtOpen-btn').classList.contains('hiroYtOpen-overlay')));

  // ===================================================================
  // 22. 画像付き・カード無し投稿：本文の直後にボタン、画像には触れない
  // ===================================================================
  //
  // v3.7.0は画像要素(tweetPhoto)自体にボタンをoverlay設置し、実機で
  // 画像が真っ白になりボタンも消える不具合を起こしてロールバックした
  // (v3.7.1)。今回は画像要素を一切操作せず、本文(tweetText)の直後に
  // 独立ブロックとしてボタンを挿入する設計にした。
  await page.evaluate(() => {
    document.getElementById('timeline').innerHTML = '';
    const art = document.createElement('article');
    art.innerHTML =
      '<a href="https://x.com/u/status/8000000000000000001">t</a>' +
      '<div data-testid="tweetText"><a href="https://t.co/abcd">youtube.com/watch?v=dQw4w9WgXcQ</a></div>' +
      '<div data-testid="tweetPhoto"><img src="pic.jpg"></div>';
    document.getElementById('timeline').appendChild(art);
  });
  const photoHtmlBefore = await page.evaluate(() =>
    document.querySelector('[data-testid="tweetPhoto"]').outerHTML);
  await rescan();
  check('22: 画像付き投稿にボタンが出る',
    await page.locator('.hiroYtOpen-btn').count() === 1);
  check('22: 表示テキストが完全なら即座に確定URL(t.co展開不要)',
    (await page.locator('.hiroYtOpen-btn').first().getAttribute('href')) ===
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    { href: await page.locator('.hiroYtOpen-btn').first().getAttribute('href') });
  const photoHtmlAfter = await page.evaluate(() =>
    document.querySelector('[data-testid="tweetPhoto"]').outerHTML);
  check('22: 画像要素のHTMLが完全に無傷（v3.7.0の再発防止）',
    photoHtmlBefore === photoHtmlAfter,
    { before: photoHtmlBefore, after: photoHtmlAfter });
  check('22: ボタンは本文の直後・画像の前に挿入される',
    await page.evaluate(() => {
      const text = document.querySelector('[data-testid="tweetText"]');
      const btn = document.querySelector('.hiroYtOpen-btn');
      const photo = document.querySelector('[data-testid="tweetPhoto"]');
      return text.nextElementSibling === btn && btn.nextElementSibling === photo;
    }));
  check('22: overlayクラスは付かない（画像に重ねない）',
    await page.evaluate(() =>
      !document.querySelector('.hiroYtOpen-btn').classList.contains('hiroYtOpen-overlay')));
  check('22: 画像要素に hiroYtOpen-host クラスが付かない',
    await page.evaluate(() =>
      !document.querySelector('[data-testid="tweetPhoto"]').classList.contains('hiroYtOpen-host')));

  // ===================================================================
  // 23. 表示テキストが省略されている場合は weak、クリックでAPI確定
  // ===================================================================
  await page.evaluate(() => {
    document.getElementById('timeline').innerHTML = '';
    window.__opened = [];
    window.__api['8000000000000000002'] = ['https://www.youtube.com/watch?v=RESOLVEDAPI'];
    const art = document.createElement('article');
    art.innerHTML =
      '<a href="https://x.com/u/status/8000000000000000002">t</a>' +
      '<div data-testid="tweetText"><a href="https://t.co/efgh">youtube.com/watch?v=dQw4w9…</a></div>' +
      '<div data-testid="tweetPhoto"><img src="pic.jpg"></div>';
    document.getElementById('timeline').appendChild(art);
  });
  await rescan();
  check('23: 省略された表示テキストでもボタンは出る(weak)',
    await page.locator('.hiroYtOpen-btn').count() === 1);
  await page.locator('.hiroYtOpen-btn').first().click();
  await page.waitForTimeout(250);
  check('23: クリックでAPIの確定URLへ開く',
    await page.evaluate(() => window.__opened.some((u) => String(u).indexOf('RESOLVEDAPI') >= 0)),
    await page.evaluate(() => window.__opened));

  // ===================================================================
  // 24. YouTube以外のリンクの画像投稿にはボタンを出さない
  // ===================================================================
  await page.evaluate(() => {
    document.getElementById('timeline').innerHTML = '';
    const art = document.createElement('article');
    art.innerHTML =
      '<a href="https://x.com/u/status/8000000000000000003">t</a>' +
      '<div data-testid="tweetText"><a href="https://t.co/xxxx">example.com/article</a></div>' +
      '<div data-testid="tweetPhoto"><img src="pic.jpg"></div>';
    document.getElementById('timeline').appendChild(art);
  });
  await rescan();
  check('24: 無関係なリンクの画像投稿にはボタンを出さない',
    await page.locator('.hiroYtOpen-btn').count() === 0,
    { count: await page.locator('.hiroYtOpen-btn').count() });

  // ===================================================================
  // 25. 画像が無い投稿は対象外（カード化されるはずなので二重対応しない）
  // ===================================================================
  await page.evaluate(() => {
    document.getElementById('timeline').innerHTML = '';
    const art = document.createElement('article');
    art.innerHTML =
      '<a href="https://x.com/u/status/8000000000000000004">t</a>' +
      '<div data-testid="tweetText"><a href="https://t.co/yyyy">youtube.com/watch?v=dQw4w9WgXcQ</a></div>';
    document.getElementById('timeline').appendChild(art);
  });
  await rescan();
  check('25: 画像が無ければ対象外',
    await page.locator('.hiroYtOpen-btn').count() === 0,
    { count: await page.locator('.hiroYtOpen-btn').count() });

  // ===================================================================
  // 26. YouTubeカードが既にある投稿では本文側にボタンを重複させない
  // ===================================================================
  await page.evaluate(() => {
    document.getElementById('timeline').innerHTML = '';
    const art = document.createElement('article');
    art.innerHTML =
      '<a href="https://x.com/u/status/8000000000000000005">t</a>' +
      '<div data-testid="tweetText">本文</div>' +
      '<div data-testid="card.wrapper"><a href="https://www.youtube.com/watch?v=CARDVIDEO11">l</a><span>youtube.com</span></div>' +
      '<div data-testid="tweetPhoto"><img src="pic.jpg"></div>';
    document.getElementById('timeline').appendChild(art);
  });
  await rescan();
  check('26: カードがあれば本文側には出さない（合計1個）',
    await page.locator('.hiroYtOpen-btn').count() === 1,
    { count: await page.locator('.hiroYtOpen-btn').count() });

  // ===================================================================
  // 27. 複数回scanしてもボタンが重複しない（安定性）
  // ===================================================================
  await page.evaluate(() => {
    document.getElementById('timeline').innerHTML = '';
    const art = document.createElement('article');
    art.innerHTML =
      '<a href="https://x.com/u/status/8000000000000000006">t</a>' +
      '<div data-testid="tweetText"><a href="https://t.co/zzzz">youtube.com/watch?v=STABLEVID1</a></div>' +
      '<div data-testid="tweetPhoto"><img src="pic.jpg"></div>';
    document.getElementById('timeline').appendChild(art);
  });
  await rescan();
  await rescan();
  await rescan();
  check('27: 複数回scanしてもボタンは1個のまま',
    await page.locator('.hiroYtOpen-btn').count() === 1,
    { count: await page.locator('.hiroYtOpen-btn').count() });

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
  process.exit(failed.length ? 1 : 0);
})();
