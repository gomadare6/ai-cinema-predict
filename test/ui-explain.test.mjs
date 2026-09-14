/**
 * UIアップデート: 予測根拠・おすすめ理由・AI説明の検証。
 *
 * 予測ロジックは一切変更していない前提で、既存の predictionBasis / historyCount /
 * confidenceCode を使った表示の組み立てだけを確認する（新しい統計判定は行わない）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

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
  findAll(cls) {
    const out = [];
    for (const c of this.children) {
      if (c.hasClass(cls)) out.push(c);
      out.push(...c.findAll(cls));
    }
    return out;
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

const workScreenShowing = {
  showingId: 'S16435',
  title: '(吹替)サンプル作品',
  screenId: '10',
  screenName: 'シアター10',
  startTime: '09:30',
  endTime: '11:30',
  seatCapacity: 313,
  predictedPct: 5.7,
  isVacant: true,
  vacancyRank: 1,
  trainingShowCount: 42,
  confidenceLabel: '過去の上映実績あり',
  confidenceKind: 'actual',
  historyCount: 42,
  confidence: '高',
  predictionBasisDetail: '作品×スクリーンの過去42回を参考',
  reason: '過去の同作品・同スクリーンでは比較的空いている傾向があります。',
  basisMethodLabel: '作品 × スクリーンの過去実績',
};

const screenFallbackShowing = {
  showingId: 'S16480',
  title: '新作サンプル',
  screenId: '8',
  screenName: 'シアター8',
  startTime: '21:10',
  endTime: '23:10',
  seatCapacity: 76,
  predictedPct: 27.7,
  isVacant: false,
  vacancyRank: 60,
  trainingShowCount: 1638,
  confidenceLabel: '参考値：スクリーンの過去実績から予測',
  confidenceKind: 'fallback',
  historyCount: 1638,
  confidence: '中',
  predictionBasisDetail: 'スクリーンの過去1638回を参考',
  reason: '同作品・同スクリーンの履歴がないため、スクリーンの過去実績をもとに予測しています。',
  basisMethodLabel: 'スクリーンの過去実績',
};

const futureShowing = {
  ...workScreenShowing,
  showingId: 'F00099',
  isFuture: true,
  confidence: '低',
  historyCount: 2,
  predictionBasisDetail: '作品×スクリーンの過去2回を参考',
  reason: '過去の同作品・同スクリーンの上映実績をもとに予測しています。',
};

function draw(showings) {
  const ul = new FakeNode('ul');
  renderCards(ul, showings);
  return ul.children;
}

// 1) work×screen の上映 → 正しい予測根拠が表示される
test('テスト1: work×screen 実績ありの上映に正しい予測根拠が表示される', () => {
  const card = draw([workScreenShowing])[0];
  const basis = card.find('card__basis');
  assert.ok(basis, '予測の根拠 <details> が付く');
  assert.match(basis.find('card__basis-summary').textContent, /作品×スクリーンの過去42回を参考/);

  const rows = basis.findAll('card__basis-list').flatMap((dl) => dl.children.map((c) => c.textContent));
  assert.ok(rows.includes('作品 × スクリーンの過去実績'), '予測方法が自然な日本語で出る');
  assert.ok(rows.includes('42回'), '過去上映の回数が出る');
  assert.ok(rows.includes('高'), '参考度が出る');
});

// 2) screen fallback → 正しい説明が表示される
test('テスト2: screen fallback の上映に正しい説明が表示される', () => {
  const card = draw([screenFallbackShowing])[0];
  assert.equal(
    card.find('card__reason').textContent,
    '同作品・同スクリーンの履歴がないため、スクリーンの過去実績をもとに予測しています。'
  );
  const basis = card.find('card__basis');
  const rows = basis.findAll('card__basis-list').flatMap((dl) => dl.children.map((c) => c.textContent));
  assert.ok(rows.includes('スクリーンの過去実績'));
});

// 3) confidence が高/中/低で正しい
test('テスト3: confidence (参考度) が高/中/低で正しく表示される', () => {
  const [wsCard, sCard, fCard] = draw([workScreenShowing, screenFallbackShowing, futureShowing]);
  assert.match(wsCard.find('card__basis-summary').textContent, /参考度: 高/);
  assert.match(sCard.find('card__basis-summary').textContent, /参考度: 中/);
  assert.match(fCard.find('card__basis-summary').textContent, /参考度: 低/);
});

// 4) historyCount が正しく表示される
test('テスト4: historyCount (過去上映回数) が詳細欄に正しく出る', () => {
  const card = draw([futureShowing])[0];
  const rows = card
    .find('card__basis')
    .findAll('card__basis-list')
    .flatMap((dl) => dl.children.map((c) => c.textContent));
  assert.ok(rows.includes('2回'));
});

// 5) future 上映 → AI予測であることが分かる
test('テスト5: 未来上映には AI予測バッジが付き、実績と混同しない', () => {
  const [normalCard, futureCard] = draw([workScreenShowing, futureShowing]);
  assert.equal(normalCard.find('badge--future'), null);
  const badge = futureCard.find('badge--future');
  assert.ok(badge);
  assert.equal(badge.textContent, 'AI予測（先の上映予定）');
});

// 6) 10%未満 → 「空いている可能性が高い」表示が維持される
test('テスト6: 10%未満の上映は既存の空いている表示が維持される', () => {
  const card = draw([workScreenShowing])[0];
  assert.equal(card.find('badge--vacant').textContent, '空いている可能性が高い');
  assert.match(card.className, /card--vacant/);
});

// 7) 予測値は既存値から変更されていない (UI 層は表示するだけ)
test('テスト7: 追加した説明文はあっても、予測混雑率・空き判定の値自体は変えていない', () => {
  const card = draw([workScreenShowing])[0];
  assert.equal(card.find('gauge__value').textContent, '5.7%');
  assert.equal(card.find('gauge__fill').style.width, '5.7%');
});

// 断定・おすすめ表現を使っていないこと（既存の規約を維持）
test('補助: 新しい説明文でも断定・おすすめ表現を使っていない', () => {
  const text = draw([workScreenShowing, screenFallbackShowing, futureShowing])
    .map((c) => c.textContent)
    .join(' ');
  for (const forbidden of ['空席あり', '必ず', '確実', '保証', 'おすすめ', '高精度', '正確に予測']) {
    assert.doesNotMatch(text, new RegExp(forbidden), `「${forbidden}」を使わない`);
  }
});

// 参考度の免責文言がカード内に存在すること
test('補助: 「予測精度そのものではない」旨の免責がカード内にある', () => {
  const card = draw([workScreenShowing])[0];
  const note = card.find('card__basis-note');
  assert.ok(note);
  assert.match(note.textContent, /予測精度そのものではなく/);
});
