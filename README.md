# tampermonkey-scripts

個人用の Tampermonkey ユーザースクリプト置き場。
公開リポジトリなので、**秘密にすべき情報は置かないこと**。

## 収録スクリプト

### X YouTube Card - Open in Browser

X(Twitter) のタイムライン上のYouTubeカードに「▶ YouTubeで開く」ボタンを追加し、
X内蔵プレイヤーを経由せずにYouTubeを開く。

- 本体: [`x-youtube-card-open-in-browser.user.js`](x-youtube-card-open-in-browser.user.js)
- 仕様書: [`SPEC.md`](SPEC.md)

**インストール**（Safari で開くと Tampermonkey のインストール画面が出る）

```
https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/x-youtube-card-open-in-browser.user.js
```

`@updateURL` を設定済みのため、インストール後は Tampermonkey が自動で更新を拾う。

## 更新の手順

1. スクリプトを修正する
2. **`@version` を上げる**（これを忘れると自動更新が配信されない）
3. `SPEC.md` の変更履歴とバージョンを更新する
4. `main` へプッシュする

`@version` を上げずにプッシュしても、既存の利用者には何も届かない。

## 設計上の要点

詳細は `SPEC.md` にあるが、壊しやすい箇所を挙げておく。

- **`@inject-into page` は必須**。React の `__reactProps$` / `__reactFiber$` は
  isolated world から参照できず、URL解決の主要経路が死ぬ
- **`@connect` はリダイレクト先も宣言する**。`publish.twitter.com` は
  `publish.x.com` へ飛ぶため、両方ないと遮断される
- ボタンが一切出なくなったら、まず `[data-testid="card.wrapper"]` の変更を疑う
