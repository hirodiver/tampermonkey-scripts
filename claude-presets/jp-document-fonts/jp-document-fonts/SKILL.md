---
name: jp-document-fonts
description: 日本語の文書・資料ファイル（Word/.docx、PowerPoint/.pptx、Excel/.xlsx、PDF、印刷用HTML）を作る・直すときに、フォントを指定されていなくても日本語に合うフォントと日本語の言語設定を自動で入れる。docx・pptx・xlsx・PDF を python-docx / docx(docx-js) / python-pptx / PptxGenJS / openpyxl / reportlab / HTML→PDF で生成するとき、また「漢字が中国語っぽい」「Calibri になる」「文字化けする」と言われたときに使う。
---

# 日本語文書のフォント

ユーザーがフォントを指定していない日本語の文書では、このルールで決める。ユーザーの指定があれば、そちらを優先する。

## 1. どのフォントにするか

| 用途 | 本文 | 見出し |
|---|---|---|
| 迷ったとき・正式な文書・印刷・長文（Word 標準と同じ） | 游明朝 | 游ゴシック |
| 社内メモ、画面で読む資料、箇条書きが中心の簡単な文書 | 游ゴシック | 游ゴシック |
| スライド | 游ゴシック（本文） | 游ゴシック（太字） |
| 高齢の方向け・見やすさ重視・案内文 | BIZ UDPゴシック | BIZ UDPゴシック |
| 表計算 | 游ゴシック 11pt（Excel 日本語版の標準） | — |

- 英数字も同じ日本語フォントにそろえる（Calibri・Arial・Times New Roman と混ぜない）。
- 1つの文書で使うフォントは2種類まで。
- ＭＳ 明朝・ＭＳ ゴシック・メイリオは、ユーザーが望んだときか、古い様式に合わせるときだけ使う。
- 文字の大きさの目安：Word 本文 10.5〜11pt、スライド本文 18pt 以上。

## 2. 必ず入れる設定（ここが一番大事）

フォント名を入れるだけでは足りない。次の2つがそろって初めて日本語の字形になる。

1. **東アジア用フォント欄**に日本語フォントを入れる
   - Word: `w:rFonts` の `w:eastAsia`（`w:ascii` と `w:hAnsi` も同じフォントに）
   - PowerPoint: `a:ea`（`a:latin` も同じフォントに）
2. **言語を日本語にする**
   - Word: `w:lang` の `w:val="ja-JP"` と `w:eastAsia="ja-JP"`
   - PowerPoint: `a:rPr` の `lang="ja-JP"`
   - HTML: `<html lang="ja">`

これが抜けると、フォントが Calibri のままになったり、「骨」「直」「今」などの漢字が中国語の形で表示されたりする。

各ライブラリでの書き方は次を読む。

- Word（python-docx / docx-js）→ `references/docx.md`
- PowerPoint（python-pptx / PptxGenJS）→ `references/pptx.md`
- PDF・HTML・Excel → `references/pdf-html-xlsx.md`

## 3. 仕上げの確認

.docx と .pptx は、渡す前にこのスキルのフォルダにある確認スクリプトを通す（標準ライブラリだけで動く）。

```bash
python3 <このスキルのフォルダ>/scripts/check_jp_fonts.py 出力ファイル.docx
python3 <このスキルのフォルダ>/scripts/check_jp_fonts.py 出力ファイル.pptx --fix   # 直せるものは直す
```

`NG` が出たら直してから渡す。`--fix` で直るのは、言語設定の抜け、PptxGenJS が入れる中国語向けの文字コード指定、PowerPoint のテーマの東アジア用フォントの空欄。フォントそのものの抜けは、コードを直して作り直す。

PDF や画像にしたときは、出来上がりを画像にして目で見る。とくに「骨」「直」「今」「角」「写」の形を見る。中国語の形になっていたら、フォントか言語設定が抜けている。

## 4. 作業環境のフォントについて

- 游明朝・游ゴシックは Windows と Office に入っている。Claude が作業するサーバー（Linux）には入っていないことが多い。
- .docx / .pptx は、フォント名を書くだけで相手の Windows / Office で正しく表示されるので、サーバーにフォントがなくてもそのまま指定してよい。
- PDF・画像は作業環境のフォントで描かれて埋め込まれる。`fc-list :lang=ja family` で日本語フォントを確かめ、Noto Sans CJK JP・Noto Serif CJK JP・IPAex・IPA のどれかをはっきり指定する。WenQuanYi・Droid Sans Fallback・Noto Sans CJK SC は中国語向けなので使わない。
