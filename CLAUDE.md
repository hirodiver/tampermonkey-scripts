# CLAUDE.md

hirodiver の Tampermonkey ユーザースクリプト置き場。
**ユーザースクリプト（`*.user.js`）はすべてここに作る。**

## リポジトリの使い分け（置き場所を間違えないために）

hirodiver の個人ツールは2つのリポジトリに分かれている。指示にリポジトリ名が
無くても、次の表で置き場所を決める。

| 作るもの | リポジトリ | 置き場所 |
|---|---|---|
| Tampermonkey ユーザースクリプト（`*.user.js`）と、その検証・仕様書 | **tampermonkey-scripts**（ここ） | ルート直下にファイル1つ。テストは `test/` |
| 単一ファイル HTML ツール、Excel 生成・Python などの補助ツール、スキル、設計資料 | **claude-code-tools** | ルート直下に日本語フォルダを1つ |

- 「X の〜を隠して」「YouTube で〜したい」のような**ブラウザ上の見た目・操作を変える依頼は
  ユーザースクリプト**。ここに作る。
- 表から一意に決まらないときは、**ファイルを作る前に**「どこに置くか」を1行で確認する。
  推測で作らない。
- 目的のリポジトリがセッションに無いときは、手元にある別のリポジトリで代用しない。
  クラウドのセッションなら `add_repo` で追加してから作業する。追加できなければ、
  そう伝えて止める。
- claude-code-tools にも古いユーザースクリプト（`YouTube配信予定リスト/` など）が
  残っているが、**配布も自動更新もされない旧版**。直すのは常にこちらのファイル。

## 応答・記述の言語

- ユーザーとの会話、コード内コメント、UI 文言はすべて**日本語**。
- 変数名・関数名は英語（lowerCamelCase）。

## ファイルの置き方

```
tampermonkey-scripts/
├── CLAUDE.md
├── README.md                    ← スクリプト一覧・インストールURL・配布の仕組み
├── SPEC.md / HANDOFF.md         ← 個別スクリプトの仕様書・引き継ぎ
├── <サイト>-<機能>.user.js       ← スクリプト本体（例: x-hide-spaces-bar.user.js）
└── test/<名前>.test.js          ← Playwright による模擬DOM検証
```

- ファイル名は英小文字のケバブケースで `<サイト>-<機能>.user.js`（`x-` `youtube-` など）。
  フォルダは作らず、ルート直下に置く。
- ヘッダは既存スクリプト（例: `x-hide-spaces-bar.user.js`）を写して始める。
  - `@namespace local.hiro.tools`
  - `@name` は短く、末尾に ` vX.Y.Z` で `@version` と同じ値を付ける
  - `@homepageURL` / `@supportURL` はこのリポジトリ、
    `@downloadURL` / `@updateURL` は `main` の raw URL
- 新しいスクリプトを足したら、**README の「スクリプト一覧」表と「インストール」の URL 一覧にも足す**。
- 既存スクリプトを直したら**必ず `@version` を上げる**（上げないと配信されない）。
  バージョンの付け方、配布と自動更新の詳細は README に従う。
- **検証が通ったら、確認せず PR を作って `main` にマージするところまで続けて行う。**
  ユーザースクリプトは壊れてもユーザーが Tampermonkey で外せばよく、リスクが小さい。
  `main` に入らないと配布も自動更新もされないので、マージまでが作業。
  PR は squash マージ。対象は `*.user.js`・README・テストなど、このリポジトリの通常の変更に限る
  （履歴の書き換えや force push はしない）。
- 報告の最後に、インストール用の URL と、それがいま開けるか（`main` に入っているか）を書く。

## ユーザースクリプトの書き方（ハウススタイル）

既存の [YouTube 配信予定リスト](youtube-upcoming-stream-list.user.js) が基準。

### レイアウト

- 全体を `(function () { 'use strict'; ... })();` で囲む
- インデント4スペース
- セクションは日本語ラベル付きの罫線コメントで区切る:

```js
    // ============================================================
    // 配信開始日時取得
    // ============================================================
```

- **縦に広く書く。** 引数が複数あれば1行1引数、論理的な区切りごとに空行。
  1行に詰め込まない。
- ファイル先頭に「設定」セクションを置き、調整しうる定数を
  日本語コメント付きで並べる（同時接続数、リトライ間隔、デバウンス時間など）。

### DOM 操作

- **`innerHTML` は使わない。** YouTube 等は Trusted Types が有効で例外になる。
  `document.createElement` + `textContent` + `Object.assign(el.style, {...})`。
- 要素のクリアは `panel.replaceChildren()`。
- 色は各サイトの CSS 変数を借りる（例: `var(--yt-spec-text-primary)`）。
  ダークモード対応が自動で効く。

### 対象サイトの DOM が変わる前提で書く

- セレクタは**配列にして順に試す**。新旧クラス名を両方入れておく。

```js
const selectors = [
    'a.ytLockupViewModelContentImage[href*="/watch"]',   // 新
    'a#thumbnail[href*="/watch"]',                        // 旧
    'a[href*="/watch?v="]'                                // 保険
];
```

- 属性判定が効かない場合に備え、表示テキストの正規表現マッチを最終手段に置く。
- 取得できなければ `'タイトル不明'` のような日本語フォールバック文字列を返す。

### SPA・再描画への対応

必須の3点セット:

1. `document.addEventListener('yt-navigate-finish', ...)` 等のサイト固有遷移イベント
2. `MutationObserver` で対象カードの追加を検知
3. `setTimeout` によるデバウンス（`scheduleBuild(delay, force)`）

さらに:

- 処理中フラグ（`building`）+ 再実行要求フラグ（`rebuildRequested`）で
  多重実行を防ぎ、終了後に1回だけ追い実行する。
- 「カード構成の署名」と「描画内容の署名」を文字列で持ち、
  変化がなければ DOM を作り直さない。
- サイト側の再描画で自作パネルが消えたら作り直す。
- MutationObserver 内で自作パネル自身の変更は無視する（無限ループ防止）。

### 非同期・キャッシュ

- `Map` にキャッシュ。値は `{ data, fetchedAt }` の形。
- **失敗は永久キャッシュしない。** `fetchedAt` からの経過で再試行する。
- 同一キーの多重リクエストは `pendingRequests` Map で Promise を共有する。
- 並列数はワーカープール方式で制限する（`CONCURRENCY` 定数）。

### 日時

- 表示は JST 固定。`Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo' })`。
- 「今日 21:00」「明日 21:00」「9/5 21:00」の形式。

### 一発で効かせる（推測で出さない）

貼ったその場で効かないスクリプトは失敗とみなす。渡す前に必ず次を満たすこと。

- **未確認の `data-testid` に依存しない。** 記憶で書いたセレクタは当たらない前提。
  「何をしている要素か」（例: スペースへのリンクを含む・投稿本体を含まない）という
  **構造で狙う**。テストIDは当たれば儲けものの補助に置く。
- **非表示系は CSS を先に効かせる。** `document-start` で `<style>` を注入し、
  `:has()` で対象を消す。要素が生まれた瞬間から効くので「一瞬見えてから消える」が
  起きず、MutationObserver の取りこぼしにも強い。JS はその保険に回す。
- **模擬DOMで実際に流して確認する。** 対象サイトの構造を模したDOMを
  ヘッドレスChromium（Playwright）に組み、スクリプトを流し込んで
  `test/*.test.js` に残す。最低限、**狙ったものが消える／狙っていないものが残る／
  要素の使い回しで戻る**の3点を見る。`node --check` は構文を見ているだけで、
  動作確認ではない。
- **外すときの手がかりを同梱する。** `window.__tm〇〇.dump()` のような診断関数を置き、
  判定結果を `console.table` で出す。外れてもユーザーが1回の報告で直せる。

## 動作確認

Node.js v24 導入済み（ローカルの Windows では `C:\Program Files\nodejs\node.exe`）。
**ファイルを渡す前に必ず構文チェックする。**

```bash
node --check path/to/script.user.js
```

`node` が PATH に見つからない場合（インストール直後のシェルなど）はフルパスで呼ぶ:

```bash
"/c/Program Files/nodejs/node.exe" --check path/to/script.user.js
```

模擬DOMの検証はグローバルに入っている Playwright で流す:

```bash
NODE_PATH=$(npm root -g) node test/x-hide-spaces-bar.test.js
```

構文が通っても実際の挙動は別。最終確認は Tampermonkey に貼って
DevTools コンソールを見る。

## やらないこと

- ビルドツール、バンドラ、npm 依存を持ち込まない。単一ファイルで完結させる。
