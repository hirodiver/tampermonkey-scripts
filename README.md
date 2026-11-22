# tampermonkey-scripts

hirodiver 用の Tampermonkey ユーザースクリプト置き場。

## スクリプト一覧

| ファイル | 名前 | 対象 |
|---|---|---|
| `x-youtube-card-open-in-browser.user.js` | [X YouTube Card](docs/x-youtube-card-open-in-browser.md) | x.com / twitter.com |
| `x-status-page-auto-reload.user.js` | [X Status Auto Reload](docs/x-status-page-auto-reload.md) | x.com / twitter.com |
| `x-following-tab.user.js` | [X フォロー中固定](docs/x-following-tab-and-note-notice.md) | x.com / twitter.com |
| `x-hide-note-notice.user.js` | [X ノート通知非表示](docs/x-following-tab-and-note-notice.md) | x.com / twitter.com |
| `x-hide-spaces-bar.user.js` | [X スペース帯非表示](docs/x-hide-spaces-bar.md) | x.com / twitter.com |
| `x-bottom-bar-opaque.user.js` | X 下部メニュー不透明化 | x.com / twitter.com |
| `x-account-switcher.user.js` | [X アカウント切替](docs/x-account-switcher.md) | x.com / twitter.com |
| `x-tab-account.user.js` | [X タブ別アカウント](docs/x-tab-account.md) | x.com / twitter.com |
| `x-hex-decode.user.js` | [X 16進デコード](docs/x-hex-decode.md) | x.com / twitter.com |
| `youtube-full-dates-jst.user.js` | [YouTube Full Dates (JST)](docs/youtube-full-dates-jst.md) | www.youtube.com |
| `youtube-upcoming-stream-list.user.js` | YouTube 配信予定リスト | www.youtube.com |
| `youtube-hide-chat-users.user.js` | [YouTube チャット非表示](docs/youtube-hide-chat-users.md) | www.youtube.com/live_chat |
| `youtube-chat-highlight.user.js` | [YouTube チャット強調](docs/youtube-chat-highlight.md) | www.youtube.com/live_chat |
| `youtube-chat-input-toggle.user.js` | [YouTube チャット入力欄切替](docs/youtube-chat-input-toggle.md) | www.youtube.com/live_chat |
| `youtube-watch-chat-fit.user.js` | [YouTube チャット高さ調整](docs/youtube-watch-chat-fit.md) | www.youtube.com（再生ページ） |
| `youtube-volume-boost.user.js` | [YouTube 音量ブースト](docs/youtube-volume-boost.md) | www.youtube.com |
| `twitch-volume-boost.user.js` | [Twitch Volume Boost](docs/twitch-volume-boost.md) | www.twitch.tv |
| `youtube-watch-later-clear.user.js` | [YouTube 後で見る一括削除](docs/youtube-watch-later-clear.md) | www.youtube.com/playlist?list=WL |
| `demae-can-confirm.user.js` | [出前館 到着確認](docs/demae-can-confirm.md) | demae-can.com |
| `tenbin-ai-biz-terms-expand-all.user.js` | [天秤AI 約款一括展開](docs/tenbin-ai-biz-terms-expand-all.md) | biz.tenbin.ai/trust |
| `page-to-markdown.user.js` | [ページ本文コピー](docs/page-to-markdown.md) | 全サイト |
| `claude-dictation-shortcut.user.js` | [Claude 音声入力キー](docs/claude-dictation-shortcut.md) | claude.ai（Claude Code on the web） |
| `google-hide-ai-overview.user.js` | [Google AI概要非表示](docs/google-hide-ai-overview.md) | www.google.com / www.google.co.jp の検索結果 |
| `block-ctrl-d-bookmark.user.js` | [Ctrl+D ブックマーク無効](docs/block-ctrl-d-bookmark.md) | 全サイト |

各スクリプトの使い方・作りの要点・診断・検証の手順は、名前のリンク先（`docs/<ファイル名>.md`）にある。
スクリプトを直したら、README ではなくそのファイルを更新する。

**`@name` は短く、末尾に `@version` と同じ値を付ける。** Tampermonkeyの一覧画面は
名前が長いと省略され、バージョンも一覧には出ない（個別のスクリプト詳細画面を
開く必要がある）ため、`@name` の末尾に ` vX.Y.Z` の形で `@version` と同じ値を
付記し、一覧からでもバージョンが分かるようにする（例: `X YouTube Card v3.9.1`）。
`@version` を上げたら、その値に合わせて `@name` 末尾のバージョン表記も必ず更新すること。

**機能を巻き戻すときも `@version` は必ず前へ進める。** Tampermonkeyはバージョンが
上がったときだけ更新するため、番号を元に戻すと自動更新でダウングレードが配信されない。
例: v3.10.0の機能を取り消してv3.9.1の状態に戻す場合、番号は3.9.1ではなく
**3.10.1**（直前より大きい値）にする。中身がどの版相当かは `@version` ではなく
仕様書の変更履歴（X YouTube Card なら [`docs/x-youtube-card-open-in-browser.spec.md`](docs/x-youtube-card-open-in-browser.spec.md)）で示す。
基本の名前部分は2〜4単語（日本語なら10文字前後）まで。詳細な説明は `@description` に書く。

## インストール

Tampermonkey で以下の raw URL を開くとインストールできる（以後は自動更新される）。

- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-youtube-card-open-in-browser.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-status-page-auto-reload.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-following-tab.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-hide-note-notice.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-hide-spaces-bar.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-bottom-bar-opaque.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-account-switcher.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-tab-account.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-hex-decode.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/youtube-full-dates-jst.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/youtube-upcoming-stream-list.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/youtube-hide-chat-users.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/youtube-chat-highlight.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/youtube-chat-input-toggle.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/youtube-watch-chat-fit.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/youtube-volume-boost.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/twitch-volume-boost.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/youtube-watch-later-clear.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/demae-can-confirm.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/tenbin-ai-biz-terms-expand-all.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/page-to-markdown.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/claude-dictation-shortcut.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/google-hide-ai-overview.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/block-ctrl-d-bookmark.user.js

### 新しいスクリプトを入れるとき

上の URL は **`main` に入ってから**でないと開けない（開くと「404: Not Found」になる）。
作ったばかりのスクリプトは、まず作業ブランチにだけある。

**`main` にマージ済みなら（いつもの入れ方）**

1. マージから数分待つ（配信側のキャッシュのため。下の「自動更新の仕組み」参照）
2. Tampermonkey を入れたブラウザ（Safari など）で、上の一覧の URL を開く
3. インストール画面が出たら「インストール」を押す
4. 対象のページを開いて動くか確かめる（ページが開いたままなら再読み込みする）

**まだ作業ブランチにしかないとき（先に試したい場合）**

URL の `main` の部分を作業ブランチ名に置き換えて開けば、同じ手順で入れられる。

```
https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/<ブランチ名>/<ファイル名>
```

この方法で入れても、以後の更新は `main` から届く（スクリプト内の `@updateURL` が
`main` を指しているため）。マージ前は更新の確認が空振りするだけで害はない。

**作業した側（Claude）へ**: 新しいスクリプトを作ったら、報告の最後に
**インストール用の URL と、それがいま開けるか（`main` に入っているか）**を必ず書くこと。

## 自動更新の仕組み

各スクリプトの `@updateURL` / `@downloadURL` は上記 raw URL（`main` ブランチ）を指している。
Tampermonkey は定期的に `@updateURL` を取得し、`@version` が手元より新しければ更新する。

**更新を配信するときのルール**

1. スクリプトを編集する
2. **必ず `@version` を上げる**（上げないと配信されない）
3. `main` ブランチに反映する

`main` に入っていない変更は配信されない。作業ブランチにコミットしただけでは反映されないので注意。

**push した直後は届かない。理由が2つある。**

1. Tampermonkey の定期チェックは既定でおおむね1日1回。すぐ反映したいなら
   ダッシュボードの**「更新を確認」を手動実行する**
2. `raw.githubusercontent.com` は `cache-control: max-age=300` で配信され、
   **キャッシュは CDN の POP ごとに独立**している。push 直後は端末の近くの POP が
   まだ旧版を返しうるため、**手動実行しても「更新なし」と判定される**

Tampermonkey は取得した中身の `@version` が同じなら、エラーを出さず黙って何もしない。
**push から数分おいてから「更新を確認」を実行すること。**

**待たずに済ませるには**、配布URLを Safari で開き、インストール画面が出たら
**インストールせずに閉じる**。端末が新しいファイルを取り直すので、
直後の「更新を確認」が通る（実測で確認済み）。

なお、開発環境から `curl` で配信URLを叩いて 200 と新バージョンを確認しても、
**それは実機に届くことの証明にならない**（別の POP を見ているため）。

**`@name` だけを変更した場合について**

`@namespace` が同じままなら、`@name` を変更しても同一スクリプトとして扱われ、
通常の「更新を確認」でそのまま新しい名前に切り替わる（実測で確認済み、2026-09）。
別スクリプトとして登録されるのは、下記の YouTube Full Dates (JST) のように
`@namespace` ごと変えた場合。

## 注意

公開リポジトリなので、**秘密にすべき情報は置かないこと**。
