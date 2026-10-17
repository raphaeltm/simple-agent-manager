#!/usr/bin/env python3
"""Actual observer CLI tests with synthetic data and no live credentials/network."""
import datetime
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
CANARY = 'ghs_' + 'SYNTHETIC_ONLY_CANARY'.ljust(36, 'X')


class ObserverTests(unittest.TestCase):
    def test_actual_cli_private_streams_fail_closed_and_comparisons(self):
        with tempfile.TemporaryDirectory(prefix='sam-observer-canary-') as tmp:
            root = Path(tmp)
            files = ['.reliability-a/tracked.txt', '.reliability-a/staged-new.txt', '.reliability-a/untracked.txt', '.do-state.md', '.workflow-state.md']
            baseline = {'head': 'b'*40, 'branch': 'sam/test-task', 'index': 'c'*40, 'status': '',
                        'files': {name: 'd'*64 for name in files}, 'stagedTracked': 'staged', 'stagedNew': 'new',
                        'remoteRefs': 'a'*40+'\trefs/heads/main'}
            (root/'baseline.json').write_text(json.dumps(baseline))
            fake = '''#!/usr/bin/env python3
import os,sys,json,time
mode=os.environ['OBSERVER_MODE']
print(os.environ['PROBE_CANARY'],file=sys.stderr,flush=True)
if mode=='failure':print(os.environ['PROBE_CANARY']);sys.exit(42)
if mode=='timeout':time.sleep(2)
if sys.argv[0].endswith('/git'):
 if mode=='malformedrefs':print(os.environ['PROBE_CANARY'])
 else:print(('e' if mode=='refsmismatch' else 'a')*40+'\\trefs/heads/main')
else:
 if mode=='malformedprs':print(os.environ['PROBE_CANARY'])
 elif mode=='prmismatch':print(json.dumps([dict(number=1,url='https://github.com/owner/disposable/pull/1',state='OPEN',headRefName='sam/test-task')]))
 else:print('[]')
'''
            for name in ['git','gh']:
                path=root/name;path.write_text(fake);path.chmod(0o700)
            env={**os.environ,'PATH':str(root)+os.pathsep+os.environ['PATH'],'PROBE_CANARY':CANARY}
            common=['--repository','owner/disposable','--branch','sam/test-task','--baseline',str(root/'baseline.json'),'--expectations',str(root/'expected.json'),'--timeout-seconds','0.05']
            def run(mode, behavior='normal', extra=None):
                result=subprocess.run(['python3',str(ROOT/'terminal-observer.py'),mode,*common,*(extra or [])],env={**env,'OBSERVER_MODE':behavior},cwd=root,capture_output=True,text=True,timeout=4)
                self.assertNotIn(CANARY,result.stdout+result.stderr)
                output=json.loads(result.stdout)
                self.assertEqual(set(output),{'checks','statuses'})
                self.assertTrue(output['checks'])
                self.assertTrue(all(type(v) is bool for v in output['checks'].values()))
                self.assertTrue(all(type(v) is int for v in output['statuses'].values()))
                return result,output
            # Failure/interruption cannot create valid expectations.
            for behavior in ['failure','timeout','malformedrefs','malformedprs','refsmismatch']:
                result,_=run('record',behavior)
                self.assertEqual(result.returncode,1)
                self.assertFalse((root/'expected.json').exists())
            result,_=run('record')
            self.assertEqual(result.returncode,0)
            terminal=datetime.datetime.now(datetime.timezone.utc).isoformat()
            args=['--terminal-completed-at',terminal]
            result,output=run('check',extra=args)
            self.assertEqual(result.returncode,0)
            self.assertTrue(all(output['checks'].values()))
            for behavior in ['failure','timeout','malformedrefs','malformedprs','refsmismatch','prmismatch']:
                result,_=run('check',behavior,args)
                self.assertEqual(result.returncode,1)
            for value in ['{}','{',json.dumps({'unexpected':CANARY})]:
                original=(root/'expected.json').read_text()
                (root/'expected.json').write_text(value)
                result,_=run('check',extra=args)
                self.assertEqual(result.returncode,1)
                (root/'expected.json').write_text(original)
            for extra in [[],['--terminal-completed-at',CANARY],['--timeout-seconds',CANARY],['--pr-limit',CANARY]]:
                result,_=run('check',extra=extra)
                self.assertEqual(result.returncode,1)


if __name__=='__main__':
    unittest.main()
