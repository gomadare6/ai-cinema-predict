'use strict';

/**
 * STEP 3 との整合性確認。
 *   node scripts/verify-step3.js
 *
 * 学習期間だけで集計 → 検証期間 (2025-10-01〜12-31) の全上映を予測 →
 * MAE / 「空いている(<10%)」分類指標 / 予測下位スライスの実績平均を出す。
 * STEP 3 の基準: 全体 MAE ≒ 4.28
 */

const { loadShowings } = require('../src/dataset');
const { buildAggregates } = require('../src/buildAggregates');
const { createPredictor } = require('../src/predictor');
const { VACANCY_THRESHOLD_PCT } = require('../src/config');

function mean(xs) {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function main() {
  const { showings } = loadShowings();
  const aggregates = buildAggregates(showings);
  const { predict } = createPredictor(aggregates);

  const validation = showings.filter((s) => s.inValidationWindow);

  const absErr = [];
  const bySource = { work_screen: [], screen: [], global: [] };
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  const scored = [];

  for (const s of validation) {
    const p = predict({
      showingId: s.showingId,
      movieId: s.movieId,
      movieTitle: s.movieTitle,
      screenId: s.screenId,
      showDateTime: s.showDateTime,
      seatCapacity: s.seatCapacity,
    });
    const err = Math.abs(s.actualOccupancyPct - p.predictedOccupancyPct);
    absErr.push(err);
    bySource[p.predictionSource].push(err);

    const actualVacant = s.actualOccupancyPct < VACANCY_THRESHOLD_PCT;
    const predVacant = p.isVacant;
    if (actualVacant && predVacant) tp++;
    else if (!actualVacant && predVacant) fp++;
    else if (actualVacant && !predVacant) fn++;
    else tn++;

    scored.push({ pred: p.predictedOccupancyPct, actual: s.actualOccupancyPct });
  }

  const acc = (tp + tn) / (tp + fp + fn + tn);
  const precision = tp / (tp + fp);
  const recall = tp / (tp + fn);
  const f1 = (2 * precision * recall) / (precision + recall);

  scored.sort((a, b) => a.pred - b.pred);
  const slice = (q) => {
    const k = Math.floor((scored.length * q) / 100);
    const sl = scored.slice(0, k);
    return {
      k,
      actualMean: mean(sl.map((x) => x.actual)),
      hitRate: sl.filter((x) => x.actual < VACANCY_THRESHOLD_PCT).length / k,
    };
  };

  console.log('=== STEP 3 整合性確認 (検証期間 2025-10-01〜2025-12-31) ===');
  console.log(`検証上映数            : ${validation.length}   (STEP 3: 5,520)`);
  console.log(`全体 MAE             : ${mean(absErr).toFixed(2)}   (STEP 3: 4.28)`);
  console.log(
    `  作品×スクリーン実績あり: MAE ${mean(bySource.work_screen).toFixed(2)}  n=${bySource.work_screen.length}   (STEP 3: 2.26)`
  );
  console.log(
    `  スクリーン平均         : MAE ${mean(bySource.screen).toFixed(2)}  n=${bySource.screen.length}   (STEP 3: 5.90)`
  );
  console.log(
    `  全体平均               : MAE ${bySource.global.length ? mean(bySource.global).toFixed(2) : '-'}  n=${bySource.global.length}   (STEP 3: 0件)`
  );
  console.log('');
  console.log(`「空いている(<10%)」判定  混同行列  TP=${tp} FP=${fp} FN=${fn} TN=${tn}`);
  console.log(
    `  Accuracy=${acc.toFixed(3)} (0.839)  Precision=${precision.toFixed(3)} (0.796)  Recall=${recall.toFixed(3)} (0.793)  F1=${f1.toFixed(3)} (0.795)`
  );
  console.log('');
  for (const q of [10, 20, 30]) {
    const r = slice(q);
    console.log(
      `予測下位 ${String(q).padStart(2)}% (n=${r.k})  実績平均混雑率=${r.actualMean.toFixed(2)}%  実際に<10%だった割合=${(r.hitRate * 100).toFixed(1)}%`
    );
  }
  console.log('  (STEP 3 上位10%: 実績平均 6.41% / 該当率 96.7%)');
}

main();
