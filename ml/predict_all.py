"""全 21,900 上映を HGB で採点し ml/derived/ml-predictions.csv に出す。

STEP 11 で Web に接続するかは評価結果を見て決める。ここでは生成のみ。
出力: 上映ID, ml_predicted_pct  （小数は丸めず保存。表示丸めは接続時に行う）
"""

from __future__ import annotations

import csv
import os

import joblib
import numpy as np

from common import DERIVED_DIR, MODEL_DIR
from features import rows_to_matrix
from train import load_dataset_csv


def main():
    rows = load_dataset_csv("dataset_all.csv")
    enc = joblib.load(os.path.join(MODEL_DIR, "ordinal_encoder.joblib"))
    hgb = joblib.load(os.path.join(MODEL_DIR, "hgb.joblib"))

    X, _ = rows_to_matrix(rows, ordinal_encoder=enc, fit=False)
    pred = hgb.predict(X)
    pred = np.clip(pred, 0.0, 100.0)

    out = os.path.join(DERIVED_DIR, "ml-predictions.csv")
    with open(out, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["上映ID", "ml_predicted_pct"])
        for r, p in zip(rows, pred):
            w.writerow([r["showing_id"], repr(float(p))])

    print(f"=== 全上映スコア出力 ===")
    print(f"  {len(rows)} 行 -> {out}")
    print(f"  予測レンジ: {pred.min():.2f} 〜 {pred.max():.2f}  平均 {pred.mean():.2f}")


if __name__ == "__main__":
    main()
