/**
 * 座席マップ / 孤立空席率のデータ読み込み。
 * derived/analytics/{seat-layout,seatmaps}.json はトップ画面では取得せず、
 * カードの「座席の状況を見る」が最初に開かれたときに1回だけ取得してキャッシュする。
 */

let loadPromise = null;

function fetchJson(url) {
  return fetch(url, { cache: 'no-cache' }).then((res) => {
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    return res.json();
  });
}

/** 座席レイアウト + 座席マップをまとめて取得する (呼び出し側からは1回だけ実行される想定)。 */
export function loadSeatMapData() {
  if (!loadPromise) {
    loadPromise = Promise.all([
      fetchJson('/derived/analytics/seat-layout.json'),
      fetchJson('/derived/analytics/seatmaps.json'),
    ]).then(([layouts, seatmaps]) => ({ layouts, seatmaps }));
  }
  return loadPromise;
}

/** 1上映分の座席マップ情報を組み立てる。実績データが無い上映（未来の上映予定）は null。 */
export function getSeatMapFor(data, showingId, screenId) {
  const entry = data.seatmaps[showingId];
  const layout = data.layouts[String(screenId)];
  if (!entry || !layout) return null;

  const states = entry.c;
  const seats = layout.order.map((seatId, i) => ({ seatId, state: decodeState(states[i]) }));

  return {
    seats,
    rows: layout.rows,
    isolatedRatePct: entry.i,
    emptyCount: entry.e,
    soldCount: entry.so,
  };
}

function decodeState(code) {
  if (code === 'S') return 'sold';
  if (code === 'I') return 'isolated';
  return 'empty';
}
