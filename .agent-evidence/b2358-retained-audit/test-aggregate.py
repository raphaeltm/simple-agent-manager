import subprocess,sys,tempfile,time,os,signal,json
from pathlib import Path
probe=Path(__file__).with_name('b-probe-bounded.py').resolve()
with tempfile.TemporaryDirectory() as d:
 pidfile=Path(d)/'child.pid'
 code="import importlib.util,signal,types; s=importlib.util.spec_from_file_location('probe',"+repr(str(probe))+");m=importlib.util.module_from_spec(s);s.loader.exec_module(m);signal.signal(signal.SIGTERM,m.aggregate_deadline);p=m.Probe(types.SimpleNamespace(timeout_seconds=60));p.run('aggregate',['sh','-c',"+repr('echo $$ > '+str(pidfile)+'; exec sleep 60')+"])"
 proc=subprocess.Popen([sys.executable,'-c',code],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 limit=time.monotonic()+5
 while not pidfile.exists() and time.monotonic()<limit:time.sleep(.01)
 assert pidfile.exists()
 child=int(pidfile.read_text());proc.send_signal(signal.SIGTERM);out,err=proc.communicate(timeout=2)
 assert proc.returncode==124 and not out and not err
 try:os.kill(child,0)
 except ProcessLookupError:pass
 else:raise AssertionError('owned child survived')
 print(json.dumps({'aggregateSignalExit124':True,'ownedChildGone':True,'outputPrivate':True}))
