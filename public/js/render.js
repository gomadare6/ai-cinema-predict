/**
 * DOM 描画。データの加工や判定はここでは行わない (data.js / STEP 5 の値をそのまま出す)。
 */

/** チップ（トグルボタン）群を描画する。 */
export function renderChips(container, items, activeId, onSelect) {
  container.textContent = '';
  for (const item of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.textContent = item.label;
    btn.setAttribute('aria-pressed', String(item.id === activeId));
    if (item.hint) btn.title = `${item.label}（${item.hint}）`;
    btn.addEventListener('click', () => onSelect(item.id));
    container.appendChild(btn);
  }
}

/** 上映カード1枚を作る。 */
function createCard(showing) {
  const li = document.createElement('li');
  li.className =
    'card' +
    (showing.isVacant ? ' card--vacant' : '') +
    (showing.isTopPick ? ' card--top' : '');

  // --- 表示中の条件でいちばん空いている見込みの1件だけに付く見出し ---
  if (showing.isTopPick) {
    const note = document.createElement('p');
    note.className = 'card__top-note';
    note.textContent = 'この条件で最も空いている見込み';
    li.appendChild(note);
  }

  // --- 上段: 順位・タイトル・時刻/スクリーン/座席数 ---
  const head = document.createElement('div');
  head.className = 'card__head';

  // 順位は「空いている順（予測混雑率の低い順）」。作品の人気順ではない。
  const rankNo = showing.viewRank ?? showing.vacancyRank;
  const rank = document.createElement('div');
  rank.className = 'card__rank';
  rank.textContent = String(rankNo);
  const rankUnit = document.createElement('span');
  rankUnit.className = 'card__rank-unit';
  rankUnit.textContent = '位';
  rank.appendChild(rankUnit);
  rank.title = `空いている順（予測混雑率の低い順）${rankNo}位`;
  rank.setAttribute('aria-label', `空いている順 ${rankNo}位（予測混雑率の低い順）`);
  head.appendChild(rank);

  const headMain = document.createElement('div');

  const title = document.createElement('h3');
  title.className = 'card__title';
  title.textContent = showing.title;
  headMain.appendChild(title);

  const meta = document.createElement('p');
  meta.className = 'card__meta';

  const time = document.createElement('span');
  time.className = 'card__time';
  time.textContent = showing.endTime
    ? `${showing.startTime}–${showing.endTime}`
    : showing.startTime;
  meta.appendChild(time);

  meta.appendChild(sep());
  meta.appendChild(document.createTextNode(showing.screenName));
  meta.appendChild(sep());
  meta.appendChild(document.createTextNode(`${showing.seatCapacity}席`));

  headMain.appendChild(meta);
  head.appendChild(headMain);
  li.appendChild(head);

  // --- 下段: 予測混雑率（このカードの主役） ---
  const gauge = document.createElement('div');
  gauge.className = 'gauge';

  const row = document.createElement('div');
  row.className = 'gauge__row';

  const label = document.createElement('span');
  label.className = 'gauge__label';
  label.textContent = '予測混雑率';
  row.appendChild(label);

  const value = document.createElement('span');
  value.className = 'gauge__value';
  // 小数第1位で揃えて表示する（STEP 4 の表示仕様。判定は丸め前の値で済んでいる）
  value.textContent = Number(showing.predictedPct).toFixed(1);
  const unit = document.createElement('span');
  unit.className = 'gauge__unit';
  unit.textContent = '%';
  value.appendChild(unit);
  row.appendChild(value);

  gauge.appendChild(row);

  const track = document.createElement('div');
  track.className = 'gauge__track';
  // バーは予測混雑率の目安。実際の空席数ではないことを読み上げにも明示する。
  track.title = '予測混雑率の目安（満席=100%）。実際の空席数ではありません。目印は10%。';
  track.setAttribute('role', 'img');
  track.setAttribute(
    'aria-label',
    `予測混雑率 ${Number(showing.predictedPct).toFixed(1)}%` +
      '（満席を100%としたときの目安。実際の空席数ではありません）'
  );
  const fill = document.createElement('div');
  fill.className = 'gauge__fill';
  // 予測値をそのままバーの長さにする（新たな閾値判定はしない）
  fill.style.width = `${Math.max(0, Math.min(100, showing.predictedPct))}%`;
  track.appendChild(fill);
  gauge.appendChild(track);

  li.appendChild(gauge);

  // --- バッジ: 空いている判定 + 信頼度 ---
  const badges = document.createElement('div');
  badges.className = 'card__badges';

  if (showing.isVacant) {
    const b = document.createElement('span');
    b.className = 'badge badge--vacant';
    b.textContent = '空いている可能性が高い';
    badges.appendChild(b);
  }

  const conf = document.createElement('span');
  conf.className =
    'badge ' + (showing.confidenceKind === 'actual' ? 'badge--actual' : 'badge--fallback');
  conf.textContent =
    showing.confidenceKind === 'actual'
      ? `${showing.confidenceLabel}（${showing.trainingShowCount}回）`
      : showing.confidenceLabel;
  conf.title =
    showing.confidenceKind === 'actual'
      ? 'この作品をこのスクリーンで上映した過去実績の平均から予測しています。'
      : 'この作品のこのスクリーンでの過去実績がないため、スクリーン全体の過去実績で代用した参考値です。';
  badges.appendChild(conf);

  li.appendChild(badges);
  return li;
}

function sep() {
  const s = document.createElement('span');
  s.className = 'card__sep';
  s.textContent = '·';
  return s;
}

/** カード一覧を描画する。 */
export function renderCards(container, showings) {
  container.textContent = '';
  const frag = document.createDocumentFragment();
  for (const s of showings) frag.appendChild(createCard(s));
  container.appendChild(frag);
}

/** 状態パネル（読み込み中・空・エラー）を表示する。 */
export function showStatus(el, { title, body, isError = false }) {
  el.textContent = '';
  el.className = 'status' + (isError ? ' status--error' : '');
  if (title) {
    const h = document.createElement('p');
    h.className = 'status__title';
    h.textContent = title;
    el.appendChild(h);
  }
  if (body) {
    const p = document.createElement('p');
    p.style.margin = '0';
    // <code> を使いたい箇所だけ許可する簡易置換
    const parts = String(body).split(/`([^`]+)`/);
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        const code = document.createElement('code');
        code.textContent = part;
        p.appendChild(code);
      } else if (part) {
        p.appendChild(document.createTextNode(part));
      }
    });
    el.appendChild(p);
  }
  el.hidden = false;
}

export function hideStatus(el) {
  el.hidden = true;
  el.textContent = '';
}
