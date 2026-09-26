# PowerPoint（.pptx）の日本語フォント設定

入れるのは次の2つ。

- `a:latin` と `a:ea` に同じ日本語フォント（例：`游ゴシック`）
- `a:rPr` に `lang="ja-JP"`

## PptxGenJS

PptxGenJS には注意点が3つある（4.0.1 で確認）。

1. `lang` を書かないと `lang="en-US"` になる。
2. `pres.theme = { bodyFontFace }` はテーマの英字用の欄にしか入らず、東アジア用の欄は空のまま。テーマだけに頼らず、**文字ごとに `fontFace` と `lang` を必ず書く**。
3. `fontFace` を書くと、東アジア用の欄に**中国語（簡体字）向けの文字コード指定（`charset="-122"`）**が入る。仕上げに `scripts/check_jp_fonts.py --fix` で日本語向け（`charset="-128"`）に直す。

```javascript
const pptxgen = require("pptxgenjs");

const JA = { fontFace: "游ゴシック", lang: "ja-JP" };   // すべての addText に混ぜる

const pres = new pptxgen();
pres.layout = "LAYOUT_16x9";
pres.theme = { headFontFace: "游ゴシック", bodyFontFace: "游ゴシック", lang: "ja-JP" };

const slide = pres.addSlide();
slide.addText("見出し", { ...JA, x: 0.5, y: 0.4, w: 9, h: 0.8, fontSize: 32, bold: true });
slide.addText("本文です。骨・直・今。", { ...JA, x: 0.5, y: 1.4, w: 9, h: 3, fontSize: 20 });

// 表・グラフにも同じ指定を入れる
slide.addTable([[{ text: "項目", options: JA }, { text: "内容", options: JA }]], { ...JA, x: 0.5, y: 4.5, w: 9 });

pres.writeFile({ fileName: "out.pptx" }).then(() => {
  // 仕上げ：python3 scripts/check_jp_fonts.py out.pptx --fix
});
```

表は `addTable` の全体の指定とセルごとの `options` の両方に、グラフは `fontFace` 系の指定（`catAxisLabelFontFace` など）に同じフォントを入れる。

## python-pptx

python-pptx の `font.name` は `a:latin` しか変えない。`a:ea` と `lang` は XML で足す。

```python
from pptx import Presentation
from pptx.oxml.ns import qn
from pptx.util import Pt

FONT = "游ゴシック"

def set_jp_font(run, font_name=FONT):
    run.font.name = font_name                  # a:latin
    rPr = run._r.get_or_add_rPr()
    rPr.set("lang", "ja-JP")
    ea = rPr.find(qn("a:ea"))
    if ea is None:
        ea = rPr.makeelement(qn("a:ea"), {})
        latin = rPr.find(qn("a:latin"))
        latin.addnext(ea)                      # a:latin の直後に置く
    ea.set("typeface", font_name)

prs = Presentation()
slide = prs.slides.add_slide(prs.slide_layouts[1])
slide.shapes.title.text = "見出し"
slide.placeholders[1].text = "本文です。骨・直・今。"

for shape in slide.shapes:
    if shape.has_text_frame:
        for p in shape.text_frame.paragraphs:
            for r in p.runs:
                set_jp_font(r)

prs.save("out.pptx")
```

新しい文字列を足したあとは、上のループをもう一度通してから保存する。

## テンプレートごと直したいとき

`ppt/theme/theme1.xml` の `a:majorFont` と `a:minorFont` にある `<a:ea typeface=""/>` に
日本語フォントを入れると、個別に指定していない文字も日本語フォントになる。
`scripts/check_jp_fonts.py 対象.pptx --fix` はこの空欄を `游ゴシック` で埋める。
