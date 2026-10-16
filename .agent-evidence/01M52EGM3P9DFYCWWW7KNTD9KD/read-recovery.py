import os,json,urllib.request,time
from pathlib import Path
out={'observedAtMs':int(time.time()*1000),'ok':False}
try:
 base='https://api.cloudflare.com/client/v4/accounts/'+os.environ['CF_ACCOUNT_ID'];headers={'Authorization':'Bearer '+os.environ['CF_TOKEN'],'Content-Type':'application/json'}
 def req(p,d=None):
  with urllib.request.urlopen(urllib.request.Request(base+p,headers=headers,data=None if d is None else json.dumps(d).encode()),timeout=15) as r:return json.load(r)['result']
 bs=req('/workers/scripts/sam-api-staging/settings')['bindings'];db=next(x['id'] for x in bs if x.get('name')=='DATABASE')
 rows=req('/d1/database/'+db+'/query',{'sql':"SELECT t.id,t.status,t.workspace_id,t.claimed_warm_node_id,w.status workspace_status,w.node_id,n.status node_status,n.runtime,n.agent_version,n.capacity_pool_revision,n.warm_since FROM tasks t LEFT JOIN workspaces w ON w.id=t.workspace_id LEFT JOIN nodes n ON n.id=w.node_id WHERE t.id=?",'params':['01M52EGM3P9DFYCWWW7KNTD9KD']})[0]['results']
 out['rows']=rows
 def q(sql,params=[]):return req('/d1/database/'+db+'/query',{'sql':sql,'params':params})[0]['results']
 out['recovery']=q('SELECT id,status,recovery_status,recovery_claimed_at,recovery_task_id,recovery_workspace_id,restored_at FROM session_snapshots WHERE chat_session_id=?',['a9f622fa-f468-4826-9d8c-4db8a549d6f2'])
 out['globalNondeletedVmCount']=q("SELECT COUNT(*) n FROM nodes WHERE runtime='vm' AND status!='deleted'")[0]['n']
 out['globalNonterminalWarmClaims']=q("SELECT COUNT(*) n FROM tasks WHERE claimed_warm_node_id IS NOT NULL AND status NOT IN ('completed','cancelled','failed')")[0]['n']
 out['ok']=True
except Exception:pass
Path('/workspaces/simple-agent-manager/.agent-evidence/01M52EGM3P9DFYCWWW7KNTD9KD/recovery-canonical.json').write_text(json.dumps(out,sort_keys=True,indent=2)+'\n');print(json.dumps(out))
