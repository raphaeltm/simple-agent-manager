/**
 * Scenario index — exports all eval scenarios.
 */

import weatherBaseline from './weather-baseline.js';
import readAndSummarize from './read-and-summarize.js';
import grepLocateCode from './grep-locate-code.js';
import missingFileRecovery from './missing-file-recovery.js';
import proposePatch from './propose-patch.js';
import interpretTestFailure from './interpret-test-failure.js';
import multiFileRefactor from './multi-file-refactor.js';
import testDrivenFix from './test-driven-fix.js';
import dependencyAnalysis from './dependency-analysis.js';

export const ALL_SCENARIOS = [
  weatherBaseline,
  readAndSummarize,
  grepLocateCode,
  missingFileRecovery,
  proposePatch,
  interpretTestFailure,
  multiFileRefactor,
  testDrivenFix,
  dependencyAnalysis,
];
