# YouTube 配信予定リスト について（ファイル: `youtube-upcoming-stream-list.user.js`）

YouTube の登録チャンネルページ（`https://www.youtube.com/feed/subscriptions`）の上部に、本日開始・配信中・今後のライブ配信（プレミア公開等を含む）を開始日時順にまとめたパネル（`#tm-upcoming-stream-list`）を表示する。

## 使い方

登録チャンネルページを開くと、動画グリッドの最上部にパネルが出る。設定は画面上のボタンから行う。

- **区分と表示順。** **「開始済み」「これから（今日）」「明日以降」** の 3 区分に分かれ、配信日時・チャンネル名・配信タイトルの 3 列で開始日時順に並ぶ。行をクリックすると該当動画へ移動する。
- **1 日の起点は「本日 5:00 JST」。** 深夜 0:00〜4:59 の間は前日の続きとみなし、前日 5:00 JST 以降に開始した配信を表示する。現在配信中のものは開始日時にかかわらず残る。
- **強調ワード。** 右上の「強調ワード」ボタンから改行区切りで文字列を入力すると、タイトルまたはチャンネル名に部分一致する行（大文字・小文字は区別しない）が強調表示される。入力内容は `localStorage`（`tm-upcoming-stream-list-highlight`）に保存される。
- **リストの折りたたみ。** 「リストを非表示 / リストを表示」ボタンで開閉でき、状態は `localStorage`（`tm-upcoming-stream-list-collapsed`）に保存される。両方のラベル幅の広い方にボタン幅を固定し、切り替えで横位置がずれないようにしている。

## 作りの要点

- **YouTube 内部 API による情報取得とキャッシュ。** フィード上の `ytd-rich-item-renderer` をすべて候補にし、`/youtubei/v1/player` へ最大 6 並列（`CONCURRENCY = 6`）で問い合わせて `liveBroadcastDetails.startTimestamp` を取得する。結果は `Map` にキャッシュし、通常動画や取得失敗（`isLiveContent: false`）は 5 分（`RETRY_MS`）後に再試行する。
- **前回リストの保持。** 取得したリストを `localStorage`（`tm-upcoming-stream-list-items`、最大 300 件）に保存し、次回ページを開いたときは API 取得が終わる前に現在の時刻で区分を引き直して暫定表示（「更新中…」表示）する。
- **現在配信中判定。** タイトル文中の「LIVE」「配信中」には頼らず、サムネイルのオーバーレイ属性（`[overlay-style="LIVE"], [data-style="LIVE"]`）およびバッジ要素のテキストのみで判定する。
- **DOM 操作と SPA 追従。** Trusted Types 対策として `innerHTML` を使わず、`document.createElement`・`textContent`・`replaceChildren` で組み立てる。配色は YouTube 側の CSS 変数を使いダークモードに自動対応する。パネル本体と強調ワード入力欄は一度だけ組み立てて中身だけ差し替えるため、再描画で入力中のフォーカスが失われない。`yt-navigate-finish`・`MutationObserver`・1 分ごとの区分更新タイマー（`SECTION_TICK_MS`）で追従し、登録チャンネル以外のページへ移動したらパネルを削除する。

## 検証

```bash
node --check youtube-upcoming-stream-list.user.js
NODE_PATH=$(npm root -g) node test/youtube-upcoming-stream-list.test.js
```

`youtubei/v1/player` をモックした模擬 DOM で、通常動画の除外と 3 件表示、「開始済み / これから（今日）/ 明日以降」の区切り、開始日時順の並び替え、`localStorage` へのリスト保存、改行区切り複数ワードでの部分一致強調、再訪問時の保持リスト先行表示（「更新中」表示・区切り引き直し・強調ワード復元）、表示/非表示ボタンの切り替えで位置がずれないことを確認する。実機（YouTube 本体）の DOM そのものではないため、テスト通過は実機動作を保証しない。
