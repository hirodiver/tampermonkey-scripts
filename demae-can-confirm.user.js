// ==UserScript==
// @name         出前館 - 到着時刻確認オートクリック
// @namespace    local.hiro.tools
// @version      1.0.0
// @description  カートで「注文を完了する」を押した後に出る「お届け時間に変更があります」確認モーダルの「注文を完了する」ボタンを自動でクリックする
// @author       hirodiver
// @match        https://demae-can.com/*
// @match        https://*.demae-can.com/*
// @run-at       document-idle
// @grant        none
// @homepageURL  https://github.com/hirodiver/tampermonkey-scripts
// @supportURL   https://github.com/hirodiver/tampermonkey-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/demae-can-confirm.user.js
// @updateURL    https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/demae-can-confirm.user.js
// ==/UserScript==

// -----------------------------------------------------------------------------
// 対象: カートで最初の「注文を完了する」を押した後、混雑等で到着時刻が変わった場合に
// 出る「お届け時間に変更があります」確認モーダル。このモーダルの中の「注文を完了する」
// ボタンを押さないと注文が確定しない仕様のため、自動でクリックして進める。
//
// 誤爆防止のため、単に「注文を完了する」というテキストのボタンならなんでも押すのではなく、
// そのボタンの祖先に「お届け時間」「変更」を含む見出しがある場合のみ自動クリックする。
// カート画面本体の（ユーザーが手動で押すべき）最初の「注文を完了する」ボタンには
// この見出しが存在しないため、誤って自動クリックされることはない。
// -----------------------------------------------------------------------------

(function () {
  'use strict';

  const CONFIRM_BUTTON_TEXT = '注文を完了する';
  const CONFIRM_TITLE_PATTERN = /お届け時間.*変更/;
  const CLICK_DELAY_MS = 500;
  const ANCESTOR_SEARCH_DEPTH = 8;

  const processedButtons = new WeakSet();

  function isVisible(el) {
    return !!(el.offsetParent || el.getClientRects().length);
  }

  function isInsideChangeModal(button) {
    let node = button;
    for (let i = 0; i < ANCESTOR_SEARCH_DEPTH && node; i++) {
      const text = node.textContent;
      if (text && CONFIRM_TITLE_PATTERN.test(text)) {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  function collectCandidateButtons(root) {
    const buttons = [];
    if (root.matches && root.matches('button, [role="button"], a')) {
      buttons.push(root);
    }
    if (root.querySelectorAll) {
      root.querySelectorAll('button, [role="button"], a').forEach((el) => buttons.push(el));
    }
    return buttons;
  }

  function tryAutoConfirm(root) {
    if (!(root instanceof Element)) return;

    for (const button of collectCandidateButtons(root)) {
      if (processedButtons.has(button)) continue;
      if (button.textContent?.trim() !== CONFIRM_BUTTON_TEXT) continue;
      if (!isVisible(button)) continue;
      if (!isInsideChangeModal(button)) continue;

      processedButtons.add(button);
      setTimeout(() => {
        if (isVisible(button)) {
          button.click();
        }
      }, CLICK_DELAY_MS);
    }
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        tryAutoConfirm(node);
      }
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  tryAutoConfirm(document.documentElement);
})();
