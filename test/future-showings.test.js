'use strict';

/**
 * 未来の上映予定 (data/future_showings.csv) の読み込みと予測の検証。
 *
 * 予測ロジック自体 (src/predictor.js) は変更していないため、ここでは
 *  - future_showings.csv の読み込みが壊れないこと
 *  - 読み込んだ未来上映が既存の予測器でそのまま予測・ランキングできること
 * を確認する。学習集計 (src/buildAggregates.js) には未来上映を一切混ぜていないため、
 * データリークが起きないことは既存の predictor.test.js のテストでカバーされている。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadShowings, loadFutureShowings } = require('../src/dataset');
const { buildAggregates } = require('../src/buildAggregates');
const { createPredictor } = require('../src/predictor');
const {
  BASIS_WORK_SCREEN,
  BASIS_SCREEN,
  BASIS_GLOBAL,
  SOURCE_WORK_SCREEN,
  SOURCE_SCREEN,
  SOURCE_GLOBAL,
  CONFIDENCE_HIGH,
  CONFIDENCE_MEDIUM,
  CONFIDENCE_LOW,
} = require('../src/config');

// 実データの学習集計から予測器を作る (本番と同じもの)。未来上映はここには一切混ぜない。
const { showings } = loadShowings();
const aggregates = buildAggregates(showings);
const predictor = createPredictor(aggregates);

/** テスト用に一時ディレクトリへ future_showings.csv を書き出すヘルパー。 */
function writeTempFutureCsv(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-cinema-future-'));
  fs.writeFileSync(path.join(dir, 'future_showings.csv'), content, 'utf8');
  return dir;
}

test('テスト1: future_showings.csv が存在しない場合は空配列を返す (後方互換)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-cinema-nofile-'));
  const result = loadFutureShowings(dir, new Map());
  assert.deepEqual(result, []);
});

test('テスト2: リポジトリの data/future_showings.csv を読み込める (未来日付)', () => {
  const future = loadFutureShowings();
  assert.ok(future.length > 0, 'サンプル未来上映が1件以上あること');
  for (const f of future) {
    assert.equal(f.isFuture, true);
    assert.equal(f.actualOccupancyPct, null, '未来上映に販売実績はない');
    assert.equal(f.inTrainingWindow, false);
    assert.equal(f.inValidationWindow, false);
    assert.match(f.showDate, /^\d{4}-\d{2}-\d{2}$/);
    // 学習期間・検証期間 (2025年) より未来の日付であること
    assert.ok(f.showDate > '2025-12-31', `${f.showDate} は学習・検証期間より未来`);
  }
});

test('テスト3: 未来上映にも既存の予測器でそのまま予測値が付く', () => {
  const future = loadFutureShowings();
  for (const f of future) {
    const result = predictor.predict({
      showingId: f.showingId,
      movieId: f.movieId,
      movieTitle: f.movieTitle,
      screenId: f.screenId,
      showDateTime: f.showDateTime,
      seatCapacity: f.seatCapacity,
    });
    assert.equal(typeof result.predictedOccupancyPct, 'number');
    assert.ok(result.predictedOccupancyPct >= 0 && result.predictedOccupancyPct <= 100);
    assert.equal(typeof result.isVacant, 'boolean');
  }
});

test('テスト4: work×screen 実績がある未来上映 → 作品×スクリーン平均が使われる', () => {
  // F00001 = M0004 (劇場版『チェンソーマン レゼ篇』) × スクリーン1。学習期間に実績あり。
  const wsEntry = aggregates.workScreen.find((e) => e.movieId === 'M0004' && e.screenId === '1');
  assert.ok(wsEntry, '前提: M0004×screen1 の学習実績があること');

  const result = predictor.predict({
    showingId: 'F00001',
    movieId: 'M0004',
    movieTitle: 'テスト用',
    screenId: '1',
    showDateTime: '2026-10-10 09:30',
    seatCapacity: 320,
  });

  assert.equal(result.predictionBasis, BASIS_WORK_SCREEN);
  assert.equal(result.predictionSource, SOURCE_WORK_SCREEN);
  assert.equal(result.predictedOccupancyPct, wsEntry.avgOccupancyPct);
});

test('テスト5: 作品IDが過去データ(movies.csv)に存在しない未来上映 → スクリーン平均にフォールバックし、壊れない', () => {
  // F00003 = 未公開の新作 (M9001)。movies.csv に存在しない movieId。
  const hasWorkScreen = aggregates.workScreen.some((e) => e.movieId === 'M9001');
  assert.equal(hasWorkScreen, false, '前提: M9001 は学習期間の実績が無いこと');

  const scEntry = aggregates.screen.find((e) => e.screenId === '1');
  assert.ok(scEntry);

  assert.doesNotThrow(() => {
    const result = predictor.predict({
      showingId: 'F00003',
      movieId: 'M9001',
      movieTitle: '(未公開)新作アニメーション',
      screenId: '1',
      showDateTime: '2026-10-10 19:00',
      seatCapacity: 320,
    });
    assert.equal(result.predictionBasis, BASIS_SCREEN);
    assert.equal(result.predictionSource, SOURCE_SCREEN);
    assert.equal(result.predictedOccupancyPct, scEntry.avgOccupancyPct);
  });
});

test('テスト6: 未知のスクリーンIDの行はスキップされる (アプリ全体は壊れない)', () => {
  const dir = writeTempFutureCsv(
    [
      '上映ID,作品ID,作品名,スクリーンID,上映日,開始時刻,終了時刻',
      'FX001,M0004,テスト作品,999,2026-02-01,10:00,12:00', // 未知のスクリーンID
      'FX002,M0004,テスト作品,1,2026-02-01,13:00,15:00', // 既知のスクリーンID
    ].join('\n') + '\n'
  );
  const screens = new Map([['1', { screenId: '1', screenName: 'シアター1', seatCapacity: 320 }]]);

  let result;
  assert.doesNotThrow(() => {
    result = loadFutureShowings(dir, screens);
  });
  assert.equal(result.length, 1, '未知のスクリーンIDの行だけが除外されること');
  assert.equal(result[0].showingId, 'FX002');
});

test('テスト7: work×screen も screen 実績も無い場合 → 全体平均 (global) にフォールバックする', () => {
  // 合成集計データで global フォールバックだけを検証する (実データでは screen 実績が
  // 全スクリーンにあるため global フォールバックは発生しないので、predictor.test.js の
  // テスト4と同じ手法で合成集計を使う)。
  const synthetic = {
    trainingWindow: aggregates.trainingWindow,
    workScreen: [],
    screen: [],
    global: { trainingShowCount: 100, avgOccupancyPct: 13.8 },
  };
  const p = createPredictor(synthetic);

  const result = p.predict({
    showingId: 'FX-GLOBAL',
    movieId: 'M9999',
    movieTitle: 'まったく実績の無い作品',
    screenId: '999',
    showDateTime: '2026-06-01 10:00',
    seatCapacity: 100,
  });

  assert.equal(result.predictionBasis, BASIS_GLOBAL);
  assert.equal(result.predictionSource, SOURCE_GLOBAL);
  assert.equal(result.predictedOccupancyPct, 13.8);
});

test('テスト8: 未来上映でも 10%未満判定は丸め前の値で正しく行われる', () => {
  const synthetic = {
    trainingWindow: aggregates.trainingWindow,
    workScreen: [],
    screen: [{ screenId: 'A', trainingShowCount: 10, avgOccupancyPct: 9.99 }],
    global: { trainingShowCount: 10, avgOccupancyPct: 50 },
  };
  const p = createPredictor(synthetic);
  const result = p.predict({
    showingId: 'FX-VACANT',
    movieId: 'M9999',
    screenId: 'A',
    showDateTime: '2026-06-01 10:00',
  });
  assert.equal(result.isVacant, true);
});

test('テスト9: 未来上映を含めても予測混雑率でランキングできる (過去実績と混在時も決定的)', () => {
  const future = loadFutureShowings();
  assert.ok(future.length >= 2, '前提: 未来上映が複数あること');

  const predicted = future.map((f) =>
    predictor.predict({
      showingId: f.showingId,
      movieId: f.movieId,
      movieTitle: f.movieTitle,
      screenId: f.screenId,
      showDateTime: f.showDateTime,
      seatCapacity: f.seatCapacity,
    })
  );
  const ranked = predictor.rank(predicted);

  // 順位が 1..n の連番であること
  assert.deepEqual(
    ranked.map((r) => r.vacancyRank),
    ranked.map((_, i) => i + 1)
  );
  // 予測混雑率の昇順になっていること
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].predictedOccupancyPct <= ranked[i].predictedOccupancyPct);
  }

  // 2回計算しても同じ順位になる (決定的)
  const ranked2 = predictor.rank(predicted);
  assert.deepEqual(
    ranked.map((r) => r.showingId),
    ranked2.map((r) => r.showingId)
  );
});

test('テスト11: 未来上映にも historyCount / confidence / predictionBasis が付く (説明可能性の追加項目)', () => {
  const future = loadFutureShowings();
  for (const f of future) {
    const result = predictor.predict({
      showingId: f.showingId,
      movieId: f.movieId,
      movieTitle: f.movieTitle,
      screenId: f.screenId,
      showDateTime: f.showDateTime,
      seatCapacity: f.seatCapacity,
    });
    assert.equal(typeof result.historyCount, 'number');
    assert.equal(result.historyCount, result.trainingShowCount, 'historyCount は trainingShowCount の別名');
    assert.ok(
      [CONFIDENCE_HIGH, CONFIDENCE_MEDIUM, CONFIDENCE_LOW].includes(result.confidence),
      `confidence は high/medium/low のいずれか (実際: ${result.confidence})`
    );
    assert.ok(
      [BASIS_WORK_SCREEN, BASIS_SCREEN, BASIS_GLOBAL].includes(result.predictionBasis),
      'predictionBasis は既存の3種類のいずれか'
    );
  }
});

test('テスト12: F00001 (work×screen実績あり) は confidence が high、F00003 (未知の作品) は screen 段で high にならない', () => {
  // F00001 = M0004×screen1、学習実績60回 (>= CONFIDENCE_HIGH_MIN_COUNT=20) → high
  const r1 = predictor.predict({
    showingId: 'F00001',
    movieId: 'M0004',
    screenId: '1',
    showDateTime: '2026-10-10 09:30',
  });
  assert.equal(r1.predictionSource, SOURCE_WORK_SCREEN);
  assert.equal(r1.confidence, CONFIDENCE_HIGH);

  // F00003 = M9001 (movies.csvに無い未知の作品) × screen1 → screen 段にフォールバック。
  // screen 段は件数がいくら多くても high にはしない (作品への特化度が低いため)。
  const r2 = predictor.predict({
    showingId: 'F00003',
    movieId: 'M9001',
    screenId: '1',
    showDateTime: '2026-10-10 19:00',
  });
  assert.equal(r2.predictionSource, SOURCE_SCREEN);
  assert.notEqual(r2.confidence, CONFIDENCE_HIGH);
});

test('テスト10: 上映IDが schedules.csv (過去実績) と重複していない', () => {
  const future = loadFutureShowings();
  const historicalIds = new Set(showings.map((s) => s.showingId));
  for (const f of future) {
    assert.equal(historicalIds.has(f.showingId), false, `${f.showingId} は実績データと重複していない`);
  }
});
