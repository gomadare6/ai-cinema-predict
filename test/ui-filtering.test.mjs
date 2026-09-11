/**
 * STEP 7: 日付・時間帯フィルタリングと「空いている順」体験の検証。
 *
 * public/js/data.js の純粋関数を、実データ (derived/ui-showings.json) で検証する。
 * 予測アルゴリズムは検証しない（STEP 5 の値をそのまま使えているかだけ確認する）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildResultView,
  getShowingsForDate,
  filterByBand,
  sortShowings,
  summarize,
  shiftDate,
  formatDateLabel,
  TIME_BANDS,
  SORT_MODES,
} from '../public/js/data.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'derived', 'ui-showings.json'), 'utf8'));

// build-ui-data.js の列順（テストが JSON の生値を直接確認するため）
const COL = { showingId: 0, startTime: 3, predictedPct: 6, isVacant: 9, vacancyRank: 10 };
const DATES = ['2025-10-01', '2025-10-02', '2025-12-31'];
const hourOf = (hhmm) => Number(String(hhmm).slice(0, 2));
const cond = (date, bandId = 'all', sortId = 'vacancy') => ({ date, bandId, sortId });

// ---------------------------------------------------------------------------
// テスト1: 日付を変更すると、指定日の上映だけになる
// ---------------------------------------------------------------------------
test('テスト1: 日付フィルターは指定日の上映だけを返す（他の日を混ぜない）', () => {
  for (const date of DATES) {
    const view = buildResultView(data, cond(date));
    const idsForDate = new Set(data.days[date].map((r) => r[COL.showingId]));

    assert.equal(view.showings.length, data.days[date].length);
    assert.equal(view.showings.length, 60, `${date} は 10スクリーン×6回 = 60上映`);
    for (const s of view.showings) {
      assert.ok(idsForDate.has(s.showingId), `${s.showingId} は ${date} の上映`);
    }
    // 別の日の上映IDが1件も含まれない
    const otherDate = date === '2025-10-01' ? '2025-10-02' : '2025-10-01';
    const otherIds = new Set(data.days[otherDate].map((r) => r[COL.showingId]));
    assert.equal(
      view.showings.filter((s) => otherIds.has(s.showingId)).length,
      0
    );
  }
});

// ---------------------------------------------------------------------------
// テスト2 / テスト3: 前日・翌日
// ---------------------------------------------------------------------------
test('テスト2: 前日は1日前の日付になる', () => {
  assert.equal(shiftDate('2025-10-02', -1), '2025-10-01');
  assert.equal(shiftDate('2025-10-01', -1), '2025-09-30');
  assert.equal(shiftDate('2025-01-01', -1), '2024-12-31');
});

test('テスト3: 翌日は1日後の日付になる', () => {
  assert.equal(shiftDate('2025-10-01', 1), '2025-10-02');
  assert.equal(shiftDate('2025-09-30', 1), '2025-10-01');
});

// ---------------------------------------------------------------------------
// テスト4: 月末→翌月初 / 年末→翌年初 が正しい
// ---------------------------------------------------------------------------
test('テスト4: 月末・年末年始の日付繰り上がり／繰り下がりが正しい', () => {
  assert.equal(shiftDate('2025-10-31', 1), '2025-11-01', '10月末 → 11月初');
  assert.equal(shiftDate('2025-11-01', -1), '2025-10-31', '11月初 → 10月末');
  assert.equal(shiftDate('2025-12-31', 1), '2026-01-01', '年末 → 翌年初');
  assert.equal(shiftDate('2026-01-01', -1), '2025-12-31', '翌年初 → 年末');
  assert.equal(shiftDate('2025-02-28', 1), '2025-03-01', '2025年2月は28日まで');
  assert.equal(shiftDate('2024-02-28', 1), '2024-02-29', '2024年はうるう年');
  assert.equal(shiftDate('2025-07-01', 0), '2025-07-01', 'delta 0 は変化なし');
});

// ---------------------------------------------------------------------------
// テスト5: 時間帯「午前」で午前の上映だけになる
// ---------------------------------------------------------------------------
test('テスト5: 時間帯「午前」は開始時刻が12:00より前の上映だけになる', () => {
  for (const date of DATES) {
    const view = buildResultView(data, cond(date, 'morning'));
    assert.ok(view.showings.length > 0);
    for (const s of view.showings) {
      assert.ok(hourOf(s.startTime) < 12, `${s.startTime} は午前`);
    }
    // 実データの午前枠は 09:30 の10スクリーンのみ
    assert.equal(view.showings.length, 10);
  }
});

// ---------------------------------------------------------------------------
// テスト6: 時間帯「すべて」で全時間帯に戻る
// ---------------------------------------------------------------------------
test('テスト6: 時間帯「すべて」は全60上映（全時間帯）に戻る', () => {
  const view = buildResultView(data, cond('2025-10-01', 'all'));
  assert.equal(view.showings.length, 60);

  const bands = { morning: 0, afternoon: 0, evening: 0, night: 0 };
  for (const s of view.showings) {
    const h = hourOf(s.startTime);
    if (h < 12) bands.morning++;
    else if (h < 17) bands.afternoon++;
    else if (h < 20) bands.evening++;
    else bands.night++;
  }
  assert.deepEqual(bands, { morning: 10, afternoon: 20, evening: 20, night: 10 });

  // 各時間帯フィルターの合計 = すべて
  const sum = TIME_BANDS.filter((b) => b.id !== 'all').reduce(
    (a, b) => a + filterByBand(view.showings, b.id).length,
    0
  );
  assert.equal(sum, 60);
});

// ---------------------------------------------------------------------------
// テスト7: 「空いている順」で予測混雑率が昇順
// ---------------------------------------------------------------------------
test('テスト7: 空いている順 = 予測混雑率 昇順 → vacancyRank の連番', () => {
  for (const date of DATES) {
    const view = buildResultView(data, cond(date, 'all', 'vacancy'));
    const list = view.showings;

    for (let i = 1; i < list.length; i++) {
      assert.ok(
        list[i - 1].predictedPct <= list[i].predictedPct,
        `${date}: 予測混雑率が昇順`
      );
    }
    // STEP 5 の vacancyRank がそのまま 1..n の並びになっている
    assert.deepEqual(
      list.map((s) => s.vacancyRank),
      list.map((_, i) => i + 1)
    );
    // 先頭がその日いちばん空いている上映
    const minPct = Math.min(...list.map((s) => s.predictedPct));
    assert.equal(list[0].predictedPct, minPct);
  }
});

// ---------------------------------------------------------------------------
// テスト8: 「上映時間順」で開始時刻順（同時刻は上映ID昇順・決定的）
// ---------------------------------------------------------------------------
test('テスト8: 上映時間順 = 開始時刻 昇順、同時刻は上映ID昇順で決定的', () => {
  const view = buildResultView(data, cond('2025-10-01', 'all', 'time'));
  const list = view.showings;

  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1];
    const cur = list[i];
    assert.ok(prev.startTime <= cur.startTime, '開始時刻が昇順');
    if (prev.startTime === cur.startTime) {
      assert.ok(prev.showingId < cur.showingId, '同時刻は上映ID昇順');
    }
  }

  // 入力順に依存しない
  const a = sortShowings(list, 'time').map((s) => s.showingId);
  const b = sortShowings(list.slice().reverse(), 'time').map((s) => s.showingId);
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// テスト9: 日付＋時間帯を組み合わせても正しい
// ---------------------------------------------------------------------------
test('テスト9: 日付 × 時間帯 の組み合わせが正しい', () => {
  const date = '2025-12-31';
  const view = buildResultView(data, cond(date, 'evening', 'vacancy'));
  const idsForDate = new Set(data.days[date].map((r) => r[COL.showingId]));

  assert.ok(view.showings.length > 0);
  for (const s of view.showings) {
    assert.ok(idsForDate.has(s.showingId), 'その日の上映');
    const h = hourOf(s.startTime);
    assert.ok(h >= 17 && h < 20, `${s.startTime} は夕方 (17:00〜19:59)`);
  }
  // 夕方枠は 17:00 と 19:00 の各10スクリーン
  assert.equal(view.showings.length, 20);

  // 直接パイプラインを組んでも同じ結果
  const manual = sortShowings(
    filterByBand(getShowingsForDate(data, date), 'evening'),
    'vacancy'
  );
  assert.deepEqual(
    view.showings.map((s) => s.showingId),
    manual.map((s) => s.showingId)
  );
});

// ---------------------------------------------------------------------------
// テスト10: 0件の場合に適切な状態になる
// ---------------------------------------------------------------------------
test('テスト10: 上映0件のとき state が返り、画面が壊れない情報になる', () => {
  // データ範囲外の日付 → no-date-data
  const outOfRange = buildResultView(data, cond('2024-06-01'));
  assert.equal(outOfRange.state, 'no-date-data');
  assert.equal(outOfRange.showings.length, 0);
  assert.deepEqual(outOfRange.summary, { total: 0, vacant: 0 });
  assert.equal(outOfRange.dateLabel, '2024年6月1日（土）');

  // 時間帯で0件になるケース（合成データ: 午前しか無い日に「夜」を選ぶ）
  const synthetic = {
    meta: { screens: { 1: { name: 'シアター1', capacity: 100 } } },
    titles: ['サンプル作品'],
    days: {
      '2025-10-05': [
        // showingId, titleId, screenId, start, end, cap, pct, src, n, isVacant, rank
        ['S99001', 0, '1', '09:30', '11:30', 100, 8.0, 'w', 10, 1, 1],
        ['S99002', 0, '1', '10:00', '12:00', 100, 12.0, 's', 5, 0, 2],
      ],
    },
  };
  const emptyBand = buildResultView(synthetic, cond('2025-10-05', 'night'));
  assert.equal(emptyBand.state, 'empty-band');
  assert.equal(emptyBand.showings.length, 0);
  assert.equal(emptyBand.summary.total, 0);
  assert.equal(emptyBand.bandLabel, '夜');

  // 同じ日で「すべて」なら 2件表示される
  const all = buildResultView(synthetic, cond('2025-10-05', 'all'));
  assert.equal(all.state, 'ok');
  assert.equal(all.showings.length, 2);
});

// ---------------------------------------------------------------------------
// テスト11: フィルター後の「全○上映のうち○件が空いている見込み」が正しい
// ---------------------------------------------------------------------------
test('テスト11: 件数サマリの母数はフィルター適用後（表示対象）だけ', () => {
  const date = '2025-10-01';

  // 「すべて」: 母数 = その日全60上映
  const all = buildResultView(data, cond(date, 'all'));
  const dayRows = data.days[date];
  assert.equal(all.summary.total, 60);
  assert.equal(all.summary.vacant, dayRows.filter((r) => r[COL.isVacant] === 1).length);

  // 「午前」: 母数 = 午前の上映だけ。空き件数も午前の中だけで数える
  const morning = buildResultView(data, cond(date, 'morning'));
  const morningRows = dayRows.filter((r) => hourOf(r[COL.startTime]) < 12);
  assert.equal(morning.summary.total, morningRows.length);
  assert.equal(
    morning.summary.vacant,
    morningRows.filter((r) => r[COL.isVacant] === 1).length
  );
  // 午前の母数はその日全体より必ず小さい（＝全体件数を母数にしていない）
  assert.ok(morning.summary.total < all.summary.total);
  assert.ok(morning.summary.vacant <= all.summary.vacant);

  // summarize() 単体でも母数 = 引数配列
  const picked = all.showings.slice(0, 7);
  assert.deepEqual(summarize(picked), {
    total: 7,
    vacant: picked.filter((s) => s.isVacant).length,
  });

  // 各時間帯の total を足すと その日の全上映数になる
  const bandTotals = ['morning', 'afternoon', 'evening', 'night'].map(
    (id) => buildResultView(data, cond(date, id)).summary.total
  );
  assert.equal(bandTotals.reduce((a, b) => a + b, 0), 60);
});

// ---------------------------------------------------------------------------
// テスト12: STEP 5 の予測値を UI 層が改変していない
// ---------------------------------------------------------------------------
test('テスト12: UI 層は予測値 (predictedPct/isVacant/vacancyRank) を素通しする', () => {
  // meta が STEP 5 の前提のまま
  assert.equal(data.meta.vacancyThresholdPct, 10);
  assert.deepEqual(data.meta.trainingWindow, {
    start: '2025-01-01',
    end: '2025-09-30',
  });

  for (const date of DATES) {
    const rawById = new Map(data.days[date].map((r) => [r[COL.showingId], r]));
    for (const s of getShowingsForDate(data, date)) {
      const raw = rawById.get(s.showingId);
      assert.equal(s.predictedPct, raw[COL.predictedPct], 'predictedPct を再計算していない');
      assert.equal(s.isVacant, raw[COL.isVacant] === 1, 'isVacant を再判定していない');
      assert.equal(s.vacancyRank, raw[COL.vacancyRank], 'vacancyRank をそのまま使っている');
    }
  }

  // 並び替え・絞り込みをしても予測値は不変
  const before = getShowingsForDate(data, '2025-10-01');
  const after = sortShowings(filterByBand(before, 'afternoon'), 'time');
  for (const s of after) {
    const orig = before.find((x) => x.showingId === s.showingId);
    assert.equal(s.predictedPct, orig.predictedPct);
    assert.equal(s.isVacant, orig.isVacant);
    assert.equal(s.vacancyRank, orig.vacancyRank);
  }
});

// ---------------------------------------------------------------------------
// 補助: 処理順（日付→時間帯→並び替え）と非破壊性
// ---------------------------------------------------------------------------
test('補助: buildResultView は入力データを変更しない', () => {
  const snapshot = JSON.stringify(data.days['2025-10-02']);
  buildResultView(data, cond('2025-10-02', 'evening', 'time'));
  buildResultView(data, cond('2025-10-02', 'all', 'vacancy'));
  assert.equal(JSON.stringify(data.days['2025-10-02']), snapshot);
});

test('補助: ラベル類が正しく返る', () => {
  const v = buildResultView(data, cond('2025-10-01', 'evening', 'time'));
  assert.equal(v.dateLabel, '2025年10月1日（水）');
  assert.equal(v.bandLabel, '夕方');
  assert.equal(v.sortLabel, '上映時間順');
  assert.equal(SORT_MODES.length, 2);
  assert.equal(formatDateLabel('2025-12-31'), '2025年12月31日（水）');
});
