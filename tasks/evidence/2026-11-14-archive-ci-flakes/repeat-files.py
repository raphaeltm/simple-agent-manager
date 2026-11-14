#!/usr/bin/env python3
"""Bounded foreground full-file stability runs; no retry or timeout changes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument('suite', choices=['compact', 'lifecycle'])
parser.add_argument('mode', choices=['normal', 'loaded'])
parser.add_argument('--count', type=int, default=5)
parser.add_argument('--start', type=int, default=1)
args = parser.parse_args()
if not 1 <= args.count <= 10:
    parser.error('count must be between 1 and 10; use separate bounded batches')
root = Path(__file__).resolve().parents[3]
scratch = root / '.tmp' / 'archive-ci-flakes'
scratch.mkdir(parents=True, exist_ok=True)
specs = {
    'compact': ('@simple-agent-manager/project-data', 'tests/unit/project-data-compact-archive.test.ts', 13, []),
    'lifecycle': ('@simple-agent-manager/api', 'tests/workers/node-lifecycle-decisions.test.ts', 9, ['--config', 'vitest.workers.config.ts']),
}
package, file, expected, options = specs[args.suite]
result_file = Path(__file__).with_name('repeat-results.jsonl')
cpus = sorted(os.sched_getaffinity(0))[:2]
if len(cpus) < 2:
    parser.error('loaded verification requires at least two available CPU cores')
workers = []
clock_ticks = os.sysconf('SC_CLK_TCK')
def cpu_seconds(pid):
    fields = Path(f'/proc/{pid}/stat').read_text().split()
    return (int(fields[13]) + int(fields[14])) / clock_ticks

def stop_group(process):
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)

batch_deadline = time.monotonic() + 540
try:
    if args.mode == 'loaded':
        for cpu in cpus:
            workers.append(subprocess.Popen(
                ['taskset', '-c', str(cpu), sys.executable, '-c', 'while True: pass'],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
            ))
    for index in range(args.start, args.start + args.count):
        remaining = batch_deadline - time.monotonic()
        if remaining < 30:
            raise RuntimeError('batch budget exhausted; no more test processes launched')
        if result_file.exists():
            existing = [json.loads(line) for line in result_file.read_text().splitlines()]
            if any(row['suite'] == args.suite and row['mode'] == args.mode and row['index'] == index
                   for row in existing):
                raise RuntimeError('run index already recorded; refusing a hidden repeat')
        name = f'{args.suite}-{args.mode}-{index:02}'
        report = scratch / f'{name}.json'
        log = scratch / f'{name}.log'
        command = ['pnpm', '--filter', package, 'exec', 'vitest', 'run', *options, file,
                   '--reporter=json', f'--outputFile={report}']
        if workers:
            command = ['taskset', '-c', ','.join(map(str, cpus)), *command]
        before_cpu = [cpu_seconds(p.pid) for p in workers]
        started = time.monotonic()
        with log.open('w') as output:
            process = subprocess.Popen(command, cwd=root, stdout=output, stderr=subprocess.STDOUT,
                                       start_new_session=True)
            try:
                code = process.wait(timeout=min(180, remaining))
            except subprocess.TimeoutExpired:
                stop_group(process)
                code = 124
        elapsed = time.monotonic() - started
        data = json.loads(report.read_text()) if report.exists() else {}
        cases = [case for suite in data.get('testResults', []) for case in suite['assertionResults']]
        busy_cpu = [cpu_seconds(p.pid)-before for p, before in zip(workers, before_cpu)]
        record = {
            'suite': args.suite, 'mode': args.mode, 'index': index, 'exitCode': code,
            'wallSeconds': elapsed, 'passed': data.get('numPassedTests'),
            'failed': data.get('numFailedTests'), 'skipped': data.get('numPendingTests'),
            'cpuAffinity': cpus if workers else None, 'busyWorkerCpuSeconds': busy_cpu,
            'command': command,
            'sourceHashes': {path: hashlib.sha256((root/path).read_bytes()).hexdigest()
                             for path in ['.github/workflows/ci.yml',
                                          'packages/project-data/tests/unit/project-data-compact-archive.test.ts',
                                          'apps/api/tests/workers/node-lifecycle-decisions.test.ts']},
            'cases': [{'name': c['fullName'], 'ms': c.get('duration'), 'status': c['status']}
                      for c in cases],
        }
        with result_file.open('a') as output:
            output.write(json.dumps(record) + '\n')
        print(json.dumps({k:v for k,v in record.items() if k not in ('command','cases','sourceHashes')}), flush=True)
        if code or record['passed'] != expected or record['failed'] != 0 or any(t <= 0 for t in busy_cpu):
            raise RuntimeError(f'full-file validation failed; inspect {log}')
finally:
    for worker in workers:
        stop_group(worker)
