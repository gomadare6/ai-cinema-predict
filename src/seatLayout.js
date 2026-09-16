'use strict';

/**
 * seats.csv から座席配置を読み込み、上映ごとの座席利用状況（空席・孤立空席）を
 * 判定するための「配置」だけを組み立てるモジュール。
 *
 * 座席の個別人気（どの座席がよく売れるか）はここでは一切扱わない。
 * データ分析で確認済みの通り、座席単位の販売頻度には現実的でない偏り
 * （特定座席が不自然に高頻度で売れる）があり、個別座席ランキング化は行わない。
 * ここで使うのは「区画（通路で区切られたひとまとまり）の中で、ある上映において
 * どの座席が空いているか」という、その上映限りの状態だけ。
 */

const path = require('path');
const { readCsv } = require('./csv');
const { DATA_DIR } = require('./config');

/**
 * seats.csv を読み込み、スクリーンIDごとの座席配列にする。
 * @param {string} dataDir
 * @returns {Map<string, Array<{seatId,row,num,block,aisle,wheelchair,rank}>>}
 */
function loadSeatsByScreen(dataDir = DATA_DIR) {
  const { rows } = readCsv(path.join(dataDir, 'seats.csv'));
  const byScreen = new Map();
  for (const r of rows) {
    const screenId = r['スクリーンID'];
    const seat = {
      seatId: r['座席ID'],
      screenId,
      row: r['列'],
      num: Number(r['座席番号']),
      block: r['ブロック'],
      aisle: r['通路側'] === 'True',
      wheelchair: r['車イス席'] === 'True',
      rank: r['座席ランク'],
    };
    if (!byScreen.has(screenId)) byScreen.set(screenId, []);
    byScreen.get(screenId).push(seat);
  }
  return byScreen;
}

/**
 * 1スクリーン分の座席配置を組み立てる。
 * 「区画」は同じ列（row）の中で座席番号が連番でなくなる箇所（通路の切れ目）で区切る。
 * @param {Array<object>} seatRows loadSeatsByScreen() の1スクリーン分
 * @returns {{
 *   rows: Array<{ row: string, segments: Array<Array<object>> }>,
 *   order: string[],           // 表示用の座席ID順 (行→座席番号)
 *   seatIndex: Map<string, object>,
 * }}
 */
function buildScreenLayout(seatRows) {
  const byRow = new Map();
  for (const s of seatRows) {
    if (!byRow.has(s.row)) byRow.set(s.row, []);
    byRow.get(s.row).push(s);
  }

  const rows = [...byRow.keys()].sort().map((row) => {
    const seats = byRow.get(row).slice().sort((a, b) => a.num - b.num);
    const segments = [];
    let current = [];
    for (const seat of seats) {
      if (current.length > 0 && seat.num !== current[current.length - 1].num + 1) {
        segments.push(current);
        current = [];
      }
      current.push(seat);
    }
    if (current.length > 0) segments.push(current);
    return { row, segments };
  });

  const order = [];
  const seatIndex = new Map();
  for (const r of rows) {
    for (const seg of r.segments) {
      for (const seat of seg) {
        order.push(seat.seatId);
        seatIndex.set(seat.seatId, seat);
      }
    }
  }

  return { rows, order, seatIndex };
}

/**
 * 全スクリーンの座席配置を組み立てる。
 * @param {string} dataDir
 * @returns {Map<string, ReturnType<typeof buildScreenLayout>>}
 */
function buildAllScreenLayouts(dataDir = DATA_DIR) {
  const byScreen = loadSeatsByScreen(dataDir);
  const layouts = new Map();
  for (const [screenId, seatRows] of byScreen) {
    layouts.set(screenId, buildScreenLayout(seatRows));
  }
  return layouts;
}

module.exports = { loadSeatsByScreen, buildScreenLayout, buildAllScreenLayouts };
