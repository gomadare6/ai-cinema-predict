"""特徴量エンジニアリング（データリーク防止つき）。

方針:
- 直接特徴量は schedules / screens / movies の「上映前に確定している」項目のみ。
- 履歴（ターゲットエンコード）特徴量は **学習期間 (train) の実績 y だけ** から作る。
  * test 行  … 学習期間 train 全体の辞書を適用（STEP 5 と同じ手順。ホールドアウトはリークなし）。
  * train 行 … 5-fold の out-of-fold で付与し、自分自身の y が自分の特徴量に混ざらないようにする
                （モデル選択時の楽観バイアス防止。fold 分割の乱数固定）。
- 履歴キーが学習期間に存在しない場合は NaN（HistGradientBoosting はネイティブに欠損を扱う）。
"""

from __future__ import annotations

import numpy as np
from sklearn.model_selection import KFold

from common import RANDOM_STATE

# HGB に「カテゴリ」として渡す列（Ordinal エンコード後に categorical_features 指定）。
#
# 生カテゴリ（screen_id / genre / distributor / weekday / special_day 等）は
# STEP 2 で混雑率との相関がほぼゼロ（eta^2≈0）と確認済みで、
# 学習期間の作品固有パターンを検証期間の新作に持ち込む「過学習面」にしかならない。
# → 混雑率を実際に説明できる「座席数（機械的）＋月（弱い季節性）＋履歴平均」に絞る。
# start_slot だけ 6 値と小さく安価なので残す。
CATEGORICAL_COLUMNS = [
    "start_slot",
]

# 数値としてそのまま渡す列
NUMERIC_DIRECT_COLUMNS = [
    "seat_capacity",
    "month",
]

# 履歴（ターゲットエンコード）で作る数値列
HISTORY_COLUMNS = [
    # 現在の統計予測そのもの（作品×スクリーン→スクリーン→全体のフォールバック値）。
    # これを主特徴量にすることで HGB は「統計予測からの残差補正」を学ぶ形になる。
    # 改善できなければ ≒ 恒等関数を学び 4.28 に並ぶだけ（悪化しにくい）。
    "hist_fallback_pred",
    "hist_movie_screen_avg",
    "hist_movie_screen_count",
    "hist_movie_avg",
    "hist_movie_count",
    "hist_screen_avg",
    "hist_screen_count",
    "hist_genre_screen_avg",
    "hist_genre_capband_avg",
    "hist_distributor_avg",
    "hist_global_avg",
    "has_movie_screen_history",
    "has_movie_history",
]

FEATURE_COLUMNS = CATEGORICAL_COLUMNS + NUMERIC_DIRECT_COLUMNS + HISTORY_COLUMNS


# --------------------------------------------------------------------------- #
# 履歴辞書（学習期間の行だけから作る）
# --------------------------------------------------------------------------- #
def _mean(vals):
    return sum(vals) / len(vals) if vals else float("nan")


def build_history_tables(train_rows):
    """train_rows（学習期間の上映 dict 群）から履歴平均辞書を作る。"""
    ms = {}   # (movie_id, screen_id) -> [y,...]
    mv = {}   # movie_id -> [y,...]
    sc = {}   # screen_id -> [y,...]
    gs = {}   # (genre, screen_id) -> [y,...]
    gc = {}   # (genre, capacity_band) -> [y,...]
    ds = {}   # distributor -> [y,...]
    allv = []
    for r in train_rows:
        y = r["y"]
        ms.setdefault((r["movie_id"], r["screen_id"]), []).append(y)
        mv.setdefault(r["movie_id"], []).append(y)
        sc.setdefault(r["screen_id"], []).append(y)
        gs.setdefault((r["genre"], r["screen_id"]), []).append(y)
        gc.setdefault((r["genre"], r["capacity_band"]), []).append(y)
        ds.setdefault(r["distributor"], []).append(y)
        allv.append(y)
    return {
        "movie_screen": {k: (_mean(v), len(v)) for k, v in ms.items()},
        "movie": {k: (_mean(v), len(v)) for k, v in mv.items()},
        "screen": {k: (_mean(v), len(v)) for k, v in sc.items()},
        "genre_screen": {k: _mean(v) for k, v in gs.items()},
        "genre_capband": {k: _mean(v) for k, v in gc.items()},
        "distributor": {k: _mean(v) for k, v in ds.items()},
        "global": _mean(allv),
    }


def _history_features_for_row(r, tables):
    ms = tables["movie_screen"].get((r["movie_id"], r["screen_id"]))
    mv = tables["movie"].get(r["movie_id"])
    sc = tables["screen"].get(r["screen_id"])
    gs = tables["genre_screen"].get((r["genre"], r["screen_id"]))
    gc = tables["genre_capband"].get((r["genre"], r["capacity_band"]))
    ds = tables["distributor"].get(r["distributor"])
    g = tables["global"]
    nan = float("nan")
    # STEP 5 の統計予測（作品×スクリーン → スクリーン → 全体）
    if ms:
        fallback_pred = ms[0]
    elif sc:
        fallback_pred = sc[0]
    else:
        fallback_pred = g
    return {
        "hist_fallback_pred": fallback_pred,
        "hist_movie_screen_avg": ms[0] if ms else nan,
        "hist_movie_screen_count": ms[1] if ms else 0,
        "hist_movie_avg": mv[0] if mv else nan,
        "hist_movie_count": mv[1] if mv else 0,
        "hist_screen_avg": sc[0] if sc else nan,
        "hist_screen_count": sc[1] if sc else 0,
        "hist_genre_screen_avg": gs if gs is not None else nan,
        "hist_genre_capband_avg": gc if gc is not None else nan,
        "hist_distributor_avg": ds if ds is not None else nan,
        "hist_global_avg": g,
        "has_movie_screen_history": 1 if ms else 0,
        "has_movie_history": 1 if mv else 0,
    }


def add_history_features(rows, train_rows, *, oof: bool):
    """rows の各 dict に HISTORY_COLUMNS を追加する（in-place）。

    oof=False … rows は test / 全件など。train_rows 全体の辞書を適用（STEP 5 と同じ手順）。
    oof=True  … rows は学習行そのもの。**作品ID でグループ化した 5-fold** で付与する。
                各 fold は「その作品を含まない学習行」だけから辞書を作るので、
                held-out 作品の学習行は作品履歴が NaN になる。
                → 学習データにも現実的なコールドスタート行（約20%）が現れ、
                  検証期間の 55.6% コールドスタートに対して HGB が学べるようになる。
    """
    if not oof:
        tables = build_history_tables(train_rows)
        for r in rows:
            r.update(_history_features_for_row(r, tables))
        return rows

    # OOF: 学習行を 5 分割し、各 fold は残り 4 fold の辞書で埋める
    idx = np.arange(len(rows))
    kf = KFold(n_splits=5, shuffle=True, random_state=RANDOM_STATE)
    for tr_idx, val_idx in kf.split(idx):
        fold_train = [rows[i] for i in tr_idx]
        tables = build_history_tables(fold_train)
        for i in val_idx:
            rows[i].update(_history_features_for_row(rows[i], tables))
    return rows


# --------------------------------------------------------------------------- #
# 行 dict 群 -> 特徴量行列
# --------------------------------------------------------------------------- #
def rows_to_matrix(rows, ordinal_encoder=None, *, fit=False):
    """rows(list[dict]) -> (X: np.ndarray float, encoder)

    カテゴリ列は OrdinalEncoder。未知カテゴリは NaN（HGB がネイティブに欠損扱い）。
    """
    from sklearn.preprocessing import OrdinalEncoder

    cat_raw = [[str(r[c]) for c in CATEGORICAL_COLUMNS] for r in rows]
    if fit:
        ordinal_encoder = OrdinalEncoder(
            handle_unknown="use_encoded_value",
            unknown_value=np.nan,
            encoded_missing_value=np.nan,
            dtype=np.float64,
        )
        cat_enc = ordinal_encoder.fit_transform(cat_raw)
    else:
        cat_enc = ordinal_encoder.transform(cat_raw)

    num = np.array(
        [[float(r[c]) for c in (NUMERIC_DIRECT_COLUMNS + HISTORY_COLUMNS)] for r in rows],
        dtype=np.float64,
    )
    X = np.hstack([cat_enc, num])
    return X, ordinal_encoder


# categorical_features 用のブールマスク（先頭 len(CATEGORICAL_COLUMNS) 列が True）
def categorical_mask():
    mask = np.zeros(len(FEATURE_COLUMNS), dtype=bool)
    mask[: len(CATEGORICAL_COLUMNS)] = True
    return mask
