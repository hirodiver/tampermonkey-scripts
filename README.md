# tampermonkey-scripts

hirodiver 用の Tampermonkey ユーザースクリプト置き場。

## スクリプト一覧

| ファイル | 名前 | 対象 |
|---|---|---|
| `x-youtube-card-open-in-browser.user.js` | X YouTube Card | x.com / twitter.com |
| `x-status-page-auto-reload.user.js` | X Status Auto Reload | x.com / twitter.com |
| `x-following-tab.user.js` | X フォロー中固定 | x.com / twitter.com |
| `x-hide-note-notice.user.js` | X ノート通知非表示 | x.com / twitter.com |
| `youtube-full-dates-jst.user.js` | YouTube Full Dates (JST) | www.youtube.com |
| `youtube-upcoming-stream-list.user.js` | YouTube 配信予定リスト | www.youtube.com |
| `demae-can-confirm.user.js` | 出前館 到着確認 | demae-can.com |

**`@name` は短く、末尾に `@version` と同じ値を付ける。** Tampermonkeyの一覧画面は
名前が長いと省略され、バージョンも一覧には出ない（個別のスクリプト詳細画面を
開く必要がある）ため、`@name` の末尾に ` vX.Y.Z` の形で `@version` と同じ値を
付記し、一覧からでもバージョンが分かるようにする（例: `X YouTube Card v3.9.1`）。
`@version` を上げたら、その値に合わせて `@name` 末尾のバージョン表記も必ず更新すること。
基本の名前部分は2〜4単語（日本語なら10文字前後）まで。詳細な説明は `@description` に書く。

## インストール

Tampermonkey で以下の raw URL を開くとインストールできる（以後は自動更新される）。

- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-youtube-card-open-in-browser.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-status-page-auto-reload.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-following-tab.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-hide-note-notice.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/youtube-full-dates-jst.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/youtube-upcoming-stream-list.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/demae-can-confirm.user.js

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

## YouTube Full Dates (JST) について

Greasy Fork の "YouTube Full Dates (v3)" (script id 564941) を元にした**独立フォーク**。
`@name` / `@namespace` / 更新URL をすべて差し替えているため、本家の更新は反映されない。

Tampermonkey はスクリプトを `@namespace` + `@name` で識別するため、本フォークは本家とは別スクリプトとして登録される。
本家を入れている場合は**本家を削除**すること（両方動くと日付を二重に書き換えて競合する）。
設定値（`GM_setValue`）もスクリプト単位で分かれるため、フォーク側では初期設定からやり直しになる。

## X YouTube Card の設計上の要点

詳細は [`SPEC.md`](SPEC.md) にあるが、壊しやすい箇所を挙げておく。

- **`@inject-into page` は必須**。React の `__reactProps$` / `__reactFiber$` は
  isolated world から参照できず、URL解決の主要経路が死ぬ
- **`@connect` はリダイレクト先も宣言する**。`publish.twitter.com` は
  `publish.x.com` へ飛ぶため、両方ないと遮断される
- ボタンが一切出なくなったら、まず `[data-testid="card.wrapper"]` の変更を疑う

### 検証

編集したら、コミット前に自動検証を通すこと。

```
node --check x-youtube-card-open-in-browser.user.js
NODE_PATH=$(npm root -g) node test/x-youtube-card.test.js
```

ヘッドレスChromium上でXのカード構造を模したDOMにスクリプトを流し込み、検出・URL解決・ボタン設置を確認する（50項目、Playwright が必要）。
ただしXの実DOMやiOSのUniversal Linkの挙動は再現していないため、**実機確認の代わりにはならない**。

## X Status Auto Reload について（ファイル: `x-status-page-auto-reload.user.js`）

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

## X フォロー中固定 / X ノート通知非表示 について

Control Panel for Twitter のうち常用する機能だけを、**機能ごとに独立したスクリプト**として
実装したもの。CfT は多機能な分、X 側の変更で壊れたときに原因箇所を特定しづらい。

**あえて1ファイルにまとめていない理由**

Tampermonkey のダッシュボードから、コードを触らずに機能単位でオン・オフできるようにするため。
スクリプト内の定数で切り替える方式だと、切り替えのたびにエディタを開く必要があるうえ、
次の自動更新で書き戻されてしまう。2つは処理の中身（タブ操作 / セル走査）が全く別なので、
分割によるコード重複もほとんど生じない。

なお**広告の非表示は別の拡張機能に任せているため、ここには実装していない**。

### X フォロー中固定（`x-following-tab.user.js`）

ホームの「おすすめ」タブ（英語UIでは `For you`）を隠し、選択されていれば「フォロー中」タブを
自動クリックする。

- 「フォロー中」タブが見つからないときは、おすすめタブを隠さない。タブ構成が変わったときに
  どちらも見られなくなるのを防ぐため
- 自動クリックは `TAB_CLICK_INTERVAL`（既定1.5秒）のクールダウン付き。X 側の再描画と競合して
  連打になるのを防ぐ
- ラベルが変わったら冒頭の `FOR_YOU_LABELS` / `FOLLOWING_LABELS` を直す。判定時に空白は
  除去するが、大文字小文字は区別する

### X ノート通知非表示（`x-hide-note-notice.user.js`）

通知タブのコミュニティノート関連の通知を隠す。

- 非表示は要素の削除ではなく `display:none`。誤爆時に DevTools で元要素を確認できる
- X はスクロール時に `cellInnerDiv` を別の通知へ使い回す。そのため毎回すべてのセルを
  判定し直し、条件から外れた要素は表示に戻す（隠しっぱなしにしない）
- 判定文字列は冒頭の `COMMUNITY_NOTE_KEYWORDS` にある（部分一致）

### 共通の作り

X には YouTube の `yt-navigate-finish` に相当する遷移イベントが無い。`pushState` /
`replaceState` をラップする手もあるが、**iOS の Tampermonkey はスクリプトを
isolated world で実行するため、書き換えた `history` はページ側の呼び出しを捕捉できない**。
そのため history には触らず、`MutationObserver` のコールバックの中で
`location.pathname` の変化を見ている（`locationChanged()`）。実行環境に依存しない。

### 使い分け（2026-09 時点）

| 環境 | 構成 |
|---|---|
| デスクトップ Chrome | Control Panel for Twitter を使う |
| iOS Safari | CfT はオフ。`x-following-tab.user.js` を使う |

デスクトップの X は余計な表示が多く、CfT の恩恵が大きいのでそのまま使う。
iOS の X は元々表示がシンプルで CfT の利点が薄いうえ、挙動が不安定なため、
必要な機能だけの軽いスクリプトに置き換える。

**CfT とスクリプトを同じ環境で同時に有効にしないこと。** どちらもタブを操作するため競合する。

## 出前館 到着確認 について（ファイル: `demae-can-confirm.user.js`）

カートで「注文を完了する」を押した後、混雑等で到着時刻が変わった場合にのみ出る
「お届け時間に変更があります」確認モーダル内の「注文を完了する」ボタンを自動でクリックする。

- 見出しに「お届け時間」「変更」を含むモーダル内のボタンだけを対象にしており、
  カート画面本体にある（ユーザーが手動で押すべき）最初の「注文を完了する」ボタンは対象外
- 出前館側のDOM構造（クラス名・文言）が変わると効かなくなる可能性がある。
  効かなくなった場合はモーダルの見出し文言が変わっていないか確認すること

## 注意

公開リポジトリなので、**秘密にすべき情報は置かないこと**。
