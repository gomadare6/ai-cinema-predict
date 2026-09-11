"""ML 用データセットを生成する。

  data/*.csv
    -> 全 21,900 上映の y（実績混雑率）と直接特徴量
    -> 履歴特徴量を「学習期間の実績だけ」から付与
         test : train 全体の辞書
         train: 5-fold OOF
    -> ml/derived/dataset_train.csv, dataset_test.csv, dataset_all.csv, dataset_meta.json

元 CSV は読み取りのみ。出力は ml/derived/ 配下だけ。
"""

from __future__ import annotations

import csv
import json
import os

from common import (
    DERIVED_DIR,
    TRAINING_START,
    TRAINING_END,
    VALIDATION_START,
    VALIDATION_END,
    load_showings,
)
from features import (
    CATEGORICAL_COLUMNS,
    HISTORY_COLUMNS,
    NUMERIC_DIRECT_COLUMNS,
    add_history_features,
)

# dataset CSV に書く列（特徴量 + キー + 目的変数）
# screen_id は特徴量からは外した（生カテゴリは過学習面）が、統計ベースライン再現の
# ため（作品×スクリーン→スクリーン→全体）キーとして保持する。
KEY_COLUMNS = ["showing_id", "movie_id", "screen_id", "show_date", "split", "n_sold"]
OUT_COLUMNS = (
    KEY_COLUMNS
    + CATEGORICAL_COLUMNS
    + NUMERIC_DIRECT_COLUMNS
    + HISTORY_COLUMNS
    + ["y"]
)


def _write(path, rows):
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=OUT_COLUMNS, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow(r)


def main():
    os.makedirs(DERIVED_DIR, exist_ok=True)

    rows = load_showings()
    train_rows = [r for r in rows if r["split"] == "train"]
    test_rows = [r for r in rows if r["split"] == "test"]
    other_rows = [r for r in rows if r["split"] == "other"]

    assert not other_rows, f"想定外の期間の上映が {len(other_rows)} 件（2025年内のはず）"

    # --- リーク防止の要: 履歴は学習行の y だけから作る ---
    add_history_features(train_rows, train_rows, oof=True)     # 学習行は OOF
    add_history_features(test_rows, train_rows, oof=False)     # 検証行は train 全体の辞書

    # 全件版（predict_all 用。全件とも train 全体の辞書で付与）
    all_rows = load_showings()
    add_history_features(all_rows, train_rows, oof=False)

    _write(os.path.join(DERIVED_DIR, "dataset_train.csv"), train_rows)
    _write(os.path.join(DERIVED_DIR, "dataset_test.csv"), test_rows)
    _write(os.path.join(DERIVED_DIR, "dataset_all.csv"), all_rows)

    meta = {
        "training_window": {"start": TRAINING_START, "end": TRAINING_END},
        "validation_window": {"start": VALIDATION_START, "end": VALIDATION_END},
        "n_train": len(train_rows),
        "n_test": len(test_rows),
        "n_all": len(all_rows),
        "categorical_columns": CATEGORICAL_COLUMNS,
        "numeric_direct_columns": NUMERIC_DIRECT_COLUMNS,
        "history_columns": HISTORY_COLUMNS,
        "target": "実績混雑率(%) = ticket_sales行数 / screens.座席数 * 100",
        "leak_guard": "history features built from train-window outcomes only; train uses 5-fold OOF",
        "forbidden_features": [
            "対象上映の ticket_sales 実績 / 販売席数 / 購入者属性 / 購入日時 / 券種 / チャネル / 支払金額 / グループ情報",
            "movies.csv 動員数合計 / 興行収入合計",
            "movies.csv 公開日 / 終映日 / 上映日数 由来の recency",
        ],
    }
    with open(os.path.join(DERIVED_DIR, "dataset_meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    # 検証: train と test の日付が重ならない
    tr_dates = {r["show_date"] for r in train_rows}
    te_dates = {r["show_date"] for r in test_rows}
    assert tr_dates.isdisjoint(te_dates), "train と test の日付が重複"
    assert max(tr_dates) <= TRAINING_END < VALIDATION_START <= min(te_dates)

    cold = sum(1 for r in test_rows if not r["has_movie_screen_history"])
    print("=== dataset 生成 ===")
    print(f"  train : {len(train_rows):>6}  ({min(tr_dates)} 〜 {max(tr_dates)})")
    print(f"  test  : {len(test_rows):>6}  ({min(te_dates)} 〜 {max(te_dates)})")
    print(f"  all   : {len(all_rows):>6}")
    print(f"  test コールドスタート(作品×スクリーン履歴なし): {cold} ({cold / len(test_rows) * 100:.1f}%)")
    print(f"  出力  : {DERIVED_DIR}/dataset_train.csv, dataset_test.csv, dataset_all.csv, dataset_meta.json")


if __name__ == "__main__":
    main()
