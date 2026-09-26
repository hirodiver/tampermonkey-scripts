# Word（.docx）の日本語フォント設定

方針：一つひとつの文字列ではなく、**スタイル（標準・見出し）と文書全体の既定**にまとめて入れる。
入れるのは次の3つ。

- `w:rFonts` の `w:ascii` `w:hAnsi` `w:eastAsia`（同じ日本語フォント）
- `w:asciiTheme` などのテーマ指定は消す（残すとテーマのフォントが勝つ）
- `w:lang w:val="ja-JP" w:eastAsia="ja-JP"`

フォント名は日本語表記（`游明朝`、`游ゴシック`）で書く。日本語版 Word が自分で保存するときと同じ書き方。

## python-docx

```python
from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt

BODY_FONT = "游明朝"      # 簡単な文書なら "游ゴシック"
HEADING_FONT = "游ゴシック"

def set_jp_font(el, font_name):
    """スタイル・run・既定（rPrDefault）に日本語フォントと日本語の言語設定を入れる"""
    if hasattr(el, "get_or_add_rPr"):          # スタイルや run
        rPr = el.get_or_add_rPr()
    else:                                      # w:rPrDefault
        rPr = el.find(qn("w:rPr"))
        if rPr is None:
            rPr = OxmlElement("w:rPr")
            el.append(rPr)
    rFonts = rPr.find(qn("w:rFonts"))
    if rFonts is None:
        rFonts = OxmlElement("w:rFonts")
        rPr.insert(0, rFonts)
    for attr in ("w:asciiTheme", "w:hAnsiTheme", "w:eastAsiaTheme", "w:cstheme"):
        rFonts.attrib.pop(qn(attr), None)
    for attr in ("w:ascii", "w:hAnsi", "w:eastAsia"):
        rFonts.set(qn(attr), font_name)
    lang = rPr.find(qn("w:lang"))
    if lang is None:
        lang = OxmlElement("w:lang")
        rPr.append(lang)
    lang.set(qn("w:val"), "ja-JP")
    lang.set(qn("w:eastAsia"), "ja-JP")

doc = Document()

# 文書全体の既定（docDefaults）
rpr_default = doc.styles.element.find(qn("w:docDefaults")).find(qn("w:rPrDefault"))
set_jp_font(rpr_default, BODY_FONT)

# 標準スタイル
normal = doc.styles["Normal"]
set_jp_font(normal.element, BODY_FONT)
normal.font.size = Pt(10.5)

# 見出し・表題
for name in ("Title", "Heading 1", "Heading 2", "Heading 3"):
    set_jp_font(doc.styles[name].element, HEADING_FONT)

doc.add_heading("見出し", level=1)
doc.add_paragraph("本文です。骨・直・今。")
doc.save("out.docx")
```

後から `run.font.name = "..."` を使うと、`ascii` と `hAnsi` しか変わらない。
run ごとにフォントを変えるときも `set_jp_font(run._element, ...)` を使う。

## docx（docx-js / npm の `docx`）

```javascript
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require("docx");

const BODY = "游明朝";      // 簡単な文書なら "游ゴシック"
const HEAD = "游ゴシック";
const jaFont = (name) => ({ ascii: name, hAnsi: name, eastAsia: name });
const jaLang = { value: "ja-JP", eastAsia: "ja-JP" };

const doc = new Document({
  styles: {
    default: {
      document: { run: { font: jaFont(BODY), language: jaLang, size: 21 } }, // 21 = 10.5pt
      heading1: { run: { font: jaFont(HEAD), language: jaLang, bold: true, size: 28 } },
      heading2: { run: { font: jaFont(HEAD), language: jaLang, bold: true, size: 24 } },
      title:    { run: { font: jaFont(HEAD), language: jaLang, bold: true, size: 32 } },
    },
  },
  sections: [{
    children: [
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("見出し")] }),
      new Paragraph({ children: [new TextRun("本文です。骨・直・今。")] }),
    ],
  }],
});
Packer.toBuffer(doc).then((buf) => require("fs").writeFileSync("out.docx", buf));
```

`font: "游明朝"` のように文字列1つで書くと、東アジア用の欄に入らない場合がある。
必ず `{ ascii, hAnsi, eastAsia }` の形で書く。

## 既存の .docx を直すとき

1. `word/styles.xml` の `w:docDefaults` と、使われているスタイルに上の3つを入れる。
2. `word/document.xml` の run に `w:rFonts` があり `w:eastAsia` がないものは、`w:eastAsia` を足す。
3. `python3 scripts/check_jp_fonts.py 対象.docx --fix` で言語設定の抜けを埋め、残りの `NG` を確認する。
