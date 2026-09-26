#!/usr/bin/env python3
"""日本語の .docx / .pptx のフォントと言語設定を確かめる（--fix で直せるものは直す）。

使い方:
    python3 check_jp_fonts.py 文書.docx [--fix]
    python3 check_jp_fonts.py 資料.pptx [--fix]

終了コード: 0 = NG なし、1 = NG あり、2 = 使い方の誤り
標準ライブラリだけで動く。
"""
import re
import shutil
import sys
import tempfile
import zipfile
from collections import Counter

DEFAULT_PPTX_FONT = "游ゴシック"

# 中国語・韓国語向けのフォント（日本語文書に入っていたら NG）
NON_JP_FONTS = re.compile(
    r"^(SimSun|NSimSun|SimHei|SimKai|KaiTi|FangSong|Microsoft YaHei.*|DengXian.*|等线.*|宋体|黑体|"
    r"微软雅黑|PMingLiU|MingLiU.*|新細明體|細明體|Microsoft JhengHei.*|微軟正黑體|"
    r"Malgun Gothic|맑은 고딕|Batang|바탕|Gulim|굴림|Dotum|돋움|"
    r"Noto Sans CJK (SC|TC|KR)|Noto Serif CJK (SC|TC|KR)|Noto Sans (SC|TC|KR)|"
    r"Source Han Sans (SC|TC|K)|WenQuanYi.*|Droid Sans Fallback)$"
)
KANA = re.compile(r"[぀-ヿ]")
CJK = re.compile(r"[぀-ヿ㐀-鿿＀-￯]")


class Report:
    def __init__(self):
        self.ng, self.warn, self.fixed = [], [], []

    def show(self, fonts):
        if fonts:
            print("使われているフォント: " + "、".join(f"{f}（{n}）" for f, n in fonts.most_common()))
        for msg in self.fixed:
            print(f"直した: {msg}")
        for msg in self.ng:
            print(f"NG: {msg}")
        for msg in self.warn:
            print(f"注意: {msg}")
        if not self.ng and not self.warn:
            print("OK: 問題は見つかりませんでした。")
        return 1 if self.ng else 0


def read_parts(path, pattern):
    with zipfile.ZipFile(path) as z:
        return {n: z.read(n).decode("utf-8") for n in z.namelist() if re.fullmatch(pattern, n)}


def write_parts(path, changed):
    """zip 内の変更したパーツだけ差し替える（ほかのパーツと順序はそのまま）"""
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".tmp")
    tmp.close()
    with zipfile.ZipFile(path) as src, zipfile.ZipFile(tmp.name, "w", zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            data = changed[item.filename].encode("utf-8") if item.filename in changed else src.read(item.filename)
            dst.writestr(item, data)
    shutil.move(tmp.name, path)


def text_of(xml, tag):
    return "".join(re.findall(rf"<{tag}(?: [^>]*)?>([^<]*)</{tag}>", xml))


# ---------------------------------------------------------------- docx

def check_docx(path, fix):
    rep, fonts = Report(), Counter()
    parts = read_parts(path, r"word/(document|styles|header\d*|footer\d*|footnotes|endnotes)\.xml")
    styles = parts.get("word/styles.xml", "")
    body = "".join(text_of(x, "w:t") for n, x in parts.items() if n != "word/styles.xml")
    if not CJK.search(body):
        rep.warn.append("本文に日本語が見つかりません。日本語の文書でなければ、この確認は不要です。")

    changed = {}
    for name, xml in parts.items():
        for m in re.finditer(r"<w:rFonts\b[^>]*/>", xml):
            for attr in ("ascii", "hAnsi", "eastAsia"):
                f = re.search(rf'w:{attr}="([^"]*)"', m.group(0))
                if f:
                    fonts[f.group(1)] += 1
        # 中国語・韓国語の言語設定を日本語に
        zh = re.findall(r'<w:lang\b[^>]*w:eastAsia="(zh|ko)-[^"]*"', xml)
        if zh:
            if fix:
                xml = re.sub(r'(<w:lang\b[^>]*w:eastAsia=")(?:zh|ko)-[^"]*"', r'\1ja-JP"', xml)
                changed[name] = xml
                rep.fixed.append(f"{name}: 東アジアの言語が中国語・韓国語の箇所 {len(zh)} か所を ja-JP に")
            else:
                rep.ng.append(f"{name}: 東アジアの言語が中国語・韓国語の箇所が {len(zh)} か所あります（--fix で直せます）")
        # rFonts があって eastAsia の指定がない run
        loose = [m for m in re.findall(r"<w:rFonts\b[^>]*/>", xml)
                 if 'w:ascii="' in m and "w:eastAsia" not in m]
        if loose and name != "word/styles.xml":
            rep.warn.append(f"{name}: 英字用フォントだけ指定されて東アジア用フォントがない run が {len(loose)} 個あります")

    for f in fonts:
        if NON_JP_FONTS.match(f):
            rep.ng.append(f"中国語・韓国語向けのフォント「{f}」が使われています")

    # 文書全体の既定（docDefaults）と標準スタイル
    defaults = re.search(r"<w:rPrDefault>.*?</w:rPrDefault>", styles, re.S)
    normal = re.search(r'<w:style\b[^>]*w:styleId="(?:a|Normal)"[^>]*>.*?</w:style>', styles, re.S)
    scope = (defaults.group(0) if defaults else "") + (normal.group(0) if normal else "")
    if not re.search(r'<w:rFonts\b[^>]*w:eastAsia="[^"]+"', scope):
        rep.ng.append("文書全体の既定と標準スタイルに東アジア用フォント（w:eastAsia）がありません（スタイルに日本語フォントを入れてください）")
    if not re.search(r'<w:lang\b[^>]*w:eastAsia="ja-JP"', scope):
        if fix and defaults:
            new_default = defaults.group(0)
            if "<w:lang" in new_default:
                new_default = re.sub(r"<w:lang\b[^>]*/>", '<w:lang w:val="ja-JP" w:eastAsia="ja-JP"/>', new_default)
            elif "<w:rPr/>" in new_default:
                new_default = new_default.replace("<w:rPr/>", '<w:rPr><w:lang w:val="ja-JP" w:eastAsia="ja-JP"/></w:rPr>')
            else:
                new_default = new_default.replace("</w:rPr>", '<w:lang w:val="ja-JP" w:eastAsia="ja-JP"/></w:rPr>')
            styles = changed.get("word/styles.xml", styles).replace(defaults.group(0), new_default)
            changed["word/styles.xml"] = styles
            rep.fixed.append("文書全体の既定に言語 ja-JP を設定")
        else:
            rep.ng.append("文書全体の既定と標準スタイルに言語 ja-JP（w:lang w:eastAsia）がありません（--fix で直せます）")

    if fix and changed:
        write_parts(path, changed)
    return rep.show(fonts)


# ---------------------------------------------------------------- pptx

def check_pptx(path, fix):
    rep, fonts = Report(), Counter()
    parts = read_parts(path, r"ppt/(slides/slide\d+|slideLayouts/slideLayout\d+|slideMasters/slideMaster\d+|theme/theme\d+|notesSlides/notesSlide\d+)\.xml")
    slides = {n: x for n, x in parts.items() if n.startswith("ppt/slides/")}
    if not CJK.search("".join(text_of(x, "a:t") for x in slides.values())):
        rep.warn.append("スライドに日本語が見つかりません。日本語の資料でなければ、この確認は不要です。")

    changed = {}
    for name, xml in parts.items():
        orig = xml
        for f in re.findall(r'<a:(?:latin|ea)\b[^>]*typeface="([^"+][^"]*)"', xml):
            fonts[f] += 1

        # 東アジア用の欄に中国語向けの文字コード（PptxGenJS は -122 = GB2312 を入れる）
        bad_cs = re.findall(r'<a:ea\b[^>]*charset="(-122|-120|-127|134|136|129)"', xml)
        if bad_cs:
            if fix:
                xml = re.sub(r'(<a:ea\b[^>]*charset=")(?:-122|-120|-127|134|136|129)"', r'\1-128"', xml)
                rep.fixed.append(f"{name}: 東アジア用フォントの文字コード指定 {len(bad_cs)} か所を日本語向けに")
            else:
                rep.ng.append(f"{name}: 東アジア用フォントに中国語・韓国語向けの文字コード指定が {len(bad_cs)} か所あります（--fix で直せます）")

        if name.startswith("ppt/slides/"):
            # 日本語を含む run と、段落末の設定の言語
            bad_lang = 0
            def fix_run(m):
                nonlocal bad_lang
                run = m.group(0)
                if CJK.search(text_of(run, "a:t")) and not re.search(r'<a:rPr\b[^>]*lang="ja', run):
                    bad_lang += 1
                    if fix:
                        if re.search(r"<a:rPr\b[^>]*\blang=", run):
                            run = re.sub(r'(<a:rPr\b[^>]*\blang=")[^"]*"', r'\1ja-JP"', run, count=1)
                        elif "<a:rPr" in run:
                            run = re.sub(r"<a:rPr\b", '<a:rPr lang="ja-JP"', run, count=1)
                        else:
                            run = run.replace("<a:r>", '<a:r><a:rPr lang="ja-JP"/>', 1)
                return run
            xml = re.sub(r"<a:r>.*?</a:r>", fix_run, xml, flags=re.S)
            if bad_lang:
                if fix:
                    xml = re.sub(r'(<a:endParaRPr\b[^>]*\blang=")en-US"', r'\1ja-JP"', xml)
                    rep.fixed.append(f"{name}: 日本語の文字 {bad_lang} か所の言語を ja-JP に")
                else:
                    rep.ng.append(f"{name}: 日本語の文字なのに言語が ja-JP でない箇所が {bad_lang} か所あります（--fix で直せます）")
            no_ea = [r for r in re.findall(r"<a:rPr\b[^>]*>.*?</a:rPr>", xml, re.S)
                     if "<a:latin" in r and "<a:ea" not in r]
            if no_ea:
                rep.ng.append(f"{name}: 英字用フォントだけ指定されて東アジア用フォント（a:ea）がない箇所が {len(no_ea)} か所あります（a:ea を足してください）")

        if name.startswith("ppt/theme/"):
            empty = re.findall(r'<a:(?:majorFont|minorFont)>.*?</a:(?:majorFont|minorFont)>', xml, re.S)
            n_empty = sum(1 for blk in empty if '<a:ea typeface=""' in blk)
            if n_empty:
                if fix:
                    jp = [f for f, _ in fonts.most_common() if CJK.search(f) or f.startswith(("Yu ", "Meiryo", "BIZ", "Noto Sans JP", "Hiragino"))]
                    font = jp[0] if jp else DEFAULT_PPTX_FONT
                    xml = re.sub(r"(<a:(majorFont|minorFont)>.*?)<a:ea typeface=\"\"\s*/>",
                                 rf'\1<a:ea typeface="{font}"/>', xml, flags=re.S)
                    rep.fixed.append(f"{name}: テーマの東アジア用フォントの空欄を「{font}」で埋めた")
                else:
                    rep.warn.append(f"{name}: テーマの東アジア用フォントが空欄です（--fix で埋めます）")

        if xml != orig:
            changed[name] = xml

    for f in fonts:
        if NON_JP_FONTS.match(f):
            rep.ng.append(f"中国語・韓国語向けのフォント「{f}」が使われています")
    if fix and changed:
        write_parts(path, changed)
    return rep.show(fonts)


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    fix = "--fix" in argv
    if len(args) != 1:
        print(__doc__)
        return 2
    path = args[0]
    print(f"== {path}")
    if path.lower().endswith((".docx", ".dotx")):
        return check_docx(path, fix)
    if path.lower().endswith((".pptx", ".potx")):
        return check_pptx(path, fix)
    print("対応しているのは .docx と .pptx です。")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
