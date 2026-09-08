# X YouTube Card - Open in Browser 仕様書

- **バージョン**: 3.8.2
- **形式**: Tampermonkey ユーザースクリプト
- **ファイル**: `x-youtube-card-open-in-browser.user.js`
- **namespace**: `local.hiro.tools`

---

## 1. 目的

X(Twitter) のタイムライン上のYouTubeカードに「▶ YouTubeで開く」ボタンを追加し、X内蔵プレイヤーを経由せずにYouTubeを開く。

X はカード化した投稿の本文からURL文字列を除去し、カードのタップをアプリ内プレイヤーの起動に割り当てる。そのため「元のYouTubeを開く」という単純な操作が、通常のUI上では成立しない。本スクリプトはその経路を復元する。

---

## 2. 動作環境

| 項目 | 内容 |
|---|---|
| 対象サイト | `https://x.com/*`, `https://twitter.com/*` |
| 実行タイミング | `document-idle` |
| 実行コンテキスト | `@inject-into page`（ページコンテキスト） |
| 権限 | `GM_xmlhttpRequest` |
| フレーム | `@noframes`（トップレベルのみ） |
| 想定環境 | iOS Safari + Tampermonkey（v3.3.0 以降は実機未確認） |
| 配布元 | https://github.com/hirodiver/tampermonkey-scripts |

### 実行コンテキストについて

ページコンテキストでの実行が必須である。React が DOM 要素に付与する `__reactProps$…` / `__reactFiber$…` は expando プロパティであり、コンテンツスクリプトの isolated world からは参照できない。`@inject-into content` を指定するとURL解決の主要経路が丸ごと死ぬ。

なお `@sandbox raw` は併用しない。既定のサンドボックスでもDOMノードは実物のページオブジェクトであり、React expando は読める。

### 通信許可

`@connect` は初期URLと最終URLの**両方**が照合される。`publish.twitter.com` は現在 `publish.x.com` へリダイレクトするため、リダイレクト先を宣言していないと遮断される。以下をすべて宣言している。

```
@connect cdn.syndication.twimg.com
@connect publish.x.com
@connect publish.twitter.com
@connect x.com
@connect *
```

末尾の `*` は、未知のドメインに当たった際に「すべて許可」ボタンを提示させるための Tampermonkey 公式推奨の書き方。

---

## 3. 設定項目

スクリプト冒頭の定数で挙動を変更できる。

| 定数 | 既定値 | 意味 |
|---|---|---|
| `DEBUG` | `false` | `true` でコンソールに検出・通信ログを出力 |
| `OPEN_TARGET` | `'browser'` | `'browser'`＝常にSafariで開く / `'app'`＝可能ならYouTubeアプリで開く |
| `ENABLE_IMAGE_POST_SUPPORT` | `true` | 画像付き・カード無し投稿対応（5.5章）の有効/無効。`false` にすると、再配信を待たずTampermonkeyのエディタ上の書き換えだけでこの機能だけ即座に無効化できる（カードのボタンには影響しない） |
| `PREFETCH_ON_VIEW` | `true` | カードが表示域に近づいた時点でURL取得を先行 |
| `MAX_INFLIGHT` | `3` | 先読みの同時実行上限 |
| `BTN_LABEL` | `▶ YouTubeで開く` | ボタン文言 |
| `SCAN_DELAY` | `200` | MutationObserver のデバウンス(ms) |
| `REQ_TIMEOUT` | `8000` | 外部リクエストのタイムアウト(ms) |

---

## 4. 処理フロー

```
起動
 ├ injectStyle()            スタイル注入
 ├ scan()                   初回走査
 └ MutationObserver(body, childList+subtree) 登録
                            → 自前ノードだけの変化なら無視
                            → 200msデバウンス → scan()

scan()   card.wrapper を走査
 ├ isYouTubeCard()          直リンク／iframe／ドメイン表記で判定
 ├ stateOf(card)            WeakMapから状態取得（tweetId変化なら破棄して作り直し）
 ├ watchForPrefetch()       IntersectionObserver に登録
 ├ resolveFromDom()         未解決ならDOM/Reactで解決
 └ pickTarget() → ボタン設置／形態・位置が不一致なら作り直し

表示域に接近（rootMargin 400px）
 └ prefetch()               未解決またはweakなら syndication API を先行取得

ボタン押下
 ├ pointerdown              未確定なら取得開始（先読みの保険）
 └ click
     ├ 修飾キー・中クリック → ブラウザ既定（hrefで新規タブ）
     ├ URL解決済み          → openUrl()
     └ 未解決                → 空タブ確保 → 取得 → openUrl()
```

---

## 5. URL解決

### 5.1 同期経路（DOM / React）

`resolveUrlRaw(card, article)` が以下の順に試行する。

| 優先 | 手段 | 備考 |
|---|---|---|
| 1 | カード内のYouTube直リンク | `watch` / `youtu.be` / `shorts` |
| 2 | 再生済み iframe の `/embed/ID` | X内プレイヤー起動後に有効 |
| 3 | React内部state | `__reactProps$` と `__reactFiber$.memoizedProps` を深さ6まで探索。カード自身 → カード内の子孫(最大40要素) → 上位12階層の順。上位への探索は境界要素の**手前**で打ち切り、境界要素自身は見ない |
| 4 | カード内の t.co リンク | 暫定値（weak）扱い |
| 5 | ツイート本文内の t.co リンク | 本文中の t.co が**1本だけ**のときのみ採用。暫定値（weak）扱い |

t.co は「YouTube URLと確定していない」ため weak として記録する。weak のまま残っているカードは、先読み・押下時に非同期経路で確定URLへ上書きする。

**上位探索の境界**は、そのカードの scope（→ 5.4）内のYouTubeカードの枚数で決める。

| 枚数 | 境界（この要素は見ない） | 意図 |
|---|---|---|
| 2枚以上 | `card.parentElement` | 隣のカードと共有する親のpropsを覗くと、両カードが同じURLになる |
| 1枚 | scope の親 | 曖昧さが無いので遡り、配信前カードの解決率を上げる |

境界要素を**含めて**探索すると、複数カード構成で全カードが共有親の同一URLになる。v3.3.x はこの不具合を持っていた。

カード内の子孫探索は境界に関わらず常に行う。子孫は確実にそのカードのものなので、隣のカードが混入しない。

React探索は起点ごとに visited 集合（WeakSet）を作り直す。使い回すと深さ上限で打ち切った枝が「訪問済み」として残り、別の起点から浅い深さで到達できたURLを取りこぼす。

### 5.2 非同期経路（外部API）

同期経路が空振りした場合に使用する。**配信前のライブカードは同期経路が全滅する**（カードにアンカーが存在せず、本文からもURLが除去されるため）ので、実質この経路が本命になる。

**主経路: syndication API**

```
https://cdn.syndication.twimg.com/tweet-result?id=<ID>&lang=ja&token=<TOKEN>
```

- token は `((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '')`
- レスポンスの `entities.urls[].expanded_url` は **t.co 展開済み**。ここから取れればt.coの推測が不要になる
- 取れない場合、レスポンス全体をJSON文字列化してYouTube URLを正規表現で拾う（カードの binding_values 対策）
- 結果は**出現順の配列**で返す。1ツイートに複数のYouTubeカードがある場合、そのカードが article 内で何番目のYouTubeカードかで対応する1件を選ぶ

**第2フォールバック: oEmbed**

```
https://publish.x.com/oembed?omit_script=1&url=<永続リンク>
```

返却HTMLからYouTube直URL、無ければ t.co を抽出する。こちらも配列で返す。

**キャッシュ方針**

- in-flight の Promise ごと `Map` で共有し、連打しても1リクエストに収める
- **失敗はキャッシュしない**。一時的な遮断や通信エラーで、そのツイートが再読み込みまで永久に失敗し続けるのを防ぐ

### 5.3 正規化

`normalizeYtUrl()` が `embed` / `live` / `shorts` / `youtu.be` を `https://www.youtube.com/watch?v=ID` に統一する。

- 再生位置 `t`（embedでは `start`）は引き継ぐ
- `si=` 等のトラッキングパラメータは破棄
- watch形式やプレイリスト等はそのまま通過
- 同期経路・非同期経路の**両方**の結果に適用する

### 5.4 カードが属するツイート（scope）

`findStatus(card, article)` は、**カードから上へ辿って最初に status リンクを含む祖先**を、そのカードのツイートとみなす。その祖先を scope と呼ぶ。

article 全体の最初の status リンクを使うと、**引用ツイート内のカードでも外側のツイートIDになり、APIから別の動画のURLが返る**。v3.4.x まではこの不具合を持っていた。

scope は次の3つで使う。

| 用途 | 効果 |
|---|---|
| APIに投げるツイートID / 永続リンク | 引用カードは引用元のツイートを引く |
| `cardIndex()` の数え上げ範囲 | 本体カードと引用カードで番号が通し番号にならない |
| 本文 t.co フォールバックの探索範囲 | 引用カードは引用ブロック内の本文だけを見る |

引用ブロックに status リンクが無い構成では article まで遡るので、従来どおりの結果になる。

---

## 5.5 画像付き・カード無し投稿への対応

Xは画像が付いた投稿では、YouTube URLが含まれていても `card.wrapper` を作らない
（投稿画像がサムネイル代わりになるため）。カード化と本文URL除去はセットの処理
なので、この場合は本文に t.co リンクがそのまま残る。

t.co の遷移先はDOMからは分からないが、Xは本文中のリンクを表示する際に
**元URL（収まらなければ末尾を省略）をテキストとしてそのまま出す**。これを読む
ことで、展開せずにYouTubeらしさを判定できる。

### v3.7.0での失敗と設計の変更

最初の実装（v3.7.0）は画像コンテナ（`tweetPhoto`）要素自体に
`position: relative` を付与し、ボタンをその右上にoverlay設置した。
模擬DOMのテストは全項目通過したが、**実機では画像が真っ白になりボタンも
消える**不具合が発生し、ロールバックした（v3.7.1）。原因は未特定（実際の
Xの `tweetPhoto` のDOM構造をこの開発環境から確認できないため）。

v3.8.0では、**画像要素には一切手を加えない**設計に変更した。ボタンは
本文（`tweetText`）の直後に独立ブロックとして挿入する。カード展開後の
inline配置（`card.wrapper`の直前に挿入）と同じ、既に実績のある方式の
向きを変えただけで、画像のクラス・属性・DOM構造は何も変更しない。

ただしこれも実機は未確認のまま配信する。模擬DOMのテストが通ることは
安全の証明にならない、というのがv3.7.0の教訓そのものである。そこで
`ENABLE_IMAGE_POST_SUPPORT`（v3.8.1）を設け、万一この機能だけが
問題を起こした場合に、再配信（git操作・push・CDNキャッシュ待ち）を
待たずに、Tampermonkeyのエディタでこの1行を `false` に書き換えて
保存するだけで即座に無効化できるようにした。カード機能には影響しない。

### 検出

`findYouTubeTextLink(article)` が `tweetText` 内の `<a>` を走査し、表示テキスト
（`textContent`）が `YT_DISPLAY_RE`（`youtube.com/watch?v=` 等、プロトコル省略
可）にマッチするものを探す。

- YouTubeカードが1つでもある article は対象外（`hasYouTubeCardInArticle()`）。
  カード側のボタンで足りるため
- 画像（`[data-testid="tweetPhoto"]`）が無い article も対象外。画像が無ければ
  通常どおりカード化されるはずなので、二重対応する理由が無い。**この判定に
  使うだけで、`tweetPhoto` 要素そのものには一切触れない**

### URL解決

表示テキストから動画ID（11文字）が完全に読めるかどうかで扱いを変える。

| 状態 | 判定 | 扱い |
|---|---|---|
| 省略記号（`…` / `...`）が無く、IDが11文字以上 | `complete: true` | 確定URL（weak:false） |
| 省略されている、またはIDが11文字未満 | `complete: false` | href（t.co）を暫定値として使う（weak:true） |

weak のときは、通常のカードと同じく非同期経路（syndication API）が確定URLへ
上書きする。**表示テキストから復元したURLは検証していない**ので、末尾が
実際には省略されていないのに何らかの理由でズレて見える等のケースでは、
誤ったIDを開く可能性がゼロではない（→ 10章 B-9）。

### 状態管理・ボタン設置の再利用

`tweetText` 要素自体を「card」として `cardState` / `cardButton` に載せる。
これにより、状態管理・先読み・クリック処理・開き方（`openUrl`）は通常の
カードとまったく同じ経路を再利用する。異なるのは判定・解決の中身と、
設置位置だけ：

| 用途 | カード | 画像付き投稿 |
|---|---|---|
| 検出 | `isYouTubeCard()` | `findYouTubeTextLink()` |
| 同期解決 | `resolveFromDom()` | `resolveFromPostText()` |
| 設置先 | `card.wrapper` | `tweetText`（画像には触れない） |
| 配置形態 | `'overlay'` ⇔ `'inline-before'` を切替 | 常に `'inline-after'`（本文の直後） |

`addButton()` の第4引数は真偽値のoverlayフラグから、`'overlay'` /
`'inline-before'` / `'inline-after'` の3値（`placement`）に拡張した。
同期解決関数も引数（`resolveSync`）として受け取るようになり、呼び出し側が
カード用・画像投稿用のどちらを渡すかを決める。

---

## 6. 開き方の仕様

iOS では Universal Link の成立条件により、遷移の起こし方でYouTubeアプリに奪われるかどうかが変わる。Apple の制約として、クリックがユーザー起点であること、遷移がクライアント側JavaScriptでないことが要求される。

| モード | URL解決済み | 未解決（取得後） |
|---|---|---|
| `'browser'`（既定） | 空タブ確保 → `setTimeout(0)` で location 代入 → **Safari** | 同左 → **Safari** |
| `'app'` | ユーザー操作内の `window.open(url)` → **YouTubeアプリ** | 確保済みタブに代入 → **Safari** |

`'browser'` は遷移をユーザー操作の外へ意図的に追い出すことで、Universal Link を発火させず確実にSafariに留める。両経路で挙動が一致する。

`'app'` は未解決時のみアプリに渡せない。ただし先読みが有効な場合、押下時点では通常すでに解決済みのため、この経路に落ちることはほとんどない。

カスタムスキーム（`youtube://`）による強制は、アプリ未導入時にタブが行き止まりになるため採用していない。

---

## 7. UI仕様

| 項目 | 内容 |
|---|---|
| 要素 | `<a href target="_blank" rel="noopener noreferrer" role="button">` |
| ラベル | `▶ YouTubeで開く` |
| 配色 | ライト: 背景 `#3b5bdb` / hover `#2f4ac4`、ダーク(`prefers-color-scheme`): `#4c6ef5` / hover `#5c7cfa`。文字は `#fff` |
| 書体 | Noto Sans JP 11px / weight 500 |
| aria-label | `YouTubeをブラウザで開く` |

**設置形態**

- **展開前** — `card.wrapper` の右上にオーバーレイ（`position: absolute; top: 8px; right: 8px`）。カード側に `position: relative` を付与
- **展開後**（カード内にiframeが入った状態）— カード直上にインライン配置。オーバーレイ用の `position: relative` は除去

展開状態に対して形態または位置が不一致になった場合、`scan()` がボタンを作り直す。

**イベント制御**

`mousedown` / `pointerdown` / `click` をすべてキャプチャ段階で `stopPropagation` し、カード本体およびツイート本体のクリック（＝X内プレイヤー起動、詳細画面遷移）を抑止する。

`<a>` 化により、URL確定済みなら中クリック・修飾キー付きクリック・長押しでのリンクコピーがブラウザ標準の挙動で使える。左クリック（修飾キーなし）だけを `preventDefault` して `openUrl()` の経路へ流し、Safari固定の挙動を維持する。URLが後から確定した場合は `href` を追従更新する。逆に、URLが未解決または t.co 止まり（weak）のときは `href` を**外す**。確定していないURLをブラウザ既定の経路に渡さないため。

---

## 8. 状態管理

状態は **`card.wrapper` 単位** で `WeakMap` に保持する。

| フィールド | 意味 |
|---|---|
| `tweetId` / `permalink` | 所属ツイート |
| `url` | 解決済みURL |
| `weak` | `url` が t.co 由来の暫定値である |
| `tried` | 先読みを試行済み（1カード1回） |
| `watched` | IntersectionObserver 登録済み。**状態を作り直しても引き継ぐ**（監視は状態ではなく要素に紐づくため） |
| `needsRefetch` | DOM再利用で作り直された状態。次の `scan()` で先読みを直接起動する |
| `isYtCard` | `isYouTubeCard()` が一度 true と判定したことを記憶する。同じツイートである間は再判定しない |

article の data 属性ではなくカード単位にしたことで、

- 1つの article に複数カードがある構成（引用ツイート等）で、各カードが独立したURLを持つ
- 仮想リストによるDOM再利用時に古いURLが張り付かない（`tweetId` が変化した状態は破棄し、ボタンの `href` も外す）
- ページ遷移でDOMが捨てられれば状態も自動で回収される

### 判定の固定化（isYtCard）

`scan()` は本来、毎回 `isYouTubeCard()` を呼んでカードかどうかを判定する。
しかし**カード展開直後の一瞬**、ドメイン表記が消え、iframeもまだ挿入されていない
過渡的なDOM状態になることがある。この瞬間に再判定すると `isYouTubeCard()` が
**falseへ反転**し、`scan()` がそのカードを丸ごと無視する。React側は展開時に
古いボタンを道連れに消してしまっているため、ボタンが跡形もなく消える
（実機報告: デスクトップChrome / iOS Safari 双方で、カードクリック後に
ボタンがどこにも見えなくなる）。

対策として、一度 `isYouTubeCard()` が true と判定したカードは `state.isYtCard`
に記録し、同じツイートである間（`tweetId` が変わらない間）は再判定しない。
DOM再利用で別ツイートに化けたときは `isYtCard` を含む状態ごと破棄されるので、
正しく再判定される。

### 判定の固定化（article単位）：articleYtState

上記の `isYtCard` は「同じDOM要素の中身だけが変わる」ケースは救えるが、
**Xがカード要素自体を丸ごと新しいノードに置き換える**ケースには無力だった。
新しい要素には `cardState` の記憶が無く、置き換え直後の一瞬（直リンクも
iframeもドメイン表記も無い「読み込み中」的な過渡状態）に `isYouTubeCard()`
が false を返すと、その要素は二度とYouTubeカードとして扱われず、ボタンが
永久に復活しなかった（実機報告 v3.8.1後: **配信前カードをタップ（展開）
すると、そのままボタンが消える**。v3.6.0で直したはずの症状の再発に見えたが、
実際にはv3.6.0の修正が最初からカバーしていなかった別の穴だった）。

対策として、`articleYtState`（`WeakMap`、キーは article）を追加した。
`isYouTubeCard()` が true と判定した瞬間、その article を記録する。以後、
同じ article 内の別のカード要素（＝置き換え後の新ノード）が判定基準を
一時的に満たさなくても、そのarticleが既に確定済みなら通す。

```
scan() のカード判定:
  isYouTubeCard(card) が true
    → articleYtState に記録し、通す
  isYouTubeCard(card) が false
    → article が articleYtState に記録済みなら、それでも通す
    → 記録が無ければ、本来どおりスキップ
```

**トレードオフ**: 1つの article に複数カードがある構成（B-5/B-8で既知の
制約があるのと同種）で、片方がYouTube、もう片方が無関係な別サービスの
カードだった場合、後者も誤ってYouTube扱いされる可能性がゼロではない
（→ 10章 B-11）。ただし article をまたいだ誤検出は起きない（`articleYtState`
のキーは article 単位で、隣接する無関係な article には波及しない）。

### DOM再利用時の後始末

`tweetId` の変化で状態を破棄するとき、次の2つを併せて行う。

- **ボタンの `href` を外す**（`syncHref(card, null)`）。残すと、中クリックやリンクコピーで前のツイートの動画が開く
- **`watched` を引き継ぎ、`needsRefetch` を立てる**。IntersectionObserver は observe 済みの要素へ再度 observe しても無視するため、登録し直したつもりで再通知が来ない。代わりに `scan()` から直接 `prefetch()` を呼ぶ（そのカードは既に画面上にある）

検出とURLは分離したままで、**URLが取れなくてもボタンは表示される**。解決はクリック時に非同期経路へフォールバックする。同時に、解決できないカードに対する再探索ループも止まる。

---

## 9. エラー表示と切り分け

失敗時、ボタン文言が1.8秒間切り替わる。

| 表示 | 意味 | 確認先 |
|---|---|---|
| `取得失敗(リンク)` | 状態に `tweetId` が無い（`findStatus()` が空振り） | article内の `a[href*="/status/"]` の構造 |
| `取得失敗(API)` | syndication・oEmbed とも空振り | `DEBUG = true` でHTTPステータスまたは遮断理由 |

`取得中…` が表示されずに即失敗する場合は前者、一瞬表示されてから失敗する場合は後者。

---

## 10. 既知の制約・未対応

| # | 内容 | 影響 |
|---|---|---|
| B-1' | 本文の t.co フォールバックは候補が1本のときだけ使う | 複数リンクの投稿では本文 t.co を使わず、非同期経路の結果を待つ。誤URLを開く代わりに、稀に解決が一拍遅れる |
| B-5 | 複数カードへのURL割当は「article内のYouTubeカードの出現順」に依存 | APIの返す順序とDOM順が食い違う構成では入れ替わりうる |
| B-6 | ドメイン表記の判定は表示文字列に依存 | Xがカード下部のドメイン表記をやめると、直リンクもiframeも無い配信前カードで検出できなくなる |
| B-8 | scope は status リンクの有無で決まる | 引用ブロックに status リンクが無い構成では、引用カードが外側のツイートIDで解決される（v3.4.x 以前と同じ挙動） |
| B-9 | 画像付き投稿の表示テキストからの動画ID復元は未検証のまま使う | 稀に誤ったIDを開く可能性がある。非同期経路で確定URLに上書きされるまでの間のみ |
| B-10 | 画像付き投稿は `tweetPhoto`（判定用）と `tweetText`（設置先）の2セレクタに依存 | Xがdata-testidを変更すると検出できなくなる |
| B-11 | `articleYtState` は article 単位で判定を緩める | 1 article に複数カードがあり、片方がYouTube・もう片方が無関係な別サービスの場合、後者も誤ってYouTube扱いされうる |
| C-3' | ダークテーマ追従は `prefers-color-scheme` ベース | X側だけをライト／ダークに切り替えた場合はOS設定に従う |
| B-7 | React探索の子孫走査は先頭40要素まで | 巨大なカードでは末尾の要素にしかpropsが無い場合に取りこぼす。非同期経路へ落ちる |
| V-1 | 検証はヘッドレスChromium上の模擬DOMのみ | Xの実DOM・Reactの内部構造は再現できていない。実機（iOS Safari + Tampermonkey）での確認は別途必要 |

### v3.2.1 から解消した項目

| # | 旧内容 | 解消方法 |
|---|---|---|
| B-1 | 本文の最初の t.co を無条件に採用 | 候補1本のときのみ採用＋weak扱いで後から上書き |
| B-2 | 状態が article 単位で複数カードに非対応 | 状態を `card.wrapper` 単位の WeakMap へ移動 |
| B-3 | DOM再利用で古いURLが残る | 状態に `tweetId` を持たせ、変化したら破棄 |
| B-4 | textContent の緩い判定で誤検出 | ドメイン表記（`youtube.com` / `youtu.be`）の厳密一致に変更 |
| C-1 | 自身のDOM操作で余分な走査が走る | 追加・削除が自前のボタン／スタイルだけの MutationRecord は無視 |
| C-2 | `<button>` のため中クリック・URLコピー不可 | `<a href>` 化。左クリック以外はブラウザ既定に委ねる |

## 11. 外部依存のリスク

| 依存先 | 性質 | 壊れた場合 |
|---|---|---|
| `cdn.syndication.twimg.com/tweet-result` | Xの非公開エンドポイント。仕様変更・レート制限の予告はない | oEmbed へ自動フォールバック |
| `publish.x.com/oembed` | 公開エンドポイントだが過去に404多発・IP単位の遮断事例あり | `取得失敗(API)` |
| `[data-testid="card.wrapper"]` | XのDOM実装依存 | カード検出が全滅しボタンが出なくなる |
| カード下部のドメイン表記 | Xの表示仕様依存 | 直リンクもiframeも無いカード（配信前ライブ等）の検出が落ちる |
| 展開後iframeのドメイン | `youtube.com` と `youtube-nocookie.com` の両方に対応済み | 別の埋め込みドメインに変わった場合は再度対応が必要 |
| `__reactProps$` / `__reactFiber$` | Reactの内部実装依存 | 同期経路の優先度3が死に、非同期経路へ落ちる |

いずれも単独障害では全滅せず、下位の経路に落ちる多段構成にしてある。**ボタンが一切出なくなった場合は `card.wrapper` の変更を疑う**のが最短。

---

## 12. 検証

### 自動検証

```
NODE_PATH=$(npm root -g) node test/x-youtube-card.test.js
```

ヘッドレスChromium（Playwright）上にXのカード構造を模したDOMを組み、スクリプトを流し込んで挙動を確認する。`GM_xmlhttpRequest` と `window.open` はモック。49項目。

| 項目 | 確認内容 |
|---|---|
| 1 | 直リンクカードの検出・overlay設置・href正規化 |
| 2 | タイトルに「YouTube」を含む他ドメインカードを検出しない |
| 3 | 配信前ライブカード（アンカー無し）の検出とAPI解決 |
| 4 | 1 article 2カードで、それぞれ対応するURLで開く |
| 5 | 展開でoverlay→inlineへ切替、`host`クラス除去、embedからの解決 |
| 6 | DOM再利用後に古い `href` が残らない |
| 7-8 | React props からの解決／隣カードへの混入が無い |
| 9 | 本文 t.co が複数のとき本文t.coを使わない |
| 10-11 | 失敗表示と、失敗をキャッシュしないこと |
| 12 | 中クリックで `preventDefault` しない |
| 13-14 | 祖先props（1枚時）／子孫propsからの解決 |
| 15 | 先読みの発火と、DOM再利用後の再発火 |
| 16 | ドメイン表記の判定 12パターン（表記ゆれ・誤検出の双方） |
| 17-18 | 引用ツイート内カードが引用側のツイートIDで解決される |
| 19 | weak(t.co) のとき href を付けない |
| 20 | 展開でドメイン表記が消える過渡状態でもカードを見失わない |
| 21 | 展開後の iframe が youtube-nocookie.com でも解決できる |
| 22-23 | 画像付き・カード無し投稿：表示テキストからの確定／weak解決、画像要素が無傷であること |
| 24-27 | 無関係なリンク・画像無し・カード優先での誤検出防止、複数回scanでの重複防止 |
| 28 | カード要素が丸ごと置き換わって（タップ後の再描画等）もボタンを見失わない |
| 29 | article単位の緩和が隣接する無関係なarticleへ越境しない |

**このテストが保証しないこと**

Xの実DOM構造、Reactの実際の内部形状、iOSのUniversal Linkの挙動、Tampermonkeyの `@connect` 判定、実APIのレスポンス形状。**実機確認の代替にはならない。**

### 実機で確認すべきこと

1. タイムラインのYouTubeカードにボタンが出るか
2. 押すとSafariでYouTubeが開くか（アプリに奪われないか）
3. 配信前のライブカードでURLが取れるか
4. 1つの投稿に複数のYouTubeカードがある場合、それぞれ正しいURLが開くか
5. タイトルに「YouTube」を含む他ドメインのカードにボタンが出ていないか

ボタンが一切出ない場合、疑う順序は `[data-testid="card.wrapper"]` の変更 → `isYouTubeCard()` が厳しすぎる、の順。判定を緩めるなら `hasYouTubeDomainLabel()` を見る。

---

## 13. 変更履歴

### v3.8.2
- **実機報告により判明: 配信前のカードをタップ（展開）すると、ボタンが消えたまま復活しない不具合を修正**。v3.6.0で入れた `isYtCard`（同じDOM要素の中身が変わるケースを救う固定化）は、Xがカード要素自体を丸ごと新しいノードに置き換えるケースには無力だった。新しい要素には過去の記憶が無く、置き換え直後の一瞬（判定基準を満たさない過渡状態）に判定されると、その要素は二度とYouTubeカードとして扱われなかった
- `articleYtState`（→ 8章）を追加し、article単位でも一度確定した事実を記憶するようにした。同じ実験（v3.6.0のコードでも同一シナリオが再現すること）で確認した上で、今回の変更による退行ではなく元から存在した別の穴だったと特定した
- 検証を49項目に拡充。カード要素の丸ごと置き換えと、article単位の緩和が隣接articleへ越境しないことの両方を確認するテストを追加

### v3.8.1
- `ENABLE_IMAGE_POST_SUPPORT` を追加。画像付き投稿対応（v3.8.0）だけを、再配信を待たずにTampermonkeyのエディタ上の書き換えで即座に無効化できるようにした。カード機能には影響しない
- v3.7.0のロールバック（git操作・push・CDNキャッシュ待ちが必要だった）よりも早く止められる手段を、ユーザーからの「配信して問題が起きた場合、ロールバック不要で元に戻せるか」という問いを受けて用意した

### v3.8.0
- **画像付きでカード化されない投稿への対応を再実装**。v3.7.0は画像要素（`tweetPhoto`）自体にボタンをoverlay設置して実機を壊し、v3.7.1でロールバックした（下記参照）。今回は**画像要素には一切手を加えない**設計に変更し、本文（`tweetText`）の直後にボタンを独立ブロックとして追加する（→ 5.5章）
- `addButton()` の設置方式指定を真偽値（overlay）から `'overlay'` / `'inline-before'` / `'inline-after'` の3値（`placement`）に拡張。画像付き投稿は常に `'inline-after'`
- 検出（`findYouTubeTextLink`）・解決（`resolveFromPostText`）のロジック自体はv3.7.0から変更なし。表示テキストから動画IDが完全に読めれば確定URL、省略されていればweak扱いとし非同期経路が確定させる
- 検証を45項目に拡充。画像要素のHTMLが操作前後で完全に一致することを確認するテストを追加（v3.7.0の再発防止）

### v3.7.1（v3.7.0のロールバック）
- **実機報告により判明: 画像付き投稿で画像が真っ白になり、ボタンも表示されなくなる不具合が発生**。v3.7.0で追加した「画像付き・カード無し投稿への対応」（`tweetPhoto` 要素にボタンをoverlay設置する機能）が原因と見て、機能ごと撤去した
- 疑わしい実装（未検証、原因は確定していない）：
  - `target.classList.add(CLASS.host)` で `tweetPhoto` 要素に `position: relative` を付与しており、Xの画像レイアウト（絶対配置やaspect-ratio制御に依存している可能性）を壊した疑いがある
  - `tweetPhoto` セレクタが実際には `<img>` 要素自体を指しており、`appendChild` が例外を投げてMutationObserverのコールバックごと失敗した疑いがある（`<img>` は子ノードを持てない）
  - どちらも実際のXのDOMをこの開発環境からは確認できておらず、確定していない
- スクリプト本体・テストスイートはv3.6.0の内容に戻した。ただし `@version` はTampermonkeyの仕様上ダウングレードとして無視されるため、3.6.0には戻さず3.7.1として前進させた
- 画像付き投稿対応を再挑戦する場合は、まず実際の `tweetPhoto` 要素の構造（タグ名・親子関係・CSS）を実機のDevToolsで確認してから設計し直すこと

### v3.7.0（ロールバック済み。上記参照）
- **画像付きでカード化されない投稿にもボタンを追加**。Xは画像付き投稿ではYouTube URLがあってもcard.wrapperを作らず、本文にt.coリンクがそのまま残る。t.co自体は展開しないと遷移先が分からないが、Xが本文リンクの表示に使う元URLのテキスト（収まらなければ末尾省略）を読むことで、展開せずにYouTubeらしさを判定できるようにした
- 表示テキストから動画IDが完全に読めれば確定URLとして即座に使用。省略されていればweak扱いとし、既存の非同期経路（syndication API）が確定させる
- ボタンは画像コンテナ（`tweetPhoto`）の右上にoverlay設置。YouTubeカードが既にある投稿では二重に出さない
- `addButton()` の同期解決ロジックを引数化し、カード用（`resolveFromDom`）・画像投稿用（`resolveFromPostText`）のどちらでも使えるよう汎用化。状態管理・先読み・クリック処理・開き方は完全に共通
- 検証を41項目に拡充

### v3.6.0
- **実機報告により判明: カードをクリックして展開すると、ボタンがどこにも見えなくなる不具合を修正**（デスクトップChrome / iOS Safari 双方で発生）。`scan()` が毎回 `isYouTubeCard()` を再判定していたため、展開直後の一瞬（ドメイン表記が消え、iframeもまだ無い過渡的なDOM状態）に判定がfalseへ反転し、カードを丸ごと無視していた。一度trueと判定したカードは、同じツイートである間は再判定しないよう修正（→ 8章「判定の固定化」）
- 展開後の埋め込みiframeが `youtube-nocookie.com`（プライバシー強化埋め込み）の場合にも対応。ドメイン表記の判定・iframeセレクタの両方に追加
- 検証を33項目に拡充。旧v3.5.0で実際に本不具合が再現することを確認した上で修正した

### v3.5.0
- **引用ツイート内のカードが外側のツイートIDで解決されていた不具合を修正**。`findStatus()` がarticle全体の最初の status リンクを使っていたため、引用カードで別の動画が開いていた。カードから最も近い status リンクを持つ祖先（scope）を使うようにした（→ 5.4）
- `cardIndex()` の数え上げと本文 t.co の探索範囲も scope 基準に変更。本体カードと引用カードで番号が通し番号にならなくなった
- **ドメイン表記の判定を緩めた**。完全一致だったため `From youtube.com` / `youtube.com から` / `🔗youtube.com` のような装飾付き表記を検出できなかった。ドメインを1トークンとして切り出せることを条件にし、`notyoutube.com` や「YouTubeで話題」は従来どおり弾く
- 検証を29項目に拡充

### v3.4.0
- **React探索が境界要素自身を見ていた不具合を修正**。1 article に複数のYouTubeカードがある構成で、共有する親要素のpropsを拾い、全カードが同じURLになっていた（新 B-5 の主因）
- React探索にカード内子孫の走査を追加（最大40要素）。カード自身にpropsが無い構成での解決率が上がる
- カードが1枚だけの article では、上位探索の境界を article の親まで広げた
- **DOM再利用でボタンの `href` に前のツイートのURLが残る不具合を修正**。中クリック・リンクコピーで誤った動画が開いていた
- **DOM再利用後に先読みが二度と発火しない不具合を修正**。observe 済みの要素への再 observe が無視されるため、`scan()` から直接先読みするようにした
- URLが未解決または weak のときは `href` を外すようにした
- 検証ハーネス `test/x-youtube-card.test.js` を追加（ヘッドレスChromium、24項目）

### v3.3.2
- 配布ブランチを `main` に整理し、`@updateURL` / `@downloadURL` を `main` 参照へ変更

### v3.3.1
- `@updateURL` / `@downloadURL` / `@homepageURL` / `@supportURL` を追加し、Tampermonkey の自動更新に対応（C-4）

### v3.3.0
- 状態を article 単位から `card.wrapper` 単位（WeakMap）へ移行。1 article 複数カード構成に対応し、仮想リストのDOM再利用による古いURLの張り付きも解消（B-2 / B-3）
- YouTubeカード判定をドメイン表記の厳密一致へ変更。タイトルに「YouTube」を含む他ドメインのカードを誤検出しなくなった（B-4）
- 本文 t.co フォールバックを「候補1本のときのみ」に限定し、t.co 由来のURLを weak として後から確定URLで上書きするようにした（B-1）
- ボタンを `<a href>` 化。中クリック・修飾キー付きクリック・リンクコピーが効くようになった（C-2）
- React探索がカードの親要素より上へ遡らないよう制限（隣のカードのURL混入を防止）
- 非同期経路の戻り値を配列化し、カードの出現順で対応するURLを選択
- ダークテーマ用の配色を追加（C-3）
- 自前のDOM操作に由来する MutationRecord を無視し、余分な走査を抑制（C-1）

### v3.2.1
- `OPEN_TARGET` を追加し、Universal Link の発火有無を制御。既定でSafari固定に統一
- IntersectionObserver による先読みを追加（同時3件、1記事1回）

### v3.2.0
- `@inject-into content` + `@sandbox raw` の矛盾を解消し `@inject-into page` に統一
- `@connect` にリダイレクト先 `publish.x.com` ほかを追加（**配信前カードで「URL取得失敗」となる直接原因の修正**）
- 非同期経路の主経路を oEmbed から syndication API へ変更
- クリック時に空タブを同期確保し、取得後に流し込む方式へ変更（同一タブ遷移をやめた）
- React探索の visited 集合を起点ごとにリセット
- 取得結果の正規化漏れ、失敗の永久キャッシュ、多重リクエスト、`position: relative` の残留を修正

### v3.1.0
- 検出済みフラグとURLを分離し、URL未解決でもボタンを表示
- 解決失敗時の無限リトライを停止
- 展開状態に応じたボタン形態の切替
- oEmbed フォールバックを追加

### v1.8.0
- 初期実装（DOM + React探索 + t.coフォールバック）
