"""共通ローダ／定数。

- 元CSV (data/) は読み取りのみ。
- 目的変数の混雑率は src/dataset.js と同じ式で計算する:
      実績混雑率(%) = 対象上映IDの ticket_sales 行数 ÷ その上映のスクリーン座席数 × 100
- 期間・閾値は src/config.js と一致させること（test_ml.py で検証）。
"""

from __future__ import annotations

import csv
import os
from collections import Counter

# --- src/config.js と一致させる（ドリフト検知は ml/test_ml.py） ---
TRAINING_START = "2025-01-01"
TRAINING_END = "2025-09-30"
VALIDATION_START = "2025-10-01"
VALIDATION_END = "2025-12-31"
VACANCY_THRESHOLD_PCT = 10.0

RANDOM_STATE = 42

_HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(_HERE)
DATA_DIR = os.path.join(PROJECT_ROOT, "data")
ML_DIR = _HERE
DERIVED_DIR = os.path.join(_HERE, "derived")
MODEL_DIR = os.path.join(_HERE, "model")


def _read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def load_screens():
    """スクリーンID -> {'seat_capacity': int}"""
    out = {}
    for r in _read_csv(os.path.join(DATA_DIR, "screens.csv")):
        out[r["スクリーンID"]] = {"seat_capacity": int(r["座席数"])}
    return out


def load_movies():
    """作品ID -> {'genre', 'distributor'}  （recency系・動員/興収は使わないので読まない）"""
    out = {}
    for r in _read_csv(os.path.join(DATA_DIR, "movies.csv")):
        out[r["作品ID"]] = {"genre": r["ジャンル"], "distributor": r["配給社"]}
    return out


def count_sold_by_showing():
    """上映ID -> 販売座席数（ticket_sales 1行 = 1座席。属性列は一切参照しない）"""
    counts = Counter()
    path = os.path.join(DATA_DIR, "ticket_sales.csv")
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        header = next(reader)
        idx = header.index("上映ID")
        for row in reader:
            if row:
                counts[row[idx]] += 1
    return counts


def capacity_band(cap: int) -> str:
    if cap <= 100:
        return "S"
    if cap <= 220:
        return "M"
    return "L"


def load_showings():
    """全 21,900 上映を dict のリストで返す。各行に目的変数 y（実績混雑率）と split を付与。

    予測入力に使ってよい素の項目のみ保持する。ticket_sales の属性列・購入日時、
    movies の公開日/終映日/上映日数/動員数/興収は保持しない（データリーク防止）。
    """
    screens = load_screens()
    movies = load_movies()
    sold = count_sold_by_showing()

    rows = []
    for r in _read_csv(os.path.join(DATA_DIR, "schedules.csv")):
        sid = r["上映ID"]
        screen_id = r["スクリーンID"]
        movie_id = r["作品ID"]
        cap = screens[screen_id]["seat_capacity"]
        n_sold = sold.get(sid, 0)
        y = n_sold / cap * 100.0

        show_date = r["上映日"]          # YYYY-MM-DD（辞書順 = 日付順）
        start_time = r["開始時刻"]       # HH:MM
        month = int(show_date[5:7])
        # 開始時刻スロット（実データは 09:30/12:00/14:30/17:00/19:00/21:10 の6枠）
        start_slot = start_time
        hh = int(start_time[:2])
        # 曜日（0=月 .. 6=日）は日付から純粋計算
        y_, m_, d_ = (int(x) for x in show_date.split("-"))
        weekday = _weekday(y_, m_, d_)

        mv = movies.get(movie_id, {"genre": "(不明)", "distributor": "(不明)"})

        if TRAINING_START <= show_date <= TRAINING_END:
            split = "train"
        elif VALIDATION_START <= show_date <= VALIDATION_END:
            split = "test"
        else:
            split = "other"

        rows.append(
            {
                "showing_id": sid,
                "movie_id": movie_id,
                "screen_id": screen_id,
                "seat_capacity": cap,
                "capacity_band": capacity_band(cap),
                "show_date": show_date,
                "start_slot": start_slot,
                "start_hour": hh,
                "weekday": weekday,
                "weekday_type": r["曜日種別"],           # 平日 / 土日祝
                "month": month,
                "special_day": r["特別日"] or "none",     # '' -> 'none'
                "late_show": 1 if r["レイトショー"] == "True" else 0,
                "genre": mv["genre"],
                "distributor": mv["distributor"],
                "y": y,
                "n_sold": n_sold,
                "split": split,
            }
        )
    return rows


def _weekday(y: int, m: int, d: int) -> int:
    """Sakamoto's algorithm。0=Monday .. 6=Sunday。外部ライブラリ不要。"""
    t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4]
    if m < 3:
        y -= 1
    return ((y + y // 4 - y // 100 + y // 400 + t[m - 1] + d) % 7 + 6) % 7


def mae(y_true, y_pred):
    return sum(abs(a - b) for a, b in zip(y_true, y_pred)) / len(y_true)


def rmse(y_true, y_pred):
    return (sum((a - b) ** 2 for a, b in zip(y_true, y_pred)) / len(y_true)) ** 0.5


def classification_metrics(y_true, y_pred, thr=VACANCY_THRESHOLD_PCT):
    """<thr% を「空いている」とみなす2値分類。判定は丸め前の値で行う。"""
    tp = fp = fn = tn = 0
    for a, p in zip(y_true, y_pred):
        act = a < thr
        pre = p < thr
        if act and pre:
            tp += 1
        elif pre and not act:
            fp += 1
        elif act and not pre:
            fn += 1
        else:
            tn += 1
    acc = (tp + tn) / max(1, tp + fp + fn + tn)
    prec = tp / (tp + fp) if (tp + fp) else float("nan")
    rec = tp / (tp + fn) if (tp + fn) else float("nan")
    f1 = 2 * prec * rec / (prec + rec) if (prec + rec) else float("nan")
    return {
        "accuracy": acc,
        "precision": prec,
        "recall": rec,
        "f1": f1,
        "confusion": {"tp": tp, "fp": fp, "fn": fn, "tn": tn},
    }


def ranking_metrics(y_true, y_pred, thr=VACANCY_THRESHOLD_PCT):
    """予測が低い順に並べ、下位 10/20/30% の実績平均と真に<thr%の割合。"""
    order = sorted(range(len(y_pred)), key=lambda i: y_pred[i])
    out = {}
    n = len(order)
    for q in (10, 20, 30):
        k = max(1, n * q // 100)
        idx = order[:k]
        actual_mean = sum(y_true[i] for i in idx) / k
        share_lt = sum(1 for i in idx if y_true[i] < thr) / k
        out[q] = {"k": k, "actual_mean": actual_mean, "share_lt_thr": share_lt}
    return out
