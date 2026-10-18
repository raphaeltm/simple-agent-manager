import os,json,urllib.request,time
from pathlib import Path
out={'observedAtMs':int(time.time()*1000),'ok':False}
try:
 base='https://api.cloudflare.com/client/v4/accounts/'+os.environ['CF_ACCOUNT_ID'];headers={'Authorization':'Bearer '+os.environ['CF_TOKEN'],'Content-Type':'application/json'}
 def req(p,d=None):
  with urllib.request.urlopen(urllib.request.Request(base+p,headers=headers,data=None if d is None else json.dumps(d).encode()),timeout=15) as r:return json.load(r)['result']
 bs=req('/workers/scripts/sam-api-staging/settings')['bindings'];db=next(x['id'] for x in bs if x.get('name')=='DATABASE')
 rows=req('/d1/database/'+db+'/query',{'sql':"SELECT s.id,s.chat_session_id,s.status,s.recovery_status,s.recovery_claimed_at,s.recovery_task_id,t.status task_status FROM session_snapshots s LEFT JOIN tasks t ON t.id=s.recovery_task_id WHERE s.project_id=? AND (s.recovery_claimed_at IS NOT NULL OR s.recovery_status='waking')",'params':['01KJNR9R3TEN3KX1ETE33852R8']})[0]['results']
 out['rows']=rows
 exact=req('/d1/database/'+db+'/query',{'sql':"SELECT COUNT(*) n FROM session_snapshots WHERE chat_session_id IN (?,?) AND (recovery_claimed_at IS NOT NULL OR recovery_status='waking')",'params':['4e5282b9-0cd5-454f-a8f0-db160b9823fe','f5f56c5b-e9fb-4218-b327-bd9d4b7e25e9']})[0]['results'][0]['n']
 out['exactBoundSessionsRecoveryCount']=exact;out['exactBoundSessionsRecoveryZero']=exact==0
 out['historicalTaskTerminal']=all(r['task_status'] in ['failed','cancelled','completed'] for r in rows)
 out['ok']=True
except Exception:pass
Path('/workspaces/simple-agent-manager/.agent-evidence/reliability-a-fresh-return-20261016/recovery-detail.json').write_text(json.dumps(out,sort_keys=True,indent=2)+'\n');print(json.dumps(out))
