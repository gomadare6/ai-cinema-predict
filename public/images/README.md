# public/images/

## cinema-lobby.jpg （要配置）

ヒーロー背景に使うシネシティザートのロビー写真。**このファイルを置いてください。**

- ファイル名：`cinema-lobby.jpg`（`styles.css` の `.site-header__media` が参照）
- 推奨：横長（3:1 程度）、長辺 1600–2000px、JPEG 品質 75–82、~300KB 以下
- 未配置でもページは壊れません。ヒーローはネイビー地にフォールバックします。
- CSS 側で軽いぼかし（PC 4px / スマホ 3px）＋ネイビー半透明オーバーレイ
  （上 56% → 下 86%）＋タイトルの text-shadow を掛けて文字を優先しています。
  写真を差し替えたら `background-position`（現在 `center 42%`）だけ微調整可。

配置後の確認：
```
npm run dev         # http://localhost:5173/ を実ブラウザで
npm run build && npm run build:site   # dist/images/ にコピーされる
```
