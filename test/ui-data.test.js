'use strict';

/**
 * UI 配信データ (derived/ui-showings.json) の検証。
 *
 * 目的: UI が表示する値が STEP 5 の予測エンジンの出力と一致していることを保証する。
 *       (UI 側で独自計算していないことの担保)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { loadShowings } = require('../src/dataset');
const { loadAggregates } = require('../src/buildAggregates');
const { createPredictor } = require('../src/predictor');
const { DERIVED_DIR, VACANCY_THRESHOLD_PCT } = require('../src/config');

const UI_JSON = path.join(DERIVED_DIR, 'ui-showings.json');
const available = fs.existsSync(UI_JSON);

test('UI配信データが存在する (npm run build:ui)', { skip: !available && 'ui-showings.json 未生成' }, () => {
  assert.ok(available);
});

if (available) {
  const payload = JSON.parse(fs.readFileSync(UI_JSON, 'utf8'));
  const { showings } = loadShowings();
  const predictor = createPredictor(loadAggregates(DERIVED_DIR));

  const COL = {
    showingId: 0,
    titleId: 1,
    screenId: 2,
    startTime: 3,
    endTime: 4,
    seatCapacity: 5,
    predictedPct: 6,
    sourceCode: 7,
    trainingShowCount: 8,
    isVacant: 9,
    vacancyRank: 10,
  };

  test('UIデータ: 全上映が含まれ、日付でもれなく分割されている', () => {
    const total = Object.values(payload.days).reduce((a, rows) => a + rows.length, 0);
    assert.equal(total, showings.length);
    assert.equal(payload.meta.dates.length, Object.keys(payload.days).length);
  });

  test('UIデータ: 予測値・isVacant が STEP 5 predictor の出力と一致する', () => {
    const byId = new Map(showings.map((s) => [s.showingId, s]));
    let checked = 0;

    for (const rows of Object.values(payload.days)) {
      for (const row of rows) {
        const s = byId.get(row[COL.showingId]);
        assert.ok(s, `${row[COL.showingId]} が schedules に存在する`);

        const p = predictor.predict({
          showingId: s.showingId,
          movieId: s.movieId,
          movieTitle: s.movieTitle,
          screenId: s.screenId,
          showDateTime: s.showDateTime,
          seatCapacity: s.seatCapacity,
        });

        assert.equal(row[COL.predictedPct], p.predictedOccupancyPctDisplay);
        assert.equal(row[COL.isVacant] === 1, p.isVacant);
        assert.equal(row[COL.trainingShowCount], p.trainingShowCount);
        assert.equal(row[COL.seatCapacity], s.seatCapacity);
        assert.equal(payload.titles[row[COL.titleId]], s.movieTitle);
        assert.equal(row[COL.startTime], s.startTime);
        checked++;
      }
    }
    assert.equal(checked, showings.length);
  });

  test('UIデータ: 各日の vacancyRank が 1..n の連番になっている', () => {
    for (const [date, rows] of Object.entries(payload.days)) {
      const ranks = rows.map((r) => r[COL.vacancyRank]).sort((a, b) => a - b);
      assert.deepEqual(
        ranks,
        rows.map((_, i) => i + 1),
        `${date} の順位が連番`
      );
    }
  });

  test('UIデータ: 空いている順に並んでおり、閾値と整合している', () => {
    for (const rows of Object.values(payload.days)) {
      const sorted = rows.slice().sort((a, b) => a[COL.vacancyRank] - b[COL.vacancyRank]);
      for (let i = 1; i < sorted.length; i++) {
        assert.ok(
          sorted[i - 1][COL.predictedPct] <= sorted[i][COL.predictedPct],
          '予測混雑率が昇順'
        );
      }
      // isVacant は閾値未満のみ true (10.0 ちょうどは false)
      for (const r of rows) {
        if (r[COL.isVacant] === 1) assert.ok(r[COL.predictedPct] < VACANCY_THRESHOLD_PCT + 0.05);
        else assert.ok(r[COL.predictedPct] >= VACANCY_THRESHOLD_PCT - 0.05);
      }
    }
  });

  test('UIデータ: 内部の source 値は 1文字コードのみ (画面に内部値を出さない)', () => {
    const seen = new Set();
    for (const rows of Object.values(payload.days)) {
      for (const r of rows) seen.add(r[COL.sourceCode]);
    }
    for (const code of seen) assert.ok(['w', 's', 'g'].includes(code), `想定外のコード: ${code}`);
    // 現データでは work_screen と screen の2種類のみ (global フォールバックは発生しない)
    assert.ok(seen.has('w') && seen.has('s'));
    assert.equal(seen.has('g'), false);
  });

  test('UIデータ: スクリーン情報が screens.csv と一致する', () => {
    const { screens } = loadShowings();
    for (const [id, info] of Object.entries(payload.meta.screens)) {
      const sc = screens.get(id);
      assert.ok(sc, `スクリーン ${id} が存在する`);
      assert.equal(info.capacity, sc.seatCapacity);
      assert.equal(info.name, sc.screenName);
    }
  });
}
