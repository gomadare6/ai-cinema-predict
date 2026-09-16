'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildScreenLayout } = require('../src/seatLayout');
const { computeSeatUsage, compactStates } = require('../src/seatUsage');

/** テスト用の座席配置: 1列, 2区画 (1-4 / 6-9, 番号5は通路で欠番) */
function makeSeats() {
  return [
    { seatId: 'A1', row: 'A', num: 1 },
    { seatId: 'A2', row: 'A', num: 2 },
    { seatId: 'A3', row: 'A', num: 3 },
    { seatId: 'A4', row: 'A', num: 4 },
    { seatId: 'A6', row: 'A', num: 6 },
    { seatId: 'A7', row: 'A', num: 7 },
    { seatId: 'A8', row: 'A', num: 8 },
    { seatId: 'A9', row: 'A', num: 9 },
  ];
}

test('buildScreenLayout: 座席番号の欠番で区画を分ける', () => {
  const layout = buildScreenLayout(makeSeats());
  assert.equal(layout.rows.length, 1);
  assert.equal(layout.rows[0].segments.length, 2);
  assert.equal(layout.rows[0].segments[0].length, 4);
  assert.equal(layout.rows[0].segments[1].length, 4);
  assert.deepEqual(layout.order, ['A1', 'A2', 'A3', 'A4', 'A6', 'A7', 'A8', 'A9']);
});

test('computeSeatUsage: 両隣が売れた単独空席だけが孤立空席', () => {
  const layout = buildScreenLayout(makeSeats());
  // A1 A2(空) A3 A4 | A6 A7(空) A8(空) A9
  const sold = new Set(['A1', 'A3', 'A4', 'A6', 'A9']);
  const usage = computeSeatUsage(layout, sold);

  assert.equal(usage.totalSeats, 8);
  assert.equal(usage.soldCount, 5);
  assert.equal(usage.emptyCount, 3);
  // A2 は両隣(A1,A3)が売れているので孤立。A7,A8 は連続2席空きなので孤立ではない。
  assert.equal(usage.isolatedCount, 1);
  assert.ok(Math.abs(usage.isolatedRate - 100 / 3) < 1e-9);

  const states = Object.fromEntries(usage.seatStates.map((s) => [s.seatId, s.state]));
  assert.equal(states.A2, 'isolated');
  assert.equal(states.A7, 'empty');
  assert.equal(states.A8, 'empty');
});

test('computeSeatUsage: 区画の端の単独空席は孤立ではない', () => {
  const layout = buildScreenLayout(makeSeats());
  // A1(空) A2 A3 A4 | 区画端なので孤立ではない
  const sold = new Set(['A2', 'A3', 'A4', 'A6', 'A7', 'A8', 'A9']);
  const usage = computeSeatUsage(layout, sold);
  assert.equal(usage.isolatedCount, 0);
  const states = Object.fromEntries(usage.seatStates.map((s) => [s.seatId, s.state]));
  assert.equal(states.A1, 'empty');
});

test('computeSeatUsage: 空席0のときは isolatedRate も0 (0除算しない)', () => {
  const layout = buildScreenLayout(makeSeats());
  const sold = new Set(layout.order);
  const usage = computeSeatUsage(layout, sold);
  assert.equal(usage.emptyCount, 0);
  assert.equal(usage.isolatedRate, 0);
  assert.equal(usage.occupancyPct, 100);
});

test('computeSeatUsage: 全席空席なら孤立空席は発生しない (区画端しかない)', () => {
  const layout = buildScreenLayout(makeSeats());
  const usage = computeSeatUsage(layout, new Set());
  assert.equal(usage.soldCount, 0);
  assert.equal(usage.isolatedCount, 0);
  assert.equal(usage.occupancyPct, 0);
});

test('computeSeatUsage: 孤立空席率100%のケース (空席が全て孤立)', () => {
  const layout = buildScreenLayout(makeSeats());
  // A1 A2(空) A3 | A6 A7 A8(空) A9 → 両方とも両隣が売れた単独空席
  const sold = new Set(['A1', 'A3', 'A4', 'A6', 'A7', 'A9']);
  const usage = computeSeatUsage(layout, sold);
  assert.equal(usage.emptyCount, 2);
  assert.equal(usage.isolatedCount, 2);
  assert.equal(usage.isolatedRate, 100);
});

test('compactStates: sold/empty/isolated を1文字コードに変換する', () => {
  const layout = buildScreenLayout(makeSeats());
  const sold = new Set(['A1', 'A3', 'A4', 'A6', 'A9']);
  const usage = computeSeatUsage(layout, sold);
  const code = compactStates(usage.seatStates);
  assert.equal(code.length, 8);
  assert.equal(code, 'SISSSEES');
});
