/**
 * ブラウザ側のデータ整形ロジック (public/js/data.js) の検証。
 * data.js は DOM に依存しないため Node からそのまま import できる。
 * (fetch を使う loadUiData 以外の純粋関数をテストする)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getShowingsForDate,
  filterByBand,
  sortShowings,
  formatDateLabel,
  TIME_BANDS,
  SORT_MODES,
} from '../public/js/data.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI_JSON = path.join(ROOT, 'derived', 'ui-showings.json');
const payload = JSON.parse(fs.readFileSync(UI_JSON, 'utf8'));
const DATE = '2025-10-01';

test('UIロジック: 指定日の上映を表示用オブジェクトに変換できる', () => {
  const list = getShowingsForDate(payload, DATE);
  assert.equal(list.length, 60, '1日は10スクリーン×6回 = 60上映');

  for (const s of list) {
    assert.match(s.showingId, /^S\d{5}$/);
    assert.ok(typeof s.title === 'string' && s.title.length > 0, '作品名が入っている');
    assert.match(s.screenName, /^シアター\d+$/, 'スクリーン名が screens.csv 由来');
    assert.match(s.startTime, /^\d{2}:\d{2}$/);
    assert.ok(s.seatCapacity > 0);
    assert.ok(typeof s.predictedPct === 'number');
    assert.ok(typeof s.isVacant === 'boolean');
    assert.ok(['actual', 'fallback'].includes(s.confidenceKind));
    // 内部値 (work_screen / screen / global) が文言に混入していないこと
    assert.doesNotMatch(s.confidenceLabel, /work_screen|screen_avg|global/);
  }
});

test('UIロジック: 存在しない日付は空配列を返す (画面が壊れない)', () => {
  assert.deepEqual(getShowingsForDate(payload, '2024-01-01'), []);
  assert.deepEqual(getShowingsForDate(payload, 'bogus'), []);
});

test('UIロジック: 時間帯フィルタが実際の上映枠に対応している', () => {
  const list = getShowingsForDate(payload, DATE);
  const counts = {};
  for (const band of TIME_BANDS) {
    counts[band.id] = filterByBand(list, band.id).length;
  }
  assert.equal(counts.all, 60);
  // 実データの上映枠は 09:30 / 12:00 / 14:30 / 17:00 / 19:00 / 21:10
  assert.equal(counts.morning, 10, '午前: 09:30 の10スクリーン');
  assert.equal(counts.afternoon, 20, '午後: 12:00 と 14:30');
  assert.equal(counts.evening, 20, '夕方: 17:00 と 19:00');
  assert.equal(counts.night, 10, '夜: 21:10');
  assert.equal(counts.morning + counts.afternoon + counts.evening + counts.night, 60);

  // 不正な band id は「すべて」にフォールバック
  assert.equal(filterByBand(list, 'nope').length, 60);
});

test('UIロジック: 空いている順の並びが STEP 5 の vacancyRank に一致する', () => {
  const list = getShowingsForDate(payload, DATE);
  const sorted = sortShowings(list, 'vacancy');

  assert.deepEqual(
    sorted.map((s) => s.vacancyRank),
    sorted.map((_, i) => i + 1)
  );
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i - 1].predictedPct <= sorted[i].predictedPct, '予測混雑率が昇順');
  }
  // 先頭が最も空いている上映
  assert.equal(sorted[0].predictedPct, Math.min(...list.map((s) => s.predictedPct)));
  assert.equal(sorted[0].isVacant, true);
});

test('UIロジック: 上映時間順の並びが決定的である', () => {
  const list = getShowingsForDate(payload, DATE);
  const a = sortShowings(list, 'time').map((s) => s.showingId);
  const b = sortShowings(list.slice().reverse(), 'time').map((s) => s.showingId);
  assert.deepEqual(a, b, '入力順に依存しない');

  const sorted = sortShowings(list, 'time');
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i - 1].startTime <= sorted[i].startTime, '開始時刻が昇順');
  }
  // 元の配列は変更されない
  assert.equal(list.length, 60);
});

test('UIロジック: 日付ラベルの曜日が正しい', () => {
  assert.equal(formatDateLabel('2025-10-01'), '2025年10月1日（水）');
  assert.equal(formatDateLabel('2025-01-01'), '2025年1月1日（水）');
  assert.equal(formatDateLabel('2025-12-31'), '2025年12月31日（水）');
  assert.equal(formatDateLabel('2025-10-04'), '2025年10月4日（土）');
});

test('UIロジック: フォールバック上映が「実績あり」と誤解されない文言になっている', () => {
  const list = getShowingsForDate(payload, DATE);
  const fallback = list.filter((s) => s.confidenceKind === 'fallback');
  const actual = list.filter((s) => s.confidenceKind === 'actual');
  assert.ok(fallback.length > 0, 'フォールバックの上映が存在する');
  assert.ok(actual.length > 0, '実績ありの上映も存在する');

  for (const s of fallback) {
    assert.match(s.confidenceLabel, /^参考値：/, 'フォールバックは「参考値：」で始まる');
    assert.doesNotMatch(s.confidenceLabel, /実績あり/);
  }
  for (const s of actual) {
    assert.equal(s.confidenceLabel, '過去の上映実績あり');
    assert.ok(s.trainingShowCount >= 1);
  }
});

test('UIロジック: 並び順の選択肢が2種類だけ定義されている', () => {
  assert.deepEqual(
    SORT_MODES.map((m) => m.id),
    ['vacancy', 'time']
  );
});
