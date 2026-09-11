/**
 * public/js/render.js の DOM 構築を検証する。
 *
 * ブラウザなしで確認するため、必要最小限の document スタブを立てる。
 * 目的は特に以下2点:
 *   - 予測混雑率が主役として出ていること
 *   - フォールバックの上映が「実績あり」と誤解される表示にならないこと
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ---------- 最小 DOM スタブ ----------

class FakeNode {
  constructor(tag = '#fragment') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attrs = {};
    this.style = {};
    this._text = '';
    this.className = '';
    this.title = '';
    this.type = '';
    this.hidden = false;
  }

  appendChild(child) {
    if (child.tagName === '#FRAGMENT') {
      this.children.push(...child.children);
    } else {
      this.children.push(child);
    }
    return child;
  }

  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }

  getAttribute(k) {
    return this.attrs[k];
  }

  addEventListener(type, fn) {
    (this._listeners ??= {})[type] = fn;
  }

  click() {
    this._listeners?.click?.();
  }

  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }

  /** 自身と子孫のテキストを連結した結果 */
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this._text + this.children.map((c) => c.textContent).join('');
  }

  /** クラス名で子孫を1つ探す */
  find(cls) {
    for (const c of this.children) {
      if (String(c.className).split(/\s+/).includes(cls)) return c;
      const hit = c.find(cls);
      if (hit) return hit;
    }
    return null;
  }

  /** クラス名で子孫をすべて探す */
  findAll(cls) {
    const out = [];
    for (const c of this.children) {
      if (String(c.className).split(/\s+/).includes(cls)) out.push(c);
      out.push(...c.findAll(cls));
    }
    return out;
  }
}

globalThis.document = {
  createElement: (tag) => new FakeNode(tag),
  createDocumentFragment: () => new FakeNode('#fragment'),
  createTextNode: (t) => {
    const n = new FakeNode('#text');
    n._text = String(t);
    return n;
  },
};

const { renderCards, renderChips, showStatus, hideStatus } = await import('../public/js/render.js');

// ---------- テストデータ ----------

const vacantActual = {
  showingId: 'S16435',
  title: '(吹替)ジュラシック・ワールド／復活の大地',
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
};

const busyFallback = {
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
};

// ---------- テスト ----------

test('render: カードに タイトル・時刻・スクリーン・座席数・予測混雑率 が出る', () => {
  const list = new FakeNode('ul');
  renderCards(list, [vacantActual]);

  assert.equal(list.children.length, 1);
  const card = list.children[0];

  assert.equal(card.find('card__title').textContent, vacantActual.title);
  // STEP 8: 順位は「N位」表記 + 読み上げラベルで、人気順との誤解を防ぐ
  const rank = card.find('card__rank');
  assert.equal(rank.textContent, '1位');
  assert.match(rank.getAttribute('aria-label'), /空いている順 1位/);
  assert.doesNotMatch(rank.getAttribute('aria-label'), /人気|おすすめ/);
  assert.equal(card.find('gauge__value').textContent, '5.7%');
  assert.equal(card.find('gauge__label').textContent, '予測混雑率');

  const meta = card.find('card__meta').textContent;
  assert.match(meta, /09:30–11:30/);
  assert.match(meta, /シアター10/);
  assert.match(meta, /313席/);
});

test('render: 予測混雑率がバーの長さに反映される', () => {
  const list = new FakeNode('ul');
  renderCards(list, [vacantActual, busyFallback]);

  assert.equal(list.children[0].find('gauge__fill').style.width, '5.7%');
  assert.equal(list.children[1].find('gauge__fill').style.width, '27.7%');
});

test('render: isVacant=true のカードだけ「空いている可能性が高い」が付く', () => {
  const list = new FakeNode('ul');
  renderCards(list, [vacantActual, busyFallback]);

  const [vacantCard, busyCard] = list.children;

  assert.match(vacantCard.className, /card--vacant/);
  assert.equal(vacantCard.find('badge--vacant').textContent, '空いている可能性が高い');

  assert.doesNotMatch(busyCard.className, /card--vacant/);
  assert.equal(busyCard.find('badge--vacant'), null, '混雑側に空きバッジは付かない');
});

test('render: 断定表現を使っていない', () => {
  const list = new FakeNode('ul');
  renderCards(list, [vacantActual, busyFallback]);
  const text = list.textContent;

  for (const forbidden of ['空席あり', '必ず空いている', '確実', '保証']) {
    assert.doesNotMatch(text, new RegExp(forbidden), `断定表現「${forbidden}」を使わない`);
  }
  assert.match(text, /予測混雑率/);
});

test('render: フォールバックは「実績あり」と誤解される表示にならない', () => {
  const list = new FakeNode('ul');
  renderCards(list, [busyFallback]);
  const card = list.children[0];

  const badge = card.find('badge--fallback');
  assert.ok(badge, 'フォールバック専用のバッジクラスが付く');
  assert.equal(badge.textContent, '参考値：スクリーンの過去実績から予測');
  assert.doesNotMatch(badge.textContent, /実績あり/);
  assert.equal(card.find('badge--actual'), null, '実績ありバッジは付かない');

  // 学習上映数(1638)がフォールバックカードに回数として出ていないこと
  assert.doesNotMatch(card.textContent, /1638/);
});

test('render: 実績ありは回数つきで表示される', () => {
  const list = new FakeNode('ul');
  renderCards(list, [vacantActual]);
  const card = list.children[0];

  const badge = card.find('badge--actual');
  assert.ok(badge);
  assert.equal(badge.textContent, '過去の上映実績あり（42回）');
  assert.equal(card.find('badge--fallback'), null);
});

test('render: 内部値 (work_screen / screen / global) が画面に出ない', () => {
  const list = new FakeNode('ul');
  renderCards(list, [vacantActual, busyFallback]);
  const text = list.textContent + JSON.stringify(list.children.map((c) => c.attrs));

  for (const internal of ['work_screen', 'screen_avg', 'global', 'isVacant', 'predictionSource']) {
    assert.doesNotMatch(text, new RegExp(internal), `内部値「${internal}」を表示しない`);
  }
});

test('render: 0件のときも例外なく空になる (画面が真っ白にならない)', () => {
  const list = new FakeNode('ul');
  renderCards(list, [vacantActual]);
  assert.equal(list.children.length, 1);
  renderCards(list, []); // 再描画で消える
  assert.equal(list.children.length, 0);
});

test('render: チップは選択状態を aria-pressed で示し、クリックで通知する', () => {
  const box = new FakeNode('div');
  const picked = [];
  renderChips(
    box,
    [
      { id: 'all', label: 'すべて' },
      { id: 'morning', label: '午前', hint: '〜11:59' },
    ],
    'morning',
    (id) => picked.push(id)
  );

  assert.equal(box.children.length, 2);
  assert.equal(box.children[0].getAttribute('aria-pressed'), 'false');
  assert.equal(box.children[1].getAttribute('aria-pressed'), 'true');
  assert.equal(box.children[1].title, '午前（〜11:59）');

  box.children[0].click();
  assert.deepEqual(picked, ['all']);
});

test('render: 状態パネルはエラー時にクラスが変わり、hideStatus で隠れる', () => {
  const box = new FakeNode('div');

  showStatus(box, { title: '読み込み中…' });
  assert.equal(box.hidden, false);
  assert.equal(box.className, 'status');
  assert.match(box.textContent, /読み込み中/);

  showStatus(box, { title: '失敗', body: '`npm run dev` を実行', isError: true });
  assert.match(box.className, /status--error/);
  assert.match(box.textContent, /npm run dev/);

  hideStatus(box);
  assert.equal(box.hidden, true);
  assert.equal(box.textContent, '');
});
