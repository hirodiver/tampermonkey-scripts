const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// x-tab-account.user.js の検証用ハーネス。
//
//   NODE_PATH=$(npm root -g) node test/x-tab-account.test.js
//
// 1つのブラウザコンテキストに複数のページを開き、Chrome のタブを模す。
// localStorage は全タブ共通、sessionStorage はタブごと、という点は本物と同じ。
//
// X 側の模擬（デスクトップ幅）:
//   - ログイン中のアカウントは全タブ共通（localStorage の mock-cookie。Cookie の代わり）
//   - 画面（左のプロフィールリンク・左下のアカウントボタン・切替メニュー）は
//     読み込んだ時点のアカウントで描き、別タブで切り替えても古いまま
//   - 切替メニューでは、画面上の現在のアカウントは押せない。他のアカウントを押すと
//     mock-cookie を書き換え、/home を読み込み直す（mode=spa なら読み込み直さずに描き直す）
//
// タブの前面・裏とフォーカスは、ヘッドレスでは本物を操作できないので、
// sessionStorage の mock-vis / mock-focus で document.visibilityState と
// document.hasFocus() を差し替え、visibilitychange / focus を投げて模す。
//
// X の実DOMではない（切替メニューの中身は x-account-switcher の実機診断と模擬に合わせた）ので、
// これに通ることは実機で動くことを保証しない。
//
// Trusted Types を強制する CSP を付けて配信し、innerHTML を使うと落ちる状態で流す。

const SOURCE = fs.readFileSync(
  process.env.SCRIPT_PATH ||
    path.join(__dirname, '..', 'x-tab-account.user.js'),
  'utf8'
);

// 待ち時間をテスト用に縮める
const SCRIPT = SOURCE
  .replace(/const DETECT_WAIT_MS = \d+;/, 'const DETECT_WAIT_MS = 3000;')
  .replace(/const MENU_WAIT_MS = \d+;/, 'const MENU_WAIT_MS = 1200;')
  .replace(/const CONFIRM_WAIT_MS = \d+;/, 'const CONFIRM_WAIT_MS = 300;')
  .replace(/const RELOAD_TIMEOUT_MS = \d+;/, 'const RELOAD_TIMEOUT_MS = 1500;');

const PIXEL = Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64');

// --- X の模擬（ページ内で動く。innerHTML は使えないので要素を組み立てる） ---
function mockX() {
  const ACCOUNTS = ['alice', 'bob', 'carol'];
  const cookie = () => localStorage.getItem('mock-cookie') || 'alice';
  const mode = () => localStorage.getItem('mock-mode') || 'reload';

  // 出来事はタブごとに、読み込み直しても残す
  const ev = (e) => {
    const list = JSON.parse(sessionStorage.getItem('mock-events') || '[]');
    list.push(e);
    sessionStorage.setItem('mock-events', JSON.stringify(list));
  };

  // この画面が表しているアカウント。読み込んだ時点で決まり、別タブの切替では変わらない
  let shown = cookie();
  ev('load:' + location.pathname + ':' + shown);

  const h = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'onclick') el.addEventListener('click', v);
      else el.setAttribute(k, v);
    }
    for (const c of children) el.append(c);
    return el;
  };
  const avatar = (hd) =>
    h('div', { 'data-testid': 'UserAvatar-Container-' + hd },
      h('img', { src: 'https://pbs.twimg.com/profile_images/1/' + hd + '_normal.jpg', alt: '' }));
  const userCell = (hd, onclick) =>
    h('div', { role: 'button', 'data-testid': 'UserCell', onclick },
      avatar(hd), h('span', {}, hd[0].toUpperCase() + hd.slice(1)), h('span', {}, '@' + hd));

  const root = document.getElementById('react-root');
  const layers = document.getElementById('layers');
  const closeAll = () => layers.replaceChildren();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { ev('escape'); closeAll(); }
  });

  const doSwitch = (hd) => {
    ev('switch:' + hd);
    closeAll();
    const apply = () => {
      localStorage.setItem('mock-cookie', hd);
      if (mode() === 'spa') {
        shown = hd;
        history.pushState(null, '', '/home');
        renderApp();
      } else {
        location.assign('/home');
      }
    };
    if (mode() === 'confirm') {
      layers.append(h('div', { role: 'dialog' },
        h('div', { role: 'button', 'data-testid': 'confirmationSheetConfirm', onclick: () => { ev('confirm'); closeAll(); apply(); } }, 'はい')));
      return;
    }
    apply();
  };

  const nav = (p) => {
    history.pushState(null, '', p);
    renderApp();
  };

  // 切替メニュー: 現在のアカウントは押せない項目、他は押せる UserCell
  // switchpage: メニューには他のアカウントが出ず、一覧ページへのリンクだけがある
  const openMenu = () => {
    ev('open-menu');
    closeAll();
    const others = ACCOUNTS.filter((a) => a !== shown);
    layers.append(h('div', { role: 'menu', id: 'accountMenu' },
      h('div', { id: 'menuCurrent' }, avatar(shown), h('span', {}, '@' + shown), h('span', {}, '✓')),
      ...(mode() === 'switchpage' ? [] : others.map((hd) => userCell(hd, () => doSwitch(hd)))),
      mode() === 'switchpage' ?
        h('a', { href: '/account/switch', 'data-testid': 'switcher', onclick: (e) => { e.preventDefault(); ev('open-switch-page'); closeAll(); nav('/account/switch'); } }, 'すべてのアカウントを表示') : '',
      h('a', { href: '/i/flow/login', role: 'menuitem' }, '既存のアカウントを追加'),
      h('a', { href: '/logout', role: 'menuitem' }, '@' + shown + ' からログアウト')));
  };

  const mainContent = () => {
    if (location.pathname === '/account/switch') {
      return ACCOUNTS.map((hd) => hd === shown ?
        h('li', { role: 'listitem', 'data-testid': 'AccountSwitcher_Switch_Button' }, avatar(hd), h('span', {}, '@' + hd)) :
        h('button', { role: 'button', 'data-testid': 'AccountSwitcher_Switch_Button', 'aria-label': '@' + hd + 'に切り替える', onclick: () => doSwitch(hd) },
          avatar(hd), h('span', {}, '@' + hd)));
    }
    // タイムラインに出ている同名ユーザー（押すとプロフィールへ飛ぶ。切替に使ってはいけない）
    return [
      h('h1', {}, location.pathname),
      ...ACCOUNTS.map((hd) => userCell(hd, () => ev('nav:/timeline-' + hd)))
    ];
  };

  const renderApp = () => {
    root.replaceChildren(
      h('header', { role: 'banner' },
        h('a', { 'data-testid': 'AppTabBar_Profile_Link', href: '/' + shown, id: 'profileLink' }, 'プロフィール'),
        h('div', {
          role: 'button', 'data-testid': 'SideNav_AccountSwitcher_Button', 'aria-label': 'アカウントメニュー',
          id: 'switcher', style: 'position:fixed;left:10px;bottom:10px;width:220px;height:50px',
          onclick: openMenu
        }, avatar(shown), h('span', {}, '@' + shown))),
      h('main', { style: 'margin-top:40px' }, ...mainContent()));
  };

  window.mockNav = nav;
  window.addEventListener('popstate', renderApp);

  // SPA の描画が遅れて来るのを模す
  setTimeout(renderApp, 100);
}

const HTML = `<!doctype html><meta charset="utf-8"><title>x-mock</title>
<style>
  body { margin: 0; }
  img { width: 32px; height: 32px; display: block; }
  [role="button"], [role="menuitem"], a, button, li { display: block; min-height: 20px; }
  #layers > * { position: fixed; top: 0; left: 300px; width: 300px; background: #fff; }
</style>
<body><div id="react-root"></div><div id="layers"></div>
<script>(${mockX.toString()})();</script></body>`;

// タブの前面・裏とフォーカスの差し替え + ユーザースクリプト（読み込みのたびに入る）
const INIT = `
if (location.hostname === 'x.com') {
  (() => {
    const vis = () => sessionStorage.getItem('mock-vis') || 'visible';
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: vis });
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => vis() === 'hidden' });
    Document.prototype.hasFocus = function () {
      return vis() === 'visible' && sessionStorage.getItem('mock-focus') !== 'no';
    };
  })();
  ${SCRIPT}
}
`;

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra !== undefined && !cond ? '  -> ' + JSON.stringify(extra) : ''));
}

async function newContext(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route('https://x.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      headers: { 'content-security-policy': "require-trusted-types-for 'script'" },
      body: HTML
    })
  );
  await context.route('https://pbs.twimg.com/**', (route) =>
    route.fulfill({ contentType: 'image/gif', body: PIXEL })
  );
  await context.addInitScript(INIT);
  return context;
}

async function openTab(context, url) {
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto(url);
  await idle(page);
  return page;
}

// ページ遷移中の evaluate は失敗するので、成功するまで試す
async function until(page, fn, arg, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      if (await page.evaluate(fn, arg)) return true;
    } catch {
      // 遷移中
    }
    await page.waitForTimeout(100);
  }
  return false;
}

// スクリプトが落ち着く（描画済み・戻す途中でない）まで待つ。直後の遷移も拾うため、2回続けて確かめる
async function idle(page) {
  const settled = () =>
    !!window.__tmXTabAccount &&
    !!document.getElementById('profileLink') &&
    !sessionStorage.getItem('tm-x-tabacct-restore') &&
    !window.__tmXTabAccount.state().restoring;
  for (let i = 0; i < 2; i++) {
    await until(page, settled);
    await page.waitForTimeout(700);
  }
}

async function setActive(page, active, { focus = true } = {}) {
  await page.evaluate(({ active, focus }) => {
    sessionStorage.setItem('mock-vis', active ? 'visible' : 'hidden');
    sessionStorage.setItem('mock-focus', focus ? 'yes' : 'no');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event(active && focus ? 'focus' : 'blur'));
  }, { active, focus });
}

// Chrome でタブを移るのと同じ順（前のタブが裏に回ってから、次のタブが前面に来る）
async function switchTab(from, to) {
  await setActive(from, false);
  await setActive(to, true);
  await to.waitForTimeout(300);
  await idle(to);
}

const state = (page) =>
  page.evaluate(() => ({
    url: location.pathname,
    shown: (document.getElementById('profileLink')?.getAttribute('href') || '').slice(1),
    tab: JSON.parse(sessionStorage.getItem('tm-x-tabacct-tab') || 'null'),
    active: JSON.parse(localStorage.getItem('tm-x-tabacct-active') || 'null')?.handle,
    cookie: localStorage.getItem('mock-cookie') || 'alice',
    restore: sessionStorage.getItem('tm-x-tabacct-restore'),
    events: JSON.parse(sessionStorage.getItem('mock-events') || '[]')
  }));

const toastText = (page) =>
  page.evaluate(() => document.getElementById('tm-x-tabacct-root')?.shadowRoot.querySelector('.toast')?.textContent || '');

// 利用者が X の切替メニューを自分で開いて、アカウントを押す
const userSwitch = (page, handle) =>
  page.evaluate((handle) => {
    document.getElementById('switcher').click();
    [...document.querySelectorAll('#layers [data-testid="UserCell"]')]
      .find((c) => c.textContent.includes('@' + handle)).click();
  }, handle);

const setMode = (page, mode) => page.evaluate((mode) => localStorage.setItem('mock-mode', mode), mode);

const count = (events, prefix) => events.filter((e) => e.startsWith(prefix)).length;

(async () => {
  const browser = await chromium.launch();
  const context = await newContext(browser);

  // ==========================================================
  // タブA・タブB を開いて覚える
  // ==========================================================
  const A = await openTab(context, 'https://x.com/home');

  check('前提: Trusted Types が強制されている（innerHTML に文字列を入れると例外）',
    await A.evaluate(() => { try { document.body.innerHTML = '<b>x</b>'; return false; } catch { return true; } }));

  let s = await state(A);
  check('タブA: 開いたときのアカウント（@alice）とページを覚える', s.tab?.handle === 'alice' && s.tab?.url === '/home', s);
  check('タブA: 有効なアカウント（全タブ共通）を @alice にする', s.active === 'alice', s);
  check('タブA: 同じアカウントなので何もしない（メニューを開かない・読み込み直さない）',
    count(s.events, 'open-menu') === 0 && count(s.events, 'load:') === 1, s.events);

  await A.evaluate(() => window.mockNav('/dave/status/1'));
  await A.waitForTimeout(600);
  s = await state(A);
  check('タブA: 前面にある間に移ったページを覚える', s.tab?.url === '/dave/status/1', s.tab);

  await setActive(A, false);

  const B = await openTab(context, 'https://x.com/explore');
  s = await state(B);
  check('タブB: 別のタブは別に覚える（@alice / /explore）', s.tab?.handle === 'alice' && s.tab?.url === '/explore', s.tab);
  check('タブA: タブB を開いても、タブA の記憶は変わらない', (await state(A)).tab?.url === '/dave/status/1', (await state(A)).tab);

  // ==========================================================
  // タブB で @bob に切り替える（X が /home を読み込み直す）
  // ==========================================================
  await userSwitch(B, 'bob');
  await B.waitForTimeout(300);
  await idle(B);
  s = await state(B);
  check('タブB: 自分で切り替えたら、タブB のアカウントを @bob に覚え直す', s.tab?.handle === 'bob' && s.shown === 'bob', s);
  check('タブB: 有効なアカウントが @bob になる', s.active === 'bob', s);
  check('タブB: 自分で切り替えた後、元のアカウントへ戻そうとしない', count(s.events, 'switch:') === 1 && count(s.events, 'open-menu') === 1, s.events);

  await B.evaluate(() => window.mockNav('/notifications'));
  await B.waitForTimeout(600);

  const aLoadsBefore = count((await state(A)).events, 'load:');
  await B.waitForTimeout(500);
  s = await state(A);
  check('タブA: 裏にある間は何もしない（読み込み直さない・切り替えない）',
    count(s.events, 'load:') === aLoadsBefore && count(s.events, 'switch:') === 0 && s.url === '/dave/status/1', s);
  check('タブA: 裏にある間の画面は古いまま（@alice）', s.shown === 'alice' && s.cookie === 'bob', s);

  // ==========================================================
  // タブA を前面に出す → @alice に戻し、/dave/status/1 を開く
  // ==========================================================
  const bLoadsBefore = count((await state(B)).events, 'load:');
  await switchTab(B, A);
  s = await state(A);
  check('タブA: 前面に出すと @alice に戻す', s.shown === 'alice' && s.cookie === 'alice', s);
  check('タブA: 覚えていたページ（/dave/status/1）に戻る', s.url === '/dave/status/1', s);
  check('タブA: 画面が古いので、まず読み込み直してから切り替える（古い画面では @alice を押せない）',
    s.events.includes('load:/dave/status/1:bob') &&
    s.events.indexOf('load:/dave/status/1:bob') < s.events.indexOf('switch:alice'), s.events);
  check('タブA: X の切替メニューの @alice を押す', s.events.includes('switch:alice') && count(s.events, 'switch:') === 1, s.events);
  check('タブA: タイムラインの同名ユーザーを押さない', count(s.events, 'nav:') === 0, s.events);
  check('タブA: 有効なアカウントが @alice になり、タブの記憶はそのまま', s.active === 'alice' && s.tab?.handle === 'alice' && s.tab?.url === '/dave/status/1', s);
  check('タブA: 戻す途中の印を消す', s.restore === null, s.restore);
  check('タブA: 「戻しました」と知らせる', (await toastText(A)).includes('@alice に戻しました'), await toastText(A));
  s = await state(B);
  check('タブB: タブA が戻している間、裏のタブB は何もしない', count(s.events, 'load:') === bLoadsBefore && s.url === '/notifications', s);

  // ==========================================================
  // タブB を前面に出す → @bob に戻し、/notifications を開く
  // ==========================================================
  await switchTab(A, B);
  s = await state(B);
  check('タブB: 前面に出すと @bob に戻り、/notifications を開く', s.shown === 'bob' && s.cookie === 'bob' && s.url === '/notifications', s);
  check('タブA: タブB が戻しても、タブA の記憶は @alice のまま', (await state(A)).tab?.handle === 'alice', (await state(A)).tab);

  // 同じアカウントのまま前面に出し直しても何もしない
  const bBefore = await state(B);
  await setActive(B, false);
  await setActive(B, true);
  await B.waitForTimeout(800);
  s = await state(B);
  check('タブB: アカウントが合っていれば、前面に出し直しても何もしない',
    count(s.events, 'load:') === count(bBefore.events, 'load:') && count(s.events, 'open-menu') === count(bBefore.events, 'open-menu'), s.events);

  // ==========================================================
  // 2つのウインドウを並べている（前面だがフォーカスが無い）
  // ==========================================================
  await setActive(B, false);
  await setActive(A, true, { focus: false });
  await A.waitForTimeout(800);
  s = await state(A);
  check('並べたウインドウ: 見えていてもフォーカスが無ければ切り替えない', s.shown === 'alice' && s.cookie === 'bob' && count(s.events, 'switch:') === 1, s);
  await setActive(A, true, { focus: true });
  await A.waitForTimeout(300);
  await idle(A);
  s = await state(A);
  check('並べたウインドウ: フォーカスが来たら戻す', s.shown === 'alice' && s.cookie === 'alice' && s.url === '/dave/status/1', s);

  // ==========================================================
  // 読み込み直さずに切り替わる X（mode=spa）
  // ==========================================================
  await setMode(A, 'spa');
  await switchTab(A, B);   // B を @bob に戻す（spa）
  s = await state(B);
  check('読み込み直さない切替: 戻して、覚えていたページを開く', s.shown === 'bob' && s.cookie === 'bob' && s.url === '/notifications', s);

  const bSwitches = count(s.events, 'switch:');
  await userSwitch(B, 'carol');
  await B.waitForTimeout(800);
  s = await state(B);
  check('読み込み直さない切替: 自分で切り替えたら覚え直す（表示の変化で気づく）', s.tab?.handle === 'carol' && s.active === 'carol', s);
  check('読み込み直さない切替: 自分で切り替えた後、戻そうとしない', count(s.events, 'switch:') === bSwitches + 1, s.events);

  await switchTab(B, A);
  s = await state(A);
  check('読み込み直さない切替: タブA を前面に出すと @alice / /dave/status/1 に戻る', s.shown === 'alice' && s.cookie === 'alice' && s.url === '/dave/status/1', s);

  // ==========================================================
  // 確認シートが出る X（mode=confirm）
  // ==========================================================
  await setMode(A, 'confirm');
  await switchTab(A, B);
  s = await state(B);
  check('確認シート: 出たら「はい」を押して戻す', s.events.includes('confirm') && s.shown === 'carol' && s.cookie === 'carol', s);

  // ==========================================================
  // メニューに出ず、一覧ページ（/account/switch）から選ぶ X（mode=switchpage）
  // ==========================================================
  await setMode(A, 'switchpage');
  await switchTab(B, A);
  s = await state(A);
  check('一覧ページ: メニューに無ければ /account/switch を開いて押す', s.events.includes('open-switch-page') && s.shown === 'alice' && s.cookie === 'alice', s);
  check('一覧ページ: その後、覚えていたページに戻る', s.url === '/dave/status/1', s);
  check('一覧ページ: タブの記憶に /account/switch を入れない', s.tab?.url === '/dave/status/1', s.tab);

  // ==========================================================
  // 戻せない（ログアウトしたアカウント）
  // ==========================================================
  await setMode(A, 'reload');
  await A.evaluate(() => sessionStorage.setItem('tm-x-tabacct-tab', JSON.stringify({ handle: 'ghost', url: '/dave/status/1', at: Date.now() })));
  const aFail = await state(A);
  await setActive(A, false);
  await setActive(A, true);
  await A.waitForTimeout(2200);
  s = await state(A);
  check('失敗: 知らせる', /@ghost に戻せませんでした/.test(await toastText(A)) && /@alice のまま/.test(await toastText(A)), await toastText(A));
  check('失敗: 開いたメニューを閉じる', s.events.includes('escape') && await A.evaluate(() => !document.getElementById('accountMenu')), s.events);
  check('失敗: 何も押していない', count(s.events, 'switch:') === count(aFail.events, 'switch:') && count(s.events, 'nav:') === 0, s.events);
  check('失敗: このタブをいまのアカウント（@alice）で覚え直す（繰り返さない）', s.tab?.handle === 'alice' && s.restore === null, s);
  const opens = count(s.events, 'open-menu');
  await setActive(A, false);
  await setActive(A, true);
  await A.waitForTimeout(800);
  check('失敗: 次に前面に出したときは試さない', count((await state(A)).events, 'open-menu') === opens);

  // ==========================================================
  // 裏にあるタブが読み込まれても切り替えない。前面に来たら切り替える
  // ==========================================================
  await A.evaluate(() => {
    sessionStorage.setItem('tm-x-tabacct-tab', JSON.stringify({ handle: 'bob', url: '/dave/status/1', at: Date.now() }));
    sessionStorage.setItem('tm-x-tabacct-restore', JSON.stringify({ handle: 'bob', url: '/dave/status/1', step: 'reload', at: Date.now() }));
    sessionStorage.setItem('mock-vis', 'hidden');
  });
  const aHidden = await state(A);
  await A.reload();
  await A.waitForTimeout(2000);
  s = await state(A);
  check('裏で読み込み: 戻す途中の印があっても、裏では切り替えない',
    count(s.events, 'switch:') === count(aHidden.events, 'switch:') && count(s.events, 'open-menu') === count(aHidden.events, 'open-menu') && s.cookie === 'alice', s);
  check('裏で読み込み: 印は捨てる（次に前面に来たときにやり直す）', s.restore === null, s.restore);
  check('裏で読み込み: タブの記憶（@bob）は書き換えない', s.tab?.handle === 'bob', s.tab);
  await setActive(A, true);
  await A.waitForTimeout(300);
  await idle(A);
  s = await state(A);
  check('裏で読み込み: 前面に来たら @bob に切り替える', s.shown === 'bob' && s.cookie === 'bob' && s.url === '/dave/status/1', s);

  // ==========================================================
  // 自分で切り替えた直後の読み込みでフォーカスが外れていても、覚え直す
  // ==========================================================
  await A.evaluate(() => sessionStorage.setItem('mock-focus', 'no'));
  await userSwitch(A, 'carol');
  await A.waitForTimeout(1500);
  s = await state(A);
  check('自分で切替（フォーカス無しで読み込み）: @carol で覚え直す', s.tab?.handle === 'carol' && s.active === 'carol' && s.shown === 'carol', s);
  const aSwitches = count(s.events, 'switch:');
  await setActive(A, true);
  await A.waitForTimeout(1000);
  s = await state(A);
  check('自分で切替（フォーカス無しで読み込み）: フォーカスが来ても @bob へ戻さない', count(s.events, 'switch:') === aSwitches && s.cookie === 'carol', s.events);

  // ==========================================================
  // 新しいタブ・覚えないページ・診断
  // ==========================================================
  await setActive(A, false);
  const C = await openTab(context, 'https://x.com/home');
  s = await state(C);
  check('新しいタブ: いまのアカウント（@carol）で覚え、何もしない', s.tab?.handle === 'carol' && count(s.events, 'open-menu') === 0, s);

  await C.evaluate(() => window.mockNav('/i/flow/login'));
  await C.waitForTimeout(600);
  check('覚えないページ: ログインの流れはページとして覚えない', (await state(C)).tab?.url === '/home', (await state(C)).tab);

  const report = await C.evaluate(() => window.__tmXTabAccount.dump());
  check('診断: dump() がこのタブ・有効なアカウント・画面のアカウントを出す',
    /=== X タブ別アカウント 診断 ===/.test(report) && /このタブのアカウント: @carol/.test(report) &&
    /有効なアカウント（全タブ共通）: @carol/.test(report) && /画面のアカウント: @carol（プロフィールへのリンク）/.test(report), report);
  check('診断: 記録が出る', /このタブのアカウントを覚える/.test(report), report);

  const aReport = await A.evaluate(() => window.__tmXTabAccount.dump());
  check('診断: 戻した記録が読み込み直しても残る', /戻し始める/.test(aReport) && /切替先を押す/.test(aReport) && /元のページを開く/.test(aReport), aReport);

  await C.evaluate(() => window.__tmXTabAccount.forget());
  check('診断: forget() で覚え直す', (await state(C)).tab?.handle === 'carol');

  await C.evaluate(SCRIPT).catch(() => {});
  await C.waitForTimeout(300);
  check('二重起動: もう一度流しても2つ目は動かない', await C.evaluate(() =>
    document.documentElement.dataset.tmXTabAccount === window.__tmXTabAccount.version &&
    document.querySelectorAll('#tm-x-tabacct-root').length <= 1));

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
