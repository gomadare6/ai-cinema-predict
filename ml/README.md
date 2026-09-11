# ml/ — 機械学習による混雑予測（STEP 10：実装・学習・評価まで）

Web UI には接続していない。現在の統計予測（`src/predictor.js`）は一切変更していない。

## 実行環境（再現性）

| | バージョン |
|---|---|
| Python | 3.14.5 |
| scikit-learn | 1.9.0 |
| numpy | 2.5.0 |
| joblib | 1.5.3 |

- 新規パッケージのインストールなし（すべて既存）。pandas は未使用（標準 `csv` + numpy）。
- `random_state = 42` を全モデルで固定。
- 定数（学習/検証期間・`<10%` 閾値）は `src/config.js` と一致（`test_ml.py` で検証）。

## パイプライン

```
python build_dataset.py   # data/*.csv -> ml/derived/dataset_{train,test,all}.csv
python train.py           # ml/derived/dataset_train.csv -> ml/model/{dummy,rf,hgb}.joblib
python evaluate.py        # 検証期間で 全方式を採点・比較表
python predict_all.py     # 全21,900上映 -> ml/derived/ml-predictions.csv（STEP 11 用。今は未接続）
python test_ml.py         # リーク・整合・再現性チェック（26 assert）
```

すべて `ml/` ディレクトリ内で実行する（`from common import ...` のため）。

## 目的変数

`実績混雑率(%) = 対象上映IDの ticket_sales 行数 ÷ その上映のスクリーン座席数 × 100`
（`src/dataset.js` と同一。学習期間の平均が `derived/global_avg.json` と一致することを検証済み）

## 特徴量（すべて上映開始前に確定・リークなし）

- 直接：`start_slot`（6枠のカテゴリ）, `seat_capacity`, `month`
- 履歴（**学習期間 2025-01-01〜09-30 の実績のみ**から算出。学習行は 5-fold OOF、検証行は学習全体の辞書）：
  `hist_fallback_pred`（= 現在の統計予測そのもの：作品×スクリーン→スクリーン→全体）,
  作品×スクリーン平均/件数, 作品平均/件数, スクリーン平均/件数,
  ジャンル×スクリーン平均, ジャンル×座席帯平均, 配給社平均, 全体平均,
  `has_movie_screen_history`, `has_movie_history`

生カテゴリ（`screen_id` / `genre` / `distributor` / 曜日 / 特別日 / レイトショー）は**不採用**。
STEP 2 で混雑率との相関がほぼゼロ（eta²≈0）と確認済みで、学習期間の作品固有パターンを
検証期間の新作へ持ち込む過学習面にしかならなかった（初期版で MAE 6.3、コールドスタート悪化）。

## 除外した特徴量（データリーク）

- 対象上映の ticket_sales 実績・販売席数・購入者属性・購入日時・券種・チャネル・支払金額・グループ情報
- `movies.csv` の動員数合計・興行収入合計（年間累計＝検証期間を含む時系列リーク）
- `movies.csv` の公開日・終映日・上映日数 由来の recency（STEP 1 で schedules と矛盾）

## モデル

- `DummyRegressor(mean)` — 下限
- `RandomForestRegressor` — 比較用（不採用。保存肥大回避のため小さめ）
- `HistGradientBoostingRegressor` — 第一候補。`loss="absolute_error"`, `learning_rate=0.03`,
  `max_iter=500`, `max_leaf_nodes=15`, `min_samples_leaf=120`, `l2_regularization=5.0`,
  `early_stopping=True`, ネイティブ categorical + 欠損。
  単調制約（`hist_fallback_pred` 増加 / `seat_capacity` 減少）も試したが改善なし。

## 結果（検証 2025-10-01〜12-31, n=5,520）

| 方法 | MAE | F1(<10%) | コールドスタートMAE | 日次トップ1的中 |
|---|---:|---:|---:|---:|
| 全体平均 | 8.69 | – | 9.94 | – |
| 作品平均 | 7.70 | 0.104 | 10.07 | – |
| 作品×スクリーン | 6.53 | 0.371 | 9.94 | – |
| **現在の統計予測** | **4.28** | **0.795** | **5.90** | **82.6%** |
| RandomForest | 5.37 | 0.352 | 7.93 | 71.7% |
| HistGradientBoosting | 4.94 | 0.726 | 7.08 | 89.1% |

**判定：統計予測を継続。** ML は MAE・F1・コールドスタートいずれも統計予測に届かなかった
（HGB は日次トップ1的中のみ上回る）。Web には接続しない。

### なぜ ML が勝てなかったか

- warm 区間（作品×スクリーン履歴あり, 44%）は統計予測が既に MAE 2.26 とほぼ最適。HGB も 2.28 で並ぶだけ。
- コールドスタート（56%）は `hist_screen_avg` 以上の信号がデータに乏しく、統計予測の
  「→ スクリーン平均」ルール（MAE 5.90）が実質的な下限。HGB は warm 主体の学習分布から
  補正を学ぶため、cold 行でむしろ悪化（7.08）。
- STEP 2 の通り 曜日・時間帯・レイト・特別日は無相関、ジャンル・月は微弱で、ML が発見できる隠れ特徴がない。
- 学習は 1〜9 月のみで検証は 10〜12 月。季節性は外挿しかできず、複数年データなしには解消不能。

STEP 9 の事前予測（「4.28 を超えられない可能性は十分あり、伸びしろは実質コールドスタートのみ」）と一致。
