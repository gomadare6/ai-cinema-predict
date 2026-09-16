'use strict';

/**
 * 提出用の静的サイトを dist/ に組み立てる（依存ゼロ）。
 *   node scripts/build-site.js
 *
 * public/ の中身と derived/ui-showings.json を1つのディレクトリにまとめるだけ。
 * dist/ をそのまま静的ホスティング（Cloudflare Pages 等）の公開ディレクトリにできる。
 *
 *   dist/
 *   ├─ index.html / styles.css / js/*       ← public/ から
 *   └─ derived/ui-showings.json             ← 予測エンジンの出力（統計予測）
 *
 * 元データ・derived/ の集計・src/ には触らない。外部APIキーは不要。
 */

const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT, DERIVED_DIR } = require('../src/config');

const DIST = path.join(PROJECT_ROOT, 'dist');
const PUBLIC = path.join(PROJECT_ROOT, 'public');
const UI_JSON = path.join(DERIVED_DIR, 'ui-showings.json');
const ANALYTICS_DIR = path.join(DERIVED_DIR, 'analytics');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function main() {
  if (!fs.existsSync(UI_JSON)) {
    console.error(`${UI_JSON} がありません。先に \`npm run build\` を実行してください。`);
    process.exit(1);
  }

  fs.rmSync(DIST, { recursive: true, force: true });
  copyDir(PUBLIC, DIST);

  fs.mkdirSync(path.join(DIST, 'derived'), { recursive: true });
  fs.copyFileSync(UI_JSON, path.join(DIST, 'derived', 'ui-showings.json'));

  if (fs.existsSync(ANALYTICS_DIR)) {
    copyDir(ANALYTICS_DIR, path.join(DIST, 'derived', 'analytics'));
  } else {
    console.error(`${ANALYTICS_DIR} がありません。先に \`npm run build:analytics\` を実行してください。`);
    process.exit(1);
  }

  // Node からの module 判定用の public/package.json は本番サイトに不要
  fs.rmSync(path.join(DIST, 'package.json'), { force: true });

  // 画像フォルダの運用メモ (public/images/README.md) も本番サイトに不要
  fs.rmSync(path.join(DIST, 'images', 'README.md'), { force: true });

  const files = [];
  (function walk(dir, base = '') {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else files.push(rel);
    }
  })(DIST);

  console.log('=== 静的サイト生成 (dist/) ===');
  for (const f of files.sort()) {
    console.log(`  ${f}  (${fs.statSync(path.join(DIST, f)).size} B)`);
  }
  console.log('\n公開ディレクトリ : dist/');
  console.log('ビルドコマンド   : npm run build && npm run build:site');
  console.log('環境変数         : なし（外部API・キー不要）');
}

main();
