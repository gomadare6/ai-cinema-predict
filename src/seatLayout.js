'use strict';

/**
 * seats.csv から座席配置を組み立てる。上映ごとの空席・孤立空席判定に使う「配置」のみを扱い、
 * 座席の個別人気（どの座席がよく売れるか）は扱わない（座席単位の販売頻度には不自然な偏りが
 * 確認済みのため、個別座席ランキング化はしない）。
 */

const path = require('path');
const { readCsv } = require('./csv');
const { DATA_DIR } = require('./config');

/** seats.csv → スクリーンIDごとの座席配列。 */
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
 * 「区画」は同じ列で座席番号が連番でなくなる箇所（通路の切れ目）で区切る。
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

/** 全スクリーンの座席配置を組み立てる。 */
function buildAllScreenLayouts(dataDir = DATA_DIR) {
  const byScreen = loadSeatsByScreen(dataDir);
  const layouts = new Map();
  for (const [screenId, seatRows] of byScreen) {
    layouts.set(screenId, buildScreenLayout(seatRows));
  }
  return layouts;
}

module.exports = { loadSeatsByScreen, buildScreenLayout, buildAllScreenLayouts };
