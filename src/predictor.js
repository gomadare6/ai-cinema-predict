'use strict';

/**
 * 第一版 混雑率予測エンジン (STEP 4 確定仕様)。
 *
 * 予測ロジック (1上映ごと):
 *   1次: (作品ID, スクリーンID) の学習実績があれば → 作品×スクリーン平均
 *   2次: 無ければ スクリーンID の学習平均       → スクリーン平均
 *   3次: それも無ければ                          → 全体平均
 *
 * 予測入力に使うのは上映前に確定している情報のみ:
 *   作品ID / スクリーンID / (表示用に) 作品名・上映日時・座席数
 * 購入者属性・購入日時・当日の販売状況・検証期間の実績は一切使わない。
 */

const {
  VACANCY_THRESHOLD_PCT,
  DISPLAY_DECIMALS,
  BASIS_WORK_SCREEN,
  BASIS_SCREEN,
  BASIS_GLOBAL,
  CONFIDENCE_ACTUAL,
  CONFIDENCE_FALLBACK,
  SOURCE_WORK_SCREEN,
  SOURCE_SCREEN,
  SOURCE_GLOBAL,
  CONFIDENCE_HIGH_MIN_COUNT,
  CONFIDENCE_MEDIUM_MIN_COUNT,
  CONFIDENCE_HIGH,
  CONFIDENCE_MEDIUM,
  CONFIDENCE_LOW,
} = require('./config');

/**
 * 説明可能性の追加項目 (STEP 9): 予測に使った過去実績の「量」に基づく confidence を求める。
 * 予測精度そのものではない (UI側でもその旨を明示する)。
 *   - work_screen 段: 件数が多いほど high。少なければ (最も特化した組み合わせでも) low。
 *   - screen 段: 件数がどれだけあっても、作品への特化度が低いため high にはしない (上限 medium)。
 *   - global 段: 常に low (どの作品・スクリーンにも特化していない)。
 */
function computeConfidence(source, count) {
  if (source === SOURCE_WORK_SCREEN) {
    if (count >= CONFIDENCE_HIGH_MIN_COUNT) return CONFIDENCE_HIGH;
    if (count >= CONFIDENCE_MEDIUM_MIN_COUNT) return CONFIDENCE_MEDIUM;
    return CONFIDENCE_LOW;
  }
  if (source === SOURCE_SCREEN) {
    return count >= CONFIDENCE_MEDIUM_MIN_COUNT ? CONFIDENCE_MEDIUM : CONFIDENCE_LOW;
  }
  return CONFIDENCE_LOW;
}

/** 表示用の丸め (内部計算・ランキングには使わない)。6.43782 → 6.4 */
function roundForDisplay(pct, decimals = DISPLAY_DECIMALS) {
  const f = 10 ** decimals;
  return Math.round(pct * f) / f;
}

/**
 * 集計データから予測器を生成する。
 * @param {{ workScreen: Array, screen: Array, global: object }} aggregates
 */
function createPredictor(aggregates) {
  if (!aggregates || !aggregates.global || typeof aggregates.global.avgOccupancyPct !== 'number') {
    throw new Error('createPredictor: invalid aggregates (global average missing)');
  }

  const workScreenMap = new Map(); // "movieId\tscreenId" -> entry
  for (const e of aggregates.workScreen) {
    workScreenMap.set(`${e.movieId}\t${e.screenId}`, e);
  }
  const screenMap = new Map(); // screenId -> entry
  for (const e of aggregates.screen) {
    screenMap.set(e.screenId, e);
  }
  const globalEntry = aggregates.global;

  /**
   * 1上映を予測する。
   * @param {{
   *   showingId?: string, movieId: string, movieTitle?: string,
   *   screenId: string, showDateTime?: string, seatCapacity?: number,
   * }} showing
   * @returns {object} 予測結果
   */
  function predict(showing) {
    if (showing == null || showing.movieId == null || showing.screenId == null) {
      throw new Error('predict: showing requires at least { movieId, screenId }');
    }

    let predictedOccupancyPct;
    let predictionBasis;
    let confidenceLabel;
    let predictionSource;
    let trainingShowCount;

    const wsEntry = workScreenMap.get(`${showing.movieId}\t${showing.screenId}`);
    if (wsEntry) {
      predictedOccupancyPct = wsEntry.avgOccupancyPct;
      trainingShowCount = wsEntry.trainingShowCount;
      predictionBasis = BASIS_WORK_SCREEN;
      confidenceLabel = CONFIDENCE_ACTUAL;
      predictionSource = SOURCE_WORK_SCREEN;
    } else {
      const scEntry = screenMap.get(showing.screenId);
      if (scEntry) {
        predictedOccupancyPct = scEntry.avgOccupancyPct;
        trainingShowCount = scEntry.trainingShowCount;
        predictionBasis = BASIS_SCREEN;
        confidenceLabel = CONFIDENCE_FALLBACK;
        predictionSource = SOURCE_SCREEN;
      } else {
        predictedOccupancyPct = globalEntry.avgOccupancyPct;
        trainingShowCount = globalEntry.trainingShowCount;
        predictionBasis = BASIS_GLOBAL;
        confidenceLabel = CONFIDENCE_FALLBACK;
        predictionSource = SOURCE_GLOBAL;
      }
    }

    // 安全策として 0〜100 にクリップ (過去平均なので通常は範囲内)
    if (predictedOccupancyPct < 0) predictedOccupancyPct = 0;
    if (predictedOccupancyPct > 100) predictedOccupancyPct = 100;

    // 「空いている」判定は丸め前の値で行う。10.0 ちょうどは含めない (未満のみ)。
    const isVacant = predictedOccupancyPct < VACANCY_THRESHOLD_PCT;

    return {
      showingId: showing.showingId,
      movieId: showing.movieId,
      movieTitle: showing.movieTitle,
      screenId: showing.screenId,
      showDateTime: showing.showDateTime,
      seatCapacity: showing.seatCapacity,

      predictedOccupancyPct, // 生の数値 (ランキング・判定用)
      predictedOccupancyPctDisplay: roundForDisplay(predictedOccupancyPct), // 表示用 小数第1位

      predictionBasis, // 表示用文字列
      confidenceLabel, // 表示用文字列
      predictionSource, // 機械判定用 ("work_screen" | "screen" | "global")
      trainingShowCount, // 予測に使った学習上映数

      isVacant, // 予測混雑率 < 10% か

      // --- STEP 9: 説明可能性の追加項目 (既存フィールドは変更しない・追加のみ) ---
      historyCount: trainingShowCount, // trainingShowCount の別名 (未来上映の文脈での呼び名)
      confidence: computeConfidence(predictionSource, trainingShowCount), // 'high' | 'medium' | 'low'
    };
  }

  /**
   * 予測済み上映を「空いている順」に並べ替え、vacancy_rank を 1 始まりで付与する。
   * ソートキー: 1) 予測混雑率 昇順 (丸め前) 2) 上映日時 昇順 3) 上映ID 昇順
   * 入力配列は変更せず、rank を付けた新しい配列を返す。
   * @param {Array<object>} predictedShowings  predict() の戻り値の配列
   * @returns {Array<object>}
   */
  function rank(predictedShowings) {
    const sorted = predictedShowings.slice().sort((a, b) => {
      if (a.predictedOccupancyPct !== b.predictedOccupancyPct) {
        return a.predictedOccupancyPct - b.predictedOccupancyPct;
      }
      const at = a.showDateTime == null ? '' : String(a.showDateTime);
      const bt = b.showDateTime == null ? '' : String(b.showDateTime);
      if (at !== bt) return at < bt ? -1 : 1;
      const ai = a.showingId == null ? '' : String(a.showingId);
      const bi = b.showingId == null ? '' : String(b.showingId);
      if (ai !== bi) return ai < bi ? -1 : 1;
      return 0;
    });
    return sorted.map((p, i) => ({ ...p, vacancyRank: i + 1 }));
  }

  return { predict, rank };
}

module.exports = { createPredictor, roundForDisplay };
