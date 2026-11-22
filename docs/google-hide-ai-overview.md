# Google AI概要非表示 について（ファイル: `google-hide-ai-overview.user.js`）

Google 検索の結果ページに出る「AI による概要」（AI Overview）を非表示にする。
Windows の Chrome と iPhone の Safari（Tampermonkey）で使う前提。対象は
`www.google.com` と `www.google.co.jp` の `/search`。

## 作りの要点

- **CSS で先に消す。** document-start で `<style>` を注入する。概要の本体に付く
  `data-attnms` 属性と、それを包む入れ物（`:has()` で判定）を消すので、
  描画された瞬間から見えない。セレクタは uBlock Origin 用の公開フィルタ
  [Stevo's AI Blocklist](https://github.com/Stevoisiak/Stevos-AI-Blocklist)（2026-11 時点）を参照した。
- **JS は保険。** 属性やクラス名が変わった場合に備え、「AI による概要」「AI Overview」と
  完全一致する見出しの文字列を探し、ほかの検索結果の見出し（`h1`〜`h4`・`role=heading`）を
  含まない範囲まで上へ遡って `data-tm-aio="hidden"` の印を付ける。
- 印は毎回付け直す。Google が要素を使い回して別の中身を入れたら、印を外して表示に戻す。

## 限界

- JS の保険の経路は、ほかの検索結果を巻き込まない側に倒してある。概要の中に小見出しがあると、
  そこで遡りを止めるため、見出しの部分だけが消えて本文が残ることがある。
  その場合は下の診断を取って CSS のセレクタを足す。
- 生成そのものは止まらない。見た目から隠すだけ。

## 診断（iPhone 可）

検索結果の URL の末尾に `#tmaio` を付けて開くと、画面下に診断パネルが出る。
「コピー」でレポートがクリップボードに入る。CSS ルールごとの一致数、JS が見つけた候補と
消した範囲、見えたまま残っている「AI」を含む見出しが出る。
コンソールが使える環境なら `__tmGoogleAio.dump()` でも同じものが出る。

## 検証

```bash
NODE_PATH=$(npm root -g) node test/google-hide-ai-overview.test.js
```

パソコン幅と iPhone 幅の模擬DOMで、目印付きの概要が入れ物ごと消える、見出しだけで分かる
概要が消える、通常の検索結果・「AI Overview とは」の記事・「他の人はこちらも質問」が残る、
使い回しで中身が変わったら表示に戻る、を確かめる。模擬DOMは Google の実DOMそのものではない。
