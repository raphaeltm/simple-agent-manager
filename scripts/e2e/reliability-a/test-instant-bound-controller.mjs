import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,chmodSync,copyFileSync,existsSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
const here=dirname(fileURLToPath(import.meta.url)),canary='cookie=ghs_'+'S'.repeat(36),project='01KJNR9R3TEN3KX1ETE33852R8',repository='serverspresentation2025/crewai';
const uid=n=>String(n).padStart(26,'0');
function execute(binary,args,cwd,expected=0,env={}){
 const r=spawnSync(binary,args,{cwd,encoding:'utf8',timeout:10000,env:{...process.env,GIT_AUTHOR_NAME:'Synthetic Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Synthetic Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid',...env}});
 assert.equal(r.status,expected,'bounded actual command status');assert.equal(r.signal,null,'bounded command');return r.stdout;
}
test('actual supervised exact-context lifecycle preserves ownership, completion and ALL-ref sequencing without credential output',()=>{
 const root=mkdtempSync(join(tmpdir(),'sam-bound-instant-'));
 try{
  const remote=join(root,'remote.git'),repo=join(root,'repo'),bin=join(root,'bin');mkdirSync(repo);mkdirSync(bin);
  execute('git',['init','--bare','--quiet',remote],root);execute('git',['--git-dir='+remote,'symbolic-ref','HEAD','refs/heads/main'],root);execute('git',['init','--quiet','--initial-branch=main'],repo);
  execute('git',['commit','--quiet','--allow-empty','-m','synthetic baseline'],repo);execute('git',['remote','add','origin',remote],repo);
  execute('git',['push','--quiet','origin','main','HEAD:refs/heads/sam/first','HEAD:refs/heads/sam/final'],repo);
  execute('git',['switch','--quiet','-c','sam/first'],repo);
  execute('python3',[join(here,'git-probe.py'),'prepare','--disposable-repository'],repo);
  const baseline=JSON.parse(readFileSync(join(repo,'.reliability-a/baseline.json'),'utf8'));
  writeFileSync(join(bin,'git'),`#!/usr/bin/env python3\nimport os,sys\na=sys.argv[1:]\nsys.stderr.write(${JSON.stringify(canary)})\nif a==['ls-remote','--heads','https://github.com/${repository}.git']:a=['ls-remote','--heads',os.environ['TEST_REMOTE']]\nos.execv('/usr/bin/git',['git',*a])\n`);chmodSync(join(bin,'git'),0o700);
  writeFileSync(join(bin,'gh'),`#!/bin/sh\nprintf '[]\\n'\nprintf '%s' '${canary}' >&2\n`);chmodSync(join(bin,'gh'),0o700);
  const expectedPath=join(root,'expectations.json'),probeEnv={PATH:bin+':'+process.env.PATH,TEST_REMOTE:remote};
  const observerArgs=[join(here,'terminal-observer.py'),'record','--repository',repository,'--branch','sam/first','--baseline',join(repo,'.reliability-a/baseline.json'),'--expectations',expectedPath];
  execute('python3',observerArgs,repo,0,probeEnv);
  const expectations=JSON.parse(readFileSync(expectedPath,'utf8')),completedAt=new Date().toISOString();
  const checkArgs=[...observerArgs];checkArgs[1]='check';checkArgs.push('--terminal-completed-at',completedAt);
  const good=JSON.parse(execute('python3',checkArgs,repo,0,probeEnv));
  execute('git',['push','--quiet','origin','main:refs/heads/sam/future-vm'],repo);
  const bad=JSON.parse(execute('python3',checkArgs,repo,1,probeEnv));
  assert.equal(good.checks.remoteRefsUnchanged,true);assert.equal(bad.checks.remoteRefsUnchanged,false,'next startup branch invalidates old protected baseline');
  for(const mode of ['ok','changed-refs','foreign-project','foreign-session','wrong-runtime','wrong-profile','wrong-branch','no-reopen-proof','reopen','pending-delete','cleanup','sleep','expired','expired-cleanup','prepare','check-record','wake-check','complete','missing-phase','null-state','late-phase']){
   const dir=join(root,mode);mkdirSync(dir,{mode:0o700});
   const contexts=[0,1].map(i=>({taskId:uid(10+i),sessionId:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,workspaceId:uid(20+i),nodeId:uid(30+i),branch:i?'sam/final':'sam/first',agentProfileId:uid(40+i),agentType:i?'claude-code':'openai-codex',submittedAt:Date.now()-2000,evidencePrUrl:`https://github.com/${repository}/pull/1`,receipt:{taskId:uid(10+i),sessionId:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,branchName:i?'sam/final':'sam/first',status:'queued'}}));
   const c={createdAt:Date.now()-3000,expiresAt:Date.now()+7_000_000,contexts,cleanupAuthorized:true};
   if(['expired','expired-cleanup'].includes(mode))c.expiresAt=Date.now()-1;
   const kind=['cleanup','pending-delete','expired-cleanup'].includes(mode)?'cleanup':mode==='sleep'?'sleep':['prepare','check-record','wake-check','complete'].includes(mode)?mode:['missing-phase','late-phase'].includes(mode)?'wake-check':'observe';
   const op={kind,contextSlot:1,...(kind==='observe'?{target:{taskId:contexts[0].taskId,branch:'sam/first',baseline,expectations}}:{})};
   writeFileSync(join(dir,'config.json'),JSON.stringify(c),{mode:0o600});writeFileSync(join(dir,'operation.json'),JSON.stringify(op),{mode:0o600});
   if(['check-record','wake-check','complete','late-phase'].includes(mode))writeFileSync(join(dir,contexts[1].taskId+'-phase-start.json'),JSON.stringify({startedAt:Date.now()-(mode==='late-phase'?781000:500)}),{mode:0o600});
   writeFileSync(join(dir,'observer-artifact.json'),JSON.stringify({artifactId:uid(50),taskId:contexts[1].taskId}),{mode:0o600});
   if(mode==='reopen')writeFileSync(join(dir,contexts[1].taskId+'-independent-proof.json'),JSON.stringify({taskId:contexts[1].taskId,branch:contexts[1].branch,completedAt,...good}),{mode:0o600});
   for(const name of ['queue-controller.mjs','b-probe.py','git-probe.py','terminal-observer.py'])copyFileSync(join(here,name),join(dir,name));
   const mock=join(dir,'mock.mjs');
   writeFileSync(mock,`const own=${JSON.stringify(contexts[1])},target=${JSON.stringify(contexts[0])},mode=${JSON.stringify(mode)},kind=${JSON.stringify(kind)},completedAt=${JSON.stringify(completedAt)},canary=${JSON.stringify(canary)},probe=${JSON.stringify(mode==='changed-refs'?bad:good)};
    let loggedIn=false,prompted=false,deleted=false;
    export const chromium={launch:async()=>({newContext:async()=>({request:{fetch:async(url,options)=>{
     console.log(canary);console.error(canary);
     if(options.headers.Origin!=='https://api.sammy.party'||options.maxRedirects!==0)throw new Error(canary);
     const path=new URL(url).pathname;let status=200,body={};
     if(path==='/api/auth/token-login')loggedIn=true;
     else if(path==='/api/auth/sign-out')loggedIn=false;
     else if(path==='/api/auth/get-session')body=null;
     else if(path==='/api/nodes'){if(!loggedIn)status=403;else body=[{id:own.nodeId,cloudProvider:mode==='wrong-runtime'?'hetzner':'cloudflare',providerInstanceType:'cf-container'}];}
     else if(path==='/api/projects/${project}/tasks/'+own.taskId)body={id:own.taskId,projectId:mode==='foreign-project'?'foreign':${JSON.stringify(project)},outputBranch:mode==='wrong-branch'?'sam/foreign':own.branch,agentProfileHint:mode==='wrong-profile'?'foreign':own.agentProfileId,taskMode:'task',workspaceId:deleted?null:own.workspaceId,status:deleted?'cancelled':mode==='complete'&&prompted?'completed':['reopen','no-reopen-proof'].includes(mode)&&!prompted?'completed':'in_progress',completedAt:mode==='complete'&&prompted?new Date().toISOString():completedAt};
     else if(path==='/api/projects/${project}/tasks/'+target.taskId)body={id:target.taskId,projectId:${JSON.stringify(project)},outputBranch:target.branch,status:'completed',completedAt,completionEvidence:{notes:canary}};
     else if(path==='/api/workspaces/'+own.workspaceId){
      if(options.method==='DELETE'){if(mode==='pending-delete'){status=202;body={success:true,deletionStatus:'pending'};}else{deleted=true;body={success:true,deletionStatus:'confirmed'};}}
      else if(deleted)status=404;
      else body={id:own.workspaceId,projectId:${JSON.stringify(project)},chatSessionId:mode==='foreign-session'?target.sessionId:own.sessionId,nodeId:own.nodeId,branch:own.branch,repository:${JSON.stringify(repository)},workspaceProfile:'lightweight',status:'running',errorMessage:canary};
     }else if(path==='/api/projects/${project}/sessions/'+own.sessionId+'/state')body={agentSessionId:mode==='null-state'?null:'33333333-3333-4333-8333-333333333333',agentType:own.agentType,state:{activity:'idle',runtimeWorkState:'inactive',runtimeWorkCount:0,activityAt:Date.now(),runtimeWorkUpdatedAt:Date.now()}};
     else if(path==='/api/projects/${project}/sessions/'+own.sessionId+'/prompt'){
      if(options.method!=='POST'||!(kind==='observe'?options.data.content.includes('/terminal-observer.py check')&&options.data.content.includes('sam/first'):options.data.content.includes('Reliability acceptance '+kind))||options.data.content.includes('git push'))throw new Error(canary);
      if(['foreign-project','foreign-session','wrong-runtime','wrong-profile','wrong-branch','no-reopen-proof','expired'].includes(mode))throw new Error(canary);
      prompted=true;body={accepted:true,status:'queued'};
     }else if(path==='/api/projects/${project}/sessions/'+own.sessionId+'/stop')body={status:'stopped',workspaceDeleted:true};
     else if(path==='/api/workspaces/'+own.workspaceId+'/sleep')body={status:'sleeping',workspaceId:own.workspaceId,chatSessionId:own.sessionId,snapshotExpiresAt:new Date(Date.now()+60000).toISOString()};
     else if(path==='/api/projects/${project}/library/${uid(50)}/download')body=probe;
     else throw new Error(canary);
     if(options.method==='DELETE'&&path!=='/api/workspaces/'+own.workspaceId)throw new Error(canary);
     return {status:()=>status,json:async()=>body,dispose:async()=>{}};
    }}}),close:async()=>{}})};`);
   const source=readFileSync(join(here,'instant-bound-controller.mjs'),'utf8').replace("'/tmp/reliability-browser-deps/node_modules/playwright/index.mjs'",JSON.stringify(pathToFileURL(mock).href));
   const entry=join(dir,'entry.mjs');writeFileSync(entry,source);
   const r=spawnSync(process.execPath,[join(here,'safe-controller.mjs'),entry,'5000'],{encoding:'utf8',timeout:7000,env:{...process.env,SAM_INSTANT_BOUND_ROOT:dir,SAM_PLAYWRIGHT_PRIMARY_USER:canary}});
   assert.equal(r.status,0,'supervised status');assert.equal(r.stderr,'','private stderr');assert.ok(!r.stdout.includes(canary),'private stdout');
   const pass=['ok','reopen','cleanup','sleep','expired-cleanup','prepare','check-record','wake-check','complete'].includes(mode);assert.equal(JSON.parse(r.stdout).category,pass?'ok':'controller','mode '+mode);
   if(pass){const file=join(dir,'result.json');assert.ok(!readFileSync(file,'utf8').includes(canary),'safe sidecar');assert.equal(statSync(file).mode&0o777,0o600);}
   else assert.equal(existsSync(join(dir,'result.json')),false,'no failed sidecar');
   if(mode==='reopen')assert.equal(JSON.parse(readFileSync(join(dir,contexts[1].taskId+'-before-reopen.json'),'utf8')).completedAt,completedAt,'preserved original completion');
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});
