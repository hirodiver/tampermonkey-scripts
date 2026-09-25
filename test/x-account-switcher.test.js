const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// x-account-switcher.user.js の検証用ハーネス。
//
// X の切替UIを模したDOMをヘッドレスChromiumに組み、スクリプトを流し込んで確認する。
//
//   NODE_PATH=$(npm root -g) node test/x-account-switcher.test.js
//
// 模擬したのは次の2つ。どちらも X の実DOMそのものではない（特にモバイルの
// ドロワーとアカウント一覧シートは未確認）ので、これに通ることは実機で動くことを
// 保証しない。
//
//   デスクトップ幅: 左下のアカウントボタン → #layers にメニュー
//   モバイル幅:     左上のアイコン → #layers にドロワー → 「アカウント」→ 一覧シート
//                  （#layers に上下のバーが常にある。実機診断 v1.0.0 で確認）
//
// Trusted Types を強制する CSP を付けて配信し、innerHTML を使うと落ちる状態で流す。

const SOURCE = fs.readFileSync(
  process.env.SCRIPT_PATH ||
    path.join(__dirname, '..', 'x-account-switcher.user.js'),
  'utf8'
);

// 待ち時間をテスト用に縮める
const SCRIPT = SOURCE
  .replace(/const MENU_WAIT_MS = \d+;/, 'const MENU_WAIT_MS = 800;')
  .replace(/const RELOAD_TIMEOUT_MS = \d+;/, 'const RELOAD_TIMEOUT_MS = 600;')
  .replace(/const CONFIRM_WAIT_MS = \d+;/, 'const CONFIRM_WAIT_MS = 300;');

const HTML = `<!doctype html><meta charset="utf-8"><title>x-mock</title>
<style>
  body { margin: 0; }
  img { width: 32px; height: 32px; display: block; }
  [role="button"], [role="menuitem"], a { display: block; min-height: 20px; }
  #layers > * { position: fixed; top: 0; left: 0; width: 300px; background: #fff; }
</style>
<body><div id="react-root"></div><div id="layers"></div></body>`;

const PIXEL = Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64');

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra !== undefined && !cond ? '  -> ' + JSON.stringify(extra) : ''));
}

// --- ページ側のフィクスチャ（innerHTML は使えないので要素を組み立てる） ---
function fixtures() {
  window.h = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'onclick') el.addEventListener('click', v);
      else if (k === 'style') el.setAttribute('style', v);
      else el.setAttribute(k, v);
    }
    for (const c of children) el.append(c);
    return el;
  };

  window.avatar = (handle) =>
    h('div', { 'data-testid': 'UserAvatar-Container-' + handle },
      h('img', { src: 'https://pbs.twimg.com/profile_images/1/' + handle + '_normal.jpg', alt: '' }));

  window.userCell = (handle, name, onclick, id) =>
    h('div', { role: 'button', 'data-testid': 'UserCell', id: id || 'cell-' + handle, onclick },
      avatar(handle), h('span', {}, name), h('span', {}, '@' + handle));

  window.events = [];
  window.layers = document.getElementById('layers');

  window.closeAll = () => layers.replaceChildren();
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { events.push('escape'); closeAll(); }
  });

  // 切替を受け付けたら記録し、プロフィールリンク等を切替先に書き換える（再読み込みなしの切替を模す）
  window.switchedTo = (handle) => {
    events.push('switch:' + handle);
    closeAll();
    if (window.withConfirm) {
      layers.append(h('div', { role: 'dialog' },
        h('div', { role: 'button', 'data-testid': 'confirmationSheetConfirm', onclick: () => {
          events.push('confirm');
          closeAll();
          window.applyCurrent(handle);
        } }, 'はい')));
      return;
    }
    window.applyCurrent(handle);
  };
}

async function newPage(browser, viewport) {
  const page = await browser.newPage({ viewport });
  await page.route('https://x.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      headers: { 'content-security-policy': "require-trusted-types-for 'script'" },
      body: HTML
    })
  );
  await page.route('https://pbs.twimg.com/**', (route) =>
    route.fulfill({ contentType: 'image/gif', body: PIXEL })
  );
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  return page;
}

const dockButtons = (page) =>
  page.evaluate(() => {
    const root = document.getElementById('tm-x-switch-root');
    if (!root) return null;
    return [...root.shadowRoot.querySelectorAll('.av')].map((b) => ({
      handle: b.dataset.handle,
      current: b.classList.contains('current'),
      disabled: b.disabled
    }));
  });

const clickDock = (page, handle) =>
  page.evaluate((handle) => {
    document.getElementById('tm-x-switch-root').shadowRoot
      .querySelector(`.av[data-handle="${handle}"]`).click();
  }, handle);

const stored = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('tm-x-switch-accounts') || '[]').map((a) => a.screenName));

const toastText = (page) =>
  page.evaluate(() => document.getElementById('tm-x-switch-root')?.shadowRoot.querySelector('.toast')?.textContent || '');

(async () => {
  const browser = await chromium.launch();

  // ==========================================================
  // デスクトップ幅
  // ==========================================================
  {
    const page = await newPage(browser, { width: 1280, height: 800 });
    await page.goto('https://x.com/home');

    check('前提: Trusted Types が強制されている（innerHTML に文字列を入れると例外）',
      await page.evaluate(() => { try { document.body.innerHTML = '<b>x</b>'; return false; } catch { return true; } }));

    await page.evaluate(fixtures);
    await page.evaluate(() => {
      const root = document.getElementById('react-root');

      window.applyCurrent = (handle) => {
        document.getElementById('profileLink').setAttribute('href', '/' + handle);
        const sw = document.getElementById('switcher');
        sw.replaceChildren(avatar(handle), h('span', {}, '@' + handle));
      };

      window.openAccountMenu = () => {
        events.push('open-menu');
        closeAll();
        const cur = document.getElementById('profileLink').getAttribute('href').slice(1);
        const menu = h('div', { role: 'menu', id: 'accountMenu' },
          ...['alice', 'bob', 'carol'].map((hd) =>
            userCell(hd, hd[0].toUpperCase() + hd.slice(1), () => { if (hd !== cur) switchedTo(hd); })),
          h('a', { href: '/i/flow/login', role: 'menuitem' }, '既存のアカウントを追加'),
          h('a', { href: '/logout', role: 'menuitem' }, '@' + cur + ' からログアウト'));
        layers.append(menu);
      };

      root.append(
        h('header', { role: 'banner' },
          h('a', { 'data-testid': 'AppTabBar_Profile_Link', href: '/alice', id: 'profileLink' }, 'プロフィール'),
          h('div', {
            role: 'button', 'data-testid': 'SideNav_AccountSwitcher_Button', 'aria-label': 'アカウントメニュー',
            id: 'switcher', style: 'position:fixed;left:10px;bottom:10px;width:220px;height:50px',
            onclick: () => window.openAccountMenu()
          }, avatar('alice'), h('span', {}, '@alice'))),
        h('main', {},
          h('section', { role: 'region', id: 'timeline' },
            // 投稿（dave）とおすすめユーザー（eve）。どちらも自分のアカウントではない
            h('div', { 'data-testid': 'cellInnerDiv' },
              h('article', { 'data-testid': 'tweet' },
                h('a', { href: '/dave', id: 'daveAvatarLink', onclick: (e) => { e.preventDefault(); events.push('nav:/dave'); } }, avatar('dave')),
                h('span', {}, 'Dave @dave ふつうの投稿'))),
            userCell('eve', 'Eve', () => events.push('nav:/eve'), 'timelineEve'),
            userCell('bob', 'Bob（タイムライン上の同名表示）', () => events.push('nav:/bob-in-timeline'), 'timelineBob'))));
    });

    await page.evaluate(SCRIPT);
    await page.waitForTimeout(400);

    check('起動: ドックが出る（Shadow DOM）', await page.evaluate(() => !!document.getElementById('tm-x-switch-root')?.shadowRoot));
    check('起動: 一覧が空なら「読込」ボタンを出す', await page.evaluate(() =>
      !!document.getElementById('tm-x-switch-root').shadowRoot.querySelector('.load')));
    check('起動: 勝手に切替メニューを開かない', !(await page.evaluate(() => events.includes('open-menu'))));
    check('誤登録: タイムラインのユーザー（UserCell・投稿）を覚えない', (await stored(page)).length === 0, await stored(page));

    // ポストの「…」メニュー（@xxx をフォロー 等）が重なり層に出ても覚えない
    await page.evaluate(() => {
      layers.append(h('div', { role: 'menu', id: 'tweetMenu' },
        h('div', { role: 'menuitem' }, '@daveさんをフォロー'),
        h('div', { role: 'menuitem' }, '@daveさんをミュート')));
    });
    await page.waitForTimeout(400);
    check('誤登録: ポストの「…」メニューの @ハンドルを覚えない', (await stored(page)).length === 0, await stored(page));
    await page.evaluate(() => closeAll());

    // 古い（ログアウト済み）アカウントを入れておく。一覧すべてが見えたら消えるはず
    await page.evaluate(() => localStorage.setItem('tm-x-switch-accounts', JSON.stringify([{ screenName: 'zed', name: 'Zed', avatar: '' }])));

    // 利用者が自分で切替メニューを開くと覚える
    await page.evaluate(() => window.openAccountMenu());
    await page.waitForTimeout(400);
    const learned = await stored(page);
    check('収集: 切替メニューを開くと alice / bob / carol を覚える',
      JSON.stringify([...learned].sort()) === JSON.stringify(['alice', 'bob', 'carol']), learned);
    check('収集: 「既存のアカウントを追加」がある一覧なら、載っていない古いアカウントを消す', !learned.includes('zed'), learned);
    check('収集: 「@alice からログアウト」を別アカウントとして覚えない', learned.filter((x) => x === 'alice').length === 1, learned);
    check('収集: アバターは大きい版（_bigger）で覚える', await page.evaluate(() =>
      JSON.parse(localStorage.getItem('tm-x-switch-accounts')).every((a) => /_bigger\.jpg$/.test(a.avatar))));
    await page.evaluate(() => closeAll());
    await page.waitForTimeout(400);

    let buttons = await dockButtons(page);
    check('描画: ドックに3件並ぶ', buttons && buttons.length === 3, buttons);
    check('描画: 現在のアカウント（alice）に印が付く', buttons && buttons.find((b) => b.handle === 'alice')?.current && !buttons.find((b) => b.handle === 'bob')?.current, buttons);

    // 自分自身を押しても何もしない
    await page.evaluate(() => { events.length = 0; });
    await clickDock(page, 'alice');
    await page.waitForTimeout(200);
    check('切替: 現在のアカウントを押しても何もしない', !(await page.evaluate(() => events.includes('open-menu'))));

    // bob へ切替
    await page.evaluate(() => { events.length = 0; });
    await clickDock(page, 'bob');
    await page.waitForTimeout(100);
    check('切替: 切替中はボタンが押せない', (await dockButtons(page)).every((b) => b.disabled));
    await page.waitForTimeout(500);
    let ev = await page.evaluate(() => events.slice());
    check('切替: 切替メニューを開き、メニューの bob を押す', ev.includes('open-menu') && ev.includes('switch:bob'), ev);
    check('切替: タイムライン上の bob は押さない', !ev.includes('nav:/bob-in-timeline'), ev);
    check('切替: 元のページを覚える', await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem('tm-x-switch-return') || 'null')?.path === '/home'));

    // 再読み込みが起きない場合は、切り替わったのを確かめてボタンを戻す
    await page.waitForTimeout(900);
    buttons = await dockButtons(page);
    check('切替後: 再読み込みが無くても、ボタンが押せる状態に戻る', buttons.every((b) => !b.disabled), buttons);
    check('切替後: 印が bob に移る', buttons.find((b) => b.handle === 'bob')?.current, buttons);
    check('切替後: 「切り替えました」と出る', (await toastText(page)).includes('切り替えました'), await toastText(page));

    // 確認シートが出る場合
    await page.evaluate(() => { events.length = 0; window.withConfirm = true; });
    await clickDock(page, 'carol');
    await page.waitForTimeout(700);
    ev = await page.evaluate(() => events.slice());
    check('確認シート: 出たら「はい」を押す', ev.includes('switch:carol') && ev.includes('confirm'), ev);
    await page.waitForTimeout(900);
    check('確認シート: 印が carol に移る', (await dockButtons(page)).find((b) => b.handle === 'carol')?.current);
    await page.evaluate(() => { window.withConfirm = false; });

    // メニューに無いアカウント（登録が古い）を押した場合
    await page.evaluate(() => {
      const list = JSON.parse(localStorage.getItem('tm-x-switch-accounts'));
      list.push({ screenName: 'ghost', name: 'Ghost', avatar: '' });
      localStorage.setItem('tm-x-switch-accounts', JSON.stringify(list));
      document.body.append(document.createElement('i'));   // 監視を起こす
    });
    await page.waitForTimeout(400);
    await page.evaluate(() => { events.length = 0; });
    await clickDock(page, 'ghost');
    await page.waitForTimeout(1500);
    buttons = await dockButtons(page);
    check('失敗: 見つからなければ知らせる', (await toastText(page)).includes('切り替えられませんでした'), await toastText(page));
    check('失敗: ボタンが押せる状態に戻る', buttons.every((b) => !b.disabled), buttons);
    check('失敗: 開いたメニューを閉じる', await page.evaluate(() => !document.getElementById('accountMenu')));
    check('失敗: 元のページの記録を消す', await page.evaluate(() => sessionStorage.getItem('tm-x-switch-return') === null));
    check('失敗: 誤って何かを押していない', !(await page.evaluate(() => events.some((e) => e.startsWith('switch:') || e.startsWith('nav:')))),
      await page.evaluate(() => events.slice()));

    // 診断
    await page.evaluate(() => window.openAccountMenu());
    await page.waitForTimeout(400);
    const report = await page.evaluate(() => window.__tmXSwitch.dump());
    check('診断: dump() が現在のアカウントを出す', /現在のアカウント: @carol/.test(report), report.slice(0, 300));
    check('診断: 切替メニューの入れ物と候補を出す', /切替メニューと判定した入れ物: 1件/.test(report) && /@bob（アバターのtestid）/.test(report));
    check('診断: 直近の切替の記録を出す', /切替先を押す/.test(report) && /失敗: 切替メニューに @ghost が見つからない/.test(report));
    check('診断: 開いていたメニューの構造を記録する', /最後に開いていたメニュー・ドロワーの構造（/.test(report) && /\[アバター /.test(report));
    await page.evaluate(() => closeAll());

    await page.evaluate(() => { location.hash = '#tmswitch'; });
    await page.waitForTimeout(300);
    check('診断: #tmswitch でパネルが出る', await page.evaluate(() =>
      (document.querySelector('#tm-x-switch-panel textarea')?.value || '').startsWith('=== X アカウント切替 診断 ===')));
    check('診断: 閉じた後も、最後に開いていた切替メニューの構造が残る', await page.evaluate(() =>
      /既存のアカウントを追加/.test(document.querySelector('#tm-x-switch-panel textarea')?.value || '')));
    await page.evaluate(() => { location.hash = ''; });
    await page.waitForTimeout(200);
    check('診断: ハッシュを外すとパネルが消える', await page.evaluate(() => !document.getElementById('tm-x-switch-panel')));

    // 位置の変更
    const menuClick = (label) => page.evaluate((label) => {
      const sr = document.getElementById('tm-x-switch-root').shadowRoot;
      sr.querySelector('.icon').click();
      [...sr.querySelectorAll('.menu button')].find((b) => b.textContent.startsWith(label)).click();
    }, label);

    await menuClick('右上');
    check('操作: 位置を右上に変えられる', await page.evaluate(() =>
      document.getElementById('tm-x-switch-root').shadowRoot.querySelector('.dock').classList.contains('right-top')));
    check('操作: 位置を覚える', await page.evaluate(() => localStorage.getItem('tm-x-switch-position') === '"right-top"'));

    // しまう → 画面端のつまみ → 戻す
    const tuckState = () => page.evaluate(() => {
      const sr = document.getElementById('tm-x-switch-root').shadowRoot;
      const dock = sr.querySelector('.dock');
      const tab = sr.querySelector('.tab');
      const r = tab.getBoundingClientRect();
      return {
        dockShown: getComputedStyle(dock).display !== 'none',
        tabShown: getComputedStyle(tab).display !== 'none',
        tabRight: Math.round(window.innerWidth - r.right),
        tabTop: Math.round(r.top),
        tabText: tab.textContent
      };
    });

    check('操作: メニューに「最小化」「このタブでは隠す」は無い', await page.evaluate(() => {
      const sr = document.getElementById('tm-x-switch-root').shadowRoot;
      sr.querySelector('.icon').click();
      const labels = [...sr.querySelectorAll('.menu button')].map((b) => b.textContent);
      sr.querySelector('.icon').click();
      return !labels.some((l) => /最小化|展開|隠す/.test(l)) && labels.includes('しまう');
    }));

    let tuck = await tuckState();
    check('しまう: しまう前はドックが見え、つまみは無い', tuck.dockShown && !tuck.tabShown, tuck);

    await menuClick('しまう');
    tuck = await tuckState();
    check('しまう: ドックが消え、つまみだけ残る', !tuck.dockShown && tuck.tabShown, tuck);
    check('しまう: つまみは画面の端（右上に置いていれば右端・上寄り）に付く', tuck.tabRight === 0 && tuck.tabTop < 200 && tuck.tabText === '‹', tuck);
    check('しまう: 戻し方をトーストで知らせる', (await toastText(page)).includes('つまみ'), await toastText(page));
    check('しまう: 端末に覚える（再読み込み・別タブでも続く）', await page.evaluate(() => localStorage.getItem('tm-x-switch-tucked') === 'true'));

    await page.evaluate(() => document.body.append(document.createElement('i')));
    await page.waitForTimeout(400);
    tuck = await tuckState();
    check('しまう: DOM 変化があってもしまったまま', !tuck.dockShown && tuck.tabShown, tuck);

    await page.evaluate(() => document.getElementById('tm-x-switch-root').shadowRoot.querySelector('.tab').click());
    tuck = await tuckState();
    check('しまう: つまみを押すとドックが戻る', tuck.dockShown && !tuck.tabShown, tuck);
    check('しまう: 戻した状態も覚える', await page.evaluate(() => localStorage.getItem('tm-x-switch-tucked') === 'false'));
    check('しまう: 戻したらアカウントのボタンが押せる', (await dockButtons(page)).length === 3 && (await dockButtons(page)).every((b) => !b.disabled), await dockButtons(page));

    // サイト側に消されても作り直す
    await page.evaluate(() => {
      document.getElementById('tm-x-switch-root').remove();
      document.body.append(document.createElement('i'));
    });
    await page.waitForTimeout(400);
    // ghost は診断のためにメニューを開いた時点で「一覧すべて」から外れて消えている
    check('再描画: ドックが消されたら作り直す', (await dockButtons(page))?.length === 3, await dockButtons(page));

    // v1.0 の「このタブでは隠す」の値が残っていても無視する（戻せなくなる不具合の元）
    await page.evaluate(() => {
      sessionStorage.setItem('tm-x-switch-hidden', '1');
      document.body.append(document.createElement('i'));
    });
    await page.waitForTimeout(400);
    check('互換: v1.0 の「このタブでは隠す」の値が残っていても出る', await page.evaluate(() => !!document.getElementById('tm-x-switch-root')));

    // 左下に置いてしまうと、左端につまみが付く
    await menuClick('左下');
    await menuClick('しまう');
    tuck = await tuckState();
    check('しまう: 左下に置いていれば左端・下寄りに付く', !tuck.dockShown && tuck.tabText === '›' && tuck.tabTop > 400, tuck);
    check('しまう: 左端にぴったり付く', await page.evaluate(() =>
      Math.round(document.getElementById('tm-x-switch-root').shadowRoot.querySelector('.tab').getBoundingClientRect().left) === 0));
    await page.evaluate(() => document.getElementById('tm-x-switch-root').shadowRoot.querySelector('.tab').click());

    await page.evaluate(SCRIPT);
    await page.waitForTimeout(400);
    check('二重起動: もう一度流しても2つ目を作らない', await page.evaluate(() =>
      document.querySelectorAll('#tm-x-switch-root').length === 1));

    await page.close();
  }

  // ==========================================================
  // モバイル幅（iPhone 相当）
  // ==========================================================
  //
  // 実機診断（v1.0.0、iPhone）で分かった構造を再現する:
  //   - #layers の中に、上のバー（TopNavBar）・下のタブ（BottomBar）・投稿ボタン・
  //     タブの grid・新着ピルが常にある
  //   - 左上のアイコンは button[data-testid=DashButton_ProfileIcon_Link]、
  //     aria-label は「プロフィールメニュー 表示名」、アバターの testid は
  //     UserAvatar-Container-unknown（ハンドルを持たない）
  // ドロワーとアカウント一覧シートの中身は未確認なので推測で組んでいる。
  const mobileSetup = (opts) => {
    const root = document.getElementById('react-root');
    const names = { alice: 'Alice', bob: 'Bob', carol: 'Carol' };

    // メニュー類だけを閉じる（常に居るバーは残す）
    window.closeAll = () => layers.querySelectorAll('.overlay').forEach((el) => el.remove());

    window.selfAvatar = (handle) =>
      h('div', { 'data-testid': 'UserAvatar-Container-unknown' },
        h('div', { role: 'presentation' },
          h('img', { src: 'https://pbs.twimg.com/profile_images/1/' + handle + '_normal.jpg', alt: '' })));

    window.current = 'alice';

    // 上のバー: ホームでは左上に自分のアイコン、それ以外（個別ポスト等）では「戻る」
    window.renderTopBar = () => {
      const bar = document.getElementById('topNavBar');
      if (!bar) return;
      const onHome = location.pathname === '/home' || !opts.startOnStatus;
      const openerAttrs = {
        id: 'dashButton', role: 'button', 'aria-label': 'プロフィールメニュー ' + names[window.current],
        style: 'position:fixed;top:8px;left:8px;width:32px;height:32px',
        onclick: () => window.openDrawer()
      };
      if (opts.testid) openerAttrs['data-testid'] = 'DashButton_ProfileIcon_Link';
      bar.replaceChildren(
        onHome ?
          h('button', openerAttrs, selfAvatar(window.current)) :
          h('button', { role: 'button', 'aria-label': '戻る', id: 'backButton', style: 'position:fixed;top:8px;left:8px;width:32px;height:32px' }, '←'),
        h('a', { role: 'link', href: '/i/premium_sign_up' }, '購入する'),
        h('button', { role: 'button', 'aria-label': 'タイムラインを管理' }));
    };
    window.addEventListener('popstate', () => window.renderTopBar());

    window.applyCurrent = (handle) => {
      window.current = handle;
      window.renderTopBar();
      if (location.pathname === '/account/switch') {
        history.replaceState(null, '', '/home');
        document.getElementById('sheet')?.remove();
      }
    };

    // ドロワー: 自分（プロフィールへのリンク）、他のアカウント1件（アバターだけ）、「アカウント」ボタン
    window.openDrawer = () => {
      events.push('open-drawer');
      closeAll();
      const others = ['alice', 'bob', 'carol'].filter((x) => x !== window.current).slice(0, opts.noOthers ? 0 : opts.noMoreButton ? 2 : 1);
      layers.append(h('div', { role: 'dialog', 'aria-modal': 'true', id: 'drawer', class: 'overlay' },
        h('div', { 'data-testid': 'mask', onclick: () => { events.push('mask'); closeAll(); } }),
        h('a', { href: '/' + window.current, id: 'drawerMe', onclick: (e) => { e.preventDefault(); events.push('nav:/' + window.current); } },
          avatar(window.current), h('span', {}, names[window.current]), h('span', {}, '@' + window.current)),
        ...others.map((o) => h('div', { role: 'button', id: 'drawer-' + o, onclick: () => switchedTo(o) }, avatar(o))),
        opts.noMoreButton ? '' :
          opts.unlabeledMore ?
            h('div', { role: 'button', id: 'drawerMore', onclick: () => window.openSheet() }, '⋯') :
          opts.routeSheet ?
            h('a', { href: '/account/switch', 'aria-label': 'アカウント', id: 'drawerMore', onclick: (e) => { e.preventDefault(); window.openSheet(); } }, '⋯') :
            h('div', { role: 'button', 'aria-label': 'アカウント', id: 'drawerMore', onclick: () => window.openSheet() }, '⋯'),
        h('nav', {},
          h('a', { href: '/' + window.current }, 'プロフィール'),
          h('a', { href: '/i/bookmarks' }, 'ブックマーク'))));
    };

    // routeSheet: 一覧が #layers ではなく独立したページ（/account/switch）の本文に出る場合
    window.addEventListener('popstate', () => {
      events.push('back');
      document.getElementById('sheet')?.remove();
    });
    window.openSheet = () => {
      events.push('open-sheet');
      closeAll();
      if (opts.routeSheet) history.pushState(null, '', '/account/switch');
      const parent = opts.routeSheet ? document.querySelector('main') : layers;
      parent.append(h('div', opts.routeSheet ? { id: 'sheet' } : { role: 'dialog', 'aria-modal': 'true', id: 'sheet', class: 'overlay' },
        ...['alice', 'bob', 'carol'].map((hd) =>
          userCell(hd, names[hd], () => { if (hd !== window.current) switchedTo(hd); }, 'sheet-' + hd)),
        h('a', { href: '/i/flow/signup' }, '新しいアカウントを作成'),
        h('a', { href: '/i/flow/login' }, '既存のアカウントを追加')));
    };

    // 常に居るもの（実機診断の並び）
    layers.append(
      h('aside', { role: 'complementary', 'aria-label': 'ポストを作成' },
        h('div', { 'data-testid': 'FloatingActionButtonBase' },
          h('a', { role: 'link', 'data-testid': 'FloatingActionButtons_Tweet_Button', 'aria-label': 'ポストを作成', href: '/compose/post' }))),
      h('div', { 'data-testid': 'BottomBar' },
        h('nav', { role: 'navigation', 'aria-label': 'メインメニュー' },
          h('a', { role: 'link', 'data-testid': 'AppTabBar_Home_Link', 'aria-label': 'ホーム', href: '/home', onclick: (e) => {
            e.preventDefault();
            events.push('go-home');
            if (location.pathname !== '/home') history.pushState(null, '', '/home');
            window.renderTopBar();
          } }),
          h('a', { role: 'link', 'data-testid': 'AppTabBar_Notifications_Link', 'aria-label': '通知', href: '/notifications' }))),
      h('div', { 'data-testid': 'TopNavBar', id: 'topNavBar' }),
      h('div', { role: 'grid' },
        h('nav', { role: 'navigation' }, h('div', { role: 'tablist', 'data-testid': 'ScrollSnap-List' }))),
      h('div', { role: 'status' },
        h('button', { role: 'button', 'aria-label': '新しいポストがあります' }, h('div', { 'data-testid': 'pillLabel' }, '新しいポスト'))));

    root.append(
      h('main', { style: 'padding-top:120px' },
        h('div', { 'data-testid': 'cellInnerDiv' },
          h('article', { 'data-testid': 'tweet' },
            h('a', { href: '/dave', onclick: (e) => { e.preventDefault(); events.push('nav:/dave'); } }, avatar('dave')),
            h('span', {}, 'Dave @dave')))));

    window.renderTopBar();
  };

  const loadViaDock = (page) => page.evaluate(() => {
    const sr = document.getElementById('tm-x-switch-root').shadowRoot;
    const load = sr.querySelector('.load');
    if (load) { load.click(); return; }
    sr.querySelector('.icon').click();
    [...sr.querySelectorAll('.menu button')].find((b) => b.textContent === 'アカウントを読み込む').click();
  });

  for (const variant of [
    { testid: true, label: 'testid あり' },
    { testid: false, label: 'testid なし（構造で探す）' },
    { testid: true, routeSheet: true, label: '一覧が /account/switch のページ' }
  ]) {
    const page = await newPage(browser, { width: 402, height: 668 });
    await page.goto('https://x.com/home');
    await page.evaluate(fixtures);
    await page.evaluate(mobileSetup, variant);
    await page.evaluate(SCRIPT);
    await page.waitForTimeout(400);

    const tag = '[モバイル ' + variant.label + '] ';

    let report = await page.evaluate(() => window.__tmXSwitch.dump());
    check(tag + 'アバターの testid の unknown をハンドルと見なさない', !/@unknown/.test(report), report.slice(0, 400));
    check(tag + '一覧が空のうちは、現在のアカウントを「取得できない」とする', /現在のアカウント: 取得できない/.test(report), report.slice(0, 300));
    check(tag + '左上のアイコン（#layers の中）を見つける', /ドロワー: <button[^\n]*プロフィールメニュー Alice/.test(report), report.slice(0, 600));
    check(tag + '上下のバーを「メニュー・ドロワー」と見なさない', /いま開いているメニュー・ドロワー: 0件/.test(report), report.slice(0, 600));
    check(tag + '上下のバーは切替先の候補に入れない', /切替に使える候補\n  （なし）/.test(report), report.slice(0, 900));

    // ドロワーを手で開くと、そこに出ている自分のアカウントを覚える
    await page.evaluate(() => window.openDrawer());
    await page.waitForTimeout(400);
    const expectedAfterDrawer = variant.routeSheet ? ['alice', 'bob'] : ['alice'];
    check(tag + 'ドロワーを開くと、出ている自分のアカウントを覚える' + (variant.routeSheet ? '（切替ページへのリンクがあれば他も足す）' : ''),
      JSON.stringify((await stored(page)).sort()) === JSON.stringify(expectedAfterDrawer), await stored(page));
    await page.evaluate(() => { closeAll(); events.length = 0; });
    await page.waitForTimeout(400);
    report = await page.evaluate(() => window.__tmXSwitch.dump());
    check(tag + '閉じた後は、左上のアイコンの画像で現在のアカウントを特定する', /現在のアカウント: @alice（左上のアイコンの画像）/.test(report), report.slice(0, 300));
    check(tag + '閉じた後も、ドロワーの構造が診断に残る', /最後に開いていたメニュー・ドロワーの構造/.test(report) && /drawerMe|href="\/alice"/.test(report), report.slice(-1500));
    check(tag + '構造の記録に上下のバーを含めない', !/BottomBar|TopNavBar/.test(report.slice(report.indexOf('■ 最後に開いていた'))));

    // 「読込」→ ドロワー → 「アカウント」→ シートで覚えて閉じる
    await loadViaDock(page);
    await page.waitForTimeout(900);
    let ev = await page.evaluate(() => events.slice());
    const learned = await stored(page);
    check(tag + '読込: ドロワー → アカウント一覧の順に開く', ev.includes('open-drawer') && ev.includes('open-sheet'), ev);
    check(tag + '読込: 一覧シートから3件覚える', JSON.stringify([...learned].sort()) === JSON.stringify(['alice', 'bob', 'carol']), learned);
    check(tag + '読込: 終わったら閉じる（常に居るバーは残る）', await page.evaluate(() =>
      !document.getElementById('sheet') && !document.getElementById('drawer') && !!document.getElementById('dashButton')));
    check(tag + '読込: 元のページ（/home）に居る', page.url() === 'https://x.com/home', page.url());
    check(tag + '読込: 誤って何かを押していない', !ev.some((e) => e.startsWith('switch:') || e.startsWith('nav:')), ev);
    await page.waitForTimeout(400);
    check(tag + '読込後: 現在のアカウント（alice）に印が付く', (await dockButtons(page)).find((b) => b.handle === 'alice')?.current, await dockButtons(page));

    // ドロワーに出ている bob へ切替（アバターだけのボタン）
    await page.evaluate(() => { events.length = 0; });
    await clickDock(page, 'bob');
    await page.waitForTimeout(600);
    ev = await page.evaluate(() => events.slice());
    check(tag + '切替: ドロワーに出ているアカウントはそのまま押す', ev.includes('switch:bob') && !ev.includes('open-sheet'), ev);
    check(tag + '切替: ドロワーの自分のアイコン（プロフィールへのリンク）や投稿を押さない', !ev.some((e) => e.startsWith('nav:')), ev);
    await page.waitForTimeout(900);
    check(tag + '切替後: 印が bob に移る（左上のアイコンの画像で判定）', (await dockButtons(page)).find((b) => b.handle === 'bob')?.current, await dockButtons(page));

    // ドロワーに出ていない carol へ切替（一覧シートまで開く）
    await page.evaluate(() => { events.length = 0; });
    await clickDock(page, 'carol');
    await page.waitForTimeout(900);
    ev = await page.evaluate(() => events.slice());
    check(tag + '切替: ドロワーに無いアカウントは一覧シートを開いて押す', ev.includes('open-sheet') && ev.includes('switch:carol'), ev);

    if (variant.label === 'testid あり') {
      // 再読み込みしても、切替の記録と構造の記録が残る
      await page.goto('https://x.com/home');
      await page.evaluate(fixtures);
      await page.evaluate(mobileSetup, variant);
      await page.evaluate(SCRIPT);
      await page.waitForTimeout(300);
      report = await page.evaluate(() => window.__tmXSwitch.dump());
      check(tag + '再読み込み後も、直近の切替の記録が残る', /読み込み完了/.test(report) && /切替先を押す/.test(report), report.slice(0, 1500));
      check(tag + '再読み込み後も、メニュー・ドロワーの構造が残る', /最後に開いていたメニュー・ドロワーの構造/.test(report));
    }

    await page.close();
  }

  // 個別ポスト（左上が「戻る」でアイコンが無い）。v1.0.1 の実機報告
  for (const variant of [
    { testid: true, startOnStatus: true, label: '個別ポスト' },
    { testid: true, startOnStatus: true, routeSheet: true, label: '個別ポスト + 一覧が /account/switch のページ' }
  ]) {
    const page = await newPage(browser, { width: 402, height: 668 });
    const STATUS = 'https://x.com/dave/status/1';
    await page.goto(STATUS);
    await page.evaluate(fixtures);
    await page.evaluate(mobileSetup, variant);
    await page.evaluate(SCRIPT);
    await page.waitForTimeout(400);
    const tag = '[モバイル ' + variant.label + '] ';

    check(tag + '前提: 左上にアイコンが無い', await page.evaluate(() => !document.getElementById('dashButton') && !!document.getElementById('backButton')));

    await loadViaDock(page);
    await page.waitForTimeout(1200);
    let ev = await page.evaluate(() => events.slice());
    check(tag + '読込: ホームへ移ってからドロワー → 一覧を開く',
      ev.indexOf('go-home') >= 0 && ev.indexOf('go-home') < ev.indexOf('open-drawer') && ev.includes('open-sheet'), ev);
    check(tag + '読込: 3件覚える', JSON.stringify((await stored(page)).sort()) === JSON.stringify(['alice', 'bob', 'carol']), await stored(page));
    check(tag + '読込: 終わったら元の個別ポストへ戻る', page.url() === STATUS, page.url());
    await page.waitForTimeout(400);
    check(tag + '読込後: 左上のアイコンが無くても、現在のアカウント（alice）に印が付く（同じタブで確かめた値）',
      (await dockButtons(page)).find((b) => b.handle === 'alice')?.current, await dockButtons(page));

    // ドロワーに出ている bob
    await page.evaluate(() => { events.length = 0; });
    await clickDock(page, 'bob');
    await page.waitForTimeout(800);
    ev = await page.evaluate(() => events.slice());
    check(tag + '切替: ホームへ移ってからドロワーの bob を押す', ev.includes('go-home') && ev.includes('switch:bob'), ev);
    check(tag + '切替: 元のページを覚えている（X が再読み込みしたら戻す）', await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem('tm-x-switch-return') || 'null')?.path === '/dave/status/1'));
    await page.waitForTimeout(900);
    check(tag + '切替後（再読み込みなし）: 元の個別ポストへ戻る', page.url() === STATUS, page.url());
    check(tag + '切替後: 印が bob に移る', (await dockButtons(page)).find((b) => b.handle === 'bob')?.current, await dockButtons(page));

    // ドロワーに出ていない carol（一覧まで開く）
    await page.evaluate(() => { events.length = 0; });
    await clickDock(page, 'carol');
    await page.waitForTimeout(1200);
    ev = await page.evaluate(() => events.slice());
    check(tag + '切替: ホーム → ドロワー → 一覧で carol を押す', ev.includes('go-home') && ev.includes('open-sheet') && ev.includes('switch:carol'), ev);
    await page.waitForTimeout(900);
    check(tag + '切替後: 元の個別ポストへ戻る', page.url() === STATUS, page.url());

    // 履歴で戻れず開き直した場合はページが読み込み直されているので、模擬DOMとスクリプトを入れ直す
    if (!(await page.evaluate(() => !!window.h))) {
      await page.evaluate(fixtures);
      await page.evaluate(mobileSetup, variant);
      await page.evaluate(SCRIPT);
      await page.waitForTimeout(400);
    }

    // 一覧に無いアカウント: 失敗しても元のページへ戻る
    await page.evaluate(() => {
      const list = JSON.parse(localStorage.getItem('tm-x-switch-accounts'));
      list.push({ screenName: 'ghost', name: 'Ghost', avatar: '' });
      localStorage.setItem('tm-x-switch-accounts', JSON.stringify(list));
      document.body.append(document.createElement('i'));
    });
    await page.waitForTimeout(400);
    await clickDock(page, 'ghost');
    await page.waitForTimeout(2600);
    check(tag + '失敗: 元の個別ポストへ戻る', page.url() === STATUS, page.url());
    check(tag + '失敗: ボタンが押せる状態に戻る', (await dockButtons(page)).every((b) => !b.disabled), await dockButtons(page));
    check(tag + '失敗: 記録に「ホームへ移る」と「元のページへ戻る」が出る', await page.evaluate(() =>
      /左上のアイコンが無いので、ホームへ移る/.test(window.__tmXSwitch.dump()) && /元のページへ戻る/.test(window.__tmXSwitch.dump())));

    await page.close();
  }

  // ドロワーに「アカウント」ボタンが見つからない場合（未確認の構造への備え）
  {
    const page = await newPage(browser, { width: 402, height: 668 });
    await page.goto('https://x.com/home#tmswitch');
    await page.evaluate(fixtures);
    await page.evaluate(mobileSetup, { testid: true, noMoreButton: true });
    await page.evaluate(SCRIPT);
    await page.waitForTimeout(400);
    const tag = '[モバイル 一覧ボタンなし] ';

    check(tag + '診断パネルは左上のアイコンを隠さないよう画面下に出る', await page.evaluate(() => {
      const r = document.getElementById('tm-x-switch-panel').getBoundingClientRect();
      return r.top > 100;
    }));

    // パネルの「読込を試す」
    await page.evaluate(() => [...document.querySelectorAll('#tm-x-switch-panel button')].find((b) => b.textContent === '読込を試す').click());
    await page.waitForTimeout(1500);
    const learned = await stored(page);
    check(tag + 'パネルの「読込を試す」で読み込める', learned.length > 0, learned);
    check(tag + '一覧を開けなくても、ドロワーに見えている分（自分 + 2件）は覚える',
      JSON.stringify([...learned].sort()) === JSON.stringify(['alice', 'bob', 'carol']), learned);
    await page.waitForTimeout(1600);
    const text = await page.evaluate(() => document.querySelector('#tm-x-switch-panel textarea').value);
    check(tag + '記録に「アカウント」ボタンが無かったことが出る', /ドロワーの中に切替先も「アカウント」ボタンも見つからない/.test(text), text.slice(0, 2000));
    check(tag + '記録にドロワーの中の候補が出る', /中の候補: @bob @carol/.test(text), text.slice(0, 2000));
    check(tag + 'ドロワーの構造に @ハンドルの文字が出る', /「Alice ?@alice」/.test(text), text.slice(-1500));
    check(tag + '閉じる', await page.evaluate(() => !document.getElementById('drawer')));

    await page.close();
  }

  // 自動では一覧を開けない場合（「アカウント」ボタンに名前が無く、ドロワーに他のアカウントも無い）
  // → ドロワーを開いたまま残し、手で続きを押せばその場で覚える
  {
    const page = await newPage(browser, { width: 402, height: 668 });
    await page.goto('https://x.com/home');
    await page.evaluate(fixtures);
    await page.evaluate(mobileSetup, { testid: true, unlabeledMore: true, noOthers: true });
    await page.evaluate(SCRIPT);
    await page.waitForTimeout(400);
    const tag = '[モバイル 自動で開けない] ';

    await loadViaDock(page);
    await page.waitForTimeout(1400);
    const text = await toastText(page);
    check(tag + '失敗の案内に止まった段階が出る', /ドロワーの中に「アカウント」ボタンが見つからない/.test(text), text);
    check(tag + '失敗の案内に「記録をコピー」ボタンが付き、押せる', await page.evaluate(() => {
      const t = document.getElementById('tm-x-switch-root').shadowRoot.querySelector('.toast');
      return t.querySelector('button')?.textContent === '記録をコピー' && getComputedStyle(t).pointerEvents === 'auto';
    }));
    check(tag + 'ドロワーは閉じずに残す', await page.evaluate(() => !!document.getElementById('drawer')));
    check(tag + 'ドックのボタンは押せる状態に戻る', await page.evaluate(() => {
      const buttons = [...document.getElementById('tm-x-switch-root').shadowRoot.querySelectorAll('.list button')];
      return buttons.length > 0 && buttons.every((b) => !b.disabled);
    }));
    check(tag + '記録に失敗の段階が残る', await page.evaluate(() =>
      /読み込み失敗[\s\S]*ドロワーの中に「アカウント」ボタンが見つからない/.test(window.__tmXSwitch.dump())));

    await page.evaluate(() => document.getElementById('tm-x-switch-root').shadowRoot.querySelector('.toast button').click());
    await page.waitForTimeout(300);
    check(tag + '「記録をコピー」を押すと結果を知らせる', /コピー/.test(await toastText(page)), await toastText(page));

    // 続きを手で押す
    await page.evaluate(() => document.getElementById('drawerMore').click());
    await page.waitForTimeout(600);
    check(tag + '手で一覧を開くと、その場で3件覚える',
      JSON.stringify((await stored(page)).sort()) === JSON.stringify(['alice', 'bob', 'carol']), await stored(page));
    check(tag + '覚えたことを知らせる', /3件のアカウントを覚えました/.test(await toastText(page)), await toastText(page));

    await page.close();
  }

  // ==========================================================
  // 切替後に元のページへ戻す
  // ==========================================================
  {
    const page = await newPage(browser, { width: 390, height: 844 });
    await page.goto('https://x.com/home');
    await page.evaluate(() => sessionStorage.setItem('tm-x-switch-return',
      JSON.stringify({ path: '/notifications', handle: 'bob', at: Date.now() })));
    await page.evaluate(SCRIPT).catch(() => {});
    await page.waitForURL('https://x.com/notifications', { timeout: 3000 }).catch(() => {});
    check('復帰: 切替後にホームへ飛ばされたら、元のページへ戻す', page.url() === 'https://x.com/notifications', page.url());
    check('復帰: 記録は1回で消す', await page.evaluate(() => sessionStorage.getItem('tm-x-switch-return') === null));

    await page.goto('https://x.com/home');
    await page.evaluate(() => sessionStorage.setItem('tm-x-switch-return',
      JSON.stringify({ path: '/notifications', handle: 'bob', at: Date.now() - 5 * 60 * 1000 })));
    await page.evaluate(SCRIPT).catch(() => {});
    await page.waitForTimeout(500);
    check('復帰: 古い記録では戻さない', page.url() === 'https://x.com/home', page.url());

    await page.goto('https://x.com/i/flow/login');
    await page.evaluate(SCRIPT);
    await page.waitForTimeout(300);
    check('表示: ログインの流れではドックを出さない', await page.evaluate(() => !document.getElementById('tm-x-switch-root')));

    await page.close();
  }

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
