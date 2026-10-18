#!/usr/bin/env python3
"""Private remote/PR evidence; canonical task completion must be independently verified."""
import datetime
import importlib.util
import json
import math
from pathlib import Path
import re
import sys
sys.dont_write_bytecode = True
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent

def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

B = module('contained_b_probe', 'b-probe.py')
A = module('contained_a_probe', 'git-probe.py')


def timestamp(value):
    result = datetime.datetime.fromisoformat(value)
    if result.tzinfo is None:
        raise ValueError('timestamp')
    return result


def refs(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError('refs')
    result = {}
    for line in value.splitlines():
        match = re.fullmatch(r'([0-9a-f]{40}|[0-9a-f]{64})\t(refs/heads/[^\s]+)', line)
        if not match or match[2] in result:
            raise ValueError('refs')
        result[match[2]] = match[1]
    return result


def inventory(value, repository, branch, limit):
    if not isinstance(value, list) or len(value) >= limit:
        raise ValueError('inventory')  # A full page is ambiguous; never claim completeness.
    seen = set()
    for item in value:
        if not isinstance(item, dict) or set(item) != {'number', 'url', 'state', 'headRefName'}:
            raise ValueError('inventory')
        number = item['number']
        if type(number) is not int or number <= 0 or number in seen:
            raise ValueError('inventory')
        seen.add(number)
        if item['url'] != 'https://github.com/' + repository + '/pull/' + str(number) or item['state'] not in ['OPEN', 'CLOSED', 'MERGED'] or item['headRefName'] != branch:
            raise ValueError('inventory')
    return sorted(value, key=lambda item: item['number'])


def main():
    parser = B.QuietParser(description=__doc__)
    parser.add_argument('mode', choices=['record', 'check'])
    parser.add_argument('--repository', required=True)
    parser.add_argument('--branch', required=True)
    parser.add_argument('--baseline', required=True)
    parser.add_argument('--expectations', required=True)
    parser.add_argument('--terminal-completed-at')
    parser.add_argument('--timeout-seconds', type=float, default=30)
    parser.add_argument('--pr-limit', type=int, default=100)
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repository) or not re.fullmatch(r'sam/[A-Za-z0-9_/-]+', args.branch) or not math.isfinite(args.timeout_seconds) or args.timeout_seconds <= 0 or not 1 <= args.pr_limit <= 1000:
        raise ValueError('configuration')
    baseline = json.loads(Path(args.baseline).read_text())
    A.validate(baseline)
    if baseline['branch'] != args.branch:
        raise ValueError('branch')
    expected_refs = refs(baseline['remoteRefs'])
    path = Path(args.expectations)
    expected = None
    if args.mode == 'record':
        if path.exists():
            raise ValueError('existing expectations')
    else:
        expected = json.loads(path.read_text())
        if not isinstance(expected, dict) or set(expected) != {'repository', 'branch', 'remoteRefs', 'prs', 'recordedAt', 'prLimit'}:
            raise ValueError('expectations')
        if expected['repository'] != args.repository or expected['branch'] != args.branch or expected['prLimit'] != args.pr_limit or expected['remoteRefs'] != expected_refs:
            raise ValueError('expectations')
        inventory(expected['prs'], args.repository, args.branch, args.pr_limit)
        completed = timestamp(args.terminal_completed_at)
        if not timestamp(expected['recordedAt']) < completed <= datetime.datetime.now(datetime.timezone.utc):
            raise ValueError('completion time')
    runner = B.Probe(SimpleNamespace(timeout_seconds=args.timeout_seconds))
    code, output = runner.run('remoteRefs', ['git', 'ls-remote', '--heads', 'https://github.com/' + args.repository + '.git'])
    if code != 0:
        raise ValueError('remote query')
    observed_refs = refs(output.decode())
    code, output = runner.run('prInventory', ['gh', 'pr', 'list', '--repo', args.repository, '--head', args.branch,
                                            '--state', 'all', '--limit', str(args.pr_limit), '--json', 'number,url,state,headRefName'])
    if code != 0:
        raise ValueError('pr query')
    observed_prs = inventory(json.loads(output), args.repository, args.branch, args.pr_limit)
    checks = {'remoteRefsUnchanged': observed_refs == expected_refs}
    if args.mode == 'record':
        checks['expectationsRecorded'] = False
        if checks['remoteRefsUnchanged']:
            value = {'repository': args.repository, 'branch': args.branch, 'remoteRefs': expected_refs,
                     'prs': observed_prs, 'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'prLimit': args.pr_limit}
            temporary = path.with_name(path.name + '.tmp')
            temporary.write_text(json.dumps(value, sort_keys=True) + '\n')
            temporary.replace(path)
            checks['expectationsRecorded'] = True
    else:
        checks['taskBranchPrInventoryUnchanged'] = observed_prs == expected['prs']
        checks['observedAfterTerminal'] = True
    print(json.dumps({'checks': checks, 'statuses': runner.statuses}, sort_keys=True))
    return 0 if all(checks.values()) else 1


if __name__ == '__main__':
    try:
        result = main()
    except Exception:
        print(json.dumps({'checks': {'observerCompleted': False}, 'statuses': {'observer': 1}}))
        result = 1
    raise SystemExit(result)
