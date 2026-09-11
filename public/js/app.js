/**
 * 画面の状態管理とイベント配線。
 *
 * 予測値は derived/ui-showings.json（STEP 5 の予測エンジンが生成）を表示するだけ。
 * ここで混雑率・空いている判定を計算することはない。
 */

import {
  loadUiData,
  buildResultView,
  shiftDate,
  TIME_BANDS,
  SORT_MODES,
} from './data.js';
import { renderChips, renderCards, showStatus, hideStatus } from './render.js';

const el = {
  dateInput: document.getElementById('date-input'),
  dateNote: document.getElementById('date-note'),
  prevDay: document.getElementById('prev-day'),
  nextDay: document.getElementById('next-day'),
  bandChips: document.getElementById('band-chips'),
  sortChips: document.getElementById('sort-chips'),
  resultsTitle: document.getElementById('results-heading'),
  summary: document.getElementById('summary'),
  status: document.getElementById('status'),
  cards: document.getElementById('cards'),
  footerDetail: document.getElementById('footer-detail'),
};

const state = {
  data: null,
  dates: [],
  date: null,
  bandId: 'all',
  sortId: 'vacancy',
};

/** 初期表示する日付。データ範囲内なら検証期間の初日を既定にする。 */
function pickInitialDate(dates) {
  const preferred = '2025-10-01';
  return dates.includes(preferred) ? preferred : dates[0];
}

function dateMin() {
  return state.dates[0];
}
function dateMax() {
  return state.dates[state.dates.length - 1];
}

function updateDateControls() {
  el.dateInput.value = state.date;
  el.dateInput.min = dateMin();
  el.dateInput.max = dateMax();
  // 前日/翌日はデータ範囲の端で無効化する（日付演算で判定）
  el.prevDay.disabled = shiftDate(state.date, -1) < dateMin();
  el.nextDay.disabled = shiftDate(state.date, 1) > dateMax();
  el.dateNote.textContent = `（データ範囲 ${dateMin()} 〜 ${dateMax()}）`;
}

function render() {
  // 読み込み完了前にチップが押された場合は何もしない
  if (!state.data || !state.date) return;

  updateDateControls();

  // 処理順: 全上映 → 日付 → 時間帯 → 並び替え → 表示
  const view = buildResultView(state.data, {
    date: state.date,
    bandId: state.bandId,
    sortId: state.sortId,
  });

  el.resultsTitle.textContent = `上映一覧（${view.sortLabel}）`;

  if (view.state === 'no-date-data') {
    el.cards.textContent = '';
    el.summary.textContent = `${view.dateLabel}・上映データがありません`;
    showStatus(el.status, {
      title: 'この日の上映データがありません',
      body: 'データがある日付（2025年）を選んでください。',
    });
    return;
  }

  const { total, vacant } = view.summary;

  if (view.state === 'empty-band') {
    el.cards.textContent = '';
    el.summary.textContent = `${view.dateLabel}・${view.bandLabel}の上映 0件`;
    showStatus(el.status, {
      title: '該当する上映がありません',
      body: '時間帯を「すべて」に戻すか、別の日付を選んでみてください。',
    });
    return;
  }

  hideStatus(el.status);
  // 母数はフィルター適用後（いま表示している上映）
  el.summary.textContent =
    state.bandId === 'all'
      ? `${view.dateLabel}・全${total}上映のうち${vacant}件が空いている見込み`
      : `${view.dateLabel}・${view.bandLabel}の上映 ${total}件／そのうち空いている見込み ${vacant}件`;

  renderCards(el.cards, view.showings);
}

function setDate(next) {
  const min = dateMin();
  const max = dateMax();
  if (!next || !/^\d{4}-\d{2}-\d{2}$/.test(next)) {
    // 無効な入力は無視して現在の日付に戻す
    el.dateInput.value = state.date;
    return;
  }
  // データ範囲外はいちばん近い端に寄せる
  state.date = next < min ? min : next > max ? max : next;
  render();
}

function stepDate(delta) {
  const candidate = shiftDate(state.date, delta);
  if (candidate < dateMin() || candidate > dateMax()) return; // 範囲外は何もしない
  setDate(candidate);
}

function describeError(code) {
  switch (code) {
    case 'NOT_BUILT':
      return {
        title: '予測データが見つかりません',
        body:
          'プロジェクト直下で `npm run build:aggregates` → `npm run build:ui` を実行して、' +
          'derived/ui-showings.json を生成してください。',
      };
    case 'NETWORK':
      return {
        title: 'データを読み込めませんでした',
        body:
          'ファイルを直接開くと読み込みに失敗します。`npm run dev` で開発サーバーを起動し、' +
          'http://localhost:5173 を開いてください。',
      };
    case 'PARSE':
    case 'SHAPE':
      return {
        title: '予測データの形式が正しくありません',
        body: '`npm run build:ui` を再実行して、データを作り直してください。',
      };
    default:
      return {
        title: 'データを読み込めませんでした',
        body: '`npm run dev` でサーバーを起動しているか確認してください。',
      };
  }
}

async function init() {
  // チップは先に描画しておく（読み込み失敗時も操作系が消えないように）
  renderChips(el.bandChips, TIME_BANDS, state.bandId, onBandSelect);
  renderChips(el.sortChips, SORT_MODES, state.sortId, onSortSelect);

  showStatus(el.status, { title: '予測データを読み込んでいます…' });

  let data;
  try {
    data = await loadUiData();
  } catch (err) {
    showStatus(el.status, { ...describeError(err.message), isError: true });
    el.summary.textContent = '';
    console.error('[AI 空いてる映画] データ読み込み失敗:', err);
    return;
  }

  state.data = data;
  state.dates = Array.isArray(data.meta.dates) ? data.meta.dates : Object.keys(data.days).sort();

  if (state.dates.length === 0) {
    showStatus(el.status, {
      title: '上映データが空です',
      body: '`npm run build:ui` でデータを生成してください。',
      isError: true,
    });
    return;
  }

  state.date = pickInitialDate(state.dates);

  const tw = data.meta.trainingWindow;
  el.footerDetail.textContent =
    `予測は ${tw?.start ?? '-'} 〜 ${tw?.end ?? '-'} の上映実績（作品×スクリーンの平均混雑率、` +
    `実績がない場合はスクリーンの平均混雑率）にもとづく推定です。` +
    `混雑率 = 販売座席数 ÷ スクリーン座席数 × 100。`;

  el.dateInput.addEventListener('change', () => setDate(el.dateInput.value));
  el.prevDay.addEventListener('click', () => stepDate(-1));
  el.nextDay.addEventListener('click', () => stepDate(1));

  render();
}

function onBandSelect(id) {
  state.bandId = id;
  renderChips(el.bandChips, TIME_BANDS, state.bandId, onBandSelect);
  render();
}

function onSortSelect(id) {
  state.sortId = id;
  renderChips(el.sortChips, SORT_MODES, state.sortId, onSortSelect);
  render();
}

// 想定外の例外でも画面が真っ白にならないようにする
init().catch((err) => {
  console.error('[AI 空いてる映画] 初期化に失敗:', err);
  showStatus(el.status, {
    title: '画面の初期化に失敗しました',
    body: 'ページを再読み込みしてください。',
    isError: true,
  });
});
