import os,json,urllib.request,time
from pathlib import Path
out={'observedAtMs':int(time.time()*1000),'ok':False}
try:
 base='https://api.cloudflare.com/client/v4/accounts/'+os.environ['CF_ACCOUNT_ID'];headers={'Authorization':'Bearer '+os.environ['CF_TOKEN'],'Content-Type':'application/json'}
 def req(p,d=None):
  with urllib.request.urlopen(urllib.request.Request(base+p,headers=headers,data=None if d is None else json.dumps(d).encode()),timeout=15) as r:return json.load(r)['result']
 bs=req('/workers/scripts/sam-api-staging/settings')['bindings'];db=next(x['id'] for x in bs if x.get('name')=='DATABASE')
 rows=req('/d1/database/'+db+'/query',{'sql':"SELECT t.id,t.status,t.workspace_id,t.claimed_warm_node_id,w.status workspace_status,w.node_id,n.status node_status,n.runtime,n.agent_version,n.capacity_pool_revision,n.warm_since FROM tasks t LEFT JOIN workspaces w ON w.id=t.workspace_id LEFT JOIN nodes n ON n.id=w.node_id WHERE t.id=?",'params':['01M527WRMMRR56ESJF21NW6EV0']})[0]['results']
 out['rows']=rows;out['ok']=True
except Exception:pass
Path('/workspaces/simple-agent-manager/.agent-evidence/01M527WRMMRR56ESJF21NW6EV0/cleanup-canonical.json').write_text(json.dumps(out,sort_keys=True,indent=2)+'\n');print(json.dumps(out))
