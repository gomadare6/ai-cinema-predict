/**
 * 分析ページ用データ読み込み。derived/analytics/*.json (build-analytics.js が生成) を
 * そのまま取得するだけで、ここでは新しい統計計算はしない。
 */

function fetchJson(url) {
  return fetch(url, { cache: 'no-cache' }).then((res) => {
    if (!res.ok) throw new Error(`HTTP_${res.status} ${url}`);
    return res.json();
  });
}

export function loadAnalyticsData() {
  return Promise.all([
    fetchJson('/derived/analytics/validation.json'),
    fetchJson('/derived/analytics/movies.json'),
    fetchJson('/derived/analytics/screens.json'),
    fetchJson('/derived/analytics/staff.json'),
  ]).then(([validation, movies, screens, staff]) => ({ validation, movies, screens, staff }));
}
