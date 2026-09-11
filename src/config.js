'use strict';

/**
 * STEP 4 確定仕様の定数。第一版はここを唯一の設定箇所とする。
 */

const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');

module.exports = {
  PROJECT_ROOT,
  DATA_DIR: path.join(PROJECT_ROOT, 'data'),
  DERIVED_DIR: path.join(PROJECT_ROOT, 'derived'),

  // 学習期間 (この期間の上映実績だけを予測用集計に使う)
  TRAINING_START: '2025-01-01',
  TRAINING_END: '2025-09-30',

  // 検証期間 (予測値の生成には絶対に使わない。精度検証の正解値としてのみ使用)
  VALIDATION_START: '2025-10-01',
  VALIDATION_END: '2025-12-31',

  // 「空いている」判定しきい値 (%)。第一版は 10% 固定・未満のみ。
  VACANCY_THRESHOLD_PCT: 10,

  // 表示用の予測混雑率の丸め桁 (内部計算・ランキングでは丸めない)
  DISPLAY_DECIMALS: 1,

  // 予測根拠 / 信頼度ラベルの表示文字列 (STEP 4 §7)
  BASIS_WORK_SCREEN: '作品×スクリーン実績あり',
  BASIS_SCREEN: 'スクリーン平均',
  BASIS_GLOBAL: '全体平均',
  CONFIDENCE_ACTUAL: '実績あり',
  CONFIDENCE_FALLBACK: 'フォールバック',

  // 機械判定用の source 値 (prediction_source)
  SOURCE_WORK_SCREEN: 'work_screen',
  SOURCE_SCREEN: 'screen',
  SOURCE_GLOBAL: 'global',
};
