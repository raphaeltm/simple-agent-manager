#!/usr/bin/env python3
"""SPIKE ONLY. Auth key stays outside repo; outputs may contain sensitive exec data."""
import argparse,json,pathlib,time,urllib.request,urllib.error
p=argparse.ArgumentParser();p.add_argument('url');p.add_argument('id');p.add_argument('command');p.add_argument('--timeout',type=int,default=90000);p.add_argument('--output');p.add_argument('--key-file',default='/tmp/cf-spike2/key');p.add_argument('--destroy',action='store_true');a=p.parse_args()
req=urllib.request.Request(a.url+('/destroy' if a.destroy else '/exec')+'?id='+a.id,data=json.dumps({'command':a.command,'timeoutMs':a.timeout}).encode(),headers={'Authorization':'Bearer '+pathlib.Path(a.key_file).read_text().strip(),'Content-Type':'application/json','User-Agent':'curl/8.0'})
t=time.monotonic()
try:
 with urllib.request.urlopen(req,timeout=a.timeout/1000+120) as r: data=r.read().decode()
except urllib.error.HTTPError as e:data=e.read().decode()
try: response=json.loads(data)
except json.JSONDecodeError: response={'raw':data}
result={'clientSeconds':time.monotonic()-t,'response':response}
if a.output:pathlib.Path(a.output).write_text(json.dumps(result,indent=2))
print(json.dumps(result,indent=2))
