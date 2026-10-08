import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Reporter, TestModule } from 'vitest/node';

/** setupMs is module loading; beforeAll (including D1 migrations) is in testsAndHooksMs. */
export default class WorkersTimingReporter implements Reporter {
  private readonly output = process.env.WORKERS_TIMING_OUTPUT ?? 'test-results/workers-timing.json';
  private readonly files: {
    file: string;
    setupMs: number;
    collectMs: number;
    testsAndHooksMs: number;
  }[] = [];

  onTestModuleEnd(module: TestModule): void {
    const timing = module.diagnostic();
    this.files.push({
      file: module.relativeModuleId,
      setupMs: timing.setupDuration,
      collectMs: timing.collectDuration,
      testsAndHooksMs: timing.duration,
    });
    // Write after each file so a timeout still leaves useful measurements.
    mkdirSync(dirname(this.output), { recursive: true });
    writeFileSync(this.output, JSON.stringify(this.files, null, 2) + '\n');
  }
}
