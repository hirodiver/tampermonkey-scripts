# X 下部メニュー不透明化 について（ファイル: `x-bottom-bar-opaque.user.js`）

X のタイムラインをスクロールすると、画面下部のホーム / 検索 / 通知 / メッセージ帯が半透明になる。この挙動を止め、常に不透明（`opacity: 1`）のまま固定する。対象は `x.com` と `twitter.com`。

## 使い方

入れるだけ。細かな調整が必要な場合は、スクリプト冒頭の定数（`DEBUG`・`SCAN_DELAY`）を変更する。

## 作りの要点

- **CSS で先に効かせる。** `document-start` で `<style id="tm-bottombar-opaque-style">` を注入し、`[data-testid="BottomBar"]` とその子孫に `opacity: 1 !important` を当てる。要素が生まれた瞬間から効くため、スクロール中の一瞬の透け（コマ落ち）が起きない。
- **JS でインライン `style` を直接書き換えない。** X 側が後から `!important` 無しの `style.opacity` を書き換えると宣言ごと入れ替わって保護が消えるため、CSS ルール側で上書きする方式を採っている。
- **構造検出の保険。** `data-testid` が変わった場合に備え、`#react-root`（または `body`）直下の浅い階層（3段まで）から「`position: fixed`」「画面下端から 6px 以内」「幅が画面幅の 60% 以上」「ナビ用リンク（`a[href], [role="link"], [role="tab"]`）を 3〜8 個持つ」という構造で帯を探し、目印属性 `data-tm-bottombar-marked` を付けて同じ CSS ルールを当てる。
- **SPA・再描画への追従。** `MutationObserver` と 200ms のデバウンス（`SCAN_DELAY`）で DOM 変化後に再走査する。

## 診断

効かない・帯が見つからない場合は、コンソールで `__tmBottomBar.dump()` を実行する。`data-testid` と構造検出それぞれの検出有無・現在の `opacity` を `console.table` で表示する。`__tmBottomBar.css()` で注入される CSS 文字列も確認できる。

## 検証

```bash
node --check x-bottom-bar-opaque.user.js
NODE_PATH=$(npm root -g) node test/x-bottom-bar-opaque.test.js
```

ヘッドレス Chromium の模擬 DOM で、スタイル注入・初期状態、スクロール中の連続したインライン `opacity` 書き換えでも常に `opacity: 1` を保つこと、`data-testid` 除去後も構造検出で見つかり `opacity: 1` に戻ること、SPA 再描画で差し替わった新要素への追従、対象外要素（`#timeline`）の `opacity` を変更しないこと、`__tmBottomBar.dump()` の返り値を確認する。実機（X 本体）の DOM そのものではないため、テスト通過は実機動作を保証しない。
