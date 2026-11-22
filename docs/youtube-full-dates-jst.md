# YouTube Full Dates (JST) について

Greasy Fork の "YouTube Full Dates (v3)" (script id 564941) を元にした**独立フォーク**。
`@name` / `@namespace` / 更新URL をすべて差し替えているため、本家の更新は反映されない。

Tampermonkey はスクリプトを `@namespace` + `@name` で識別するため、本フォークは本家とは別スクリプトとして登録される。
本家を入れている場合は**本家を削除**すること（両方動くと日付を二重に書き換えて競合する）。
設定値（`GM_setValue`）もスクリプト単位で分かれるため、フォーク側では初期設定からやり直しになる。
