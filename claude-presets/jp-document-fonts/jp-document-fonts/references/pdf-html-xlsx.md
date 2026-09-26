# PDF・HTML・Excel の日本語フォント設定

## HTML（画面で見るもの・印刷用・PDF の元）

```html
<html lang="ja">
```

```css
/* ゴシック（画面・資料の標準） */
font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Meiryo",
             "Noto Sans JP", "Noto Sans CJK JP", sans-serif;

/* 明朝（読み物・正式な文書） */
font-family: "Hiragino Mincho ProN", "Yu Mincho", "YuMincho",
             "Noto Serif JP", "Noto Serif CJK JP", serif;
```

- `lang="ja"` がないと、同じフォントでも漢字が中国語の形になることがある。
- ユーザー自身のデザインガイドやプロジェクトの決まりがあれば、そちらを優先する。

## PDF

PDF は作業環境のフォントで描いて埋め込むので、**作業環境にある日本語フォントを名前で指定**する。

```bash
fc-list :lang=ja family      # 日本語フォントを確かめる
```

使ってよい：Noto Sans CJK JP / Noto Serif CJK JP / Noto Sans JP / IPAexGothic / IPAexMincho / IPAGothic / IPAMincho
使わない：WenQuanYi、Droid Sans Fallback、Noto Sans CJK SC・TC（中国語向け）

### HTML から PDF にする（Chromium / Playwright / WeasyPrint）

上の HTML の決まりに加えて、`font-family` の先頭に作業環境にある日本語フォントを入れる。
例：`font-family: "Noto Sans CJK JP", "IPAGothic", sans-serif;`

### reportlab

```python
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# 作業環境の日本語フォントのファイルを登録して埋め込む（パスは fc-list で調べる）
pdfmetrics.registerFont(TTFont("JP", "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf"))
# 以後 canvas.setFont("JP", 11) や ParagraphStyle(fontName="JP") で使う
```

.ttc（Noto Sans CJK など）は `TTFont("JP", path, subfontIndex=0)` のように番号を指定し、
番号ごとに日本語（JP）のものか確かめる。フォントが見つからないときは、
`from reportlab.pdfbase.cidfonts import UnicodeCIDFont` で `HeiseiKakuGo-W5`（ゴシック）
または `HeiseiMin-W3`（明朝）を登録する（埋め込まれないので、見る側の環境に頼る）。

### 仕上がりの確認

```bash
pdffonts out.pdf                 # 埋め込まれたフォント名を見る
pdftoppm -png -r 80 out.pdf page # 画像にして「骨・直・今」の形を目で確かめる
```

## Excel（openpyxl）

```python
from openpyxl.styles import Font

JP = "游ゴシック"
for row in ws.iter_rows():
    for cell in row:
        cell.font = Font(name=JP, size=cell.font.size or 11,
                         bold=cell.font.bold, color=cell.font.color)
```

新しいブックの標準フォントは Calibri なので、書き込んだセルにはすべて上のように入れる。
