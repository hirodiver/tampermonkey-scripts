# tampermonkey-scripts

hirodiver 用の Tampermonkey ユーザースクリプト置き場。

## スクリプト一覧

| ファイル | 名前 | 対象 |
|---|---|---|
| `x-youtube-card-open-in-browser.user.js` | X YouTube Card | x.com / twitter.com |
| `x-status-page-auto-reload.user.js` | X Status Auto Reload | x.com / twitter.com |
| `x-following-tab.user.js` | X フォロー中固定 | x.com / twitter.com |
| `x-hide-note-notice.user.js` | X ノート通知非表示 | x.com / twitter.com |
| `x-hide-spaces-bar.user.js` | X スペース帯非表示 | x.com / twitter.com |
| `x-bottom-bar-opaque.user.js` | X 下部メニュー不透明化 | x.com / twitter.com |
| `youtube-full-dates-jst.user.js` | YouTube Full Dates (JST) | www.youtube.com |
| `youtube-upcoming-stream-list.user.js` | YouTube 配信予定リスト | www.youtube.com |
| `youtube-hide-chat-users.user.js` | YouTube チャット非表示 | www.youtube.com/live_chat |
| `demae-can-confirm.user.js` | 出前館 到着確認 | demae-can.com |
| `tenbin-ai-biz-terms-expand-all.user.js` | 天秤AI 約款一括展開 | biz.tenbin.ai/trust |

**`@name` は短く、末尾に `@version` と同じ値を付ける。** Tampermonkeyの一覧画面は
名前が長いと省略され、バージョンも一覧には出ない（個別のスクリプト詳細画面を
開く必要がある）ため、`@name` の末尾に ` vX.Y.Z` の形で `@version` と同じ値を
付記し、一覧からでもバージョンが分かるようにする（例: `X YouTube Card v3.9.1`）。
`@version` を上げたら、その値に合わせて `@name` 末尾のバージョン表記も必ず更新すること。

**機能を巻き戻すときも `@version` は必ず前へ進める。** Tampermonkeyはバージョンが
上がったときだけ更新するため、番号を元に戻すと自動更新でダウングレードが配信されない。
例: v3.10.0の機能を取り消してv3.9.1の状態に戻す場合、番号は3.9.1ではなく
**3.10.1**（直前より大きい値）にする。中身がどの版相当かは `@version` ではなく
SPECの変更履歴で示す。
基本の名前部分は2〜4単語（日本語なら10文字前後）まで。詳細な説明は `@description` に書く。

## インストール

Tampermonkey で以下の raw URL を開くとインストールできる（以後は自動更新される）。

- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-youtube-card-open-in-browser.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-status-page-auto-reload.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-following-tab.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-hide-note-notice.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-hide-spaces-bar.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-bottom-bar-opaque.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/youtube-full-dates-jst.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/youtube-upcoming-stream-list.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/youtube-hide-chat-users.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/demae-can-confirm.user.js
- https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/tenbin-ai-biz-terms-expand-all.user.js

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

## YouTube チャット非表示 について（ファイル: `youtube-hide-chat-users.user.js`）

ライブチャットで、特定のユーザーの発言を**自分の画面からだけ**消す。
YouTube の「ユーザーをブロック」と違い YouTube 側へは何も送らないため
**相手には一切分からない**し、相手側の表示も変わらない。

### 使い方

1. 消したい発言にカーソルを載せると、右上に **「けす」** ボタンが出る。
   押すと、その人の発言は**名前を残して本文だけ**消える（本文の位置には「（非表示）」が入る）。
   誰が喋ったかは分かるので、会話の流れは追える。
   消した後は同じ場所のボタンが **「もどす」** に変わり、押すと登録が解除されて元に戻る
   （ラベルは v1.8 で「発言を消す」/「発言を戻す」から短い「けす」/「もどす」にした）
2. 画面右上（チャット上部の見出し帯のすぐ下）の「非表示リスト」ボタンでパネルが開く。
   各行に次のボタンがある
   - **「まるごと消す」**: 押すとオン（赤く反転）になり、その人の発言を**名前ごと**消す。
     もう一度押すとオフに戻り、名前を残す消し方に戻る。
     名前ごと消す操作は**ここからしかできない**（うっかり押して完全に見えなくなるのを避けるため）
   - **「解除」**: 登録を取り消し、発言がまた見えるようにする

   パネル上部の「一時的に表示する」で全員を一時的に表示できる（保存しない。タブを閉じると戻る）

   （言い回しと操作は版によって変わっている。v1.0〜v1.5 は発言に2つのボタンがあり、
   どちらの消し方も選べたが、v1.6 で「基本は名前を残して本文を消す」に絞った）

### 作りの要点

- チャットは watch ページ内の iframe（`/live_chat`）。`@match` は `live_chat*` /
  `live_chat_replay*` のみで、watch ページ本体には入れていない。ポップアウトした
  チャットも同じURLなのでそのまま動く
- 判定は**チャンネルID**（`author-external-channel-id`）優先。表示名は変えられる
  ため。属性を持たない上部ティッカーは Polymer の `__data` を浅く掘って探し、
  それも取れない相手は表示名（小文字化・完全一致）で判定する
- 消す対象は通常の発言・スーパーチャット・スーパーステッカー・メンバー加入・
  メンバーギフト、および上部に流れるティッカーの各要素
- **「けす」は本文（`#message`）とステッカー画像（`#sticker`）だけを消す**。
  名前・アイコン・金額は残す。ティッカーは本文を持たない（名前と金額だけ）ため、
  このときは触らず、「まるごと消す」がオンのときだけ消す
- v1.0 で保存した設定には消し方の区別が無い。読み込み時に「まるごと消す」オンとして扱う
  （当時の挙動）
- 表示ラベルが版によって変わっても、内部の保存形式（`mode: 'all' | 'text'`）と
  CSSクラス名は変えていない。過去に登録した設定やボタンの位置は引き継がれる
- 非表示は削除ではなく `display:none`。チャットは要素を使い回すため、毎回すべて
  判定し直し、条件から外れた要素は表示へ戻す
- 設定は `localStorage`（キー `tm-yt-chat-hide-users`）。`storage` イベントを
  見ているので、ポップアウト側で追加した分は埋め込み側にも即反映される
- 「非表示リスト」ボタンの縦位置は固定値ではなく、**見出し帯
  （`yt-live-chat-header-renderer` / `#chat-header`）の下端を毎回実測**して決める。
  帯の高さは配信ごとに変わる（メンバー章の行が増える等）ため。帯が見つからない
  ときだけ `OPEN_FALLBACK_TOP`（既定56px）を使う
- **測る対象にチャット全体を包む器を入れないこと。** v1.2 では
  `yt-live-chat-banner-manager` を含めていたため、その下端（＝画面最下部）が
  採用され、ボタンが入力欄の上へ落ちた。歯止めとして `HEADER_MAX_RATIO`
  （画面の4割より高い要素は帯と見なさない）と `OPEN_MAX_RATIO`
  （画面の3割より下へは置かない）を入れてある
- **効かないときは**、コンソールで `__tmChatHide.dump()` を実行すると、発言ごとに
  取得できたチャンネルID・表示名・消し方・非表示かどうかが出る。
  `__tmChatHide.add('UCxxxx', '', 'all')` でチャンネルIDを直接登録することもできる

### 検証

```
node --check youtube-hide-chat-users.user.js
NODE_PATH=$(npm root -g) node test/youtube-hide-chat-users.test.js
```

チャット欄の構造を模したDOMで43項目（対象だけ消える／新着・スパチャ・ティッカー／
「けす」で名前が残り本文が消える／パネルの「まるごと消す」のオン・オフ／同じボタンで「もどす」／表示名での指定／
一時解除／ボタンが見出し帯より下に出る・帯の高さに追従する・背の高い器や異常な
高さに引きずられて下へ落ちない／ラベルの言い回し／パネルからの解除／
再読み込み後の保持）を確認する。

Xの実DOMやチャットの実際の描画とは異なるため、**実機確認の代わりにはならない**。

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

## X スペース帯非表示 について（ファイル: `x-hide-spaces-bar.user.js`）

タブの下に出る音声スペースの帯（紫のピル）を隠す。

### 帯の正体（iPhone 実機の診断で確認）

```
nav > div > div[ScrollSnap-SwipeableList] > div[ScrollSnap-List]
    > div[placementTracking] > button > div > div[pill-contents-container]
      「+23・ライトノベル雑談（このラノとか）」
```

- タイムラインのセルではなく、**ヘッダの `nav` の中にある横スクロールのピル**
- 文中に「スペース」の語は出てこない。スペースへのリンク（`/i/spaces/`）も無い
- 同じピルの仕組みで「新しいポストを表示」（`pillLabel`）も出る

### 作り

**CSS（`:has`）だけで消す。** `document-start` で `<style>` を注入するので、
描画された瞬間から消えていて一瞬も見えない。JS で DOM を走査しないので、
スクロール中の負荷もかからない。

```css
nav > div:has([data-testid="pill-contents-container"])
         :not(:has([data-testid="pillLabel"]))
         :not(:has([aria-label*="新しいポスト"])) … { display: none !important; }
```

- すべてのルールを `nav` の中に限定している。タイムラインの広告セルも
  `placementTracking` を使うため、範囲を絞らないと巻き込む
- 「新しいポストを表示」と同じ入れ物に同居している場合は、入れ物ではなく
  帯（`placementTracking`）だけを消す

### 経緯（同じ失敗をしないために）

v1.0〜v2.1 で、推測に基づく経路をいくつも足しては外した。

| 版 | 試したこと | 結果 |
|---|---|---|
| v1.0〜1.3 | `/i/spaces/` リンク、「スペース」の語、セル構造で探す | 帯はリンクも語も持たずセルの外にあり、当たらず |
| v1.5 | 紫色と形で探す | 実機で当たったか確認できないまま残っていた。スクロールのたびに全要素へ `getComputedStyle` をかけるので重い |
| v1.4〜1.9 | タップで指定して覚える | 空白を解決できず、操作も分かりにくい |
| v1.7〜1.8 | 中身の無い親を畳む | 模擬DOMでは CSS が先に消していて畳み込み処理を一度も通っておらず、テストが通っても実機で効かなかった |
| v2.1 | `resize` を偽装して再計測させる | 枠は本当に高さを持っているので測り直しても同じ値。偽装イベントでは `ResizeObserver` も反応しない |

v2.2 で、**実機で効くと確認できた経路（CSS のピル）と診断だけ**に絞った
（2254行 → 約800行）。

### 残る空白（v2.3.0 で対処）

v2.2.0 の診断で、空白の正体は**帯専用の枠**と確定した。

| 深さ | 要素 | 値 |
|---|---|---|
| 13 | ヘッダ本体（タブを含む） | fixed, 107px ← 触らない |
| 12 | 枠の一番外側 | absolute, 56px |
| 11 | | relative, 56px, overflow hidden |
| 10 | `div[role=grid]` | absolute, padding-top 56px, 112px |
| 8 | `nav` | 帯の中身が入る |

中身を消しても枠は56pxのまま残っていた。v2.3.0 で深さ11・12の高さを CSS で0にする。
タブを含む深さ13には当てない（テストで確認）。

注意: `:has()` は入れ子にできず、入れ子にするとルールごと無効になる。帯の有無は
子孫セレクタで、残すものの除外は外側の `:not(:has())` で書いている。

v2.3.0 の実機診断で、枠は0になったが投稿は y162 のままだった。投稿を押し下げて
いたのは枠ではなく **`header[role=banner]`（162px＝ヘッダ106＋枠56）**。
v2.4.0 で、帯があるときだけこの header に `margin-bottom: -56px` を付けて詰める。
「新しいポストを表示」（`pillLabel`）が帯の nav に居るときは詰めない。

### 診断（iPhone 可）

帯が出ている状態で URL の末尾に `#tmspaces` を付けて開く
（例: `https://x.com/home#tmspaces`）。画面下にパネルが出るので「コピー」を押す。
iPhone ではコンソールが開けないため、この経路を用意している。
コンソールが使える環境なら `__tmSpacesBar.dump()` でも同じものが出る。

- **■ 帯**: 帯ごとに、祖先を1段ずつ（`帯専用` の真偽・実測・計算後の高さ・
  `top/bottom`・余白・子の高さ）。最後に「帯専用の一番外側: 深さ N」
- **■ 画面中央の縦一列**: 画面中央を上から8pxおきに調べ、実際に何が描かれて
  いるか。空白の場所にある要素が分かる

### 検証

```
node --check x-hide-spaces-bar.user.js
NODE_PATH=$(npm root -g) node test/x-hide-spaces-bar.test.js
```

実機診断の入れ子（absolute・padding-top 56px・クラス指定の高さ112px）を
そのまま再現し、iPhone 相当の幅（390px）で29項目を確認する。帯が待たずに消える／
タブ・投稿は消えない／「新しいポストを表示」は残す（同居時は帯だけ消す）／
nav の外のピルには触らない／診断が計算後の高さと帯専用の範囲を正しく出す、など。

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

## 天秤AI 約款一括展開 について（ファイル: `tenbin-ai-biz-terms-expand-all.user.js`）

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

## 注意

公開リポジトリなので、**秘密にすべき情報は置かないこと**。
