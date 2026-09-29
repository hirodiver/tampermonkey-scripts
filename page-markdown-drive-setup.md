# ページ本文を「参考記事アーカイブ」へ保存する設定

保存先: https://drive.google.com/drive/folders/1WFV1mV24vc2ZwXxBhS2EjhKMhgiRNVRl

ボタンを押したときに本文または選択範囲をMarkdownでコピーし、このフォルダへ `.md` として保存する。AI・APIキーは不要。タイトル・元URL・取得日時を本文の先頭に残す。未設定なら従来どおりコピーだけ使える。

## 1. 受け口を一度だけ作る（PC推奨）

1. 保存先フォルダを使えるGoogleアカウントで https://script.google.com/ を開き、「新しいプロジェクト」を作る。名前は「参考記事アーカイブ受け口」。経費処理のプロジェクトとは別にする。
2. `コード.gs` の中身を [page-markdown-receiver.gs](page-markdown-receiver.gs) の全文に置き換えて保存する。保存先IDは設定済み。
3. 上部の関数一覧で `setup` を選び「実行」。Googleの権限画面でDriveへのアクセスを許可する。自作の未審査アプリとして警告される場合は、作成したプロジェクトであることを確認して進む。
4. 実行ログに「保存先: 参考記事アーカイブ」と、64文字のトークンが出る。そのトークンをコピーして手元に控える。GitHub・チャットには貼らない。`setup` を再実行しても同じ値が出る。
5. 「デプロイ」→「新しいデプロイ」→種類の歯車から「ウェブアプリ」。実行するユーザーを「自分」、アクセスできるユーザーを「全員」にしてデプロイする。「全員」が選べないWorkspaceでは管理者の設定変更または利用できるアカウントが必要。
6. 表示された `/exec` で終わるウェブアプリURLをコピーする。`/dev` は使わない。

## 2. Tampermonkeyへ設定する（端末ごと）

1. [ページ本文コピー](https://raw.githubusercontent.com/hirodiver/tampermonkey-scripts/main/page-to-markdown.user.js) を更新する。必要な版数は **v1.2.0**。権限追加の確認が出たら、接続先が `script.google.com` と `script.googleusercontent.com` であることを確認して更新する。後者はGASの応答転送先。
2. 通常のWebページを開き直す。PCではTampermonkeyの拡張機能メニュー、iPhoneではSafariの拡張機能からTampermonkeyを開き、「Drive保存を設定／停止」を選ぶ。
3. 先ほどのウェブアプリURLとトークンを順に入力する。設定はその端末・ブラウザのTampermonkeyに保存される。サイトのlocalStorageやGitHubには入らない。
4. 📋 ボタンを押す。成功すると「Driveに保存し、コピーしました」と表示される。フォルダを開き、できた `.md` の本文・元URLを確認する。iPhone実機の送信はこの手順で確認する。

## 使い方と結果

- 📋 ボタンまたは Alt+Shift+C：コピーと保存。選択範囲があれば選択範囲だけ。
- ファイル名：`取得日時_ページタイトル_送信ID.md`。日時は日本時間。送信IDは同名記事や再送を識別するため。
- 通信中の連打は無視する。同じ内容の再送は、同じページ表示中・取得日時表記が変わらない間なら同じIDで送り、GAS側でも同じファイルを再利用する。ページ再読み込み後や取得日時が変わったコピーは、新しい保存として扱う。
- 通信失敗でもコピーは先に実行する。コピーと保存の結果をそれぞれ区別して表示する。応答待ちが30秒を超えた場合、保存された可能性はあるためフォルダを確認する。
- コピーも失敗した場合はその旨を表示する。「必ず取りこぼさない」とは保証しない。
- 50万文字を超える本文はDrive送信を止めるがコピーは実行する。
- 保存停止：「Drive保存を設定／停止」でURLを空欄にして確定。コードを消さずにコピーだけへ戻せる。
- GASを修正した場合：「デプロイを管理」から該当デプロイを編集し、新バージョンで更新する。コードを保存するだけでは公開版は変わらない。
- トークンの変更：GASのプロジェクト設定→スクリプトプロパティから `ARCHIVE_TOKEN` を削除して `setup` を再実行し、各端末に新しいトークンを登録する。

## 検証の範囲

本文抽出の既存テストと、保存機能の模擬ブラウザ・GASサービスモックを使う。Googleへの実送信、ユーザーのGoogleアカウントでの認証・デプロイ、iOS Safariの拡張機能動作はこれらのテストとは別に確認が必要。

## 公式資料（2026年9月30日確認）

- https://developers.google.com/apps-script/guides/web
- https://developers.google.com/apps-script/guides/content
- https://developers.google.com/apps-script/reference/drive/folder
- https://www.tampermonkey.net/documentation.php?locale=en
