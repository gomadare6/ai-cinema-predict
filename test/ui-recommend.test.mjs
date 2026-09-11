/**
 * STEP 8: 「空いている上映」を選びやすくする推薦・ランキングUIの検証。
 *
 * 実データ (derived/ui-showings.json) を使い、
 *   - 空いている順のランキングが維持されているか
 *   - 最上位（この条件で最も空いている見込み）が正しく1件だけ決まるか
 *   - isVacant / 実績あり / 参考値 の表示が正しいか
 *   - 予測値を UI 層が改変していないか
 * を確認する。予測アルゴリズムそのものは検証しない。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildResultView, getShowingsForDate } from '../public/js/data.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'derived', 'ui-showings.json'), 'utf8'));

const COL = { showingId: 0, startTime: 3, predictedPct: 6, sourceCode: 7, trainingShowCount: 8, isVacant: 9, vacancyRank: 10 };
const DATES = ['2025-10-01', '2025-10-02', '2025-12-31'];
const cond = (date, bandId = 'all', sortId = 'vacancy') => ({ date, bandId, sortId });

// ---------- DOM スタブ（render.js をブラウザなしで動かす） ----------

class FakeNode {
  constructor(tag = '#fragment') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attrs = {};
    this.style = {};
    this._text = '';
    this.className = '';
    this.title = '';
    this.hidden = false;
  }
  appendChild(c) {
    if (c.tagName === '#FRAGMENT') this.children.push(...c.children);
    else this.children.push(c);
    return c;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return this.attrs[k];
  }
  addEventListener() {}
  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }
  get textContent() {
    return this.children.length
      ? this._text + this.children.map((c) => c.textContent).join('')
      : this._text;
  }
  hasClass(cls) {
    return String(this.className).split(/\s+/).includes(cls);
  }
  find(cls) {
    for (const c of this.children) {
      if (c.hasClass(cls)) return c;
      const hit = c.find(cls);
      if (hit) return hit;
    }
    return null;
  }
}

globalThis.document ??= {
  createElement: (t) => new FakeNode(t),
  createDocumentFragment: () => new FakeNode('#fragment'),
  createTextNode: (t) => {
    const n = new FakeNode('#text');
    n._text = String(t);
    return n;
  },
};

const { renderCards } = await import('../public/js/render.js');

/** 上映配列をカード描画して <li> 配列を返す */
function draw(showings) {
  const ul = new FakeNode('ul');
  renderCards(ul, showings);
  return ul.children;
}

// ---------------------------------------------------------------------------
// テスト1: 空いている順の順位が維持される
// ---------------------------------------------------------------------------
test('テスト1: 空いている順の順位が維持される（予測混雑率 昇順・viewRank 連番）', () => {
  for (const date of DATES) {
    const list = buildResultView(data, cond(date, 'all', 'vacancy')).showings;

    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i - 1].predictedPct <= list[i].predictedPct, `${date}: 予測混雑率が昇順`);
    }
    assert.deepEqual(
      list.map((s) => s.viewRank),
      list.map((_, i) => i + 1),
      '表示順位が 1..n の連番'
    );
    // 絞り込みなし（すべて）のときは STEP 5 の vacancyRank と一致する
    assert.deepEqual(
      list.map((s) => s.viewRank),
      list.map((s) => s.vacancyRank),
      'band=all では viewRank === vacancyRank'
    );
  }
});

// ---------------------------------------------------------------------------
// テスト2: 最上位が最も予測混雑率の低い上映になる
// ---------------------------------------------------------------------------
test('テスト2: 最上位（isTopPick）が最も予測混雑率の低い上映1件だけになる', () => {
  for (const date of DATES) {
    for (const band of ['all', 'morning', 'evening', 'night']) {
      const view = buildResultView(data, cond(date, band, 'vacancy'));
      const list = view.showings;
      const tops = list.filter((s) => s.isTopPick);

      assert.equal(tops.length, 1, `${date}/${band}: 最上位は必ず1件`);
      const minPct = Math.min(...list.map((s) => s.predictedPct));
      assert.equal(tops[0].predictedPct, minPct, '最上位の予測混雑率が最小');
      assert.equal(tops[0].viewRank, 1, '最上位の表示順位は1位');
      assert.equal(tops[0].showingId, view.topPickId);
    }
  }
});

test('テスト2b: 並び順を上映時間順にしても最上位は同じ上映のまま', () => {
  const byVacancy = buildResultView(data, cond('2025-10-01', 'evening', 'vacancy'));
  const byTime = buildResultView(data, cond('2025-10-01', 'evening', 'time'));

  assert.equal(byTime.topPickId, byVacancy.topPickId);
  const top = byTime.showings.filter((s) => s.isTopPick);
  assert.equal(top.length, 1);
  assert.equal(top[0].viewRank, 1, '並び順が違っても順位1位のまま');
  // 上映時間順では 1位のカードが先頭に来るとは限らない
  assert.equal(byTime.showings.filter((s) => s.isTopPick).length, 1);
});

test('テスト2c: 最上位カードだけ card--top と見出しが付く', () => {
  const list = buildResultView(data, cond('2025-10-01', 'all', 'vacancy')).showings;
  const cards = draw(list);

  const topCards = cards.filter((c) => c.hasClass('card--top'));
  assert.equal(topCards.length, 1, 'card--top は1枚だけ');
  assert.equal(topCards[0].find('card__top-note').textContent, 'この条件で最も空いている見込み');

  // 2枚目以降には付かない
  const others = cards.filter((c) => !c.hasClass('card--top'));
  assert.equal(others.length, list.length - 1);
  for (const c of others) assert.equal(c.find('card__top-note'), null);
});

test('テスト2d: 1件しか該当しないときは最上位強調をしない', () => {
  const synthetic = {
    meta: { screens: { 1: { name: 'シアター1', capacity: 100 } } },
    titles: ['サンプル作品'],
    days: {
      '2025-10-05': [['S99001', 0, '1', '09:30', '11:30', 100, 8.0, 'w', 10, 1, 1]],
    },
  };
  const view = buildResultView(synthetic, cond('2025-10-05', 'all'));
  assert.equal(view.showings.length, 1);
  assert.equal(view.topPickId, null);
  assert.equal(view.showings[0].isTopPick, false);
  assert.equal(draw(view.showings)[0].find('card__top-note'), null);
});

// ---------------------------------------------------------------------------
// テスト3: isVacant の表示が正しい
// ---------------------------------------------------------------------------
test('テスト3: isVacant=true にだけ「空いている可能性が高い」が付く', () => {
  const date = '2025-10-01';
  const list = buildResultView(data, cond(date, 'all', 'vacancy')).showings;
  const cards = draw(list);

  const rawVacant = data.days[date].filter((r) => r[COL.isVacant] === 1).length;
  const badged = cards.filter((c) => c.find('badge--vacant') !== null);
  assert.equal(badged.length, rawVacant, 'バッジ数 = JSON の isVacant=1 の件数');

  list.forEach((s, i) => {
    const badge = cards[i].find('badge--vacant');
    if (s.isVacant) {
      assert.equal(badge.textContent, '空いている可能性が高い');
      assert.ok(cards[i].hasClass('card--vacant'));
    } else {
      // 混雑していると断定するバッジや文言を付けない
      assert.equal(badge, null);
      assert.equal(cards[i].hasClass('card--vacant'), false);
      assert.doesNotMatch(cards[i].textContent, /混雑しています|満席|混んでいます/);
    }
  });
});

test('テスト3b: 断定表現・おすすめ表現を使っていない', () => {
  const list = buildResultView(data, cond('2025-10-01', 'all', 'vacancy')).showings;
  const text = draw(list)
    .map((c) => c.textContent)
    .join(' ');

  for (const forbidden of [
    '空席あり',
    '必ず',
    '確実',
    '保証',
    'おすすめ',
    'AIが判断',
    'AI分析済み',
    '高精度',
  ]) {
    assert.doesNotMatch(text, new RegExp(forbidden), `「${forbidden}」を使わない`);
  }
  assert.match(text, /予測混雑率/);
  assert.match(text, /空いている可能性が高い/);
});

// ---------------------------------------------------------------------------
// テスト4 / テスト5 / テスト6: 実績あり・参考値・trainingShowCount
// ---------------------------------------------------------------------------
test('テスト4: 実績ありの上映は「過去の上映実績あり（n回）」と表示される', () => {
  const date = '2025-10-01';
  const rawById = new Map(data.days[date].map((r) => [r[COL.showingId], r]));
  const list = buildResultView(data, cond(date, 'all', 'vacancy')).showings;
  const cards = draw(list);

  let checked = 0;
  list.forEach((s, i) => {
    if (s.confidenceKind !== 'actual') return;
    const raw = rawById.get(s.showingId);
    assert.equal(raw[COL.sourceCode], 'w', 'JSON 側も作品×スクリーン実績');

    const badge = cards[i].find('badge--actual');
    assert.ok(badge, '実績ありバッジが付く');
    assert.equal(badge.textContent, `過去の上映実績あり（${raw[COL.trainingShowCount]}回）`);
    assert.equal(cards[i].find('badge--fallback'), null, '参考値バッジは付かない');
    checked++;
  });
  assert.ok(checked > 0, '実績ありの上映が存在する');
});

test('テスト5: フォールバックは「参考値：」で、実績ありと同じ見た目にしない', () => {
  const date = '2025-10-01';
  const rawById = new Map(data.days[date].map((r) => [r[COL.showingId], r]));
  const list = buildResultView(data, cond(date, 'all', 'vacancy')).showings;
  const cards = draw(list);

  let checked = 0;
  list.forEach((s, i) => {
    if (s.confidenceKind !== 'fallback') return;
    const raw = rawById.get(s.showingId);
    assert.ok(['s', 'g'].includes(raw[COL.sourceCode]));

    const badge = cards[i].find('badge--fallback');
    assert.ok(badge, '参考値バッジ（点線・淡色）が付く');
    assert.match(badge.textContent, /^参考値：/);
    assert.doesNotMatch(badge.textContent, /実績あり/);
    assert.equal(cards[i].find('badge--actual'), null, '実績ありバッジは付かない');
    // 精度を保証するような表現を使わない
    for (const bad of ['AI分析済み', '高精度', '確実']) {
      assert.doesNotMatch(cards[i].textContent, new RegExp(bad));
    }
    checked++;
  });
  assert.ok(checked > 0, 'フォールバックの上映が存在する');
});

test('テスト6: trainingShowCount は実績ありのみ回数表示され、精度を断定しない', () => {
  const date = '2025-10-02';
  const rawById = new Map(data.days[date].map((r) => [r[COL.showingId], r]));
  const list = buildResultView(data, cond(date, 'all', 'vacancy')).showings;
  const cards = draw(list);

  list.forEach((s, i) => {
    const raw = rawById.get(s.showingId);
    assert.equal(s.trainingShowCount, raw[COL.trainingShowCount], 'JSON の値をそのまま持つ');

    if (s.confidenceKind === 'actual') {
      assert.match(cards[i].textContent, new RegExp(`（${s.trainingShowCount}回）`));
    } else {
      // フォールバックの学習上映数（スクリーン全体の件数）は回数として出さない
      assert.doesNotMatch(cards[i].textContent, new RegExp(`（${s.trainingShowCount}回）`));
    }
    // 「回数が多いほど高精度」的な表現をしない
    assert.doesNotMatch(cards[i].textContent, /精度が高い|信頼度が高い|正確/);
  });
});

// ---------------------------------------------------------------------------
// テスト7: 日付・時間帯フィルター後もランキングが正しい
// ---------------------------------------------------------------------------
test('テスト7: 日付＋時間帯で絞ってもランキングが正しい', () => {
  const date = '2025-10-01';
  const view = buildResultView(data, cond(date, 'night', 'vacancy'));
  const list = view.showings;
  const idsForDate = new Set(data.days[date].map((r) => r[COL.showingId]));

  assert.equal(list.length, 10, '夜(20:00〜)は 21:10 の10スクリーン');
  for (const s of list) {
    assert.ok(idsForDate.has(s.showingId), 'その日の上映だけ');
    assert.ok(Number(String(s.startTime).slice(0, 2)) >= 20, '夜の上映だけ');
  }
  // 絞り込み後の集合内で順位が 1..10 の連番になる（飛び番にならない）
  assert.deepEqual(
    list.map((s) => s.viewRank),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  );
  for (let i = 1; i < list.length; i++) {
    assert.ok(list[i - 1].predictedPct <= list[i].predictedPct);
  }
  // 元の日全体での順位（STEP 5 の値）は保持されている
  const rawRankById = new Map(data.days[date].map((r) => [r[COL.showingId], r[COL.vacancyRank]]));
  for (const s of list) assert.equal(s.vacancyRank, rawRankById.get(s.showingId));

  // カードに出る順位は絞り込み後の順位
  const cards = draw(list);
  assert.equal(cards[0].find('card__rank').textContent, '1位');
  assert.equal(cards[9].find('card__rank').textContent, '10位');
});

test('テスト7b: 2025-12-31 × 夕方 でもランキングが成立する', () => {
  const list = buildResultView(data, cond('2025-12-31', 'evening', 'vacancy')).showings;
  assert.equal(list.length, 20);
  assert.deepEqual(
    list.map((s) => s.viewRank),
    Array.from({ length: 20 }, (_, i) => i + 1)
  );
  assert.equal(list.filter((s) => s.isTopPick).length, 1);
});

// ---------------------------------------------------------------------------
// テスト8: 0件状態が壊れていない
// ---------------------------------------------------------------------------
test('テスト8: 0件でも topPick/順位がなく、状態が返る', () => {
  const outOfRange = buildResultView(data, cond('2024-06-01'));
  assert.equal(outOfRange.state, 'no-date-data');
  assert.equal(outOfRange.showings.length, 0);
  assert.equal(outOfRange.topPickId, undefined);

  const synthetic = {
    meta: { screens: { 1: { name: 'シアター1', capacity: 100 } } },
    titles: ['サンプル作品'],
    days: {
      '2025-10-05': [
        ['S99001', 0, '1', '09:30', '11:30', 100, 8.0, 'w', 10, 1, 1],
        ['S99002', 0, '1', '10:00', '12:00', 100, 12.0, 's', 5, 0, 2],
      ],
    },
  };
  const emptyBand = buildResultView(synthetic, cond('2025-10-05', 'night'));
  assert.equal(emptyBand.state, 'empty-band');
  assert.equal(emptyBand.showings.length, 0);
  assert.equal(emptyBand.topPickId, null);
  assert.deepEqual(emptyBand.summary, { total: 0, vacant: 0 });

  // 0件を描画しても例外にならない
  assert.equal(draw(emptyBand.showings).length, 0);
});

// ---------------------------------------------------------------------------
// テスト9: STEP 5 の予測値が変更されていない
// ---------------------------------------------------------------------------
test('テスト9: STEP 5 の予測値を UI 層が改変していない', () => {
  assert.equal(data.meta.vacancyThresholdPct, 10);
  assert.deepEqual(data.meta.trainingWindow, { start: '2025-01-01', end: '2025-09-30' });

  for (const date of DATES) {
    const rawById = new Map(data.days[date].map((r) => [r[COL.showingId], r]));

    // 絞り込み・並び替え・順位付けを通しても予測値は不変
    for (const band of ['all', 'morning', 'afternoon', 'evening', 'night']) {
      for (const sortId of ['vacancy', 'time']) {
        for (const s of buildResultView(data, cond(date, band, sortId)).showings) {
          const raw = rawById.get(s.showingId);
          assert.equal(s.predictedPct, raw[COL.predictedPct]);
          assert.equal(s.isVacant, raw[COL.isVacant] === 1);
          assert.equal(s.vacancyRank, raw[COL.vacancyRank]);
          assert.equal(s.trainingShowCount, raw[COL.trainingShowCount]);
        }
      }
    }

    // getShowingsForDate 自体も素通し
    for (const s of getShowingsForDate(data, date)) {
      const raw = rawById.get(s.showingId);
      assert.equal(s.predictedPct, raw[COL.predictedPct]);
      assert.equal(s.isVacant, raw[COL.isVacant] === 1);
    }
  }
});

test('テスト9b: カードに表示される数値が JSON の予測値と一致する', () => {
  const date = '2025-10-01';
  const rawById = new Map(data.days[date].map((r) => [r[COL.showingId], r]));
  const list = buildResultView(data, cond(date, 'all', 'vacancy')).showings;
  const cards = draw(list);

  list.forEach((s, i) => {
    const raw = rawById.get(s.showingId);
    // 表示は小数第1位で揃える。バーの長さは丸め前の値をそのまま使う
    assert.equal(
      cards[i].find('gauge__value').textContent,
      `${raw[COL.predictedPct].toFixed(1)}%`
    );
    assert.equal(cards[i].find('gauge__fill').style.width, `${raw[COL.predictedPct]}%`);
  });
});

test('テスト9c: 丸め表示でも空き判定は STEP 5 の値（丸め前判定）に従う', () => {
  // スクリーン5のフォールバック平均は 9.967... → 表示は 10.0% だが isVacant は true
  const list = buildResultView(data, cond('2025-10-01', 'all', 'vacancy')).showings;
  const boundary = list.filter((s) => Number(s.predictedPct).toFixed(1) === '10.0');
  assert.ok(boundary.length > 0, '表示が 10.0% になる上映が実データに存在する');

  const rawById = new Map(data.days['2025-10-01'].map((r) => [r[COL.showingId], r]));
  for (const s of boundary) {
    // UI は再判定せず JSON の isVacant をそのまま使っている
    assert.equal(s.isVacant, rawById.get(s.showingId)[COL.isVacant] === 1);
  }
});

// ---------------------------------------------------------------------------
// 補助: 新しい段階ラベルを作っていないこと（§16）
// ---------------------------------------------------------------------------
test('補助: isVacant 以外の新しい混雑ランクを作っていない', () => {
  const list = buildResultView(data, cond('2025-10-01', 'all', 'vacancy')).showings;
  const raw = draw(list)
    .map((c) => c.textContent)
    .join(' ');
  // 「予測混雑率」は正規の見出しなので除いてから段階ラベルを探す
  const text = raw.replaceAll('予測混雑率', '');

  for (const tier of ['とても空いている', 'やや空いている', '普通', 'やや混雑', '混雑']) {
    assert.doesNotMatch(text, new RegExp(tier), `段階ラベル「${tier}」を作らない`);
  }
  // 空き関連のバッジ文言は1種類だけ
  const vacantLabels = new Set(
    draw(list)
      .map((c) => c.find('badge--vacant'))
      .filter(Boolean)
      .map((b) => b.textContent)
  );
  assert.deepEqual([...vacantLabels], ['空いている可能性が高い']);
});

test('補助: バーが実際の空席数と誤解されない説明が付いている', () => {
  const list = buildResultView(data, cond('2025-10-01', 'all', 'vacancy')).showings;
  const track = draw(list)[0].find('gauge__track');
  assert.match(track.getAttribute('aria-label'), /実際の空席数ではありません/);
  assert.match(track.title, /実際の空席数ではありません/);
});
