"""ML パイプラインの検証（assert ベース。pytest 不要）。

  python ml/test_ml.py

チェック:
  1. 定数が src/config.js と一致
  2. 目的変数（実績混雑率）が derived/global_avg.json と整合
  3. train/test の期間が重ならない・件数が既知値
  4. 禁止特徴量が dataset に混入していない
  5. 履歴特徴量が「学習期間のみ」から作られている（検証行の y を混ぜると値が変わる）
  6. dataset_all の履歴が dataset_test と一致（同じ辞書を使っている）
  7. モデル成果物が読める・予測が決定的
  8. ml-predictions.csv が全上映をカバー
"""

from __future__ import annotations

import csv
import json
import os
import re
import subprocess
import sys

import joblib
import numpy as np

from common import (
    DATA_DIR,
    DERIVED_DIR,
    MODEL_DIR,
    PROJECT_ROOT,
    TRAINING_END,
    TRAINING_START,
    VACANCY_THRESHOLD_PCT,
    VALIDATION_END,
    VALIDATION_START,
    load_showings,
)
from features import build_history_tables, rows_to_matrix
from train import load_dataset_csv

PASS = 0
FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}  {detail}")


# 1. 定数一致 -------------------------------------------------------------
cfg = open(os.path.join(PROJECT_ROOT, "src", "config.js"), encoding="utf-8").read()
def _js(key):
    m = re.search(key + r":\s*'?([0-9-]+)'?", cfg)
    return m.group(1) if m else None

check("定数: TRAINING_START", _js("TRAINING_START") == TRAINING_START, _js("TRAINING_START"))
check("定数: TRAINING_END", _js("TRAINING_END") == TRAINING_END, _js("TRAINING_END"))
check("定数: VALIDATION_START", _js("VALIDATION_START") == VALIDATION_START)
check("定数: VALIDATION_END", _js("VALIDATION_END") == VALIDATION_END)
check("定数: VACANCY_THRESHOLD_PCT", _js("VACANCY_THRESHOLD_PCT") == str(int(VACANCY_THRESHOLD_PCT)))

# 2. 目的変数の整合 ----------------------------------------------------------
rows = load_showings()
train_rows = [r for r in rows if r["split"] == "train"]
test_rows = [r for r in rows if r["split"] == "test"]
g_train = sum(r["y"] for r in train_rows) / len(train_rows)
ga = json.load(open(os.path.join(PROJECT_ROOT, "derived", "global_avg.json"), encoding="utf-8"))
check(
    "目的変数: 学習期間の平均混雑率が derived/global_avg.json と一致",
    abs(g_train - ga["平均混雑率"]) < 1e-9,
    f"{g_train} vs {ga['平均混雑率']}",
)
check("目的変数: 値域 0〜100", all(0 <= r["y"] <= 100 for r in rows))

# 3. 期間分割 ------------------------------------------------------------
check("分割: train 件数 = 16,380", len(train_rows) == 16380, len(train_rows))
check("分割: test 件数 = 5,520", len(test_rows) == 5520, len(test_rows))
tr_dates = {r["show_date"] for r in train_rows}
te_dates = {r["show_date"] for r in test_rows}
check("分割: train/test の日付が重ならない", tr_dates.isdisjoint(te_dates))
check("分割: train は学習期間内のみ", max(tr_dates) <= TRAINING_END and min(tr_dates) >= TRAINING_START)
check("分割: test は検証期間内のみ", min(te_dates) >= VALIDATION_START and max(te_dates) <= VALIDATION_END)

# 4. 禁止特徴量の非混入 -----------------------------------------------------
ds_train = load_dataset_csv("dataset_train.csv")
cols = set(ds_train[0].keys())
forbidden_substr = [
    "購入", "顧客", "会員", "年齢", "性別", "券種", "支払", "チャネル", "グループ",
    "動員", "興行", "公開日", "終映", "上映日数", "販売席", "sold_seat",
]
bad = [c for c in cols for s in forbidden_substr if s in c and c not in ("n_sold",)]
check("特徴量: 禁止列が dataset に無い", not bad, str(bad))
check("特徴量: n_sold は参考列（feature に含めない）", "n_sold" in cols)

# 5. 履歴のリーク防止（検証行の y を混ぜると履歴平均が変わる） -----------------
tbl_train_only = build_history_tables(train_rows)
tbl_with_test = build_history_tables(train_rows + test_rows)
# test にしか出ない (movie, screen) を1つ探す
tr_keys = {(r["movie_id"], r["screen_id"]) for r in train_rows}
diff_key = next(
    ((r["movie_id"], r["screen_id"]) for r in test_rows if (r["movie_id"], r["screen_id"]) not in tr_keys),
    None,
)
check("履歴: 検証のみに出る作品×スクリーンが存在（コールドスタート）", diff_key is not None)
check(
    "履歴: 学習のみ辞書に検証キーが無い（未来を使っていない）",
    diff_key not in tbl_train_only["movie_screen"],
)
check(
    "履歴: 検証を混ぜた辞書には出現（＝現行は正しく除外できている）",
    diff_key in tbl_with_test["movie_screen"],
)
# global もズレる
check(
    "履歴: global 平均が train のみと train+test で異なる",
    abs(tbl_train_only["global"] - tbl_with_test["global"]) > 1e-6,
)

# 6. dataset_all と dataset_test の履歴一致 ---------------------------------
ds_all = {r["showing_id"]: r for r in load_dataset_csv("dataset_all.csv")}
ds_test = load_dataset_csv("dataset_test.csv")
mismatch = 0
for r in ds_test:
    a = ds_all[r["showing_id"]]
    for c in ("hist_movie_screen_avg", "hist_screen_avg", "hist_global_avg"):
        va, vt = a[c], r[c]
        if not ((va != va and vt != vt) or abs(va - vt) < 1e-9):  # NaN==NaN も許容
            mismatch += 1
check("整合: dataset_all と dataset_test の履歴特徴が一致", mismatch == 0, f"{mismatch} 件不一致")

# 7. モデル成果物 -------------------------------------------------------
enc = joblib.load(os.path.join(MODEL_DIR, "ordinal_encoder.joblib"))
hgb = joblib.load(os.path.join(MODEL_DIR, "hgb.joblib"))
X1, _ = rows_to_matrix(ds_test, ordinal_encoder=enc, fit=False)
p1 = hgb.predict(X1)
p2 = hgb.predict(X1)
check("モデル: HGB 予測が決定的", np.allclose(p1, p2))
check("モデル: HGB 予測レンジが妥当（0〜100 近傍）", p1.min() > -5 and p1.max() < 105, f"{p1.min():.1f}〜{p1.max():.1f}")

mm = json.load(open(os.path.join(MODEL_DIR, "model_meta.json"), encoding="utf-8"))
check("再現性: model_meta に sklearn/numpy/python/random_state", all(
    k in mm for k in ("sklearn", "numpy", "python", "random_state")
))
check("再現性: random_state 固定 (=42)", mm["random_state"] == 42)

# 8. ml-predictions.csv カバレッジ --------------------------------------
mlp = os.path.join(DERIVED_DIR, "ml-predictions.csv")
with open(mlp, encoding="utf-8", newline="") as f:
    pred_rows = list(csv.DictReader(f))
all_ids = {r["showing_id"] for r in rows}
pred_ids = {r["上映ID"] for r in pred_rows}
check("出力: ml-predictions が全 21,900 上映をカバー", pred_ids == all_ids, f"{len(pred_ids)}")
check("出力: ml_predicted_pct が数値・0〜100", all(0 <= float(r["ml_predicted_pct"]) <= 100 for r in pred_rows))

# 9. 元CSV 未変更（サイズ既知） ------------------------------------------
sizes = {
    "movies.csv": 47794,
    "screens.csv": 845,
    "schedules.csv": 2111259,
    "ticket_sales.csv": 56577062,
}
ok = all(os.path.getsize(os.path.join(DATA_DIR, k)) == v for k, v in sizes.items())
check("保護: data/*.csv のサイズが未変更", ok)

print(f"\nMLテスト: {PASS} passed / {FAIL} failed")
sys.exit(1 if FAIL else 0)
