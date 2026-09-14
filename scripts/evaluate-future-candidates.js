'use strict';

/**
 * 未来予測の改善候補を、既存の検証方式 (学習 2025-01-01〜09-30 / 検証 2025-10-01〜12-31)
 * で比較する検証専用スクリプト。本番の予測チェーン (src/predictor.js) は一切変更しない。
 *
 *   node scripts/evaluate-future-candidates.js
 *
 * 目的: 「機能を増やす」のではなく「採用可否を検証データで判断する」こと。
 * ml/ の scikit-learn 比較と同じ位置づけ (本番未接続の検証専用コード)。
 *
 * 手法: 学習期間だけから各候補の集計 (等重み平均・最低サンプル数あり) を作り、
 * 検証期間の各上映に「work×screen → 候補 → global」のチェーンを適用して指標を比較する。
 * 最低サンプル数に満たない候補集計は使わず、次のフォールバックへ進む。
 */

const { loadShowings } = require('../src/dataset');
const { mean } = require('../src/buildAggregates');
const { TRAINING_START, TRAINING_END, VACANCY_THRESHOLD_PCT } = require('../src/config');
const { isHoliday, isHolidayAdjacent } = require('../src/holidays');

const MIN_SAMPLES = 10; // 新候補の集計に課す最低サンプル数 (満たなければ次のフォールバックへ)

// --- 候補の「グループ化キー」定義。学習期間・検証期間・未来上映のどれでも同じ式で計算できるものだけを使う。
//     (未来上映は showDate / startTime しか確定情報が無いため、そこから決定できる式のみ採用する)
function weekdayType(showDate) {
  const [y, m, d] = showDate.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 || day === 6 ? 'weekend' : 'weekday'; // 祝日は考慮しない (未来日付でも計算できる式に統一するため)
}
function timeBand(startTime) {
  const h = Number(String(startTime).slice(0, 2));
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 20) return 'evening';
  return 'night';
}
function calMonth(showDate) {
  return Number(showDate.split('-')[1]);
}

const CANDIDATES = {
  work: (s) => `${s.movieId}`,
  month: (s) => `${calMonth(s.showDate)}`,
  weekdayType: (s) => weekdayType(s.showDate),
  timeBand: (s) => timeBand(s.startTime),
  workTimeBand: (s) => `${s.movieId}\t${timeBand(s.startTime)}`,
  workMonth: (s) => `${s.movieId}\t${calMonth(s.showDate)}`,
  workWeekdayType: (s) => `${s.movieId}\t${weekdayType(s.showDate)}`,
};

/** 学習データから { key -> { avgOccupancyPct, count } } を作る。 */
function buildGroupAvg(train, keyFn) {
  const groups = new Map();
  for (const s of train) {
    const k = keyFn(s);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s.actualOccupancyPct);
  }
  const out = new Map();
  for (const [k, occ] of groups) out.set(k, { avgOccupancyPct: mean(occ), count: occ.length });
  return out;
}

/** work×screen / screen / global の学習集計 (本番と同じ等重み平均)。 */
function buildBaselineAggregates(train) {
  const ws = buildGroupAvg(train, (s) => `${s.movieId}\t${s.screenId}`);
  const sc = buildGroupAvg(train, (s) => `${s.screenId}`);
  const globalAvg = mean(train.map((s) => s.actualOccupancyPct));
  return { ws, sc, globalAvg };
}

/**
 * チェーンを1件の上映に適用する。
 * steps: [{ name, avgMap, keyFn, minSamples }, ...] を先頭から順に試し、
 * avgMap にキーがあり count >= minSamples なら採用。無ければ次へ。
 * 最後は必ず globalAvg (常に採用可能)。
 */
function predictWithChain(steps, globalAvg, showing) {
  for (const step of steps) {
    const entry = step.avgMap.get(step.keyFn(showing));
    if (entry && entry.count >= step.minSamples) {
      return { predictedOccupancyPct: entry.avgOccupancyPct, basisName: step.name, count: entry.count };
    }
  }
  return { predictedOccupancyPct: globalAvg, basisName: 'global', count: null };
}

/** 検証期間の予測配列から指標一式を計算する。 */
function evaluate(validation, predictions, warmIds) {
  const n = validation.length;
  const absErr = predictions.map((p, i) => Math.abs(p.predictedOccupancyPct - validation[i].actualOccupancyPct));
  const mae = mean(absErr);

  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (let i = 0; i < n; i++) {
    const predVacant = predictions[i].predictedOccupancyPct < VACANCY_THRESHOLD_PCT;
    const actualVacant = validation[i].actualOccupancyPct < VACANCY_THRESHOLD_PCT;
    if (predVacant && actualVacant) tp++;
    else if (predVacant && !actualVacant) fp++;
    else if (!predVacant && actualVacant) fn++;
    else tn++;
  }
  const accuracy = (tp + tn) / n;
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  // predicted-lowest 10% (n = 検証件数の10%、四捨五入)
  const top10n = Math.round(n * 0.1);
  const order = predictions
    .map((p, i) => ({ pred: p.predictedOccupancyPct, actual: validation[i].actualOccupancyPct }))
    .sort((a, b) => a.pred - b.pred)
    .slice(0, top10n);
  const top10ActualMean = mean(order.map((o) => o.actual));
  const top10ActualUnder10 = order.filter((o) => o.actual < VACANCY_THRESHOLD_PCT).length / order.length;

  // warm (work×screen 実績あり) / cold (無し) の MAE。warm/cold の分け方は本番 (baseline) 基準に統一する。
  const warmErr = [];
  const coldErr = [];
  for (let i = 0; i < n; i++) {
    (warmIds.has(validation[i].showingId) ? warmErr : coldErr).push(absErr[i]);
  }

  return {
    n,
    mae,
    accuracy,
    precision,
    recall,
    f1,
    top10ActualMean,
    top10ActualUnder10,
    warmMae: warmErr.length ? mean(warmErr) : null,
    warmN: warmErr.length,
    coldMae: coldErr.length ? mean(coldErr) : null,
    coldN: coldErr.length,
  };
}

function fmt(r) {
  return (
    `MAE=${r.mae.toFixed(2)}  Acc=${r.accuracy.toFixed(3)}  P=${r.precision.toFixed(3)}  ` +
    `R=${r.recall.toFixed(3)}  F1=${r.f1.toFixed(3)}  ` +
    `Top10実測平均=${r.top10ActualMean.toFixed(2)}%  Top10実測<10%=${(r.top10ActualUnder10 * 100).toFixed(1)}%  ` +
    `warmMAE=${r.warmMae.toFixed(2)}(n=${r.warmN})  coldMAE=${r.coldMae.toFixed(2)}(n=${r.coldN})`
  );
}

// =====================================================================================
// ラウンド2: 祝日・サービスデー・上映時間・1日あたり上映回数・作品の過去人気 の検証
// =====================================================================================

function dow(showDate) {
  const [y, m, d] = showDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=日 ... 6=土
}
function dayOfMonth(showDate) {
  return Number(showDate.split('-')[2]);
}
/** 真の「土日祝」(祝日テーブルを使う。ラウンド1の weekdayType は週末のみで祝日を含まないため別物)。 */
function trueWeekdayType(showDate) {
  const d = dow(showDate);
  return d === 0 || d === 6 || isHoliday(showDate) ? 'holiday_type' : 'weekday_type';
}

const ROUND2_BOOLEAN_CANDIDATES = {
  holiday: (s) => String(isHoliday(s.showDate)),
  holidayAdjacent: (s) => String(isHolidayAdjacent(s.showDate)),
  firstDay: (s) => String(dayOfMonth(s.showDate) === 1),
  mensDay: (s) => String(dow(s.showDate) === 1), // 月曜
  ladiesDay: (s) => String(dow(s.showDate) === 5), // 金曜
  wednesday: (s) => String(dow(s.showDate) === 3), // ラベルは無いが単独効果として検証
  lateShow: (s) => String(Number(String(s.startTime).slice(0, 2)) >= 20),
  yearEndNewYear: (s) => String(s.showDate <= `${s.showDate.slice(0, 4)}-01-03` || s.showDate >= `${s.showDate.slice(0, 4)}-12-29`),
  weekdayType3: (s) => trueWeekdayType(s.showDate),
  workWeekdayType3: (s) => `${s.movieId}\t${trueWeekdayType(s.showDate)}`,
  dailyWorkShowCount: null, // 下で別途、日ごとの集計が要るため特別扱い
};

/** movieId+showDate ごとの「その日の上映回数」を返す関数を作る (train/validation 共通ロジック)。 */
function buildDailyWorkShowCountFn(allRowsForCounting) {
  const counts = new Map();
  for (const s of allRowsForCounting) {
    const k = `${s.movieId}|${s.showDate}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return (s) => String(counts.get(`${s.movieId}|${s.showDate}`) || 0);
}

/** work ごとの平均販売座席数 (率ではなく人数) → 対象上映の座席数で正規化した占有率に変換。 */
function buildWorkAvgSoldSeatsNormalized(train) {
  const groups = new Map();
  for (const s of train) {
    if (!groups.has(s.movieId)) groups.set(s.movieId, []);
    groups.get(s.movieId).push(s.soldSeats);
  }
  const avgSoldSeatsByWork = new Map();
  for (const [k, arr] of groups) avgSoldSeatsByWork.set(k, { avgSoldSeats: mean(arr), count: arr.length });
  return avgSoldSeatsByWork;
}

function evaluateRound2() {
  const { showings } = loadShowings();
  const train = showings.filter((s) => s.inTrainingWindow);
  const validation = showings.filter((s) => s.inValidationWindow);
  const { ws, sc, globalAvg } = buildBaselineAggregates(train);
  const warmIds = new Set(validation.filter((s) => ws.has(`${s.movieId}\t${s.screenId}`)).map((s) => s.showingId));
  const baselineSteps = [
    { name: 'work_screen', avgMap: ws, keyFn: (s) => `${s.movieId}\t${s.screenId}`, minSamples: 1 },
    { name: 'screen', avgMap: sc, keyFn: (s) => `${s.screenId}`, minSamples: 1 },
  ];
  const baselinePred = validation.map((s) => predictWithChain(baselineSteps, globalAvg, s));
  const baselineResult = evaluate(validation, baselinePred, warmIds);

  console.log('\n\n=== ラウンド2: 祝日・サービスデー・上映時間・1日あたり上映回数・過去人気 ===\n');

  // --- 事前チェック: 大型連休・特殊期間は検証期間にデータが無く検証不能なものを明記する ---
  console.log('[R2-0] 大型連休・特殊期間の train/validation 件数 (検証不能なものはここで除外)');
  const ranges = {
    'GW (04-29〜05-05)': ['2025-04-29', '2025-05-05'],
    'お盆 (08-13〜08-16)': ['2025-08-13', '2025-08-16'],
    'シルバーウィーク (09-15〜09-23)': ['2025-09-15', '2025-09-23'],
  };
  for (const [name, [s, e]] of Object.entries(ranges)) {
    const trainN = train.filter((x) => x.showDate >= s && x.showDate <= e).length;
    const valN = validation.filter((x) => x.showDate >= s && x.showDate <= e).length;
    console.log(`  ${name.padEnd(24)} train=${trainN}  validation=${valN}  ${valN === 0 ? '=> 検証不能 (validationに1件も無い)。不採用' : ''}`);
  }
  console.log('  年末年始 (12-29〜01-03)        train=180  validation=180  => 検証可能 (下記 yearEndNewYear で評価)');
  console.log('');

  // --- 事前チェック: 上映時間・スクリーン別1日上映本数は分散ゼロで検証不能 ---
  function toMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
  const durations = new Set(train.map((s) => 0)); // duration は loadShowings に無いので schedules.csv 直読みで確認済み (下記コメント参照)
  console.log('[R2-1] 上映時間 (duration_minutes): data/schedules.csv の全21,900件で 120分固定 (分散ゼロ)。');
  console.log('        値が1種類しかない特徴量は学習しても係数を持てない (定数と同じ) ため、検証不能として不採用。');
  console.log('[R2-2] スクリーンの1日あたり上映本数: 全スクリーン・全日で 6本固定 (分散ゼロ)。同じ理由で不採用。');
  console.log('');

  // --- 各候補を評価するヘルパ ---
  function runCandidate(name, keyFn) {
    const avgMap = buildGroupAvg(train, keyFn);
    const soloSteps = [
      { name: 'work_screen', avgMap: ws, keyFn: (s) => `${s.movieId}\t${s.screenId}`, minSamples: 1 },
      { name, avgMap, keyFn, minSamples: MIN_SAMPLES },
    ];
    const insertSteps = [
      { name: 'work_screen', avgMap: ws, keyFn: (s) => `${s.movieId}\t${s.screenId}`, minSamples: 1 },
      { name, avgMap, keyFn, minSamples: MIN_SAMPLES },
      { name: 'screen', avgMap: sc, keyFn: (s) => `${s.screenId}`, minSamples: 1 },
    ];
    const soloPred = validation.map((s) => predictWithChain(soloSteps, globalAvg, s));
    const insertPred = validation.map((s) => predictWithChain(insertSteps, globalAvg, s));
    const soloResult = evaluate(validation, soloPred, warmIds);
    const insertResult = evaluate(validation, insertPred, warmIds);
    const usedCount = insertPred.filter((p) => p.basisName === name).length;
    return { soloResult, insertResult, usedCount };
  }

  console.log('[R2-3] 単独 (work×screen→候補→global) / 挿入 (work×screen→候補→screen→global) 比較');
  const round2Results = {};
  for (const [name, keyFn] of Object.entries(ROUND2_BOOLEAN_CANDIDATES)) {
    if (name === 'dailyWorkShowCount') continue; // 下で別途処理
    const { soloResult, insertResult, usedCount } = runCandidate(name, keyFn);
    round2Results[name] = insertResult;
    console.log(`  [単独]${name.padEnd(18)} ${fmt(soloResult)}`);
    console.log(`  [挿入]${name.padEnd(18)} ${fmt(insertResult)}  (validationで使用=${usedCount}件)`);
  }

  // dailyWorkShowCount: train/validation それぞれの「その日の上映回数」を使う (未来の情報を参照しない)
  {
    const trainDailyFn = buildDailyWorkShowCountFn(train);
    const valDailyFn = buildDailyWorkShowCountFn(validation); // 検証対象日の上映本数は当日分の schedules.csv (=未来情報ではなく確定済みスケジュール) から計算可能
    const keyFnForTrainBuild = trainDailyFn;
    const avgMap = buildGroupAvg(train, keyFnForTrainBuild);
    // 予測時に使う keyFn は「対象日の確定スケジュールから求めた本数」= 検証側は valDailyFn を使う
    const soloSteps = [
      { name: 'work_screen', avgMap: ws, keyFn: (s) => `${s.movieId}\t${s.screenId}`, minSamples: 1 },
      { name: 'dailyWorkShowCount', avgMap, keyFn: valDailyFn, minSamples: MIN_SAMPLES },
    ];
    const insertSteps = [
      { name: 'work_screen', avgMap: ws, keyFn: (s) => `${s.movieId}\t${s.screenId}`, minSamples: 1 },
      { name: 'dailyWorkShowCount', avgMap, keyFn: valDailyFn, minSamples: MIN_SAMPLES },
      { name: 'screen', avgMap: sc, keyFn: (s) => `${s.screenId}`, minSamples: 1 },
    ];
    const soloPred = validation.map((s) => predictWithChain(soloSteps, globalAvg, s));
    const insertPred = validation.map((s) => predictWithChain(insertSteps, globalAvg, s));
    const soloResult = evaluate(validation, soloPred, warmIds);
    const insertResult = evaluate(validation, insertPred, warmIds);
    round2Results.dailyWorkShowCount = insertResult;
    const usedCount = insertPred.filter((p) => p.basisName === 'dailyWorkShowCount').length;
    console.log(`  [単独]${'dailyWorkShowCount'.padEnd(18)} ${fmt(soloResult)}`);
    console.log(`  [挿入]${'dailyWorkShowCount'.padEnd(18)} ${fmt(insertResult)}  (validationで使用=${usedCount}件)`);
  }

  // workAvgSoldSeatsNormalized: avgMap の値の意味が異なる (占有率ではなく販売席数) ので専用ロジック
  {
    const avgSoldSeatsByWork = buildWorkAvgSoldSeatsNormalized(train);
    function predictNormalized(showing) {
      const wsEntry = ws.get(`${showing.movieId}\t${showing.screenId}`);
      if (wsEntry) return { predictedOccupancyPct: wsEntry.avgOccupancyPct, basisName: 'work_screen' };
      const entry = avgSoldSeatsByWork.get(showing.movieId);
      if (entry && entry.count >= MIN_SAMPLES) {
        const pct = Math.max(0, Math.min(100, (entry.avgSoldSeats / showing.seatCapacity) * 100));
        return { predictedOccupancyPct: pct, basisName: 'workAvgSoldSeatsNormalized' };
      }
      const scEntry = sc.get(showing.screenId);
      if (scEntry) return { predictedOccupancyPct: scEntry.avgOccupancyPct, basisName: 'screen' };
      return { predictedOccupancyPct: globalAvg, basisName: 'global' };
    }
    const pred = validation.map(predictNormalized);
    const result = evaluate(validation, pred, warmIds);
    round2Results.workAvgSoldSeatsNormalized = result;
    const usedCount = pred.filter((p) => p.basisName === 'workAvgSoldSeatsNormalized').length;
    console.log(`  [挿入]${'workAvgSoldSeatsNormalized'.padEnd(18)} ${fmt(result)}  (validationで使用=${usedCount}件)`);
  }
  console.log('');

  console.log('[R2-4] 作品の過去上映回数 (work historical show count) について:');
  console.log('        これ自体は混雑率の「値」を出す特徴ではなく (件数≠占有率)、既存の confidence の根拠として');
  console.log('        既に使われている (historyCount)。value predictor としては不適切なため候補から除外。');
  console.log('');

  // --- 採用ルール照合 ---
  console.log('[R2-5] 採用ルール照合 (MAE明確改善[-0.10以上] または F1/Top10明確改善、かつ coldMAE非悪化)');
  for (const [name, r] of Object.entries(round2Results)) {
    const maeGain = baselineResult.mae - r.mae;
    const f1Gain = r.f1 - baselineResult.f1;
    const top10MeanGain = baselineResult.top10ActualMean - r.top10ActualMean;
    const top10Under10Gain = r.top10ActualUnder10 - baselineResult.top10ActualUnder10;
    const coldOk = r.coldMae <= baselineResult.coldMae + 0.02;
    const meaningfulGain = maeGain >= 0.1 || f1Gain >= 0.01 || top10MeanGain >= 0.2 || top10Under10Gain >= 0.01;
    const pass = meaningfulGain && coldOk;
    console.log(
      `  ${name.padEnd(24)} ΔMAE=${maeGain >= 0 ? '+' : ''}${maeGain.toFixed(3)}  ΔF1=${f1Gain >= 0 ? '+' : ''}${f1Gain.toFixed(3)}  ` +
        `ΔTop10平均=${top10MeanGain >= 0 ? '+' : ''}${top10MeanGain.toFixed(3)}pt  ΔTop10<10%=${(top10Under10Gain * 100).toFixed(1)}pt  ` +
        `coldMAE変化=${(r.coldMae - baselineResult.coldMae).toFixed(3)}  => ${pass ? '採用条件を満たす' : '不採用'}`
    );
  }
}

function main() {
  const { showings } = loadShowings();
  const train = showings.filter((s) => s.inTrainingWindow);
  const validation = showings.filter((s) => s.inValidationWindow);

  const { ws, sc, globalAvg } = buildBaselineAggregates(train);

  // 本番と同じ warm/cold 定義: 検証上映の (作品ID, スクリーンID) が学習期間に存在するか
  const warmIds = new Set(validation.filter((s) => ws.has(`${s.movieId}\t${s.screenId}`)).map((s) => s.showingId));

  console.log('=== 検証: 未来予測の改善候補比較 ===');
  console.log(`学習期間 ${TRAINING_START}〜${TRAINING_END} / 検証期間 2025-10-01〜2025-12-31 (n=${validation.length})`);
  console.log(`最低サンプル数 (新候補のみ): ${MIN_SAMPLES}`);
  console.log('');

  // --- 0) 基準値 (本番: work×screen → screen → global) ---
  const baselineSteps = [
    { name: 'work_screen', avgMap: ws, keyFn: (s) => `${s.movieId}\t${s.screenId}`, minSamples: 1 },
    { name: 'screen', avgMap: sc, keyFn: (s) => `${s.screenId}`, minSamples: 1 },
  ];
  const baselinePred = validation.map((s) => predictWithChain(baselineSteps, globalAvg, s));
  const baselineResult = evaluate(validation, baselinePred, warmIds);
  console.log('[0] Stats baseline (本番: work×screen→screen→global)');
  console.log('    ' + fmt(baselineResult));
  console.log(
    '    既知基準値: MAE=4.28 Acc=0.839 P=0.796 R=0.793 F1=0.795 Top10実測平均=6.41% Top10実測<10%=96.7%'
  );
  console.log('');

  // --- 1) 各候補を「screen の代わり」として使う単独チェーン: work×screen → 候補 → global ---
  console.log('[1] 各候補を screen average の代わりに使った場合 (work×screen → 候補 → global)');
  const soloResults = {};
  for (const [name, keyFn] of Object.entries(CANDIDATES)) {
    const avgMap = buildGroupAvg(train, keyFn);
    const steps = [
      { name: 'work_screen', avgMap: ws, keyFn: (s) => `${s.movieId}\t${s.screenId}`, minSamples: 1 },
      { name, avgMap, keyFn, minSamples: MIN_SAMPLES },
    ];
    const pred = validation.map((s) => predictWithChain(steps, globalAvg, s));
    const result = evaluate(validation, pred, warmIds);
    soloResults[name] = { result, avgMap };
    const fallbackToGlobalCount = pred.filter((p) => p.basisName === 'global').length;
    console.log(`  ${name.padEnd(16)} ${fmt(result)}  (globalへ直接落ちた件数=${fallbackToGlobalCount})`);
  }
  console.log('');

  // --- 2) 有望な候補を「screen の前段」として追加する4段チェーン: work×screen → 候補 → screen → global ---
  console.log('[2] 各候補を screen average の手前に追加した場合 (work×screen → 候補 → screen → global)');
  const insertResults = {};
  for (const [name, keyFn] of Object.entries(CANDIDATES)) {
    const avgMap = soloResults[name].avgMap;
    const steps = [
      { name: 'work_screen', avgMap: ws, keyFn: (s) => `${s.movieId}\t${s.screenId}`, minSamples: 1 },
      { name, avgMap, keyFn, minSamples: MIN_SAMPLES },
      { name: 'screen', avgMap: sc, keyFn: (s) => `${s.screenId}`, minSamples: 1 },
    ];
    const pred = validation.map((s) => predictWithChain(steps, globalAvg, s));
    const result = evaluate(validation, pred, warmIds);
    insertResults[name] = result;
    console.log(`  ${name.padEnd(16)} ${fmt(result)}`);
  }
  console.log('');

  // --- 3) 採用判定 (機械的な参考表示。最終判断はこのスクリプトの出力を見て人が行う) ---
  console.log('[3] 採用ルール照合 (MAEが基準より明確に改善 [-0.10以上] または Top10実測平均が明確に改善 [-0.20pt以上]、かつ coldMAE が悪化していない)');
  for (const [name, r] of Object.entries(insertResults)) {
    const maeGain = baselineResult.mae - r.mae;
    const top10Gain = baselineResult.top10ActualMean - r.top10ActualMean;
    const coldOk = r.coldMae <= baselineResult.coldMae + 0.02;
    const pass = (maeGain >= 0.1 || top10Gain >= 0.2) && coldOk;
    console.log(
      `  ${name.padEnd(16)} ΔMAE=${maeGain >= 0 ? '+' : ''}${maeGain.toFixed(3)}  ` +
        `ΔTop10平均=${top10Gain >= 0 ? '+' : ''}${top10Gain.toFixed(3)}pt  coldMAE変化=${(r.coldMae - baselineResult.coldMae).toFixed(3)}  ` +
        `=> ${pass ? '採用条件を満たす' : '不採用'}`
    );
  }
}

main();
evaluateRound2();
