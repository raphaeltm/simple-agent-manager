import os,subprocess,json,time,sys,statistics
from pathlib import Path
mode=sys.argv[1];start=int(sys.argv[2]);count=int(sys.argv[3]);root=Path.cwd(); began=time.monotonic();load=None
try:
 if mode=='loaded':
  cpu=int(sys.argv[4]) if len(sys.argv)>4 else min(os.sched_getaffinity(0));assert cpu in os.sched_getaffinity(0)
  load=subprocess.Popen(['taskset','-c',str(cpu),'python3','-c','while True: pass'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 for run in range(start,start+count):
  if time.monotonic()-began>440: raise RuntimeError('bounded batch elapsed limit')
  report=root/'.tmp'/f'final-allowance-{mode}-{run:02d}.json';log=root/'.tmp'/f'final-allowance-{mode}-{run:02d}.log'
  cmd=['pnpm','--filter','@simple-agent-manager/api','exec','vitest','run','tests/unit/durable-objects/project-data-archive-sharding.test.ts','--reporter=json',f'--outputFile={report}']
  if mode=='loaded':cmd=['taskset','-c',str(cpu)]+cmd
  t=time.monotonic()
  load_ticks_start=sum(map(int,Path(f'/proc/{load.pid}/stat').read_text().split()[13:15])) if load else 0
  with log.open('w') as out: result=subprocess.run(cmd,stdout=out,stderr=subprocess.STDOUT,timeout=120)
  data=json.loads(report.read_text());cases=[a for test in data['testResults'] for a in test['assertionResults']];target=next(a for a in cases if 'keeps every source-side scan' in a['title']); row={'mode':mode,'run':run,'pass':data['numPassedTests'],'fail':data['numFailedTests'],'wall_s':round(time.monotonic()-t,3),'target_ms':round(target['duration'],3)}
  if load:
   assert load.poll() is None, 'CPU load worker exited'
   row['cpu']=cpu
   row['load_cpu_s']=round((sum(map(int,Path(f'/proc/{load.pid}/stat').read_text().split()[13:15]))-load_ticks_start)/os.sysconf('SC_CLK_TCK'),3)
   assert row['load_cpu_s']>0, 'CPU load worker consumed no CPU'
  print(json.dumps(row),flush=True)
  with (root/'.tmp'/'final-allowance-repeats.jsonl').open('a') as out:out.write(json.dumps(row)+'\n')
  assert result.returncode==0 and row['pass']==47 and row['fail']==0,row
finally:
 if load:
  load.terminate();load.wait(timeout=10)
