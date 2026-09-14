'use strict';

/**
 * 元データ CSV (data/) を読み取り専用でロードし、
 * 「1上映 = 1レコード」の配列 (実績混雑率つき) を組み立てる。
 *
 * 元 CSV は絶対に書き換えない。ここでの加工結果はメモリ上のみ。
 */

const fs = require('fs');
const path = require('path');
const { readCsv, forEachCsvRow } = require('./csv');
const { DATA_DIR, TRAINING_START, TRAINING_END, VALIDATION_START, VALIDATION_END } = require('./config');

const FUTURE_SHOWINGS_FILE = 'future_showings.csv';

/** screens.csv → Map<screenId(string), { screenId, screenName, seatCapacity(number) }> */
function loadScreens(dataDir = DATA_DIR) {
  const { rows } = readCsv(path.join(dataDir, 'screens.csv'));
  const map = new Map();
  for (const r of rows) {
    map.set(r['スクリーンID'], {
      screenId: r['スクリーンID'],
      screenName: r['スクリーン名'],
      seatCapacity: Number(r['座席数']),
    });
  }
  return map;
}

/** movies.csv → Map<movieId(string), { movieId, title, genre }>  (第一版で使う列のみ保持) */
function loadMovies(dataDir = DATA_DIR) {
  const { rows } = readCsv(path.join(dataDir, 'movies.csv'));
  const map = new Map();
  for (const r of rows) {
    map.set(r['作品ID'], {
      movieId: r['作品ID'],
      title: r['作品名'],
      genre: r['ジャンル'],
    });
  }
  return map;
}

/** schedules.csv → 上映レコード配列 (実績混雑率はまだ無し) */
function loadSchedules(dataDir = DATA_DIR) {
  const { rows } = readCsv(path.join(dataDir, 'schedules.csv'));
  return rows.map((r) => ({
    showingId: r['上映ID'],
    movieId: r['作品ID'],
    scheduleTitle: r['作品名'],
    screenId: r['スクリーンID'],
    showDate: r['上映日'],
    startTime: r['開始時刻'],
    endTime: r['終了時刻'],
  }));
}

/**
 * ticket_sales.csv を1行ずつ数えて 上映ID → 販売座席数 の Map を作る。
 * 混雑率の定義: 1行 = 1販売座席。グループ人数・購入者属性・購入日時は一切参照しない。
 * @returns {Map<string, number>}
 */
function countSoldSeatsByShowing(dataDir = DATA_DIR) {
  const counts = new Map();
  let showingIdIdx = -1;
  forEachCsvRow(path.join(dataDir, 'ticket_sales.csv'), (cells, header) => {
    if (showingIdIdx === -1) showingIdIdx = header.indexOf('上映ID');
    const sid = cells[showingIdIdx];
    counts.set(sid, (counts.get(sid) || 0) + 1);
  });
  return counts;
}

/**
 * 未来の上映予定を data/future_showings.csv (存在すれば) から読み込む。
 *
 * schedules.csv と異なり、作品名は movies.csv を参照せずこのファイル自身の値を使う
 * (movies.csv にまだ無い未来の作品IDでも読み込みが失敗しないようにするため)。
 * 販売実績 (ticket_sales.csv) は一切参照しない — 未来上映に実績は存在しない。
 * 座席数は既存の schedules.csv と同じく screens.csv から解決する (二重管理・不整合を避ける)。
 * ファイルが無い場合は空配列を返す (この機能を使わないプロジェクト状態でも壊れない)。
 *
 * @param {string} dataDir
 * @param {Map} [screens] loadScreens() の戻り値。省略時は自分で読み込む。
 * @returns {Array<object>} loadShowings().showings と同じ形 (+ endTime, isFuture:true)
 */
function loadFutureShowings(dataDir = DATA_DIR, screens) {
  const filePath = path.join(dataDir, FUTURE_SHOWINGS_FILE);
  if (!fs.existsSync(filePath)) return [];

  const screenMap = screens || loadScreens(dataDir);
  const { rows } = readCsv(filePath);
  const result = [];

  for (const r of rows) {
    const showingId = r['上映ID'];
    const screenId = r['スクリーンID'];
    const screen = screenMap.get(screenId);
    if (!screen) {
      // 未知のスクリーンIDは座席数が分からず予測できないため、その行だけ除外する
      // (アプリ全体は止めない)。
      console.warn(
        `future_showings.csv: 未知のスクリーンID "${screenId}" (${showingId}) の行をスキップしました`
      );
      continue;
    }

    const showDate = r['上映日'];
    const startTime = r['開始時刻'];

    result.push({
      showingId,
      movieId: r['作品ID'],
      movieTitle: r['作品名'],
      genre: undefined,
      screenId,
      seatCapacity: screen.seatCapacity,
      showDate,
      startTime,
      endTime: r['終了時刻'],
      showDateTime: `${showDate} ${startTime}`,
      soldSeats: null,
      actualOccupancyPct: null,
      inTrainingWindow: false,
      inValidationWindow: false,
      isFuture: true,
    });
  }

  return result;
}

function inWindow(date, start, end) {
  // ISO 文字列 (YYYY-MM-DD) はそのまま辞書順比較で日付順になる
  return date >= start && date <= end;
}

/**
 * 全上映レコードを組み立てる。各レコードに実績混雑率と期間フラグを付与。
 *
 *  実績混雑率(%) = 該当上映IDの ticket_sales 行数 ÷ スクリーン座席数 × 100
 *
 * @param {string} dataDir
 * @returns {{
 *   showings: Array<object>,
 *   screens: Map, movies: Map,
 * }}
 */
function loadShowings(dataDir = DATA_DIR) {
  const screens = loadScreens(dataDir);
  const movies = loadMovies(dataDir);
  const schedules = loadSchedules(dataDir);
  const soldByShowing = countSoldSeatsByShowing(dataDir);

  const showings = schedules.map((s) => {
    const screen = screens.get(s.screenId);
    const movie = movies.get(s.movieId);
    if (!screen) throw new Error(`unknown screenId ${s.screenId} in schedules (${s.showingId})`);
    if (!movie) throw new Error(`unknown movieId ${s.movieId} in schedules (${s.showingId})`);

    const seatCapacity = screen.seatCapacity;
    const soldSeats = soldByShowing.get(s.showingId) || 0;
    const actualOccupancyPct = (soldSeats / seatCapacity) * 100;

    return {
      showingId: s.showingId,
      movieId: s.movieId,
      movieTitle: movie.title,
      genre: movie.genre,
      screenId: s.screenId,
      seatCapacity,
      showDate: s.showDate,
      startTime: s.startTime,
      showDateTime: `${s.showDate} ${s.startTime}`,
      soldSeats,
      actualOccupancyPct,
      inTrainingWindow: inWindow(s.showDate, TRAINING_START, TRAINING_END),
      inValidationWindow: inWindow(s.showDate, VALIDATION_START, VALIDATION_END),
    };
  });

  return { showings, screens, movies };
}

module.exports = {
  loadScreens,
  loadMovies,
  loadSchedules,
  countSoldSeatsByShowing,
  loadShowings,
  loadFutureShowings,
  inWindow,
};
