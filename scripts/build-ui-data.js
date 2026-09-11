'use strict';

/**
 * UI 配信用データを生成する CLI。
 *   node scripts/build-ui-data.js
 *
 * 役割: STEP 5 の予測エンジン (src/predictor.js) を Node 側で実行し、
 *       全上映の予測結果を 1 個の JSON にまとめて derived/ui-showings.json に出す。
 *
 * これにより、ブラウザ側は「表示するだけ」になり、
 * UI が独自に混雑率や isVacant を計算する余地が無くなる。
 *
 * 元データ CSV・derived/ の集計値は読み取りのみ。書き換えない。
 */

const fs = require('fs');
const path = require('path');

const { loadShowings, loadSchedules } = require('../src/dataset');
const { loadAggregates } = require('../src/buildAggregates');
const { createPredictor } = require('../src/predictor');
const {
  DERIVED_DIR,
  TRAINING_START,
  TRAINING_END,
  VACANCY_THRESHOLD_PCT,
  SOURCE_WORK_SCREEN,
  SOURCE_SCREEN,
  SOURCE_GLOBAL,
} = require('../src/config');

// JSON を小さく保つための source コード (UI 側で日本語文言に変換する)
const SOURCE_CODE = {
  [SOURCE_WORK_SCREEN]: 'w',
  [SOURCE_SCREEN]: 's',
  [SOURCE_GLOBAL]: 'g',
};

function main() {
  const aggregatesPath = path.join(DERIVED_DIR, 'work_screen_avg.csv');
  if (!fs.existsSync(aggregatesPath)) {
    console.error(
      `集計データが見つかりません: ${aggregatesPath}\n` +
        '先に `npm run build:aggregates` を実行してください。'
    );
    process.exit(1);
  }

  // STEP 5 の成果物 (derived/) をそのまま読み込んで予測器を作る
  const aggregates = loadAggregates(DERIVED_DIR);
  const predictor = createPredictor(aggregates);

  const { showings, screens } = loadShowings();

  // 終了時刻は表示用にのみ使う (loadShowings は予測に必要な項目しか持たないため
  // schedules.csv から直接引く)
  const endTimeById = new Map(loadSchedules().map((s) => [s.showingId, s.endTime]));

  // 作品名は重複が多いので辞書化してサイズを抑える
  const titleIndex = new Map();
  const titles = [];
  const titleIdOf = (title) => {
    if (!titleIndex.has(title)) {
      titleIndex.set(title, titles.length);
      titles.push(title);
    }
    return titleIndex.get(title);
  };

  // 上映日ごとにまとめる
  const byDate = new Map();
  for (const s of showings) {
    if (!byDate.has(s.showDate)) byDate.set(s.showDate, []);
    byDate.get(s.showDate).push(s);
  }

  const days = {};
  for (const [date, daily] of byDate) {
    // STEP 5 の predict() で予測 → 同じく STEP 5 の rank() で「空いている順」を付与
    const predicted = daily.map((s) =>
      predictor.predict({
        showingId: s.showingId,
        movieId: s.movieId,
        movieTitle: s.movieTitle,
        screenId: s.screenId,
        showDateTime: s.showDateTime,
        seatCapacity: s.seatCapacity,
      })
    );
    const ranked = predictor.rank(predicted);

    const startTimeOf = new Map(daily.map((s) => [s.showingId, s.startTime]));

    // 配列形式で持つ (キー名の繰り返しを避ける)。順番は UI 側 FIELDS と対応。
    days[date] = ranked.map((p) => [
      p.showingId,
      titleIdOf(p.movieTitle),
      p.screenId,
      startTimeOf.get(p.showingId),
      endTimeById.get(p.showingId) ?? '',
      p.seatCapacity,
      p.predictedOccupancyPctDisplay, // 表示用 (小数第1位)
      SOURCE_CODE[p.predictionSource],
      p.trainingShowCount,
      p.isVacant ? 1 : 0,
      p.vacancyRank,
    ]);
  }

  const screenInfo = {};
  for (const [id, sc] of screens) {
    screenInfo[id] = { name: sc.screenName, capacity: sc.seatCapacity };
  }

  const payload = {
    meta: {
      generatedAt: new Date().toISOString(),
      trainingWindow: { start: TRAINING_START, end: TRAINING_END },
      vacancyThresholdPct: VACANCY_THRESHOLD_PCT,
      fields: [
        'showingId',
        'titleId',
        'screenId',
        'startTime',
        'endTime',
        'seatCapacity',
        'predictedOccupancyPctDisplay',
        'sourceCode',
        'trainingShowCount',
        'isVacant',
        'vacancyRank',
      ],
      dates: [...byDate.keys()].sort(),
      screens: screenInfo,
      showingCount: showings.length,
    },
    titles,
    days,
  };

  const outPath = path.join(DERIVED_DIR, 'ui-showings.json');
  fs.mkdirSync(DERIVED_DIR, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload), 'utf8');

  const bytes = fs.statSync(outPath).size;
  const vacantCount = Object.values(days)
    .flat()
    .filter((row) => row[9] === 1).length;

  console.log('=== UI 配信データ生成 ===');
  console.log(`予測エンジン    : src/predictor.js (STEP 5) / 集計は derived/ を使用`);
  console.log(`学習期間        : ${TRAINING_START} 〜 ${TRAINING_END}`);
  console.log(`上映数          : ${showings.length}`);
  console.log(`日付数          : ${payload.meta.dates.length} (${payload.meta.dates[0]} 〜 ${payload.meta.dates.at(-1)})`);
  console.log(`作品名の種類    : ${titles.length}`);
  console.log(`空いている見込み: ${vacantCount} 上映 (予測混雑率 < ${VACANCY_THRESHOLD_PCT}%)`);
  console.log(`出力            : ${outPath} (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
}

main();
