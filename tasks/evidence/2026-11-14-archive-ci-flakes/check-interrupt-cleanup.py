import json,os,signal,subprocess,sys,tempfile,time
from pathlib import Path
source=Path('tasks/evidence/2026-11-14-archive-ci-flakes/repeat-files.py').read_text()
def active(pid):
    try:return Path(f'/proc/{pid}/stat').read_text().split()[2]!='Z'
    except FileNotFoundError:return False
def check(text,label):
    with tempfile.TemporaryDirectory(prefix='archive-interrupt-') as tmp:
        root=Path(tmp); script=root/'tasks/evidence/check/repeat-files.py'
        script.parent.mkdir(parents=True);script.write_text(text)
        stub=root/'pnpm'
        stub.write_text('#!/usr/bin/env python3\nimport os,subprocess,sys,time,json\nfrom pathlib import Path\np=subprocess.Popen([sys.executable,"-c","import time; time.sleep(120)"])\nPath(os.environ["HARNESS_PID_FILE"]).write_text(json.dumps([os.getpid(),p.pid]))\np.wait()\n')
        stub.chmod(0o755);pidfile=root/'pids.json'
        env={**os.environ,'PATH':str(root)+':'+os.environ['PATH'],'HARNESS_PID_FILE':str(pidfile)}
        p=subprocess.Popen([sys.executable,str(script),'lifecycle','loaded','--count','1'],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
        ids=[];burners=[]
        try:
            deadline=time.monotonic()+15
            while not pidfile.exists() and time.monotonic()<deadline:
                if p.poll() is not None:raise RuntimeError(p.communicate())
                time.sleep(.05)
            ids=json.loads(pidfile.read_text())
            burners=[int(x) for x in Path(f'/proc/{p.pid}/task/{p.pid}/children').read_text().split() if int(x)!=ids[0]]
            os.kill(p.pid,signal.SIGINT)
            p.communicate(timeout=15)
            time.sleep(.2)
            result={'label':label,'exitCode':p.returncode,'testProcessesStillActive':[pid for pid in ids if active(pid)],'burnersStillActive':[pid for pid in burners if active(pid)]}
            return result
        finally:
            if ids:
                try:os.killpg(ids[0],signal.SIGKILL)
                except ProcessLookupError:pass
            for pid in burners+[p.pid]:
                try:os.killpg(pid,signal.SIGKILL)
                except ProcessLookupError:pass
            p.communicate(timeout=5)
fixed=source
before_source=source.replace('            except subprocess.TimeoutExpired:\n                code = 124\n            finally:\n                stop_group(process)', '            except subprocess.TimeoutExpired:\n                stop_group(process)\n                code = 124')
assert before_source!=fixed
before=check(before_source,'cleanup guard removed');after=check(fixed,'current unconditional cleanup')
assert before['testProcessesStillActive'] and not before['burnersStillActive'],before
assert not after['testProcessesStillActive'] and not after['burnersStillActive'],after
report={'behavior':'SIGINT while waiting for real separate-session test process with child and CPU burners','before':before,'after':after,'finallyCleanupOfAllProbeProcesses':True,'sourceFixtureSizeOrTestSemanticsChanged':False}
Path('tasks/evidence/2026-11-14-archive-ci-flakes/interrupt-cleanup.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
