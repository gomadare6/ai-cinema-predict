'use strict';

/**
 * 「分析」機能 (予測 vs 実績 / 座席の質 / 映画別・スクリーン別プロフィール /
 *  意外な結果 / 映画館データ) 向けの集計処理。
 *
 * 重要な前提 (README・既存 src/predictor.js と同じ):
 *  - ここでの集計結果は本番の予測ロジック (work×screen → screen → global) を
 *    一切変更しない。予測に使う derived/*_avg.csv・global_avg.json はそのまま。
 *  - ticket_sales.csv は 1行 = 1販売座席として扱う (人数・グループ数は使わない)。
 *  - 座席単位の販売頻度には現実的でない偏りが確認されているため、
 *    個別座席の人気ランキングや、座席を予測の特徴量として使う処理はここに置かない。
 *  - movies.csv の「公開日」はデータ不整合が確認されているため、ここでは使わない。
 */

const path = require('path');
const { forEachCsvRow } = require('./csv');
const { buildAggregates } = require('./buildAggregates');
const { createPredictor } = require('./predictor');
const { computeSeatUsage, compactStates } = require('./seatUsage');
const { VACANCY_THRESHOLD_PCT, DATA_DIR } = require('./config');

function mean(xs) {
  if (xs.length === 0) return null;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = mean(xs.map((x) => (x - m) ** 2));
  return Math.sqrt(variance);
}

/**
 * ticket_sales.csv を1回だけ読み、上映IDごとの販売座席ID集合を作る。
 * 大きいファイルなので forEachCsvRow でストリーム処理する (メモリに全文は持たない)。
 * @param {string} dataDir
 * @returns {Map<string, Set<string>>}
 */
function loadSoldSeatIdsByShowing(dataDir = DATA_DIR) {
  const byShowing = new Map();
  let showingIdIdx = -1;
  let seatIdIdx = -1;
  forEachCsvRow(path.join(dataDir, 'ticket_sales.csv'), (cells, header) => {
    if (showingIdIdx === -1) {
      showingIdIdx = header.indexOf('上映ID');
      seatIdIdx = header.indexOf('座席ID');
    }
    const showingId = cells[showingIdIdx];
    const seatId = cells[seatIdIdx];
    let set = byShowing.get(showingId);
    if (!set) {
      set = new Set();
      byShowing.set(showingId, set);
    }
    set.add(seatId);
  });
  return byShowing;
}

/**
 * 予測 vs 実績のレポートを作る (検証期間: config.VALIDATION_START〜END)。
 * scripts/verify-step3.js と同じ計算をベースに、散布図用サンプルも返す。
 * @param {Array<object>} showings loadShowings().showings
 * @param {number} [sampleSize] 散布図に含める点の最大数
 */
function computeValidationReport(showings, sampleSize = 600) {
  const aggregates = buildAggregates(showings);
  const { predict } = createPredictor(aggregates);
  const validation = showings.filter((s) => s.inValidationWindow);

  const absErr = [];
  const bySource = { work_screen: [], screen: [], global: [] };
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const points = [];

  for (const s of validation) {
    const p = predict({
      showingId: s.showingId,
      movieId: s.movieId,
      movieTitle: s.movieTitle,
      screenId: s.screenId,
      showDateTime: s.showDateTime,
      seatCapacity: s.seatCapacity,
    });
    const err = Math.abs(s.actualOccupancyPct - p.predictedOccupancyPct);
    absErr.push(err);
    bySource[p.predictionSource].push(err);

    const actualVacant = s.actualOccupancyPct < VACANCY_THRESHOLD_PCT;
    if (actualVacant && p.isVacant) tp++;
    else if (!actualVacant && p.isVacant) fp++;
    else if (actualVacant && !p.isVacant) fn++;
    else tn++;

    points.push({
      pred: Math.round(p.predictedOccupancyPct * 10) / 10,
      actual: Math.round(s.actualOccupancyPct * 10) / 10,
      source: p.predictionSource,
    });
  }

  // 散布図は全件返すとデータ量が大きいので、決定的に間引く (先頭からの等間隔サンプリング)
  const sampled = points.length <= sampleSize
    ? points
    : points.filter((_, i) => i % Math.ceil(points.length / sampleSize) === 0);

  const acc = (tp + tn) / (tp + fp + fn + tn);
  const precision = tp / (tp + fp) || 0;
  const recall = tp / (tp + fn) || 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  const sortedByPred = points.slice().sort((a, b) => a.pred - b.pred);
  const topSlice = (pct) => {
    const k = Math.floor((sortedByPred.length * pct) / 100);
    const sl = sortedByPred.slice(0, k);
    return {
      count: k,
      actualMean: mean(sl.map((x) => x.actual)),
      hitRate: k > 0 ? sl.filter((x) => x.actual < VACANCY_THRESHOLD_PCT).length / k : 0,
    };
  };

  return {
    validationCount: validation.length,
    mae: mean(absErr),
    maeBySource: {
      work_screen: { mae: mean(bySource.work_screen), count: bySource.work_screen.length },
      screen: { mae: mean(bySource.screen), count: bySource.screen.length },
      global: { mae: mean(bySource.global), count: bySource.global.length },
    },
    vacancyClassification: { tp, fp, fn, tn, accuracy: acc, precision, recall, f1 },
    top10: topSlice(10),
    points: sampled,
  };
}

/**
 * 映画ごとの混雑プロフィール。学習+検証期間の全実績上映を対象にする
 * (この機能は予測入力ではなく、実績の説明表示なのでデータリークの制約は無い)。
 * movies.csv の「公開日」は使わない (データ不整合が確認済みのため)。
 */
function computeMovieProfiles(showings) {
  const actual = showings.filter((s) => !s.isFuture && s.actualOccupancyPct != null);
  const byMovie = new Map();
  for (const s of actual) {
    let g = byMovie.get(s.movieId);
    if (!g) {
      g = { movieId: s.movieId, title: s.movieTitle, genre: s.genre, occ: [], byScreen: new Map() };
      byMovie.set(s.movieId, g);
    }
    g.occ.push(s.actualOccupancyPct);
    g.byScreen.set(s.screenId, (g.byScreen.get(s.screenId) || []).concat(s.actualOccupancyPct));
  }

  const profiles = [...byMovie.values()].map((g) => {
    const screens = [...g.byScreen.entries()]
      .map(([screenId, occ]) => ({ screenId, count: occ.length, avgOccupancyPct: mean(occ) }))
      .sort((a, b) => Number(a.screenId) - Number(b.screenId));
    return {
      movieId: g.movieId,
      title: g.title,
      genre: g.genre,
      showCount: g.occ.length,
      avgOccupancyPct: mean(g.occ),
      minOccupancyPct: Math.min(...g.occ),
      maxOccupancyPct: Math.max(...g.occ),
      rangeOccupancyPct: Math.max(...g.occ) - Math.min(...g.occ),
      stdevOccupancyPct: stdev(g.occ),
      screens,
    };
  });

  return profiles.sort((a, b) => b.showCount - a.showCount);
}

/** スクリーンごとのプロフィール (定員・平均混雑率など)。screens.csv の設備情報と組み合わせる。 */
function computeScreenProfiles(showings, screenMeta) {
  const actual = showings.filter((s) => !s.isFuture && s.actualOccupancyPct != null);
  const byScreen = new Map();
  for (const s of actual) {
    if (!byScreen.has(s.screenId)) byScreen.set(s.screenId, { occ: [], sold: [] });
    const g = byScreen.get(s.screenId);
    g.occ.push(s.actualOccupancyPct);
    g.sold.push(s.soldSeats);
  }

  return [...byScreen.entries()]
    .map(([screenId, g]) => {
      const meta = screenMeta.get(screenId) || {};
      return {
        screenId,
        screenName: meta.screenName,
        capacity: meta.seatCapacity,
        wheelchairSeats: meta.wheelchairSeats,
        screenSize: meta.screenSize,
        soundSystem: meta.soundSystem,
        equipment: meta.equipment,
        showCount: g.occ.length,
        avgOccupancyPct: mean(g.occ),
        avgSoldSeats: mean(g.sold),
      };
    })
    .sort((a, b) => (b.capacity || 0) - (a.capacity || 0));
}

/**
 * 清掃インターバルの実測値 (同一スクリーン・同一日の連続上映間隔)。
 * staff_issues.txt の「20〜25分しかない」という申告と、実データの分布を比較できるようにする。
 * 「短いから問題」とは断定せず、分布と平均だけを返す (文言は表示側で慎重に扱う)。
 */
function computeCleaningGapStats(schedules) {
  function toMinutes(t) {
    const [h, m] = String(t).split(':').map(Number);
    return h * 60 + m;
  }
  const byScreenDate = new Map();
  for (const s of schedules) {
    const key = `${s.screenId}\t${s.showDate}`;
    if (!byScreenDate.has(key)) byScreenDate.set(key, []);
    byScreenDate.get(key).push(s);
  }

  const gaps = [];
  for (const list of byScreenDate.values()) {
    const sorted = list.slice().sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
    for (let i = 0; i < sorted.length - 1; i++) {
      const endMin = toMinutes(sorted[i].endTime);
      const nextStartMin = toMinutes(sorted[i + 1].startTime);
      const gap = nextStartMin - endMin;
      if (gap >= 0 && gap < 180) gaps.push(gap); // 日またぎ等の外れ値だけ除外
    }
  }

  const buckets = { '0-9': 0, '10-19': 0, '20-24': 0, '25-29': 0, '30-44': 0, '45+': 0 };
  for (const g of gaps) {
    if (g < 10) buckets['0-9']++;
    else if (g < 20) buckets['10-19']++;
    else if (g < 25) buckets['20-24']++;
    else if (g < 30) buckets['25-29']++;
    else if (g < 45) buckets['30-44']++;
    else buckets['45+']++;
  }

  const sorted = gaps.slice().sort((a, b) => a - b);
  return {
    sampleCount: gaps.length,
    meanMinutes: mean(gaps),
    medianMinutes: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    under25MinRate: gaps.length ? gaps.filter((g) => g < 25).length / gaps.length : null,
    buckets,
  };
}

/**
 * 「意外な結果」向けの比較集計: 曜日種別・時間帯・レイトショーの有無ごとの平均混雑率。
 * 「◯◯だから空いている」と一般化しないための素材として、単純な平均の比較だけを返す。
 */
function computeSurpriseComparisons(showings, schedules) {
  const scheduleById = new Map(schedules.map((s) => [s.showingId, s]));
  const actual = showings.filter((s) => !s.isFuture && s.actualOccupancyPct != null);

  const byWeekdayType = new Map();
  const byHourBand = new Map();
  const byLateShow = new Map();

  const hourBand = (startTime) => {
    const h = Number(String(startTime).slice(0, 2));
    if (h < 12) return '午前(〜11:59)';
    if (h < 17) return '午後(12:00〜16:59)';
    if (h < 20) return '夕方(17:00〜19:59)';
    return '夜(20:00〜)';
  };

  for (const s of actual) {
    const sched = scheduleById.get(s.showingId);
    if (!sched) continue;

    const wd = sched.weekdayType || '不明';
    if (!byWeekdayType.has(wd)) byWeekdayType.set(wd, []);
    byWeekdayType.get(wd).push(s.actualOccupancyPct);

    const hb = hourBand(s.startTime);
    if (!byHourBand.has(hb)) byHourBand.set(hb, []);
    byHourBand.get(hb).push(s.actualOccupancyPct);

    const late = sched.lateShow ? 'レイトショー' : '通常';
    if (!byLateShow.has(late)) byLateShow.set(late, []);
    byLateShow.get(late).push(s.actualOccupancyPct);
  }

  const summarize = (map) =>
    [...map.entries()]
      .map(([key, occ]) => ({ key, count: occ.length, avgOccupancyPct: mean(occ) }))
      .sort((a, b) => b.count - a.count);

  return {
    byWeekdayType: summarize(byWeekdayType),
    byHourBand: summarize(byHourBand),
    byLateShow: summarize(byLateShow),
  };
}

/**
 * 混雑率帯ごとの孤立空席率の傾向。全実績上映を対象に座席配置と付き合わせて計算する。
 * @param {Array<object>} showings
 * @param {Map<string, Set<string>>} soldSeatIdsByShowing
 * @param {Map<string, object>} screenLayouts screenId -> buildScreenLayout() の戻り値
 */
function computeIsolatedSeatSummary(showings, soldSeatIdsByShowing, screenLayouts) {
  const actual = showings.filter((s) => !s.isFuture && s.actualOccupancyPct != null);
  const bandOf = (pct) => {
    const lo = Math.min(90, Math.floor(pct / 10) * 10);
    return `${lo}-${lo + 10}%`;
  };

  const byBand = new Map();
  let showingsWithIsolated = 0;
  let totalConsidered = 0;

  for (const s of actual) {
    const layout = screenLayouts.get(s.screenId);
    const soldIds = soldSeatIdsByShowing.get(s.showingId);
    if (!layout || !soldIds) continue;
    const usage = computeSeatUsage(layout, soldIds);
    totalConsidered++;
    if (usage.isolatedCount > 0) showingsWithIsolated++;

    const band = bandOf(usage.occupancyPct);
    if (!byBand.has(band)) byBand.set(band, { count: 0, isolatedRates: [], emptyIsIsolatedShare: [] });
    const g = byBand.get(band);
    g.count++;
    g.isolatedRates.push(usage.isolatedRate);
  }

  const bands = [...byBand.entries()]
    .map(([band, g]) => ({
      band,
      count: g.count,
      avgIsolatedRate: mean(g.isolatedRates),
    }))
    .sort((a, b) => Number(a.band.split('-')[0]) - Number(b.band.split('-')[0]));

  return {
    totalConsidered,
    showingsWithIsolatedSeat: showingsWithIsolated,
    shareOfShowingsWithIsolatedSeat: totalConsidered ? showingsWithIsolated / totalConsidered : 0,
    byOccupancyBand: bands,
  };
}

module.exports = {
  loadSoldSeatIdsByShowing,
  computeValidationReport,
  computeMovieProfiles,
  computeScreenProfiles,
  computeCleaningGapStats,
  computeSurpriseComparisons,
  computeIsolatedSeatSummary,
  compactStates,
  mean,
  stdev,
};
