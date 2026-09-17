/** 分析ページの描画とイベント配線。derived/analytics/*.json の値をそのまま表示するだけ。 */

import { loadAnalyticsData } from './analysis-data.js';

const statusEl = document.getElementById('status');

function showError() {
  statusEl.hidden = false;
  statusEl.className = 'status status--error';
  statusEl.textContent = '';
  const title = document.createElement('p');
  title.className = 'status__title';
  title.textContent = '分析データを読み込めませんでした';
  statusEl.appendChild(title);
  const body = document.createElement('p');
  body.style.margin = '0';
  body.textContent = '`npm run build:analytics` を実行してデータを生成してください。';
  statusEl.appendChild(body);
}

function reveal(id) {
  document.getElementById(id).hidden = false;
}

function addStat(dl, term, desc) {
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  dd.textContent = desc;
  dl.appendChild(dt);
  dl.appendChild(dd);
}

function pct(n) {
  return n == null ? '-' : `${n.toFixed(1)}%`;
}

function fixed(n, digits = 2) {
  return n == null ? '-' : n.toFixed(digits);
}

/** 横棒 (CSS width) の簡易バーグラフ行を作る。データの比較のためだけの単純な表現。 */
function buildBarRow(label, valuePct, maxPct, detail) {
  const row = document.createElement('div');
  row.className = 'bar-row';

  const head = document.createElement('div');
  head.className = 'bar-row__head';
  head.textContent = label;
  row.appendChild(head);

  const track = document.createElement('div');
  track.className = 'bar-row__track';
  const fill = document.createElement('div');
  fill.className = 'bar-row__fill';
  fill.style.width = `${maxPct > 0 ? Math.min(100, (valuePct / maxPct) * 100) : 0}%`;
  track.appendChild(fill);
  row.appendChild(track);

  const value = document.createElement('div');
  value.className = 'bar-row__value';
  value.textContent = detail;
  row.appendChild(value);

  return row;
}

// ---------- 予測 vs 実績 ----------

function renderValidation(validation) {
  const dl = document.getElementById('validation-stats');
  addStat(dl, '検証件数', `${validation.validationCount}件`);
  addStat(dl, '全体 MAE', `${fixed(validation.mae)}ポイント`);
  addStat(dl, '空いている判定 Accuracy', fixed(validation.vacancyClassification.accuracy, 3));
  addStat(dl, '空いている判定 F1', fixed(validation.vacancyClassification.f1, 3));
  addStat(
    dl,
    '予測下位10%の実績',
    `平均${fixed(validation.top10.actualMean)}% / 実際に10%未満だった割合${(validation.top10.hitRate * 100).toFixed(1)}%`
  );

  const table = document.getElementById('validation-source-table');
  const rows = [
    ['予測根拠', 'MAE', '件数'],
    ['作品×スクリーン実績あり', fixed(validation.maeBySource.work_screen.mae), `${validation.maeBySource.work_screen.count}件`],
    ['スクリーン平均', fixed(validation.maeBySource.screen.mae), `${validation.maeBySource.screen.count}件`],
    ['全体平均', validation.maeBySource.global.mae == null ? '-' : fixed(validation.maeBySource.global.mae), `${validation.maeBySource.global.count}件`],
  ];
  fillTable(table, rows);

  drawScatter(validation.points);
}

function drawScatter(points) {
  const canvas = document.getElementById('scatter-canvas');
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const pad = 36;

  ctx.clearRect(0, 0, w, h);

  const style = getComputedStyle(document.documentElement);
  const line = style.getPropertyValue('--line-strong').trim() || '#3c4753';
  const textColor = style.getPropertyValue('--text-faint').trim() || '#8b9088';
  const dot = style.getPropertyValue('--vacant-fill').trim() || '#1f9e7d';
  const refLine = style.getPropertyValue('--brass-bright').trim() || '#e0c35a';

  const plotW = w - pad * 2;
  const plotH = h - pad * 2;
  const toX = (v) => pad + (v / 100) * plotW;
  const toY = (v) => h - pad - (v / 100) * plotH;

  // 軸
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, pad);
  ctx.lineTo(pad, h - pad);
  ctx.lineTo(w - pad, h - pad);
  ctx.stroke();

  ctx.fillStyle = textColor;
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText('0', pad - 4, h - pad + 14);
  ctx.fillText('100', w - pad - 16, h - pad + 14);
  ctx.save();
  ctx.translate(pad - 22, pad + 6);
  ctx.fillText('実績%', 0, 0);
  ctx.restore();
  ctx.fillText('予測%', w - pad - 28, h - pad + 28);

  // 予測=実績 の目安線
  ctx.strokeStyle = refLine;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(0));
  ctx.lineTo(toX(100), toY(100));
  ctx.stroke();
  ctx.setLineDash([]);

  // 点
  ctx.fillStyle = dot;
  ctx.globalAlpha = 0.55;
  for (const p of points) {
    ctx.beginPath();
    ctx.arc(toX(p.pred), toY(p.actual), 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// ---------- 意外な結果 ----------

// グループ内最大値を基準にすると値が近いとき全バーが満タン幅になり差が伝わらないため、
// 3グループ共通の固定スケールを使う（全体平均 約13.8% に余白を持たせた上限）。
const SURPRISE_SCALE_MAX = 25;

function renderSurpriseGroup(containerId, rows) {
  const container = document.getElementById(containerId);

  const values = rows.map((r) => r.avgOccupancyPct || 0);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const diff = document.createElement('p');
  diff.className = 'analysis-section__note';
  diff.textContent = `最大と最小の差: ${(max - min).toFixed(2)}ポイント`;
  container.appendChild(diff);

  for (const r of rows) {
    container.appendChild(
      buildBarRow(r.key, r.avgOccupancyPct || 0, SURPRISE_SCALE_MAX, `${fixed(r.avgOccupancyPct)}%（n=${r.count}）`)
    );
  }
}

function renderSurprise(surprises) {
  renderSurpriseGroup('surprise-weekday', surprises.byWeekdayType);
  renderSurpriseGroup('surprise-hour', surprises.byHourBand);
  renderSurpriseGroup('surprise-late', surprises.byLateShow);
}

// ---------- 映画別プロフィール ----------

function fillTable(table, rows) {
  table.textContent = '';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  rows[0].forEach((h) => {
    const th = document.createElement('th');
    th.textContent = h;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const row of rows.slice(1)) {
    const tr = document.createElement('tr');
    row.forEach((cell) => {
      const td = document.createElement('td');
      td.textContent = cell;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
}

function renderMovies(movies) {
  const select = document.getElementById('movie-select');
  select.textContent = '';
  for (const m of movies) {
    const opt = document.createElement('option');
    opt.value = m.movieId;
    opt.textContent = `${m.title}（${m.showCount}回 / 平均${fixed(m.avgOccupancyPct, 1)}%）`;
    select.appendChild(opt);
  }

  const byId = new Map(movies.map((m) => [m.movieId, m]));

  function renderSelected() {
    const m = byId.get(select.value);
    if (!m) return;
    const dl = document.getElementById('movie-stats');
    dl.textContent = '';
    addStat(dl, '上映回数', `${m.showCount}回`);
    addStat(dl, '平均混雑率', pct(m.avgOccupancyPct));
    addStat(dl, '最低混雑率', pct(m.minOccupancyPct));
    addStat(dl, '最高混雑率', pct(m.maxOccupancyPct));
    addStat(dl, '混雑率の幅', `${fixed(m.rangeOccupancyPct, 1)}ポイント`);
    addStat(dl, 'ジャンル', m.genre || '-');

    const table = document.getElementById('movie-screen-table');
    fillTable(table, [
      ['スクリーン', '上映回数', '平均混雑率'],
      ...m.screens.map((s) => [`シアター${s.screenId}`, `${s.count}回`, pct(s.avgOccupancyPct)]),
    ]);
  }

  select.addEventListener('change', renderSelected);
  if (movies.length > 0) {
    select.value = movies[0].movieId;
    renderSelected();
  }

  const varianceTop = movies
    .filter((m) => m.showCount >= 5)
    .slice()
    .sort((a, b) => b.rangeOccupancyPct - a.rangeOccupancyPct)
    .slice(0, 5);
  fillTable(document.getElementById('movie-variance-table'), [
    ['作品名', '上映回数', '最低〜最高', '幅'],
    ...varianceTop.map((m) => [
      m.title,
      `${m.showCount}回`,
      `${pct(m.minOccupancyPct)} 〜 ${pct(m.maxOccupancyPct)}`,
      `${fixed(m.rangeOccupancyPct, 1)}pt`,
    ]),
  ]);
}

// ---------- スクリーン別プロフィール ----------

function renderScreens(screens) {
  const table = document.getElementById('screen-table');
  fillTable(table, [
    ['スクリーン', '定員', '平均混雑率', '平均販売席数', '音響', '仕様'],
    ...screens.map((s) => [
      s.screenName || `シアター${s.screenId}`,
      `${s.capacity}席`,
      pct(s.avgOccupancyPct),
      `${fixed(s.avgSoldSeats, 1)}席`,
      s.soundSystem || '-',
      s.equipment || '-',
    ]),
  ]);
}

// ---------- 映画館データ ----------

function renderStaff(staff) {
  const isolated = staff.isolatedSummary;
  const dl = document.getElementById('isolated-stats');
  addStat(dl, '孤立空席が発生した上映', `${isolated.showingsWithIsolatedSeat}/${isolated.totalConsidered}件`);
  addStat(dl, '発生割合', `${(isolated.shareOfShowingsWithIsolatedSeat * 100).toFixed(1)}%`);

  fillTable(document.getElementById('isolated-band-table'), [
    ['混雑率帯', '該当上映数', '平均孤立空席率'],
    ...isolated.byOccupancyBand.map((b) => [b.band, `${b.count}件`, pct(b.avgIsolatedRate)]),
  ]);
}

async function init() {
  try {
    const { validation, movies, screens, staff } = await loadAnalyticsData();

    renderValidation(validation);
    reveal('section-validation');

    renderSurprise(staff.surprises);
    reveal('section-surprise');

    renderMovies(movies);
    reveal('section-movies');

    renderScreens(screens);
    reveal('section-screens');

    renderStaff(staff);
    reveal('section-staff');
  } catch (err) {
    console.error('[分析ページ] データ読み込み失敗:', err);
    showError();
  }
}

init();
