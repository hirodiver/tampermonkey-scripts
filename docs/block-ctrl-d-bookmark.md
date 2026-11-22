# Ctrl+D ブックマーク無効 について（ファイル: `block-ctrl-d-bookmark.user.js`）

Chrome で Ctrl+D を押したときの「ブックマークに追加」を止める。全サイトが対象。

- 止めるのはキーの既定動作だけ（`preventDefault`）。サイト側のキー処理には渡すので、
  サイトが Ctrl+D に割り当てた働きは残る
- 日本語の変換中も止める。埋め込みの枠（iframe）の中にカーソルがあるときも止める（`@noframes` を付けない）
- Ctrl+Shift+D（すべてのタブをブックマーク）など、ほかのキーは触らない
- claude.ai では「Claude 音声入力キー」が Ctrl+D で音声入力を始める。両方入れても動きはぶつからない
- **止められないページ**：新しいタブ、`chrome://` のページ、Chrome ウェブストア、PDF ビューア。
  ユーザースクリプトが動かないため、ここでは Ctrl+D でブックマークに追加される
- ブックマークに追加したいときは、アドレスバー右の☆を押す

## 診断

止まらないときは、DevTools のコンソールで `__tmBlockCtrlD.dump()` を実行する。
スクリプトが動いているか、打ち消した回数と最後の時刻が `console.table` で出る。

## 検証

```
node --check block-ctrl-d-bookmark.user.js
NODE_PATH=$(npm root -g) node test/block-ctrl-d-bookmark.test.js
```

入力欄・contenteditable・何も選んでいない状態・同じページの iframe で Ctrl+D を押し、
既定動作が打ち消されること、サイト側のキー処理には届くこと、Ctrl+Shift+D・Ctrl+S・Ctrl+Alt+D と
普通の打鍵は素通しすること、変換中も打ち消すことを確かめる（14項目）。
ヘッドレスではブックマークの画面そのものは出ないので、画面が出ないことは Chrome の実機で確かめる。
