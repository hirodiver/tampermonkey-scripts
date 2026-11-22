# Gemini 音声入力キー について（ファイル: `gemini-dictation-shortcut.user.js`）

Gemini（`gemini.google.com`）の音声入力を **Ctrl+D** で開始・停止する（Chrome で使う想定）。
Gemini 標準の音声入力キーは Ctrl+Shift+D。Claude で使っている Ctrl+D
（[Claude 音声入力キー](claude-dictation-shortcut.md)）と手の動きをそろえるために作った。
最初の版は Gemini に書いてもらい、このリポジトリの書き方に合わせて直した。

## 使い方

1. Gemini の画面で **Ctrl+D** を押すと、入力欄のマイクボタンを押したのと同じになる
2. 話し終えたら、もう一度 **Ctrl+D** でマイクボタンをもう一度押す（＝止まる）
3. マイクボタンが見つからないときは、Gemini 標準の Ctrl+Shift+D をページに送り、
   画面下に「マイクボタンが見つかりません」と出す
4. gemini.google.com の中では、Chrome の Ctrl+D（ブックマークに追加）は効かなくなる。
   キーを変えたいときは、スクリプト先頭の `SHORTCUT` を書き換える
5. 押したときにも知らせを出したいときは、`SHOW_PRESS_TOAST` を `true` にする

## 作りの要点

- **探し方**（上から順に強い）: 音声入力の部品（`speech-dictation-mic-button` などの中のボタン）→
  ラベル（`aria-label` 等）が「音声入力」「マイク」「録音」「Use microphone」など →
  直前に Ctrl+D で押したボタン（録音中にラベルが変わっても止められるように）→
  マイクの絵（`mat-icon` の `mic` / `mic_none` / `mic_off`）のボタン
- **押さないもの**: サイドバー（`bard-sidenav`・`nav` など）の中のボタン。チャット履歴のタイトルに
  「音声入力」とあっても、そのメニューは押さない。ほかに Gemini Live（声で会話する別機能）・
  回答の停止・送信も押さない
- セレクタとラベルは、Gemini の画面構造の公開された説明が無いため推測を含む。外れたら下の診断で確かめる
- **見つからないときの Ctrl+Shift+D** は作ったキーイベント（`isTrusted` が `false`）なので、
  Gemini が受け付けるかは未確認
- **キー**: `window` のキャプチャで先に受け取り、`preventDefault` と `stopImmediatePropagation` で
  ページと Chrome のブックマークに渡さない。日本語の変換中は打ち消すだけで押さない。
  押しっぱなしの連打では1回だけ押す。Ctrl+Shift+D など、ほかのキーは触らない
- [Ctrl+D ブックマーク無効](block-ctrl-d-bookmark.md) と両方入れても動きはぶつからない

## 診断

効かないときは、DevTools のコンソールで `__tmGeminiDictation.dump()` を実行する。
押す候補（★が押すボタン）と、外したボタンとその理由が `console.table` で出る。
`__tmGeminiDictation.press()` で Ctrl+D と同じ動きを1回試せる。

## 検証

```
node --check gemini-dictation-shortcut.user.js
NODE_PATH=$(npm root -g) node test/gemini-dictation-shortcut.test.js
```

模擬DOMで、音声入力の部品・`aria-label`・マイクの絵の3つの形のボタンを押せること、
サイドバーの「音声入力」・Gemini Live・回答の停止を押さないこと、もう一度押すと止める側を押すこと、
押しっぱなしで1回だけ押すこと、変換中は押さないこと、Ctrl+Shift+D などを素通しすること、
見つからないときに Ctrl+Shift+D を送って知らせを出すことを確かめる（19項目）。
実機の Gemini で効くかは Chrome で確かめる。
