'use strict';

/**
 * 最小限の CSV 入出力ユーティリティ。
 *
 * このプロジェクトの data/*.csv は STEP 5 の事前調査で以下を確認済み:
 *  - UTF-8 BOM 付き
 *  - フィールドのクォート無し・値にカンマを含まない (作品名の読点は全角「、」)
 *  - 全行のフィールド数が一定
 * そのため単純な split(',') で安全にパースできる。外部ライブラリは追加しない。
 */

const fs = require('fs');

/** 先頭の UTF-8 BOM を除去する。 */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * CSV ファイルを読み込み、ヘッダ配列と行オブジェクト配列を返す。
 * @param {string} filePath
 * @returns {{ header: string[], rows: Array<Record<string,string>> }}
 */
function readCsv(filePath) {
  const raw = stripBom(fs.readFileSync(filePath, 'utf8'));
  const lines = raw.split(/\r?\n/);
  // 末尾の空行を除去
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return { header: [], rows: [] };

  const header = lines[0].split(',');
  const rows = new Array(lines.length - 1);
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    const obj = {};
    for (let c = 0; c < header.length; c++) obj[header[c]] = cells[c];
    rows[i - 1] = obj;
  }
  return { header, rows };
}

/**
 * CSV を1行ずつコールバックに渡す (大きい ticket_sales.csv 用)。
 * ヘッダ行はスキップされる。値は生の文字列配列で渡す。
 * @param {string} filePath
 * @param {(cells: string[], header: string[]) => void} onRow
 */
function forEachCsvRow(filePath, onRow) {
  const raw = stripBom(fs.readFileSync(filePath, 'utf8'));
  const lines = raw.split(/\r?\n/);
  if (lines.length === 0) return;
  const header = lines[0].split(',');
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '') continue;
    onRow(lines[i].split(','), header);
  }
}

/**
 * ヘッダ + 行オブジェクト配列を CSV ファイルに書き出す。
 * 値はそのまま文字列化する (このプロジェクトの生成データはカンマ・改行を含まない)。
 * @param {string} filePath
 * @param {string[]} header
 * @param {Array<Record<string, unknown>>} rows
 */
function writeCsv(filePath, header, rows) {
  const out = [header.join(',')];
  for (const row of rows) {
    out.push(header.map((h) => String(row[h])).join(','));
  }
  fs.writeFileSync(filePath, out.join('\n') + '\n', 'utf8');
}

module.exports = { readCsv, forEachCsvRow, writeCsv, stripBom };
