# X Status Auto Reload について（ファイル: `x-status-page-auto-reload.user.js`）

タイムラインから個別ポストへ遷移した際、Control Panel for Twitter 等の拡張との競合で
SPA内遷移が固まり、いつまでも読み込まれないことがある（フルリロードすれば直る）。
このスクリプトは、個別ポストのURL（`/status/数字`）に遷移してから一定時間ツイート本文が
表示されなければ自動で `location.reload()` を発行する。無限リロードを避けるため、
同一URLへの自動更新は1回のみ（`sessionStorage` で記録、タブを閉じるとリセット）。

判定は2段階。`MutationObserver` で画面のDOM変化を監視し、

- `NO_ACTIVITY_TIMEOUT_MS`（既定0.7秒）: 画面が完全に無反応（＝完全に固まっている）
  ならここで早期にリロード
- `STUCK_TIMEOUT_MS`（既定2.5秒）: DOMは動いている（＝読み込み中の兆候はある）が
  本文が出てこない場合の最終判定

体感で誤発火・遅発火する場合は、スクリプト冒頭のこの2つの定数を調整すること。

## documentElement がまだ無い時点で走ったとき（v1.2.2）

実行環境によっては、`document-start` のスクリプトが `document.documentElement` がまだ null の時点で走る。
v1.2.1 までは `observe(document.documentElement)` が TypeError になり、直接開いた個別ポストを
監視していなかった。v1.2.2 からは、そのときは `document` の直下を見て、documentElement ができてから
監視を始める。documentElement ができたことは「読み込み中の兆候あり」とみなし、早期の再読み込みはしない。
