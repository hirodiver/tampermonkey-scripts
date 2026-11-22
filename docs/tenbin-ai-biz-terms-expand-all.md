# 天秤AI 約款一括展開 について（ファイル: `tenbin-ai-biz-terms-expand-all.user.js`）

天秤AI Biz の「主要AI約款比較」ページ（`https://biz.tenbin.ai/trust`）で、
1件ずつクリックしないと開けないアコーディオン（`.detail-card`）をページ読み込み時に
自動で全部開く。右下に「全部開く」「全部閉じる」ボタンも置く。

- 各項目の見出し（`.detail-card-header`）には `onclick="toggleAcc(this.parentElement)"`
  というページ側のインラインハンドラが付いている。本スクリプトはこの関数を直接
  呼ぶのではなく、見出し要素へ `click()` を発行するだけ。inline の `onclick` は
  ページの realm で定義されているため、isolated world から `click()` するだけで
  正しく実行される（`@inject-into page` は不要）
- 既に開いている項目（`.detail-card.open`）をクリックすると閉じてしまうため、
  `open` クラスの有無を見てから、閉じている項目だけを操作する
- 一覧がJSで後から生成される可能性を考慮し、`MutationObserver` で監視して
  カードが出そろってから自動展開する。一度自動展開したら監視は止める
  （手動で閉じた項目を勝手に開き直さないため）
- ページのDOM構造（`.detail-card` / `.detail-card-header` / `open` クラス）が
  変わると効かなくなる可能性がある
