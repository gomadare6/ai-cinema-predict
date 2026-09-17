'use strict';

/**
 * 分析ページ向けの静的 JSON を derived/analytics/ に生成する CLI。
 *   node scripts/build-analytics.js
 * 本番の予測ロジック（src/predictor.js 等）は変更しない。表示専用の集計データを build 時に作り、
 * ブラウザ側で ticket_sales.csv（50万行超）を解析しないようにする。
 */

const fs = require('fs');
const path = require('path');

const { loadShowings, loadSchedules, loadScreens } = require('../src/dataset');
const { buildAllScreenLayouts } = require('../src/seatLayout');
const { computeSeatUsage, compactStates } = require('../src/seatUsage');
const {
  loadSoldSeatIdsByShowing,
  computeValidationReport,
  computeMovieProfiles,
  computeScreenProfiles,
  computeSurpriseComparisons,
  computeIsolatedSeatSummary,
} = require('../src/analytics');
const { DERIVED_DIR } = require('../src/config');

const OUT_DIR = path.join(DERIVED_DIR, 'analytics');

function main() {
  console.log('=== 分析データ生成 ===');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const { showings, screens } = loadShowings();
  const schedules = loadSchedules();
  const screenLayouts = buildAllScreenLayouts();
  const soldSeatIdsByShowing = loadSoldSeatIdsByShowing();

  // --- 1) 予測 vs 実績 ---
  const validation = computeValidationReport(showings);
  fs.writeFileSync(path.join(OUT_DIR, 'validation.json'), JSON.stringify(validation), 'utf8');
  console.log(`予測vs実績    : MAE=${validation.mae.toFixed(2)} / 検証件数=${validation.validationCount} / points=${validation.points.length}`);

  // --- 2) 映画別プロフィール ---
  const movies = computeMovieProfiles(showings);
  fs.writeFileSync(path.join(OUT_DIR, 'movies.json'), JSON.stringify(movies), 'utf8');
  console.log(`映画プロフィール: ${movies.length}件`);

  // --- 3) スクリーン別プロフィール ---
  const screenProfiles = computeScreenProfiles(showings, screens);
  fs.writeFileSync(path.join(OUT_DIR, 'screens.json'), JSON.stringify(screenProfiles), 'utf8');
  console.log(`スクリーンプロフィール: ${screenProfiles.length}件`);

  // --- 4) 映画館データ (スタッフ向け): 孤立空席の傾向 + 意外な結果 ---
  const isolatedSummary = computeIsolatedSeatSummary(showings, soldSeatIdsByShowing, screenLayouts);
  const surprises = computeSurpriseComparisons(showings, schedules);
  const staff = { isolatedSummary, surprises };
  fs.writeFileSync(path.join(OUT_DIR, 'staff.json'), JSON.stringify(staff), 'utf8');
  console.log(`孤立空席あり上映: ${isolatedSummary.showingsWithIsolatedSeat}/${isolatedSummary.totalConsidered}`);

  // --- 5) 座席マップ (座席の状況 + 孤立空席率)。実績がある上映のみ対象、個別座席ランキングは作らない。 ---
  const seatLayoutMeta = {};
  for (const [screenId, layout] of screenLayouts) {
    seatLayoutMeta[screenId] = {
      order: layout.order,
      rows: layout.rows.map((r) => ({
        row: r.row,
        segments: r.segments.map((seg) => seg.map((s) => s.seatId)),
      })),
    };
  }
  fs.writeFileSync(path.join(OUT_DIR, 'seat-layout.json'), JSON.stringify(seatLayoutMeta), 'utf8');

  const seatmaps = {};
  let seatmapCount = 0;
  for (const s of showings) {
    if (s.isFuture) continue;
    const layout = screenLayouts.get(s.screenId);
    const soldIds = soldSeatIdsByShowing.get(s.showingId);
    if (!layout || !soldIds) continue;
    const usage = computeSeatUsage(layout, soldIds);
    seatmaps[s.showingId] = {
      c: compactStates(usage.seatStates), // 座席状態 (layout.order と同じ並び順)
      i: Math.round(usage.isolatedRate * 10) / 10, // 孤立空席率(%)
      e: usage.emptyCount,
      so: usage.soldCount,
    };
    seatmapCount++;
  }
  fs.writeFileSync(path.join(OUT_DIR, 'seatmaps.json'), JSON.stringify(seatmaps), 'utf8');
  const seatmapBytes = fs.statSync(path.join(OUT_DIR, 'seatmaps.json')).size;
  console.log(`座席マップ    : ${seatmapCount}上映分 (${(seatmapBytes / 1024 / 1024).toFixed(2)} MB)`);

  console.log(`出力先        : ${OUT_DIR}`);
}

main();
