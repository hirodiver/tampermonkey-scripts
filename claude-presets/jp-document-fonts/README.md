# 日本語文書フォント設定（Claude 用）

日本語の文書を Claude に作らせるとき、毎回フォントを指定しなくても
日本語に合うフォントと日本語の言語設定が入るようにするための一式。

- **スキル**（`jp-document-fonts/`）：詳しいルール、ライブラリごとの書き方、確認スクリプト。Claude Code / Chat / Cowork で共通
- **指示文**（`instructions-snippet.md`）：常に読まれる場所に置く短い指示。スキルが呼ばれなかったときの保険

## 中身

```
jp-document-fonts/
├── README.md                  このファイル
├── instructions-snippet.md    貼り付け用の短い指示文
├── jp-document-fonts.zip      Chat / Cowork にアップロードする zip
└── jp-document-fonts/         スキル本体
    ├── SKILL.md               フォントの選び方と必須の設定
    ├── references/
    │   ├── docx.md            Word（python-docx / docx-js）
    │   ├── pptx.md            PowerPoint（python-pptx / PptxGenJS）
    │   └── pdf-html-xlsx.md   PDF・HTML・Excel
    └── scripts/
        └── check_jp_fonts.py  .docx / .pptx の確認と修正（--fix）
```

## 決めたルール

| 用途 | 本文 | 見出し |
|---|---|---|
| 迷ったとき・正式な文書・印刷・長文 | 游明朝 | 游ゴシック |
| 社内メモ、画面で読む簡単な文書 | 游ゴシック | 游ゴシック |
| スライド | 游ゴシック | 游ゴシック（太字） |
| 見やすさ重視 | BIZ UDPゴシック | BIZ UDPゴシック |
| 表計算 | 游ゴシック 11pt | — |

そのうえで、フォント名だけでなく次の2つを必ず入れる。

1. 東アジア用フォントの欄（Word は `w:eastAsia`、PowerPoint は `a:ea`）
2. 言語 `ja-JP`（HTML は `lang="ja"`）

## 導入のしかた

### Claude Code

1. スキルを個人用の場所にコピーする（全プロジェクトで使える）。

   ```bash
   mkdir -p ~/.claude/skills
   cp -r claude-presets/jp-document-fonts/jp-document-fonts ~/.claude/skills/
   ```

   Windows では `%USERPROFILE%\.claude\skills\jp-document-fonts\` に置く。
   特定のプロジェクトだけで使うなら、そのプロジェクトの `.claude/skills/` に置く。

2. `instructions-snippet.md` の枠の中を `~/.claude/CLAUDE.md` の末尾に追記する。

3. 新しいセッションで「日本語の報告書を docx で作って」などと頼み、スキルが使われるか確かめる。

### Chat と Cowork（claude.ai・デスクトップアプリ）

1. Settings（設定）→ Capabilities（機能）で「Code execution and file creation（コード実行とファイル作成）」を有効にする（スキルを使う条件）。
2. Customize（カスタマイズ）→ Skills（スキル）→「＋」→ Create skill → Upload a skill で
   `jp-document-fonts.zip` を選ぶ。Chat と Cowork は同じスキル一覧を使う。
3. 設定の「Claudeへの指示」（個人の設定）の末尾に `instructions-snippet.md` の枠の中を追記する。

claude.ai でオンにしたスキルは、同じアカウントでサインインした Claude Code にも
`~/.claude/skills/synced/` として同期される（Claude Code v2.1.273 以降）。
ただしクラウドのセッションや Cowork 以外のローカル環境では、手順 1 の方法で置いておくほうが確実。

zip を作り直すとき：

```bash
cd claude-presets/jp-document-fonts
rm -f jp-document-fonts.zip && zip -r jp-document-fonts.zip jp-document-fonts -x '*/__pycache__/*'
```

## 確認スクリプト

```bash
python3 jp-document-fonts/scripts/check_jp_fonts.py 文書.docx
python3 jp-document-fonts/scripts/check_jp_fonts.py 資料.pptx --fix
```

- `NG`：直さないと中国語の字形や Calibri になるおそれがあるもの
- `注意`：すぐには困らないが、直すとより確実なもの
- `--fix`：言語設定の抜け、PptxGenJS の文字コード指定、PowerPoint のテーマの空欄を直す

標準ライブラリだけで動く。

## 検証で分かったこと（2026年9月、docx 9.7.2・PptxGenJS 4.0.1・python-docx 1.2.0・python-pptx 1.0.2）

参考にしたまとめの内容に加えて、実際にファイルを作って XML を見たところ次のことが分かった。

- **PptxGenJS は `fontFace` を書くと、東アジア用フォントに中国語（簡体字）向けの文字コード指定 `charset="-122"` を入れる。** 日本語向けは `-128`。確認スクリプトの `--fix` で直す。
- **PptxGenJS の `lang` の既定は `en-US`。** 文字ごとに `lang: "ja-JP"` を書く必要がある。
- **PptxGenJS の `pres.theme` は英字用の欄にしか入らず、テーマの東アジア用フォントは空欄のまま。**
- **python-pptx の `font.name` と python-docx の `run.font.name` は英字用の欄しか変えない。** 東アジア用の欄は XML で足す。
- docx-js は `font: { ascii, hAnsi, eastAsia }` と `language: { value: "ja-JP", eastAsia: "ja-JP" }` をスタイルの既定に書けば、文書全体に効く。
- Claude が作業する Linux 環境には游明朝・游ゴシックがないことが多い。.docx / .pptx は名前を書けば相手の環境で表示されるが、PDF は作業環境のフォントで描かれるため、日本語用フォント（Noto Sans CJK JP、IPAex など）を名前で指定する。中国語用の WenQuanYi に置き換わると、漢字が中国語の形になる。

## 参考

- [Claudeで作ったWordの漢字が変なのは、フォントのせいじゃなかった（note）](https://note.com/yo_sato_pc/n/n5cd1502243b5)
- [@hakky_kazumasa のポスト（X）](https://x.com/hakky_kazumasa/status/2036374965520376235)
- [docx-jp（エージェント用スキル）](https://eliteai.tools/agent-skills/docx-jp)
- [Use skills in Claude（Claude ヘルプセンター）](https://support.claude.com/en/articles/12512180-use-skills-in-claude)
- [Extend Claude with skills（Claude Code ドキュメント）](https://code.claude.com/docs/en/skills)
