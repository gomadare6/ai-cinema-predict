'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeValidationReport,
  computeMovieProfiles,
  computeScreenProfiles,
  computeCleaningGapStats,
  computeSurpriseComparisons,
  computeIsolatedSeatSummary,
} = require('../src/analytics');
const { buildScreenLayout } = require('../src/seatLayout');

function showing({
  showingId, movieId, movieTitle = 'M', genre = 'G', screenId = '1',
  showDate, startTime = '10:00', seatCapacity = 100, soldSeats,
  inTrainingWindow, inValidationWindow = false, isFuture = false,
}) {
  const actualOccupancyPct = isFuture ? null : (soldSeats / seatCapacity) * 100;
  return {
    showingId, movieId, movieTitle, genre, screenId, seatCapacity,
    showDate, startTime, showDateTime: `${showDate} ${startTime}`,
    soldSeats: isFuture ? null : soldSeats,
    actualOccupancyPct,
    inTrainingWindow, inValidationWindow, isFuture,
  };
}

test('computeMovieProfiles: 同じ映画でもスクリーン別に混雑率がばらつく場合、range/stdevが計算される', () => {
  const showings = [
    showing({ showingId: 's1', movieId: 'm1', showDate: '2025-01-01', screenId: '1', soldSeats: 5, inTrainingWindow: true }),
    showing({ showingId: 's2', movieId: 'm1', showDate: '2025-01-02', screenId: '2', soldSeats: 90, inTrainingWindow: true }),
    showing({ showingId: 's3', movieId: 'm2', showDate: '2025-01-01', screenId: '1', soldSeats: 50, inTrainingWindow: true }),
  ];
  const profiles = computeMovieProfiles(showings);
  const m1 = profiles.find((p) => p.movieId === 'm1');
  assert.equal(m1.showCount, 2);
  assert.equal(m1.minOccupancyPct, 5);
  assert.equal(m1.maxOccupancyPct, 90);
  assert.equal(m1.rangeOccupancyPct, 85);
  assert.equal(m1.screens.length, 2);
});

test('computeMovieProfiles: 未来上映 (実績なし) は集計から除外される', () => {
  const showings = [
    showing({ showingId: 's1', movieId: 'm1', showDate: '2025-01-01', soldSeats: 5, inTrainingWindow: true }),
    showing({ showingId: 'f1', movieId: 'm1', showDate: '2026-01-01', isFuture: true, seatCapacity: 100 }),
  ];
  const profiles = computeMovieProfiles(showings);
  assert.equal(profiles.find((p) => p.movieId === 'm1').showCount, 1);
});

test('computeScreenProfiles: 定員・設備情報とマージされる', () => {
  const showings = [
    showing({ showingId: 's1', screenId: '1', showDate: '2025-01-01', soldSeats: 10, seatCapacity: 100, inTrainingWindow: true }),
    showing({ showingId: 's2', screenId: '1', showDate: '2025-01-02', soldSeats: 20, seatCapacity: 100, inTrainingWindow: true }),
  ];
  const screenMeta = new Map([['1', { screenId: '1', screenName: 'シアター1', seatCapacity: 100, soundSystem: '5.1ch' }]]);
  const profiles = computeScreenProfiles(showings, screenMeta);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].showCount, 2);
  assert.equal(profiles[0].avgOccupancyPct, 15);
  assert.equal(profiles[0].soundSystem, '5.1ch');
});

test('computeCleaningGapStats: 連続上映の間隔(分)を正しく求める', () => {
  const schedules = [
    { screenId: '1', showDate: '2025-01-01', startTime: '10:00', endTime: '12:00' },
    { screenId: '1', showDate: '2025-01-01', startTime: '12:20', endTime: '14:20' },
    { screenId: '1', showDate: '2025-01-01', startTime: '14:45', endTime: '16:45' },
  ];
  const stats = computeCleaningGapStats(schedules);
  assert.equal(stats.sampleCount, 2);
  assert.equal(stats.meanMinutes, 22.5);
  assert.deepEqual(stats.buckets['20-24'], 1);
  assert.deepEqual(stats.buckets['25-29'], 1);
});

test('computeSurpriseComparisons: 曜日種別・時間帯・レイトショーで平均混雑率を比較できる', () => {
  const showings = [
    showing({ showingId: 's1', showDate: '2025-01-01', startTime: '09:00', soldSeats: 10, inTrainingWindow: true }),
    showing({ showingId: 's2', showDate: '2025-01-02', startTime: '21:00', soldSeats: 30, inTrainingWindow: true }),
  ];
  const schedules = [
    { showingId: 's1', weekdayType: '平日', lateShow: false, startTime: '09:00' },
    { showingId: 's2', weekdayType: '土日祝', lateShow: true, startTime: '21:00' },
  ];
  const result = computeSurpriseComparisons(showings, schedules);
  assert.equal(result.byWeekdayType.find((r) => r.key === '平日').avgOccupancyPct, 10);
  assert.equal(result.byLateShow.find((r) => r.key === 'レイトショー').avgOccupancyPct, 30);
  assert.equal(result.byHourBand.find((r) => r.key === '夜(20:00〜)').count, 1);
});

test('computeIsolatedSeatSummary: 高混雑ほど孤立空席率が上がる傾向を再現できる (小さな合成データ)', () => {
  const seats = [
    { seatId: 'A1', row: 'A', num: 1 }, { seatId: 'A2', row: 'A', num: 2 },
    { seatId: 'A3', row: 'A', num: 3 }, { seatId: 'A4', row: 'A', num: 4 },
  ];
  const layout = buildScreenLayout(seats);
  const layouts = new Map([['1', layout]]);

  // 低混雑: 1/4 売れており、孤立席は発生しない (端の空席のみ)
  const showings = [
    showing({ showingId: 'low', screenId: '1', showDate: '2025-01-01', soldSeats: 1, seatCapacity: 4, inTrainingWindow: true }),
    showing({ showingId: 'high', screenId: '1', showDate: '2025-01-02', soldSeats: 3, seatCapacity: 4, inTrainingWindow: true }),
  ];
  const soldSeatIds = new Map([
    ['low', new Set(['A1'])],
    ['high', new Set(['A1', 'A3', 'A4'])], // A2 が孤立空席
  ]);

  const summary = computeIsolatedSeatSummary(showings, soldSeatIds, layouts);
  assert.equal(summary.totalConsidered, 2);
  assert.equal(summary.showingsWithIsolatedSeat, 1);
  const highBand = summary.byOccupancyBand.find((b) => b.band === '70-80%');
  assert.equal(highBand.avgIsolatedRate, 100);
});

test('computeValidationReport: 検証期間の予測を評価し、MAE・散布図サンプルを返す', () => {
  const showings = [
    showing({ showingId: 't1', movieId: 'm1', screenId: '1', showDate: '2025-01-01', soldSeats: 10, seatCapacity: 100, inTrainingWindow: true }),
    showing({ showingId: 't2', movieId: 'm1', screenId: '1', showDate: '2025-01-02', soldSeats: 20, seatCapacity: 100, inTrainingWindow: true }),
    showing({ showingId: 'v1', movieId: 'm1', screenId: '1', showDate: '2025-10-01', soldSeats: 15, seatCapacity: 100, inTrainingWindow: false, inValidationWindow: true }),
  ];
  const report = computeValidationReport(showings);
  assert.equal(report.validationCount, 1);
  assert.equal(report.mae, 0); // work×screen平均(15) = 実績(15) なので誤差0
  assert.equal(report.points.length, 1);
  assert.equal(report.points[0].source, 'work_screen');
});
