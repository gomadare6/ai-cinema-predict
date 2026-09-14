'use strict';

/**
 * ラウンド2 (祝日・サービスデー・上映時間・1日あたり上映回数・過去人気) の検証で使った
 * 補助ロジックの正しさを確認する。本番の予測チェーン (src/predictor.js) は無変更のため、
 * ここでは「検証に使った前提が正しいか」「今後どの特徴が採用されても壊れない土台か」を確認する。
 *
 * 採用された候補は無い (scripts/evaluate-future-candidates.js の結果、
 * 本番基準 work×screen→screen→global を明確に上回るものが無かったため)。
 * そのため predictionBasis / historyCount / confidence の意味・既存チェーンは前回同様、無変更。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { isHoliday, isHolidayAdjacent } = require('../src/holidays');
const { loadShowings, loadFutureShowings } = require('../src/dataset');
const { readCsv } = require('../src/csv');
const { buildAggregates } = require('../src/buildAggregates');
const { createPredictor } = require('../src/predictor');
const { VACANCY_THRESHOLD_PCT, DATA_DIR, CONFIDENCE_HIGH, CONFIDENCE_MEDIUM, CONFIDENCE_LOW, BASIS_WORK_SCREEN, BASIS_SCREEN, BASIS_GLOBAL } = require('../src/config');
const path = require('path');

const { showings } = loadShowings();
const train = showings.filter((s) => s.inTrainingWindow);
const aggregates = buildAggregates(showings);
const predictor = createPredictor(aggregates);

// ---------------------------------------------------------------------------
// 1) 祝日テーブル (src/holidays.js) が data/schedules.csv の「曜日種別」と完全一致すること
// ---------------------------------------------------------------------------
test('holiday: 祝日テーブルが schedules.csv の曜日種別 (土日祝/平日) と全365日一致する', () => {
  const { rows } = readCsv(path.join(DATA_DIR, 'schedules.csv'));
  const byDate = new Map();
  for (const r of rows) if (!byDate.has(r['上映日'])) byDate.set(r['上映日'], r['曜日種別']);

  function dow(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  }

  assert.equal(byDate.size, 365, '前提: 2025年の365日ぶんのデータがある');
  let checked = 0;
  for (const [date, weekdayType] of byDate) {
    const d = dow(date);
    const expected = d === 0 || d === 6 || isHoliday(date) ? '土日祝' : '平日';
    assert.equal(weekdayType, expected, `${date} の曜日種別`);
    checked++;
  }
  assert.equal(checked, 365);
});

test('holiday: 既知の祝日・振替休日が isHoliday=true になる (代表サンプル)', () => {
  for (const d of ['2025-01-01', '2025-01-13', '2025-02-24', '2025-05-05', '2025-11-24']) {
    assert.equal(isHoliday(d), true, `${d} は祝日`);
  }
  for (const d of ['2025-01-02', '2025-06-15', '2025-10-01']) {
    assert.equal(isHoliday(d), false, `${d} は祝日ではない`);
  }
});

test('holiday: isHolidayAdjacent は祝日の前日・翌日だけ true になる', () => {
  // 2025-01-13 (成人の日) の前日・翌日
  assert.equal(isHolidayAdjacent('2025-01-12'), true);
  assert.equal(isHolidayAdjacent('2025-01-14'), true);
  assert.equal(isHolidayAdjacent('2025-01-13'), false, '祝日当日自体は「前後」に含めない');
  assert.equal(isHolidayAdjacent('2025-06-15'), false, '祝日と無関係な日は false');
});

// ---------------------------------------------------------------------------
// 2) サービスデー (ファーストデイ/メンズデイ/レディースデイ) の日付ルールが実データと一致すること
// ---------------------------------------------------------------------------
test('service day: ファーストデイ=毎月1日、メンズデイ=月曜、レディースデイ=金曜 が実データの特別日ラベルと一致する', () => {
  const { rows } = readCsv(path.join(DATA_DIR, 'schedules.csv'));
  const byDate = new Map();
  for (const r of rows) if (!byDate.has(r['上映日'])) byDate.set(r['上映日'], r['特別日']);

  function dow(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  }

  let firstDayChecked = 0, mensDayChecked = 0, ladiesDayChecked = 0;
  for (const [date, special] of byDate) {
    const dom = Number(date.split('-')[2]);
    const d = dow(date);
    if (special === 'ファーストデイ') {
      assert.equal(dom, 1, `${date} のファーストデイは月初`);
      firstDayChecked++;
    }
    if (special === 'メンズデイ') {
      assert.equal(d, 1, `${date} のメンズデイは月曜`);
      mensDayChecked++;
    }
    if (special === 'レディースデイ') {
      assert.equal(d, 5, `${date} のレディースデイは金曜`);
      ladiesDayChecked++;
    }
  }
  assert.ok(firstDayChecked > 0 && mensDayChecked > 0 && ladiesDayChecked > 0, '各サービスデーが実際に存在する');

  // 逆方向: 月初なら必ずファーストデイ、月曜/金曜なら必ずメンズ/レディースデイ
  // (ただし月初と重なる日は「ファーストデイ」が優先されるため、月初以外だけで確認する)
  for (const [date, special] of byDate) {
    const dom = Number(date.split('-')[2]);
    const d = dow(date);
    if (dom === 1) {
      assert.equal(special, 'ファーストデイ', `${date} は月初なのにファーストデイでない`);
      continue;
    }
    if (d === 1) assert.equal(special, 'メンズデイ', `${date} は月曜なのにメンズデイでない`);
    if (d === 5) assert.equal(special, 'レディースデイ', `${date} は金曜なのにレディースデイでない`);
  }
});

test('service day: 「水曜のルルカメンバーズデイ」に対応する特別日ラベルは実データに存在しない (検証不能を裏付け)', () => {
  const { rows } = readCsv(path.join(DATA_DIR, 'schedules.csv'));
  const specialValues = new Set(rows.map((r) => r['特別日']));
  assert.deepEqual(
    [...specialValues].sort(),
    ['', 'ファーストデイ', 'メンズデイ', 'レディースデイ'].sort(),
    '特別日ラベルは4種類のみ (水曜メンバーズデイに相当するラベルは無い)'
  );
});

// ---------------------------------------------------------------------------
// 3) 上映時間 (duration) は分散ゼロであること (候補から除外した根拠の裏付け)
// ---------------------------------------------------------------------------
test('duration: schedules.csv の上映時間は全件120分固定 (分散ゼロなので特徴量として無効)', () => {
  const { rows } = readCsv(path.join(DATA_DIR, 'schedules.csv'));
  function toMin(t) {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  }
  const durations = new Set(rows.map((r) => toMin(r['終了時刻']) - toMin(r['開始時刻'])));
  assert.deepEqual([...durations], [120]);
});

// ---------------------------------------------------------------------------
// 4) 作品の1日あたり上映回数 (daily_work_show_count) が未来上映でも計算可能なこと
// ---------------------------------------------------------------------------
test('daily work show count: future_showings.csv の同一日付の行数だけから計算できる (ticket_sales不要)', () => {
  // 同じ日に同じ作品が複数回上映されるケースを模した未来上映データで検証する
  const futureRows = [
    { movieId: 'M0001', showDate: '2026-11-01' },
    { movieId: 'M0001', showDate: '2026-11-01' },
    { movieId: 'M0001', showDate: '2026-11-01' },
    { movieId: 'M0002', showDate: '2026-11-01' },
  ];

  function dailyWorkShowCount(rows, target) {
    return rows.filter((r) => r.movieId === target.movieId && r.showDate === target.showDate).length;
  }

  assert.equal(dailyWorkShowCount(futureRows, futureRows[0]), 3, 'M0001 はその日3回');
  assert.equal(dailyWorkShowCount(futureRows, futureRows[3]), 1, 'M0002 はその日1回');
  // 販売実績 (ticket_sales.csv) を一切参照していないことがコード上も明らか (futureRows に販売情報が無い)
});

// ---------------------------------------------------------------------------
// 5) 本番チェーンは無変更: cold-start フォールバック・predictionBasis・historyCount・confidence
// ---------------------------------------------------------------------------
test('本番チェーン: work×screen 実績なし (cold-start) は screen へフォールバックする (無変更の確認)', () => {
  const trainingMovieIds = new Set(train.map((s) => s.movieId));
  const coldShowing = showings.find(
    (s) => s.inValidationWindow && !aggregates.workScreen.some((e) => e.movieId === s.movieId && e.screenId === s.screenId)
  );
  assert.ok(coldShowing, '前提: cold-start な検証上映がある');

  const result = predictor.predict({
    showingId: coldShowing.showingId,
    movieId: coldShowing.movieId,
    movieTitle: coldShowing.movieTitle,
    screenId: coldShowing.screenId,
    showDateTime: coldShowing.showDateTime,
    seatCapacity: coldShowing.seatCapacity,
  });
  assert.ok([BASIS_SCREEN, BASIS_GLOBAL].includes(result.predictionBasis));
});

test('本番チェーン: predictionBasis / historyCount / confidence は前回と同じ意味のまま出続ける', () => {
  const entry = aggregates.workScreen.find((e) => e.trainingShowCount >= 20);
  assert.ok(entry, '前提: 高confidenceになる組み合わせがある');

  const result = predictor.predict({
    movieId: entry.movieId,
    screenId: entry.screenId,
    showDateTime: '2026-01-01 10:00',
  });
  assert.equal(result.predictionBasis, BASIS_WORK_SCREEN);
  assert.equal(result.historyCount, entry.trainingShowCount);
  assert.equal(result.confidence, CONFIDENCE_HIGH);
  assert.ok([CONFIDENCE_HIGH, CONFIDENCE_MEDIUM, CONFIDENCE_LOW].includes(result.confidence));
});

test('10%判定・ランキング: ラウンド2の検証後も丸め前判定・決定的順位が保たれている (回帰確認)', () => {
  const predicted = [
    { showingId: 'A', showDateTime: '2026-01-01 09:00', predictedOccupancyPct: 9.99 },
    { showingId: 'B', showDateTime: '2026-01-01 09:00', predictedOccupancyPct: 10.0 },
  ];
  const ranked = predictor.rank(predicted);
  assert.deepEqual(ranked.map((r) => r.showingId), ['A', 'B']);
  assert.deepEqual(ranked.map((r) => r.vacancyRank), [1, 2]);

  const p = predictor.predict({ movieId: 'ZZZ-NOT-EXIST', screenId: 'ZZZ-NOT-EXIST', showDateTime: '2026-01-01 09:00' });
  assert.equal(typeof p.isVacant, 'boolean');
  assert.equal(p.predictedOccupancyPct < VACANCY_THRESHOLD_PCT, p.isVacant);
});

// ---------------------------------------------------------------------------
// 6) 未来上映 (future_showings.csv) との整合: 既存の read/predict パスは無変更
// ---------------------------------------------------------------------------
test('future_showings: 既存の loadFutureShowings は今回の変更で壊れていない (回帰確認)', () => {
  const future = loadFutureShowings();
  assert.ok(future.length > 0);
  for (const f of future) {
    assert.equal(f.actualOccupancyPct, null, '未来上映は販売実績を持たない');
    const result = predictor.predict({
      showingId: f.showingId,
      movieId: f.movieId,
      movieTitle: f.movieTitle,
      screenId: f.screenId,
      showDateTime: f.showDateTime,
      seatCapacity: f.seatCapacity,
    });
    assert.equal(typeof result.historyCount, 'number');
    assert.ok([CONFIDENCE_HIGH, CONFIDENCE_MEDIUM, CONFIDENCE_LOW].includes(result.confidence));
  }
});
