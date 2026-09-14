'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadShowings } = require('../src/dataset');
const { buildAggregates, mean } = require('../src/buildAggregates');
const { createPredictor } = require('../src/predictor');
const {
  TRAINING_START,
  TRAINING_END,
  VALIDATION_START,
  VALIDATION_END,
  BASIS_WORK_SCREEN,
  BASIS_SCREEN,
  SOURCE_WORK_SCREEN,
  SOURCE_SCREEN,
  SOURCE_GLOBAL,
  CONFIDENCE_HIGH,
  CONFIDENCE_MEDIUM,
  CONFIDENCE_LOW,
} = require('../src/config');

// 実データを一度だけロード (読み取り専用)
const { showings } = loadShowings();
const aggregates = buildAggregates(showings);
const predictor = createPredictor(aggregates);

const wsKey = (movieId, screenId) => `${movieId}\t${screenId}`;
const workScreenKeys = new Set(aggregates.workScreen.map((e) => wsKey(e.movieId, e.screenId)));
const workScreenByKey = new Map(aggregates.workScreen.map((e) => [wsKey(e.movieId, e.screenId), e]));
const screenById = new Map(aggregates.screen.map((e) => [e.screenId, e]));

test('テスト1: 作品×スクリーン実績あり → work_screen_avg を返す', () => {
  // 学習上映数が最も多い組み合わせを選ぶ (確実に実績ありのケース)
  const entry = [...aggregates.workScreen].sort(
    (a, b) => b.trainingShowCount - a.trainingShowCount
  )[0];

  const result = predictor.predict({
    showingId: 'TEST-1',
    movieId: entry.movieId,
    movieTitle: 'dummy',
    screenId: entry.screenId,
    showDateTime: '2025-11-01 19:00',
    seatCapacity: 999,
  });

  assert.equal(result.predictedOccupancyPct, entry.avgOccupancyPct);
  assert.equal(result.predictionBasis, BASIS_WORK_SCREEN);
  assert.equal(result.predictionSource, SOURCE_WORK_SCREEN);
  assert.equal(result.confidenceLabel, '実績あり');
  assert.equal(result.trainingShowCount, entry.trainingShowCount);
});

test('テスト2: 作品×スクリーン実績なし → screen_avg を返す', () => {
  // 検証期間の上映で、同じ (作品ID, スクリーンID) が学習期間に無いものを探す
  const target = showings.find(
    (s) => s.inValidationWindow && !workScreenKeys.has(wsKey(s.movieId, s.screenId))
  );
  assert.ok(target, '該当上映が見つかること');

  const scEntry = screenById.get(target.screenId);
  assert.ok(scEntry, 'そのスクリーンの学習平均が存在すること');

  const result = predictor.predict({
    showingId: target.showingId,
    movieId: target.movieId,
    movieTitle: target.movieTitle,
    screenId: target.screenId,
    showDateTime: target.showDateTime,
    seatCapacity: target.seatCapacity,
  });

  assert.equal(result.predictedOccupancyPct, scEntry.avgOccupancyPct);
  assert.equal(result.predictionBasis, BASIS_SCREEN);
  assert.equal(result.predictionSource, SOURCE_SCREEN);
  assert.equal(result.confidenceLabel, 'フォールバック');
});

test('テスト3: 新作 (学習期間に作品が存在しない) → スクリーン平均にフォールバック', () => {
  const trainingMovieIds = new Set(
    showings.filter((s) => s.inTrainingWindow).map((s) => s.movieId)
  );
  const newMovieShowings = showings.filter(
    (s) => s.inValidationWindow && !trainingMovieIds.has(s.movieId)
  );
  assert.ok(newMovieShowings.length > 0, '検証期間のみに存在する作品があること');

  for (const s of newMovieShowings.slice(0, 50)) {
    // 新作なので作品×スクリーンの集計はどのスクリーンでも存在しない
    const hasAnyWorkScreen = aggregates.workScreen.some((e) => e.movieId === s.movieId);
    assert.equal(hasAnyWorkScreen, false);

    const result = predictor.predict({
      showingId: s.showingId,
      movieId: s.movieId,
      movieTitle: s.movieTitle,
      screenId: s.screenId,
      showDateTime: s.showDateTime,
      seatCapacity: s.seatCapacity,
    });
    assert.equal(result.predictionSource, SOURCE_SCREEN);
    assert.equal(result.predictionBasis, BASIS_SCREEN);
    assert.equal(result.predictedOccupancyPct, screenById.get(s.screenId).avgOccupancyPct);
  }
});

test('テスト4: 10%境界 — 9.99→true, 10.00→false, 10.01→false (丸め前で判定)', () => {
  // 合成集計データで境界だけを検証する
  const synthetic = {
    trainingWindow: { start: TRAINING_START, end: TRAINING_END },
    workScreen: [],
    screen: [
      { screenId: 'A', trainingShowCount: 10, avgOccupancyPct: 9.99 },
      { screenId: 'B', trainingShowCount: 10, avgOccupancyPct: 10.0 },
      { screenId: 'C', trainingShowCount: 10, avgOccupancyPct: 10.01 },
      { screenId: 'D', trainingShowCount: 10, avgOccupancyPct: 9.96 }, // 表示は 10.0 だが判定は true
    ],
    global: { trainingShowCount: 100, avgOccupancyPct: 14 },
  };
  const p = createPredictor(synthetic);

  const a = p.predict({ movieId: 'X', screenId: 'A' });
  const b = p.predict({ movieId: 'X', screenId: 'B' });
  const c = p.predict({ movieId: 'X', screenId: 'C' });
  const d = p.predict({ movieId: 'X', screenId: 'D' });

  assert.equal(a.isVacant, true, '9.99% は空いている');
  assert.equal(b.isVacant, false, '10.00% ちょうどは空いている扱いにしない');
  assert.equal(c.isVacant, false, '10.01% は空いていない');

  // 丸め前の値で判定される (表示値 10.0 でも実値 9.96 なので vacant)
  assert.equal(d.predictedOccupancyPctDisplay, 10.0);
  assert.equal(d.isVacant, true);
});

test('テスト5: ランキング — 予測混雑率昇順 → 上映日時 → 上映ID', () => {
  const predicted = [
    { showingId: 'S3', showDateTime: '2025-10-01 12:00', predictedOccupancyPct: 12.0 },
    { showingId: 'S1', showDateTime: '2025-10-01 09:00', predictedOccupancyPct: 5.0 },
    // 予測混雑率が同値 → 上映日時が早い方が上位
    { showingId: 'S4', showDateTime: '2025-10-02 09:00', predictedOccupancyPct: 8.0 },
    { showingId: 'S2', showDateTime: '2025-10-01 21:00', predictedOccupancyPct: 8.0 },
    // 予測混雑率も上映日時も同値 → 上映ID 昇順
    { showingId: 'S6', showDateTime: '2025-10-01 21:00', predictedOccupancyPct: 8.0 },
    { showingId: 'S5', showDateTime: '2025-10-01 21:00', predictedOccupancyPct: 8.0 },
  ];

  const ranked = predictor.rank(predicted);
  assert.deepEqual(
    ranked.map((r) => r.showingId),
    ['S1', 'S2', 'S5', 'S6', 'S4', 'S3']
  );
  assert.deepEqual(
    ranked.map((r) => r.vacancyRank),
    [1, 2, 3, 4, 5, 6]
  );
  // 入力配列は変更されない
  assert.equal(predicted[0].showingId, 'S3');
  assert.equal(predicted[0].vacancyRank, undefined);
});

test('テスト6a: 集計は学習期間 (2025-01-01〜2025-09-30) だけから作られている', () => {
  const training = showings.filter((s) => s.inTrainingWindow);
  const validation = showings.filter((s) => s.inValidationWindow);

  // 期間フラグの健全性
  for (const s of training) {
    assert.ok(s.showDate >= TRAINING_START && s.showDate <= TRAINING_END);
    assert.equal(s.inValidationWindow, false);
  }
  for (const s of validation) {
    assert.ok(s.showDate >= VALIDATION_START && s.showDate <= VALIDATION_END);
    assert.equal(s.inTrainingWindow, false);
  }

  // 集計に含まれる上映数の合計 = 学習上映数 (検証分が1件も混ざっていない)
  const screenCountSum = aggregates.screen.reduce((a, e) => a + e.trainingShowCount, 0);
  const wsCountSum = aggregates.workScreen.reduce((a, e) => a + e.trainingShowCount, 0);
  assert.equal(aggregates.global.trainingShowCount, training.length);
  assert.equal(screenCountSum, training.length);
  assert.equal(wsCountSum, training.length);

  // 全上映数より確実に少ない (検証分が除外されている)
  assert.ok(training.length < showings.length);
  assert.equal(training.length + validation.length, showings.length);
});

test('テスト6b: 集計値は学習期間のみの等重み平均と厳密一致する (独立再計算)', () => {
  const training = showings.filter((s) => s.inTrainingWindow);

  // work_screen を独立に再計算
  const wsGroups = new Map();
  for (const s of training) {
    const k = `${s.movieId}\t${s.screenId}`;
    if (!wsGroups.has(k)) wsGroups.set(k, []);
    wsGroups.get(k).push(s.actualOccupancyPct);
  }
  assert.equal(aggregates.workScreen.length, wsGroups.size);
  for (const e of aggregates.workScreen) {
    const occ = wsGroups.get(`${e.movieId}\t${e.screenId}`);
    assert.ok(occ, '再計算側にも同じキーがある');
    assert.equal(e.trainingShowCount, occ.length);
    assert.equal(e.avgOccupancyPct, mean(occ));
  }

  // screen を独立に再計算
  const scGroups = new Map();
  for (const s of training) {
    if (!scGroups.has(s.screenId)) scGroups.set(s.screenId, []);
    scGroups.get(s.screenId).push(s.actualOccupancyPct);
  }
  assert.equal(aggregates.screen.length, scGroups.size);
  for (const e of aggregates.screen) {
    const occ = scGroups.get(e.screenId);
    assert.equal(e.trainingShowCount, occ.length);
    assert.equal(e.avgOccupancyPct, mean(occ));
  }

  // global
  assert.equal(
    aggregates.global.avgOccupancyPct,
    mean(training.map((s) => s.actualOccupancyPct))
  );
});

test('テスト6c: 検証期間の実績を加えると集計が変わる (= 現状は確実に除外されている)', () => {
  // 検証期間まで含めて集計した場合と比較し、値が異なることを示す
  const contaminated = buildAggregatesIncludingValidation(showings);
  assert.notEqual(
    contaminated.global.avgOccupancyPct,
    aggregates.global.avgOccupancyPct
  );
  assert.ok(contaminated.global.trainingShowCount > aggregates.global.trainingShowCount);
});

test('テスト7: 混雑率の定義 — soldSeats / seatCapacity * 100 (グループ人数不使用)', () => {
  // 実データ数件で定義式が守られていることを確認
  for (const s of showings.slice(0, 200)) {
    assert.equal(s.actualOccupancyPct, (s.soldSeats / s.seatCapacity) * 100);
    assert.ok(s.actualOccupancyPct >= 0 && s.actualOccupancyPct <= 100);
  }
});

test('テスト8: buildAggregates は決定的 (2回実行して同一)', () => {
  const a1 = buildAggregates(showings);
  const a2 = buildAggregates(showings);
  assert.deepEqual(a1, a2);
});

test('テスト9: historyCount は trainingShowCount の別名として同じ値を持つ', () => {
  const entry = aggregates.workScreen[0];
  const result = predictor.predict({
    movieId: entry.movieId,
    screenId: entry.screenId,
    showDateTime: '2025-11-01 19:00',
  });
  assert.equal(result.historyCount, result.trainingShowCount);
  assert.equal(result.historyCount, entry.trainingShowCount);
});

test('テスト10: confidence — work×screen は件数に応じて high/medium/low が変わる (予測精度ではなく過去実績量の参考度)', () => {
  const synthetic = {
    trainingWindow: { start: TRAINING_START, end: TRAINING_END },
    workScreen: [
      { movieId: 'M1', screenId: '1', trainingShowCount: 20, avgOccupancyPct: 10 }, // high境界
      { movieId: 'M2', screenId: '1', trainingShowCount: 19, avgOccupancyPct: 10 }, // medium境界未満
      { movieId: 'M3', screenId: '1', trainingShowCount: 5, avgOccupancyPct: 10 }, // medium境界
      { movieId: 'M4', screenId: '1', trainingShowCount: 4, avgOccupancyPct: 10 }, // low
    ],
    screen: [],
    global: { trainingShowCount: 100, avgOccupancyPct: 14 },
  };
  const p = createPredictor(synthetic);

  assert.equal(p.predict({ movieId: 'M1', screenId: '1' }).confidence, CONFIDENCE_HIGH);
  assert.equal(p.predict({ movieId: 'M2', screenId: '1' }).confidence, CONFIDENCE_MEDIUM);
  assert.equal(p.predict({ movieId: 'M3', screenId: '1' }).confidence, CONFIDENCE_MEDIUM);
  assert.equal(p.predict({ movieId: 'M4', screenId: '1' }).confidence, CONFIDENCE_LOW);
});

test('テスト11: confidence — screen 段は件数に関わらず high にはならない (作品への特化度が低いため)', () => {
  const synthetic = {
    trainingWindow: { start: TRAINING_START, end: TRAINING_END },
    workScreen: [],
    screen: [{ screenId: '1', trainingShowCount: 1638, avgOccupancyPct: 14 }],
    global: { trainingShowCount: 16380, avgOccupancyPct: 14 },
  };
  const p = createPredictor(synthetic);
  const result = p.predict({ movieId: 'NEW', screenId: '1' });
  assert.equal(result.predictionSource, SOURCE_SCREEN);
  assert.equal(result.confidence, CONFIDENCE_MEDIUM);
  assert.notEqual(result.confidence, CONFIDENCE_HIGH);
});

test('テスト12: confidence — global 段は常に low', () => {
  const synthetic = {
    trainingWindow: { start: TRAINING_START, end: TRAINING_END },
    workScreen: [],
    screen: [],
    global: { trainingShowCount: 16380, avgOccupancyPct: 14 },
  };
  const p = createPredictor(synthetic);
  const result = p.predict({ movieId: 'NEW', screenId: 'NEW-SCREEN' });
  assert.equal(result.predictionSource, SOURCE_GLOBAL);
  assert.equal(result.confidence, CONFIDENCE_LOW);
});

// --- helper: 検証期間を含めて集計 (リーク比較用。本番ロジックでは絶対に使わない) ---
function buildAggregatesIncludingValidation(all) {
  const rows = all.filter((s) => s.inTrainingWindow || s.inValidationWindow);
  const occ = rows.map((s) => s.actualOccupancyPct);
  return {
    global: { trainingShowCount: rows.length, avgOccupancyPct: mean(occ) },
  };
}
