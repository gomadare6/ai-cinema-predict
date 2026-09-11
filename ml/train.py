"""学習期間 (2025-01-01〜09-30) で回帰モデルを学習し、ml/model/ に保存する。

モデル:
  - DummyRegressor(mean)              … 下限
  - RandomForestRegressor            … 対抗
  - HistGradientBoostingRegressor    … 第一候補（ネイティブ categorical + 欠損）

検証期間は一切読み込まない。
"""

from __future__ import annotations

import csv
import json
import os
import platform

import joblib
import numpy as np
import sklearn
from sklearn.dummy import DummyRegressor
from sklearn.ensemble import HistGradientBoostingRegressor, RandomForestRegressor

from common import DERIVED_DIR, MODEL_DIR, RANDOM_STATE
from features import (
    CATEGORICAL_COLUMNS,
    FEATURE_COLUMNS,
    HISTORY_COLUMNS,
    NUMERIC_DIRECT_COLUMNS,
    categorical_mask,
    rows_to_matrix,
)


def load_dataset_csv(name):
    path = os.path.join(DERIVED_DIR, name)
    with open(path, encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        for c in NUMERIC_DIRECT_COLUMNS + HISTORY_COLUMNS + ["y"]:
            r[c] = float(r[c]) if r[c] not in ("", "nan") else float("nan")
    return rows


def main():
    os.makedirs(MODEL_DIR, exist_ok=True)
    train_rows = load_dataset_csv("dataset_train.csv")
    y = np.array([r["y"] for r in train_rows], dtype=np.float64)

    X, enc = rows_to_matrix(train_rows, fit=True)
    cat_mask = categorical_mask()

    models = {}

    dummy = DummyRegressor(strategy="mean")
    dummy.fit(X, y)
    models["dummy"] = dummy

    # RandomForest は欠損を扱えないので、履歴なしセルは「学習期間の全体平均」で埋める
    # （-1 埋めだと木が“極端に空いている”と誤解しコールドスタートが崩壊するため）。
    fill_value = float(np.nanmean(y))
    X_rf = X.copy()
    X_rf[np.isnan(X_rf)] = fill_value
    # RF は比較用のみ（不採用）。保存肥大を避けるため小さめに。
    rf = RandomForestRegressor(
        n_estimators=120,
        max_depth=16,
        min_samples_leaf=40,
        random_state=RANDOM_STATE,
        n_jobs=-1,
    )
    rf.fit(X_rf, y)
    models["rf"] = rf

    # 強めの正則化。狙いは「統計予測(hist_fallback_pred)を土台にした残差補正」であって、
    # 学習セット固有パターンの記憶ではない。単調制約も試したが改善はなかった（README 参照）。
    hgb = HistGradientBoostingRegressor(
        loss="absolute_error",           # MAE を直接最適化
        learning_rate=0.03,
        max_iter=500,
        max_leaf_nodes=15,
        min_samples_leaf=120,
        l2_regularization=5.0,
        early_stopping=True,
        validation_fraction=0.15,
        random_state=RANDOM_STATE,
        categorical_features=cat_mask,
    )
    hgb.fit(X, y)
    models["hgb"] = hgb

    joblib.dump(models["dummy"], os.path.join(MODEL_DIR, "dummy.joblib"))
    joblib.dump(models["rf"], os.path.join(MODEL_DIR, "rf.joblib"))
    joblib.dump(models["hgb"], os.path.join(MODEL_DIR, "hgb.joblib"))
    joblib.dump(enc, os.path.join(MODEL_DIR, "ordinal_encoder.joblib"))

    meta = {
        "python": platform.python_version(),
        "sklearn": sklearn.__version__,
        "numpy": np.__version__,
        "joblib": joblib.__version__,
        "random_state": RANDOM_STATE,
        "n_train": len(train_rows),
        "feature_columns": FEATURE_COLUMNS,
        "categorical_columns": CATEGORICAL_COLUMNS,
        "hgb_params": hgb.get_params(),
        "rf_params": rf.get_params(),
    }
    # get_params に入る ndarray（categorical_features）は JSON 不可なので落とす
    meta["hgb_params"]["categorical_features"] = "bool mask, first %d cols" % len(CATEGORICAL_COLUMNS)
    with open(os.path.join(MODEL_DIR, "model_meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2, default=str)

    # 学習データ上の当てはまり（参考。OOF 履歴特徴なので極端な過学習は見えにくい）
    from common import mae

    joblib.dump({"fill_value": fill_value}, os.path.join(MODEL_DIR, "rf_fill.joblib"))
    for name, m in models.items():
        Xin = X_rf if name == "rf" else X
        pred = m.predict(Xin)
        print(f"  [train-fit] {name:5s} MAE={mae(y, pred):.3f}")
    print(f"  モデル保存: {MODEL_DIR}/(dummy|rf|hgb).joblib, ordinal_encoder.joblib, model_meta.json")


if __name__ == "__main__":
    main()
