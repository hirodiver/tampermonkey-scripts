const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// claude-dictation-shortcut.user.js の検証用ハーネス。
//
// claude.ai の入力欄（右端に send-slot と idle-slot が重なる形）を模したページを
// https://claude.ai/code として出し、ヘッドレスChromiumで本物のキー入力を送って確かめる。
//
//   NODE_PATH=$(npm root -g) node test/claude-dictation-shortcut.test.js
//
// 入力欄の構造は、claude.ai の通常チャットについて公開されている情報
// （idle-slot / send-slot、Dictate と Microphone の ∨、inert で隠す）から組んだ推測。
// Claude Code（claude.ai/code）の実DOMそのものではないので、実機確認の代わりにはならない。

const SCRIPT = fs.readFileSync(
  process.env.SCRIPT_PATH ||
    path.join(__dirname, '..', 'claude-dictation-shortcut.user.js'),
  'utf8'
);

// claude.ai 側の動きを模す:
//   - React と同じく、クリックはルートでまとめて受ける（委譲）
//   - 入力欄に文字があると idle-slot を inert + 不可視にし、send-slot を出す
//   - 音声入力ボタンを押すたびに録音中／停止を切り替え、ラベルと placeholder を変える
const HTML = `<!doctype html><meta charset="utf-8"><title>claude-mock</title>
<style>
  body { margin: 0; font: 14px sans-serif; }
  .composer { margin: 20px; border: 1px solid #ccc; border-radius: 12px; padding: 8px; }
  .editor { min-height: 24px; outline: none; }
  .toolbar { display: flex; justify-content: space-between; align-items: center; }
  .grid { display: grid; }
  .grid > * { grid-area: 1 / 1; }
  .invisible { visibility: hidden; }
  .opacity-0 { opacity: 0; }
  .pointer-events-none { pointer-events: none; }
  button { min-width: 28px; height: 28px; }
</style>
<body>
<div id="root"><main id="main"></main></div>
<script>
  window.clicks = {};
  window.pageKeys = [];
  window.dictating = {};

  // ページ側が受け取ったキー（スクリプトが打ち消したキーはここに来ない）
  document.addEventListener('keydown', (e) => {
    window.pageKeys.push((e.ctrlKey ? 'Ctrl+' : '') + (e.shiftKey ? 'Shift+' : '') + e.code);
  });

  function onActivate(button, how) {
    const id = button.id || button.getAttribute('data-testid') || '?';
    window.clicks[id] = (window.clicks[id] || 0) + 1;
    window.clicks[id + ':' + how] = (window.clicks[id + ':' + how] || 0) + 1;

    if (button.hasAttribute('data-dictate')) {
      const composer = button.closest('.composer');
      const on = !window.dictating[composer.id];
      window.dictating[composer.id] = on;
      button.setAttribute('aria-pressed', String(on));
      if (button.dataset.labelOn) {
        button.setAttribute('aria-label', on ? button.dataset.labelOn : button.dataset.labelOff);
      }
      composer.querySelector('.editor').setAttribute('data-placeholder', on ? 'Listening...' : 'Write a message...');
    }
  }

  // React の委譲と同じく、ルートでクリックを受ける
  document.getElementById('root').addEventListener('click', (e) => {
    const button = e.target.closest('button, [role="button"]');
    if (button && !button.hasAttribute('data-pointerdown-only')) onActivate(button, 'click');
  });

  // pointerdown で反応する部品（Radix の一部など）
  document.getElementById('root').addEventListener('pointerdown', (e) => {
    const button = e.target.closest('[data-pointerdown-only]');
    if (button) onActivate(button, 'pointerdown');
  });

  // 文字があると idle-slot を隠し、send-slot を出す
  document.addEventListener('input', (e) => {
    const composer = e.target.closest('.composer');
    if (composer) window.syncSlots(composer);
  });

  window.syncSlots = (composer) => {
    const hasText = composer.querySelector('.editor').textContent.trim().length > 0;
    const idle = composer.querySelector('[data-cds-part="idle-slot"]');
    const send = composer.querySelector('[data-cds-part="send-slot"]');
    const hide = (el, on) => {
      if (!el) return;
      el.classList.toggle('invisible', on);
      el.classList.toggle('opacity-0', on);
      el.classList.toggle('pointer-events-none', on);
      if (on) el.setAttribute('inert', ''); else el.removeAttribute('inert');
    };
    hide(idle, hasText);
    hide(send, !hasText);
  };

  // 入力欄を1つ組む
  //   opts.labels: { dictate, micMenu, voiceMode, send }（null ならラベルなし）
  window.mkComposer = (id, opts = {}) => {
    const labels = Object.assign({
      dictate: 'Dictate',
      micMenu: 'Microphone',
      voiceMode: 'Use voice mode',
      send: 'Send message'
    }, opts.labels || {});

    const setLabel = (el, label) => { if (label) el.setAttribute('aria-label', label); };

    const composer = document.createElement('div');
    composer.className = 'composer';
    composer.id = id;

    const editor = document.createElement(opts.textarea ? 'textarea' : 'div');
    editor.className = 'editor';
    editor.id = id + '-editor';
    if (!opts.textarea) editor.setAttribute('contenteditable', 'true');

    const wrap = document.createElement('div');
    wrap.appendChild(editor);

    const toolbar = document.createElement('div');
    toolbar.className = 'toolbar';

    const plus = document.createElement('button');
    plus.id = id + '-plus';
    plus.textContent = '+';
    setLabel(plus, 'Add files and more');

    const grid = document.createElement('div');
    grid.className = 'grid';

    const sendSlot = document.createElement('div');
    sendSlot.setAttribute('data-cds-part', 'send-slot');
    const send = document.createElement('button');
    send.id = id + '-send';
    send.textContent = '↵';
    setLabel(send, labels.send);
    sendSlot.appendChild(send);

    const idleSlot = document.createElement('div');
    idleSlot.setAttribute('data-cds-part', 'idle-slot');

    if (!opts.noDictate) {
      const split = document.createElement('div');
      split.setAttribute('data-cds', 'SplitDropdownButton');

      const dictate = document.createElement('button');
      dictate.id = id + '-dictate';
      dictate.setAttribute('data-dictate', '');
      dictate.setAttribute('data-cds-part', 'main');
      setLabel(dictate, labels.dictate);
      if (opts.labelOn) {
        dictate.dataset.labelOn = opts.labelOn;
        dictate.dataset.labelOff = labels.dictate;
      }
      if (opts.pointerdownOnly) dictate.setAttribute('data-pointerdown-only', '');
      if (opts.disabled) dictate.disabled = true;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '16');
      svg.setAttribute('height', '16');
      dictate.appendChild(svg);

      const micMenu = document.createElement('button');
      micMenu.id = id + '-micMenu';
      micMenu.setAttribute('aria-haspopup', 'menu');
      micMenu.textContent = '∨';
      setLabel(micMenu, labels.micMenu);

      split.appendChild(dictate);
      split.appendChild(micMenu);
      idleSlot.appendChild(split);
    }

    if (opts.idleExtra) {
      const extra = document.createElement('button');
      extra.id = id + '-idleExtra';
      setLabel(extra, opts.idleExtra);
      idleSlot.appendChild(extra);
    }

    if (!opts.noVoiceMode) {
      const voice = document.createElement('button');
      voice.id = id + '-voiceMode';
      voice.textContent = '|||';
      setLabel(voice, labels.voiceMode);
      idleSlot.appendChild(voice);
    }

    grid.appendChild(sendSlot);
    grid.appendChild(idleSlot);
    toolbar.appendChild(plus);
    toolbar.appendChild(grid);
    composer.appendChild(wrap);
    composer.appendChild(toolbar);
    document.getElementById('main').appendChild(composer);
    window.syncSlots(composer);
    return composer;
  };

  // Claude Code の画面にある、押すと困るボタン
  window.mkDangerButtons = () => {
    const bar = document.createElement('div');
    bar.id = 'sessionBar';

    const stop = document.createElement('button');
    stop.id = 'stopResponse';
    stop.setAttribute('aria-label', 'Stop response');
    stop.textContent = '■';

    const split = document.createElement('div');
    split.setAttribute('data-cds', 'SplitDropdownButton');
    const pr = document.createElement('button');
    pr.id = 'createPr';
    pr.textContent = 'Create PR';
    const more = document.createElement('button');
    more.id = 'createPrMenu';
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-label', 'More options');
    split.appendChild(pr);
    split.appendChild(more);

    bar.appendChild(stop);
    bar.appendChild(split);
    document.getElementById('main').appendChild(bar);
  };

  window.reset = () => {
    document.getElementById('main').replaceChildren();
    window.clicks = {};
    window.pageKeys = [];
    window.dictating = {};
    if (document.activeElement) document.activeElement.blur();
  };
</script>
</body>`;

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra !== undefined && !cond ? '  -> ' + JSON.stringify(extra) : ''));
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });

  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.route('https://claude.ai/**', (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML })
  );

  // document-start と同じく、ページのスクリプトより先に流し込む
  await page.addInitScript(SCRIPT);
  await page.goto('https://claude.ai/code/session_test');

  const clicks = () => page.evaluate(() => window.clicks);
  const count = async (id) => (await clicks())[id] || 0;
  const toast = () => page.evaluate(() => {
    const el = document.getElementById('tm-claude-dictation-shortcut-toast');
    return el && el.style.opacity === '1' ? el.textContent : '';
  });
  const pressCtrlD = async () => {
    await page.keyboard.press('Control+KeyD');
    await page.waitForTimeout(30);
  };

  check('起動: 診断の口が出る', await page.evaluate(() =>
    typeof window.__tmClaudeDictation?.dump === 'function' &&
    window.__tmClaudeDictation.version === '1.0.1'));

  // --- 基本: 空の入力欄で Ctrl+D ---
  await page.evaluate(() => window.mkComposer('c1'));
  await page.click('#c1-editor');
  await pressCtrlD();

  check('基本: Ctrl+D で音声入力ボタンが1回押される', (await count('c1-dictate')) === 1, await clicks());
  check('基本: 録音中になる', await page.evaluate(() => window.dictating.c1 === true));
  check('基本: マイク選択の ∨ は押さない', (await count('c1-micMenu')) === 0);
  check('基本: 音声モードは押さない', (await count('c1-voiceMode')) === 0);
  check('基本: 送信は押さない', (await count('c1-send')) === 0);
  check('基本: ページ側に Ctrl+D を渡さない（ブックマーク・二重処理を防ぐ）',
    !(await page.evaluate(() => window.pageKeys.includes('Ctrl+KeyD'))), await page.evaluate(() => window.pageKeys));
  check('基本: 押したことを知らせる', (await toast()).includes('マイクボタンを押しました'), await toast());
  check('基本: 入力欄のフォーカスは動かない', await page.evaluate(() => document.activeElement.id === 'c1-editor'));

  await pressCtrlD();
  check('切替: もう一度 Ctrl+D で止まる', await page.evaluate(() => window.dictating.c1 === false));
  check('切替: 音声入力ボタンが計2回押される', (await count('c1-dictate')) === 2);

  // --- 普通の入力・ほかのキーは邪魔しない ---
  await page.keyboard.type('hello d');
  check('素通し: D を普通に打てる', await page.evaluate(() =>
    document.getElementById('c1-editor').textContent === 'hello d'));
  await page.keyboard.press('Control+KeyS');
  check('素通し: ほかのショートカット（Ctrl+S）はページに届く', await page.evaluate(() => window.pageKeys.includes('Ctrl+KeyS')));
  check('素通し: 打鍵では音声入力ボタンを押さない', (await count('c1-dictate')) === 2);

  // --- 文字があるとき（マイクボタンは inert + 不可視で隠れている） ---
  check('隠れ: 文字があると idle-slot は inert で見えない', await page.evaluate(() => {
    const slot = document.querySelector('#c1 [data-cds-part="idle-slot"]');
    return slot.hasAttribute('inert') && getComputedStyle(slot).visibility === 'hidden';
  }));
  await pressCtrlD();
  check('隠れ: 隠れたマイクボタンも Ctrl+D で押せる', (await count('c1-dictate')) === 3);
  check('隠れ: 録音中になる', await page.evaluate(() => window.dictating.c1 === true));
  check('隠れ: 見えている送信ボタンは押さない', (await count('c1-send')) === 0);
  check('隠れ: 書いた文字は残る', await page.evaluate(() =>
    document.getElementById('c1-editor').textContent === 'hello d'));
  await pressCtrlD();
  check('隠れ: もう一度で止まる', await page.evaluate(() => window.dictating.c1 === false));

  // --- 日本語変換中・押しっぱなし ---
  const before = await count('c1-dictate');
  const imeResult = await page.evaluate(() => {
    const ev = new KeyboardEvent('keydown', {
      code: 'KeyD', key: 'd', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true
    });
    document.getElementById('c1-editor').dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  check('変換中: 日本語の変換中は何もしない', (await count('c1-dictate')) === before && imeResult === false);

  const repeatResult = await page.evaluate(() => {
    const ev = new KeyboardEvent('keydown', {
      code: 'KeyD', key: 'd', ctrlKey: true, repeat: true, bubbles: true, cancelable: true
    });
    document.getElementById('c1-editor').dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  check('連打: 押しっぱなしの繰り返しでは押さない（打ち消しはする）',
    (await count('c1-dictate')) === before && repeatResult === true);

  // --- 録音中にラベルが変わる ---
  await page.evaluate(() => {
    window.reset();
    window.mkComposer('c2', { labelOn: 'Stop dictation' });
  });
  await page.click('#c2-editor');
  await pressCtrlD();
  check('ラベル変化: 録音中は「Stop dictation」に変わる', await page.evaluate(() =>
    document.getElementById('c2-dictate').getAttribute('aria-label') === 'Stop dictation'));
  await pressCtrlD();
  check('ラベル変化: 「Stop dictation」でも押して止まる', await page.evaluate(() => window.dictating.c2 === false));

  // 録音中のラベルがただの「Stop」になる作りでも、始めたボタンなら押して止める
  await page.evaluate(() => {
    window.reset();
    window.mkDangerButtons();
    window.mkComposer('c3', { labelOn: 'Stop' });
  });
  await page.click('#c3-editor');
  await pressCtrlD();
  check('ラベル変化: 録音中は「Stop」に変わる', await page.evaluate(() =>
    window.dictating.c3 === true &&
    document.getElementById('c3-dictate').getAttribute('aria-label') === 'Stop'));
  await pressCtrlD();
  check('ラベル変化: ただの「Stop」でも、始めたボタンなら押して止まる',
    await page.evaluate(() => window.dictating.c3 === false), await clicks());
  check('ラベル変化: Claude の「Stop response」は押さない', (await count('stopResponse')) === 0);
  await pressCtrlD();
  check('ラベル変化: 3回目でまた録音が始まる', await page.evaluate(() => window.dictating.c3 === true));

  // --- 日本語の画面 ---
  await page.evaluate(() => {
    window.reset();
    window.mkComposer('ja', {
      labels: { dictate: '音声入力', micMenu: 'マイクを選択', voiceMode: '音声モードを使用', send: 'メッセージを送信' }
    });
  });
  await page.click('#ja-editor');
  await pressCtrlD();
  check('日本語: 「音声入力」を押す', (await count('ja-dictate')) === 1, await clicks());
  check('日本語: 「マイクを選択」「音声モード」「送信」は押さない',
    !(await count('ja-micMenu')) && !(await count('ja-voiceMode')) && !(await count('ja-send')));

  // --- ラベルが無い（未知の言語・アイコンだけ）: idle-slot の構造で当てる ---
  await page.evaluate(() => {
    window.reset();
    window.mkComposer('nolabel', {
      labels: { dictate: null, micMenu: null, voiceMode: 'Usar modo de voz', send: null }
    });
  });
  await page.click('#nolabel-editor');
  await pressCtrlD();
  check('構造: ラベルが無くても idle-slot の先頭のボタンを押す', (await count('nolabel-dictate')) === 1, await clicks());
  check('構造: ∨（aria-haspopup）は押さない', (await count('nolabel-micMenu')) === 0);
  check('構造: 後ろの知らない言語のボタンは押さない', (await count('nolabel-voiceMode')) === 0);

  // --- 入力欄が作り直されても効く ---
  await page.evaluate(() => {
    window.reset();
    window.mkComposer('old');
    document.getElementById('old').remove();
    window.mkComposer('new');
  });
  await page.click('#new-editor');
  await pressCtrlD();
  check('作り直し: 新しい入力欄のボタンを押す', (await count('new-dictate')) === 1);

  // --- 入力欄が2つ: フォーカスのある方 ---
  await page.evaluate(() => {
    window.reset();
    window.mkComposer('first');
    window.mkComposer('second');
  });
  await page.click('#second-editor');
  await pressCtrlD();
  check('2つ: フォーカスのある入力欄のボタンを押す',
    (await count('second-dictate')) === 1 && (await count('first-dictate')) === 0, await clicks());
  await page.evaluate(() => document.activeElement.blur());
  await pressCtrlD();
  check('2つ: フォーカスが外れても、最後に使った入力欄のボタンを押す',
    (await count('second-dictate')) === 2 && (await count('first-dictate')) === 0, await clicks());
  check('2つ: 押したあと入力欄にフォーカスを戻す（Enter で送れる）',
    await page.evaluate(() => document.activeElement.id === 'second-editor'));

  // --- textarea の入力欄 ---
  await page.evaluate(() => {
    window.reset();
    window.mkComposer('ta', { textarea: true });
  });
  await page.click('#ta-editor');
  await pressCtrlD();
  check('textarea: 入力欄が textarea でも押す', (await count('ta-dictate')) === 1);

  // --- pointerdown で反応する部品 ---
  await page.evaluate(() => {
    window.reset();
    window.mkComposer('pd', { pointerdownOnly: true });
  });
  await page.click('#pd-editor');
  await pressCtrlD();
  check('pointerdown: pointerdown で動く部品も1回だけ押す',
    (await count('pd-dictate:pointerdown')) === 1 && (await count('pd-dictate:click')) === 0, await clicks());

  // --- 無効なボタン ---
  await page.evaluate(() => {
    window.reset();
    window.mkComposer('dis', { disabled: true });
  });
  await page.click('#dis-editor');
  await pressCtrlD();
  check('無効: 無効なボタンは押さない', (await count('dis-dictate')) === 0);
  check('無効: 押せないことを知らせる', (await toast()).includes('押せない'), await toast());

  // --- マイクボタンが無い Claude Code の画面: 困るボタンを押さない ---
  await page.evaluate(() => {
    window.reset();
    window.mkComposer('none', { noDictate: true, noVoiceMode: true, idleExtra: 'Stop' });
    window.mkDangerButtons();
  });
  await page.click('#none-editor');
  await pressCtrlD();
  const nothing = await clicks();
  check('無し: 停止・PR 作成・送信・idle-slot の「Stop」は押さない',
    Object.keys(nothing).length === 0, nothing);
  check('無し: 見つからないと知らせ、教える状態になる',
    (await toast()).includes('見つかりませんでした') && (await toast()).includes('クリックすると覚えます'), await toast());

  // 教える: 送信ボタンを押しても覚えない
  await page.evaluate(() => {
    const custom = document.createElement('button');
    custom.setAttribute('data-testid', 'custom-mic');
    custom.textContent = '🎤';
    document.getElementById('none').appendChild(custom);
  });
  await page.click('#stopResponse');
  check('教える: 「Stop response」は覚えない', (await toast()).includes('覚えません'), await toast());

  // 教える: 目印の無いマイクボタンをクリック → 覚える
  await page.click('[data-testid="custom-mic"]');
  check('教える: クリックしたボタンを覚えたと知らせる', (await toast()).includes('覚えました'), await toast());
  check('教える: クリックそのものは止めない', (await count('custom-mic')) === 1);
  check('教える: 覚えた目印を保存する', await page.evaluate(() =>
    JSON.parse(localStorage.getItem('tm-claude-dictation-shortcut-learned')).testId === 'custom-mic'));

  await page.click('#none-editor');
  await pressCtrlD();
  check('教える: 次から Ctrl+D で覚えたボタンを押す', (await count('custom-mic')) === 2, await clicks());

  // 再読み込みしても覚えている
  await page.reload();
  await page.evaluate(() => {
    window.mkComposer('none', { noDictate: true, noVoiceMode: true });
    const custom = document.createElement('button');
    custom.setAttribute('data-testid', 'custom-mic');
    custom.textContent = '🎤';
    document.getElementById('none').appendChild(custom);
  });
  await page.click('#none-editor');
  await pressCtrlD();
  check('教える: 再読み込みしても覚えている', (await count('custom-mic')) === 1, await clicks());

  // 忘れる
  await page.evaluate(() => window.__tmClaudeDictation.forget());
  await pressCtrlD();
  check('忘れる: forget() のあとは押さない', (await count('custom-mic')) === 1);
  await page.keyboard.press('Escape');
  check('教える: Esc でやめる', (await toast()).includes('やめました'), await toast());
  await page.click('[data-testid="custom-mic"]');
  check('教える: やめたあとのクリックは覚えない', await page.evaluate(() =>
    localStorage.getItem('tm-claude-dictation-shortcut-learned') === null));

  // Ctrl+Shift+D で覚え直す
  await page.evaluate(() => {
    window.reset();
    window.mkComposer('relearn');
  });
  await page.click('#relearn-editor');
  await page.keyboard.press('Control+Shift+KeyD');
  await page.waitForTimeout(30);
  check('覚え直し: Ctrl+Shift+D で教える状態になる', (await toast()).includes('クリックすると覚えます'), await toast());
  check('覚え直し: Ctrl+Shift+D ではボタンを押さない', (await count('relearn-dictate')) === 0);
  check('覚え直し: ページ側に Ctrl+Shift+D を渡さない', !(await page.evaluate(() =>
    window.pageKeys.includes('Ctrl+Shift+KeyD'))));
  await page.click('#relearn-dictate');
  check('覚え直し: クリックしたボタンを覚える', await page.evaluate(() =>
    JSON.parse(localStorage.getItem('tm-claude-dictation-shortcut-learned')).label === 'Dictate'));
  await page.evaluate(() => window.__tmClaudeDictation.forget());

  // --- 診断 ---
  await page.evaluate(() => {
    window.reset();
    window.mkComposer('diag');
  });
  await page.click('#diag-editor');
  const report = await page.evaluate(() => window.__tmClaudeDictation.dump());
  check('診断: 押す候補の先頭が音声入力ボタン（★）',
    report.candidates[0] && report.candidates[0]['押す'] === '★' && report.candidates[0]['ラベル'] === 'Dictate',
    report.candidates);
  check('診断: 入力欄のまわりのボタンと、外した理由を出す',
    report.nearby.some((row) => row['ラベル'] === 'Microphone' && row['判定'].includes('メニュー')) &&
    report.nearby.some((row) => row['ラベル'] === 'Use voice mode' && row['判定'].includes('押さない')),
    report.nearby);
  check('診断: 入力欄を出す', report.editor.includes('diag-editor'));

  check('エラーなし', errors.length === 0, errors);

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通過');
  process.exit(failed.length ? 1 : 0);
})();
