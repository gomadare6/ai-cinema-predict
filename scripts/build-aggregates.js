'use strict';

/**
 * 予測用の事前集計データを derived/ に生成する CLI。
 *   node scripts/build-aggregates.js
 *
 * 元データ CSV は読み取りのみ。書き換えない。
 */

const { loadShowings } = require('../src/dataset');
const { buildAggregates, writeAggregates } = require('../src/buildAggregates');
const { DERIVED_DIR } = require('../src/config');

function main() {
  const { showings } = loadShowings();
  const aggregates = buildAggregates(showings);
  writeAggregates(aggregates, DERIVED_DIR);

  const trainCount = showings.filter((s) => s.inTrainingWindow).length;
  const valCount = showings.filter((s) => s.inValidationWindow).length;

  console.log('=== 予測用集計データ生成 ===');
  console.log(`学習期間            : ${aggregates.trainingWindow.start} 〜 ${aggregates.trainingWindow.end}`);
  console.log(`全上映数            : ${showings.length}`);
  console.log(`学習上映数          : ${trainCount}`);
  console.log(`検証上映数 (参考)   : ${valCount}`);
  console.log(`作品×スクリーン組数 : ${aggregates.workScreen.length}`);
  console.log(`スクリーン数        : ${aggregates.screen.length}`);
  console.log(`全体平均混雑率      : ${aggregates.global.avgOccupancyPct.toFixed(4)} %`);
  console.log(`出力先             : ${DERIVED_DIR}`);
  console.log('  - work_screen_avg.csv');
  console.log('  - screen_avg.csv');
  console.log('  - global_avg.json');
}

main();
