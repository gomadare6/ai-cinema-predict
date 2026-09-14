# AI 空いてる映画

映画館「シネシティザート」の 2025 年の上映・販売データから、各上映の**混雑率を予測**し、
**空いている見込みの上映を探せる**ようにする Web アプリ（コンテスト提出用プロトタイプ）。

「何を観るか」ではなく「いつ行けば空いているか」を起点にした体験。

## セットアップ

```bash
# 依存パッケージなし（Node.js のビルトインのみ。要 Node 18+ 目安、開発は v24）
npm run build        # data/*.csv -> derived/（予測用集計）-> derived/ui-showings.json
npm run dev          # http://localhost:5173 で開発サーバー
npm test             # Node テスト（87 件）
```

## ビルド／公開

```bash
npm run build        # 予測データ生成
npm run build:site   # dist/ に静的サイトを組み立て
```

| 項目 | 値 |
|---|---|
| 公開ディレクトリ | `dist/` |
| ビルドコマンド | `npm run build && npm run build:site` |
| 出力ディレクトリ | `dist/`（`index.html` / `styles.css` / `js/` / `derived/ui-showings.json`） |
| 環境変数・APIキー | なし（外部 API・DB・認証なし） |

`dist/` を Cloudflare Pages 等の静的ホスティングにそのまま配置できる。

### Cloudflare Pages への公開手順

1. このリポジトリを GitHub に push する。
2. [Cloudflare ダッシュボード](https://dash.cloudflare.com/) → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git** で、push した GitHub リポジトリを選択する。
3. ビルド設定を以下のとおり入力する。

   | 項目 | 値 |
   |---|---|
   | Framework preset | None |
   | Build command | `npm run build && npm run build:site` |
   | Build output directory | `dist` |
   | Root directory | `/`（リポジトリ直下） |
   | 環境変数 | 設定不要（外部 API・キーなし） |

4. Save and Deploy を押すとビルドが走り、`https://<project>.pages.dev` が発行される。以降は GitHub の該当ブランチに push するたびに自動で再ビルド・再公開される。
5. スマホ・PC どちらも、発行された URL を開くだけで利用できる（インストール不要・ログイン不要）。

## 予測方式（本番＝統計予測）

上映ごとに、学習期間 **2025-01-01〜2025-09-30** の実績だけを使った過去平均でフォールバック：

1. 同じ **作品 × スクリーン** の過去平均混雑率
2. なければ **スクリーン** の過去平均混雑率
3. なければ **全体平均**

- 混雑率(%) = 販売された座席数 ÷ スクリーンの座席数 × 100（`ticket_sales` 1 行 = 1 座席）
- 「空いている」判定：予測混雑率 **< 10%**（丸め前の値で判定）
- ランキング：予測混雑率の低い順 → 上映日時 → 上映ID

検証期間 2025-10-01〜12-31（5,520 上映）での MAE = **4.28**。

予測ロジックは `src/predictor.js`、UI は `public/`（表示のみ・予測値は再計算しない）。

## 機械学習の比較検証（`ml/`・本番未接続）

統計予測をベースラインに scikit-learn（HistGradientBoosting / RandomForest）を比較した。

| 方法 | MAE |
|---|---:|
| 現在の統計予測 | **4.28** |
| HistGradientBoosting | 4.94 |
| RandomForest | 5.37 |

今回のデータでは統計予測が最も良かった（warm 区間は統計予測が既にほぼ最適、コールドスタート 56% に
ML が発見できる追加信号がない、学習が 1〜9 月のみで季節性を外挿できない）。
このため **本番は統計予測を採用し、ML は検証結果として `ml/` に残す**。詳細は `ml/README.md`。

```bash
cd ml && python build_dataset.py && python train.py && python evaluate.py && python test_ml.py
# 要 scikit-learn 1.9 / numpy 2.5（インストール済み前提。pandas 不使用）
```

## ディレクトリ

```
data/        元CSV（読み取り専用・未変更）
derived/     予測用集計 + ui-showings.json（npm run build で生成）
src/         予測エンジン（config / csv / dataset / buildAggregates / predictor）
scripts/     build-aggregates / build-ui-data / build-site / serve / verify-step3
public/      Web UI（index.html / styles.css / js/）
test/        Node テスト 87 件
ml/          ML 比較検証（本番未接続）
dist/        提出用静的サイト（build:site で生成・gitignore）
```
