import os,json,urllib.request,urllib.error,datetime,uuid,hashlib,time
from pathlib import Path
root=Path('/workspaces/simple-agent-manager/.agent-evidence/publication-supplement/b15b14fe-e7fa-4041-90e3-7fa55a560e49')
call='exec-403c262a-4f59-43e8-b91f-4a046d01094f';session='4e5282b9-0cd5-454f-a8f0-db160b9823fe';fid='01M52GZ6HHCV06MB8NAF1WWECH'
out={'observedAtMs':int(time.time()*1000),'operation':'download_library_file','toolCallId':call,'sessionId':session,'fileId':fid,'timeRange':{'from':'2026-10-16T14:14:07Z','to':'2026-10-16T14:14:18Z'},'source':'Cloudflare retained observability sam-api-staging','httpStatus':None,'correlated':[],'causeEstablished':False}
def epoch(t):return int(datetime.datetime.fromisoformat(t.replace('Z','+00:00')).timestamp()*1000)
body={'queryId':str(uuid.uuid4()),'timeframe':{'from':epoch(out['timeRange']['from']),'to':epoch(out['timeRange']['to'])},'view':'events','limit':50,'parameters':{'datasets':[],'filters':[{'key':'$workers.scriptName','operation':'eq','type':'string','value':'sam-api-staging'}],'orderBy':{'value':'timestamp','order':'desc'},'limit':50,'needle':{'value':fid,'isRegex':False,'matchCase':False}}}
try:
 req=urllib.request.Request('https://api.cloudflare.com/client/v4/accounts/'+os.environ['CF_ACCOUNT_ID']+'/workers/observability/telemetry/query',headers={'Authorization':'Bearer '+os.environ['CF_TOKEN'],'Content-Type':'application/json'},data=json.dumps(body).encode(),method='POST')
 with urllib.request.urlopen(req,timeout=20) as r:out['httpStatus']=r.status;raw=r.read()
 out['responseSha256']=hashlib.sha256(raw).hexdigest();v=json.loads(raw);result=v.get('result',{});ev=result.get('events',{});rows=ev.get('events',[]) if isinstance(ev,dict) else ev if isinstance(ev,list) else []
 out['returnedCount']=len(rows);out['boundedLimitReached']=len(rows)>=50
 def classify(s):
  z=s.lower()
  if 'file not found' in z or 'not found in library' in z:return 'library-file-not-found'
  if 'invalid' in z and ('path' in z or 'parameter' in z or 'argument' in z):return 'incorrect-invocation'
  if 'forbidden' in z or 'unauthorized' in z or 'permission denied' in z:return 'auth-rejection'
  if 'timed out' in z or 'timeout' in z or 'connection refused' in z or 'network' in z:return 'transport'
  if 'workspace' in z and ('not running' in z or 'not reachable' in z or 'unavailable' in z):return 'workspace-unreachable'
  return 'unclassified'
 for row in rows:
  serial=json.dumps(row,sort_keys=True);hasFile=fid in serial;hasSession=session in serial;hasCall=call in serial
  if not(hasFile or hasSession or hasCall):continue
  known=[x for x in ['mcp.download_library_file.error','mcp.tool_error','mcp.request.error'] if x in serial]
  cat=classify(serial);out['correlated'].append({'operation':'download_library_file','event':known[0] if known else 'unclassified','timestamp':row.get('timestamp') if isinstance(row.get('timestamp'),(int,float)) else None,'correlation':{'fileIdMatches':hasFile,'sessionIdMatches':hasSession,'toolCallIdMatches':hasCall},'category':cat,'sourceRowSha256':hashlib.sha256(serial.encode()).hexdigest()})
 out['causeEstablished']=any(x['category']!='unclassified' for x in out['correlated']);out['result']='correlated-cause' if out['causeEstablished'] else 'no-retained-correlated-cause'
except urllib.error.HTTPError as e:out['httpStatus']=e.code;out['result']='retained-log-access-denied' if e.code in [401,403] else 'retained-log-query-unavailable'
except Exception:out['result']='retained-log-query-unavailable'
(root/'retained-call-log-projection.json').write_text(json.dumps(out,sort_keys=True,indent=2)+'\n');print(json.dumps(out))
