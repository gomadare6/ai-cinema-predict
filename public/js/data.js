/**
 * UI 配信データの読み込みと整形。
 *
 * 重要: 予測混雑率・isVacant・空いている順の順位は、すべて Node 側の
 * STEP 5 予測エンジン (src/predictor.js) が算出した値をそのまま使う。
 * このファイルで混雑率や 10% 判定を計算してはいけない。
 */

/** 開発サーバー (scripts/serve.js) はプロジェクトルートを配信するので絶対パスで引く。 */
const DATA_URL = '/derived/ui-showings.json';

/** JSON の行配列 → 意味のあるプロパティ名に変換するための列順 (build-ui-data.js と対応) */
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
  isFuture: 11,
  confidenceCode: 12,
};

/** 予測根拠 (内部コード) → ユーザー向け文言。内部値はそのまま画面に出さない。 */
const SOURCE_TEXT = {
  w: { label: '過去の上映実績あり', kind: 'actual' },
  s: { label: '参考値：スクリーンの過去実績から予測', kind: 'fallback' },
  g: { label: '参考値：劇場全体の過去実績から予測', kind: 'fallback' },
};

/**
 * confidence (内部コード) → ユーザー向け文言。
 * 「予測精度そのもの」と誤解されないよう、常に「過去実績の量に基づく参考度」という
 * 文脈をセットで表示する (render.js 側の title/aria-label でも明示する)。
 */
const CONFIDENCE_TEXT = {
  h: '高',
  m: '中',
  l: '低',
};

/**
 * 予測根拠を「作品×スクリーンの過去12回を参考」のような具体的な文章にする。
 * sourceCode と trainingShowCount は既に JSON にあるので、ここでは新しい判定はせず
 * 文字列の組み立てだけを行う (10%判定・ランキングと同じく、値そのものの計算はしない)。
 */
function buildBasisDetail(sourceCode, trainingShowCount) {
  if (sourceCode === 'w') return `作品×スクリーンの過去${trainingShowCount}回を参考`;
  if (sourceCode === 's') return `スクリーンの過去${trainingShowCount}回を参考`;
  return '全体平均を参考';
}

/** 「予測の根拠」詳細欄の予測方法ラベル (内部コードを出さず自然な日本語にする)。 */
const BASIS_METHOD_TEXT = {
  w: '作品 × スクリーンの過去実績',
  s: 'スクリーンの過去実績',
  g: '全上映の過去実績',
};

/** predictionBasis ごとの自然な説明文 (【3. predictionBasisごとの文章】)。内部コードは出さない。 */
const BASIS_SENTENCE_TEXT = {
  w: '過去の同じ作品・スクリーンの上映実績をもとに予測しています。',
  s: '同じスクリーンの過去上映実績をもとに予測しています。',
  g: '全上映の過去実績をもとに予測しています。',
};

/**
 * カードに常時表示する短い説明文 (【1. 上映カードに「おすすめ理由」を追加】)。
 * データから言えないことは断定しない。sourceCode / isVacant は既に判定済みの値を使うだけで、
 * ここで新しい統計判定は行わない。
 */
function buildReason(sourceCode, isVacant) {
  if (sourceCode === 'w') {
    return isVacant
      ? '過去の同作品・同スクリーンでは比較的空いている傾向があります。'
      : '過去の同作品・同スクリーンの上映実績をもとに予測しています。';
  }
  if (sourceCode === 's') {
    return '同作品・同スクリーンの履歴がないため、スクリーンの過去実績をもとに予測しています。';
  }
  return '利用できるスクリーン履歴がないため、全体の過去実績をもとに予測しています。';
}

/** 時間帯フィルタの定義 (開始時刻の「時」で判定) */
export const TIME_BANDS = [
  { id: 'all', label: 'すべて', match: () => true },
  { id: 'morning', label: '午前', hint: '〜11:59', match: (h) => h < 12 },
  { id: 'afternoon', label: '午後', hint: '12:00〜16:59', match: (h) => h >= 12 && h < 17 },
  { id: 'evening', label: '夕方', hint: '17:00〜19:59', match: (h) => h >= 17 && h < 20 },
  { id: 'night', label: '夜', hint: '20:00〜', match: (h) => h >= 20 },
];

export const SORT_MODES = [
  { id: 'vacancy', label: '空いている順' },
  { id: 'time', label: '上映時間順' },
];

/**
 * 配信データを取得する。
 * @returns {Promise<{ meta: object, titles: string[], days: Record<string, Array[]> }>}
 */
export async function loadUiData() {
  let res;
  try {
    res = await fetch(DATA_URL, { cache: 'no-cache' });
  } catch (cause) {
    throw new Error('NETWORK', { cause });
  }
  if (!res.ok) {
    throw new Error(res.status === 404 ? 'NOT_BUILT' : `HTTP_${res.status}`);
  }

  let json;
  try {
    json = await res.json();
  } catch (cause) {
    throw new Error('PARSE', { cause });
  }
  if (!json || !json.meta || !json.days || !Array.isArray(json.titles)) {
    throw new Error('SHAPE');
  }
  return json;
}

/**
 * 指定日の上映を、表示しやすいオブジェクト配列に変換する。
 * @param {object} data loadUiData() の戻り値
 * @param {string} date "YYYY-MM-DD"
 * @returns {Array<object>}
 */
export function getShowingsForDate(data, date) {
  const rows = data.days[date];
  if (!Array.isArray(rows)) return [];

  return rows.map((row) => {
    const screenId = String(row[COL.screenId]);
    const screen = data.meta.screens?.[screenId];
    const source = SOURCE_TEXT[row[COL.sourceCode]] ?? {
      label: '参考値',
      kind: 'fallback',
    };

    return {
      showingId: row[COL.showingId],
      title: data.titles[row[COL.titleId]] ?? '(作品名不明)',
      screenId,
      screenName: screen?.name ?? `スクリーン${screenId}`,
      startTime: row[COL.startTime],
      endTime: row[COL.endTime],
      seatCapacity: row[COL.seatCapacity],

      // STEP 5 の予測結果 (再計算しない)
      predictedPct: row[COL.predictedPct],
      isVacant: row[COL.isVacant] === 1,
      vacancyRank: row[COL.vacancyRank],
      trainingShowCount: row[COL.trainingShowCount],
      // 未来の上映予定 (data/future_showings.csv 由来) かどうか。過去実績と混同させない表示に使う。
      isFuture: row[COL.isFuture] === 1,

      confidenceLabel: source.label,
      confidenceKind: source.kind, // 'actual' | 'fallback'

      // --- STEP 9: 説明可能性の追加項目 (既存フィールドは変更せず追加のみ) ---
      historyCount: row[COL.trainingShowCount], // trainingShowCount の別名 (未来上映の文脈での呼び名)
      confidence: CONFIDENCE_TEXT[row[COL.confidenceCode]] ?? '低', // '高' | '中' | '低' (過去実績の量に基づく参考度。予測精度ではない)
      predictionBasisDetail: buildBasisDetail(row[COL.sourceCode], row[COL.trainingShowCount]),

      // --- UIアップデート: 予測根拠・おすすめ理由の追加 (既存フィールドは変更せず追加のみ) ---
      reason: buildReason(row[COL.sourceCode], row[COL.isVacant] === 1),
      basisMethodLabel: BASIS_METHOD_TEXT[row[COL.sourceCode]] ?? '全上映の過去実績',
      basisSentence: BASIS_SENTENCE_TEXT[row[COL.sourceCode]] ?? BASIS_SENTENCE_TEXT.g,
    };
  });
}

/** 時間帯で絞り込む。 */
export function filterByBand(showings, bandId) {
  const band = TIME_BANDS.find((b) => b.id === bandId) ?? TIME_BANDS[0];
  return showings.filter((s) => band.match(Number(String(s.startTime).slice(0, 2))));
}

/**
 * 並び替える。どちらも決定的（入力順に依存しない）。
 * - 'vacancy': STEP 5 が付与した vacancyRank の昇順
 *              (= 予測混雑率 昇順 → 上映日時 昇順 → 上映ID 昇順)。
 * - 'time'   : 上映開始時刻の昇順。同じ開始時刻は 上映ID 昇順。
 * いずれも最後に 上映ID でタイブレークして完全に一意にする。
 */
export function sortShowings(showings, sortId) {
  const list = showings.slice();
  if (sortId === 'time') {
    list.sort(
      (a, b) =>
        String(a.startTime).localeCompare(String(b.startTime)) ||
        String(a.showingId).localeCompare(String(b.showingId))
    );
  } else {
    list.sort(
      (a, b) =>
        a.vacancyRank - b.vacancyRank ||
        String(a.showingId).localeCompare(String(b.showingId))
    );
  }
  return list;
}

/** 表示対象の上映から件数サマリを作る。母数は渡された配列そのもの。 */
export function summarize(showings) {
  return {
    total: showings.length,
    vacant: showings.filter((s) => s.isVacant).length,
  };
}

/**
 * 「日付 → 時間帯 → 並び替え」を1回にまとめ、画面表示に必要な情報を返す。
 * 予測値 (predictedPct / isVacant / vacancyRank) は data のものをそのまま使う。
 *
 * @param {object} data loadUiData() の戻り値
 * @param {{ date: string, bandId: string, sortId: string }} conditions
 * @returns {{
 *   dateLabel: string, bandLabel: string, sortLabel: string,
 *   showings: Array<object>, summary: { total: number, vacant: number },
 *   dayTotal: number,
 *   state: 'ok' | 'empty-band' | 'no-date-data',
 * }}
 */
export function buildResultView(data, { date, bandId, sortId }) {
  const dateLabel = formatDateLabel(date);
  const bandLabel = (TIME_BANDS.find((b) => b.id === bandId) ?? TIME_BANDS[0]).label;
  const sortLabel = (SORT_MODES.find((m) => m.id === sortId) ?? SORT_MODES[0]).label;

  // 1) 日付で絞り込み
  const dayShowings = getShowingsForDate(data, date);
  if (dayShowings.length === 0) {
    return {
      dateLabel, bandLabel, sortLabel,
      showings: [], summary: { total: 0, vacant: 0 }, dayTotal: 0,
      state: 'no-date-data',
    };
  }

  // 2) 時間帯で絞り込み
  const inBand = filterByBand(dayShowings, bandId);

  // 絞り込み後の集合における「空いている順」の順位を付ける。
  // STEP 5 の vacancyRank（その日全体での順位）はそのまま保持し、別項目として持つ。
  // 予測値の再計算はしておらず、既存の predictedPct / vacancyRank で並べているだけ。
  const vacancyOrder = inBand
    .slice()
    .sort((a, b) => a.predictedPct - b.predictedPct || a.vacancyRank - b.vacancyRank);
  const viewRankById = new Map(vacancyOrder.map((s, i) => [s.showingId, i + 1]));

  // 表示中の条件でいちばん空いている見込みの1件（2件以上あるときだけ意味を持つ）
  const topPickId = vacancyOrder.length >= 2 ? vacancyOrder[0].showingId : null;

  const annotated = inBand.map((s) => ({
    ...s,
    viewRank: viewRankById.get(s.showingId),
    isTopPick: s.showingId === topPickId,
  }));

  // 3) 並び替え
  const showings = sortShowings(annotated, sortId);

  return {
    dateLabel, bandLabel, sortLabel,
    showings,
    summary: summarize(inBand), // 母数 = いま表示対象になっている上映だけ
    dayTotal: dayShowings.length,
    topPickId,
    state: showings.length === 0 ? 'empty-band' : 'ok',
  };
}

/** "2025-10-01" → "2025年10月1日（水）" */
export function formatDateLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const wd = ['日', '月', '火', '水', '木', '金', '土'][new Date(y, m - 1, d).getDay()];
  return `${y}年${m}月${d}日（${wd}）`;
}

/**
 * 日付文字列を deltaDays 日ずらす。月末・月初・年末年始をまたいでも正しい。
 * UTC 基準で計算して DST の影響を受けないようにする。
 * "2025-10-01" 前1日 → "2025-09-30" / "2025-12-31" 後1日 → "2026-01-01"
 * @param {string} dateStr "YYYY-MM-DD"
 * @param {number} deltaDays
 * @returns {string} "YYYY-MM-DD"
 */
export function shiftDate(dateStr, deltaDays) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
