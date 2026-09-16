/**
 * 座席マップ / 孤立空席率のデータ読み込み。
 *
 * derived/analytics/seat-layout.json (スクリーンの座席配置, 数十KB) と
 * derived/analytics/seatmaps.json (上映ごとの座席状態, 数MB) は、
 * トップ画面の初期表示では取得しない。カードの「座席の状況を見る」が
 * 最初に開かれたときに1回だけ取得し、以降はメモリにキャッシュして使い回す。
 *
 * ここでは座席の個別人気（どの座席がよく売れるか）は一切扱わない。
 * 扱うのは「その上映で今どの座席が売れている/空いている/孤立空席か」という
 * その上映限りの状態だけ。
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

/**
 * 1上映分の座席マップ情報を組み立てる。実績データが無い上映 (未来の上映予定) は null。
 * @param {{layouts:object, seatmaps:object}} data loadSeatMapData() の戻り値
 * @param {string} showingId
 * @param {string} screenId
 */
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
