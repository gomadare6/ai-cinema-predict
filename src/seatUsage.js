'use strict';

/**
 * 1上映の座席配置＋販売済み座席ID集合から、空席の利用しやすさを判定する。
 *
 * 孤立空席の定義: 同じ区画（通路で区切られたひとまとまり）内で、両隣を販売済み座席に
 * 挟まれた「1席だけの空席」。区画の端（片側にしか隣席が無い空席）は含めない。
 */
function computeSeatUsage(layout, soldSeatIdSet) {
  const seatStates = [];
  let totalSeats = 0;
  let soldCount = 0;
  let isolatedCount = 0;

  for (const r of layout.rows) {
    for (const seg of r.segments) {
      const states = seg.map((seat) => (soldSeatIdSet.has(seat.seatId) ? 'sold' : 'empty'));
      for (let i = 0; i < seg.length; i++) {
        if (states[i] !== 'empty') continue;
        const prevSold = i > 0 && states[i - 1] === 'sold';
        const nextSold = i < seg.length - 1 && states[i + 1] === 'sold';
        const hasPrev = i > 0;
        const hasNext = i < seg.length - 1;
        // 孤立: 両隣が存在し、両方とも売れている（区画の端は対象外）
        if (hasPrev && hasNext && prevSold && nextSold) {
          states[i] = 'isolated';
        }
      }
      for (let i = 0; i < seg.length; i++) {
        totalSeats++;
        if (states[i] === 'sold') soldCount++;
        if (states[i] === 'isolated') isolatedCount++;
        seatStates.push({ seatId: seg[i].seatId, state: states[i] });
      }
    }
  }

  const emptyCount = totalSeats - soldCount;
  const isolatedRate = emptyCount > 0 ? (isolatedCount / emptyCount) * 100 : 0;
  const occupancyPct = totalSeats > 0 ? (soldCount / totalSeats) * 100 : 0;

  return { totalSeats, soldCount, emptyCount, isolatedCount, isolatedRate, occupancyPct, seatStates };
}

/** seatStates を表示用の1文字コードに圧縮する ('S'=販売済み, 'E'=空席, 'I'=孤立空席)。 */
function compactStates(seatStates) {
  const code = { sold: 'S', empty: 'E', isolated: 'I' };
  return seatStates.map((s) => code[s.state]).join('');
}

module.exports = { computeSeatUsage, compactStates };
