"""検証期間 (2025-10-01〜12-31, 5,520 上映) だけで全方式を採点する。

比較:
  全体平均 / 作品平均 / 作品×スクリーン(+全体フォールバック) / 現在の統計予測(STEP5) /
  RandomForest / HistGradientBoosting

現在の統計予測は Python で STEP 5 と同じフォールバック（作品×スクリーン→スクリーン→全体）を
学習期間の辞書から再現する（既知の MAE 4.28 と一致するはず）。
"""

from __future__ import annotations

import csv
import os
from collections import defaultdict

import joblib
import numpy as np

from common import (
    DERIVED_DIR,
    MODEL_DIR,
    VACANCY_THRESHOLD_PCT,
    classification_metrics,
    mae,
    ranking_metrics,
    rmse,
)
from features import HISTORY_COLUMNS, NUMERIC_DIRECT_COLUMNS, rows_to_matrix
from train import load_dataset_csv


# --------------------------------------------------------------------------- #
# 統計ベースライン（学習期間の辞書のみ）
# --------------------------------------------------------------------------- #
def statistical_baselines(train_rows, test_rows):
    ws, mv, sc, allv = defaultdict(list), defaultdict(list), defaultdict(list), []
    for r in train_rows:
        ws[(r["movie_id"], r["screen_id"])].append(r["y"])
        mv[r["movie_id"]].append(r["y"])
        sc[r["screen_id"]].append(r["y"])
        allv.append(r["y"])
    g = sum(allv) / len(allv)
    ws_avg = {k: sum(v) / len(v) for k, v in ws.items()}
    mv_avg = {k: sum(v) / len(v) for k, v in mv.items()}
    sc_avg = {k: sum(v) / len(v) for k, v in sc.items()}

    pred_global, pred_movie, pred_ws, pred_stat = [], [], [], []
    for r in test_rows:
        key = (r["movie_id"], r["screen_id"])
        pred_global.append(g)
        pred_movie.append(mv_avg.get(r["movie_id"], g))
        pred_ws.append(ws_avg.get(key, g))
        # STEP 5: 作品×スクリーン -> スクリーン -> 全体
        if key in ws_avg:
            pred_stat.append(ws_avg[key])
        elif r["screen_id"] in sc_avg:
            pred_stat.append(sc_avg[r["screen_id"]])
        else:
            pred_stat.append(g)
    return {
        "全体平均": pred_global,
        "作品平均": pred_movie,
        "作品×スクリーン": pred_ws,
        "現在の統計予測": pred_stat,
    }, g


def per_day_top_pick(test_rows, y_true, y_pred):
    """日ごとに「予測が最も低い1件」が実績の最空四分位に入る割合。"""
    by_day = defaultdict(list)
    for i, r in enumerate(test_rows):
        by_day[r["show_date"]].append(i)
    hits = 0
    days = 0
    for _, idxs in by_day.items():
        if len(idxs) < 4:
            continue
        days += 1
        actuals = sorted(y_true[i] for i in idxs)
        q1 = actuals[max(0, len(actuals) // 4 - 1)]
        pick = min(idxs, key=lambda i: y_pred[i])
        if y_true[pick] <= q1:
            hits += 1
    return hits / days if days else float("nan"), days


def report_block(name, y_true, y_pred, cold_mask):
    cls = classification_metrics(y_true, y_pred)
    rnk = ranking_metrics(y_true, y_pred)
    warm = [(a, p) for a, p, c in zip(y_true, y_pred, cold_mask) if not c]
    cold = [(a, p) for a, p, c in zip(y_true, y_pred, cold_mask) if c]
    line = f"{name:16s} MAE={mae(y_true, y_pred):5.2f}  RMSE={rmse(y_true, y_pred):5.2f}"
    line += f"  Acc={cls['accuracy']:.3f} P={cls['precision']:.3f} R={cls['recall']:.3f} F1={cls['f1']:.3f}"
    print(line)
    if warm and cold:
        print(
            f"{'':16s}   履歴あり MAE={mae([a for a,_ in warm],[p for _,p in warm]):5.2f} (n={len(warm)})"
            f"   コールドスタート MAE={mae([a for a,_ in cold],[p for _,p in cold]):5.2f} (n={len(cold)})"
        )
    print(
        f"{'':16s}   下位10% 実績平均={rnk[10]['actual_mean']:5.2f}%  真に<10%={rnk[10]['share_lt_thr']*100:4.1f}%"
        f"   下位20%={rnk[20]['actual_mean']:5.2f}%/{rnk[20]['share_lt_thr']*100:4.1f}%"
        f"   下位30%={rnk[30]['actual_mean']:5.2f}%/{rnk[30]['share_lt_thr']*100:4.1f}%"
    )
    return {"mae": mae(y_true, y_pred), **cls, "ranking": rnk}


def main():
    train_rows = load_dataset_csv("dataset_train.csv")
    test_rows = load_dataset_csv("dataset_test.csv")
    y_true = np.array([r["y"] for r in test_rows], dtype=np.float64)
    cold_mask = [not bool(int(r["has_movie_screen_history"])) for r in test_rows]

    enc = joblib.load(os.path.join(MODEL_DIR, "ordinal_encoder.joblib"))
    hgb = joblib.load(os.path.join(MODEL_DIR, "hgb.joblib"))
    rf = joblib.load(os.path.join(MODEL_DIR, "rf.joblib"))
    dummy = joblib.load(os.path.join(MODEL_DIR, "dummy.joblib"))

    X_test, _ = rows_to_matrix(test_rows, ordinal_encoder=enc, fit=False)
    rf_fill = joblib.load(os.path.join(MODEL_DIR, "rf_fill.joblib"))["fill_value"]
    X_test_rf = X_test.copy()
    X_test_rf[np.isnan(X_test_rf)] = rf_fill

    stat_preds, g = statistical_baselines(train_rows, test_rows)

    print("=== 検証 (2025-10-01〜2025-12-31, n=%d) ===" % len(test_rows))
    print("--- 比較表（MAE 昇順の目安。左から順に）---")
    results = {}
    results["全体平均"] = report_block("全体平均", y_true, np.array(stat_preds["全体平均"]), cold_mask)
    results["作品平均"] = report_block("作品平均", y_true, np.array(stat_preds["作品平均"]), cold_mask)
    results["作品×スクリーン"] = report_block(
        "作品×スクリーン", y_true, np.array(stat_preds["作品×スクリーン"]), cold_mask
    )
    results["現在の統計予測"] = report_block(
        "現在の統計予測", y_true, np.array(stat_preds["現在の統計予測"]), cold_mask
    )
    results["RandomForest"] = report_block("RandomForest", y_true, rf.predict(X_test_rf), cold_mask)
    results["HistGradientBoosting"] = report_block(
        "HistGradientBoosting", y_true, hgb.predict(X_test), cold_mask
    )

    print("\n--- 日次「最も空いている見込み」1件 が実績の最空四分位に入る割合 ---")
    for name, pred in [
        ("現在の統計予測", np.array(stat_preds["現在の統計予測"])),
        ("RandomForest", rf.predict(X_test_rf)),
        ("HistGradientBoosting", hgb.predict(X_test)),
    ]:
        rate, days = per_day_top_pick(test_rows, y_true, pred)
        print(f"  {name:16s} {rate*100:5.1f}%  ({days} 日)")

    print("\n--- MAE まとめ ---")
    for k in ["全体平均", "作品平均", "作品×スクリーン", "現在の統計予測", "RandomForest", "HistGradientBoosting"]:
        print(f"  {k:16s} MAE {results[k]['mae']:.2f}")

    # 採用判定の材料
    base = results["現在の統計予測"]
    hgbr = results["HistGradientBoosting"]
    print("\n--- 判定材料（HGB vs 現在の統計予測）---")
    print(f"  MAE      : {hgbr['mae']:.2f}  vs  {base['mae']:.2f}   (差 {base['mae']-hgbr['mae']:+.2f})")
    print(f"  F1(<10%) : {hgbr['f1']:.3f} vs {base['f1']:.3f}")
    print(
        f"  下位10%実績平均 : {hgbr['ranking'][10]['actual_mean']:.2f}%  vs  {base['ranking'][10]['actual_mean']:.2f}%"
    )


if __name__ == "__main__":
    main()
