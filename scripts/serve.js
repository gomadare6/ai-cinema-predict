'use strict';

/**
 * 依存ゼロの静的ファイルサーバー (ローカル開発用)。
 *   node scripts/serve.js  →  http://localhost:5173
 *
 * ブラウザから file:// で fetch すると CORS で失敗するため、最小の HTTP サーバーで配信する。
 *
 * 配信ルート = public/ （＝提出時の dist/ と同じ構造）。
 *   /            -> public/index.html
 *   /styles.css  -> public/styles.css
 *   /js/app.js   -> public/js/app.js
 *   /derived/... -> プロジェクト直下の derived/...   （予測データ ui-showings.json はここ）
 *
 * index.html はドキュメント相対パス（./styles.css など）で参照しているため、
 * 配信ルートを public/ にしないとブラウザが /styles.css を要求して 404 になる
 * （＝スタイル未適用の素の HTML に見える）。build:site の dist/ も同じ構造なので、
 * 開発サーバーと本番静的サイトで挙動が一致する。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('../src/config');

const PORT = Number(process.env.PORT) || 5173;
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const DERIVED_DIR = path.join(PROJECT_ROOT, 'derived');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** リクエストパス -> 実ファイルパス（配信ルートの外に出さない）。不正なら null。 */
function resolveFile(urlPath) {
  if (urlPath === '/') urlPath = '/index.html';

  // /derived/* だけはプロジェクト直下の derived/ から出す
  if (urlPath === '/derived' || urlPath.startsWith('/derived/')) {
    const rel = urlPath.slice('/derived/'.length);
    const file = path.join(DERIVED_DIR, rel);
    return file.startsWith(DERIVED_DIR) ? file : null;
  }

  const file = path.join(PUBLIC_DIR, urlPath);
  return file.startsWith(PUBLIC_DIR) ? file : null;
}

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, `http://localhost:${PORT}`).pathname);
  } catch {
    res.writeHead(400).end('Bad Request');
    return;
  }

  const filePath = resolveFile(urlPath);
  if (!filePath) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`404 Not Found: ${urlPath}`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('AI 空いてる映画 — 開発サーバー起動');
  console.log(`  http://localhost:${PORT}`);
  console.log('  配信ルート: public/ （/derived/* は プロジェクト直下 derived/ から）');
  console.log('  停止: Ctrl+C');
});
