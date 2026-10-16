import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {baselineArtifact,expectationsArtifact,probeArtifact} from './queue-controller.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const ID='01ARZ3NDEKTSV4RRFFQ69G5FAV', OTHER='01ARZ3NDEKTSV4RRFFQ69G5FAW';
const PROBE='01ARZ3NDEKTSV4RRFFQ69G5FAX';
const UUID='11111111-1111-4111-8111-111111111111';
const CANARY='__Secure-better-auth.session_token=SYNTHETIC_ONLY_NOT_REAL_123456789';
const names=['.reliability-a/tracked.txt','.reliability-a/staged-new.txt','.reliability-a/untracked.txt','.do-state.md','.workflow-state.md'];
const baseline={head:'a'.repeat(40),branch:'sam/cell',index:'b'.repeat(40),status:'AM .reliability-a/tracked.txt\nA  .reliability-a/staged-new.txt\n?? .do-state.md',files:Object.fromEntries(names.map(n=>[n,'c'.repeat(64)])),stagedTracked:'staged tracked content',stagedNew:'staged new content',remoteRefs:'d'.repeat(40)+'\trefs/heads/main'};
const expectations={repository:'owner/disposable',branch:'sam/cell',remoteRefs:{'refs/heads/main':'d'.repeat(40)},prs:[],recordedAt:'2026-10-15T00:00:00.000Z',prLimit:100};
const fake=`import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
const secret=process.env.SAM_PLAYWRIGHT_PRIMARY_USER,mode=process.env.QUEUE_FAKE_MODE;let loggedOut=false,currentUrl='',stateCalls=0;
console.log(secret);process.stderr.write(secret);
const note=v=>appendFileSync(process.env.QUEUE_FAKE_EVENTS,JSON.stringify(v)+'\\n');
export const chromium={launch:async()=>{if(mode==='startup')throw new Error(secret);return {
newContext:async()=>({newPage:async()=>({goto:async url=>{currentUrl=mode==='screenshot-redirect'?'https://other.example.invalid/':url;},url:()=>currentUrl,screenshot:async options=>{if(mode==='screenshot-error'){writeFileSync(options.path,secret);throw new Error(secret);}writeFileSync(options.path,'SYNTHETIC_IMAGE_NOT_LIVE');}}),request:{fetch:async(url,options)=>{
if(url.endsWith('/state'))stateCalls++;
if(mode==='state-network'&&stateCalls===2&&url.endsWith('/state'))throw new Error(secret);
note({path:new URL(url).pathname,method:options.method,logout:url.endsWith('/sign-out'),normalOrigin:options.headers.Origin==='https://api.example.invalid',redirectsDisabled:options.maxRedirects===0});
if(!url.endsWith('/sign-out')&&!url.endsWith('/token-login')){if(mode==='network')throw new Error(secret);if(mode==='timeout'){const e=new Error(secret);e.name='TimeoutError';throw e;}if(mode==='hung')await new Promise(()=>{});}
if(url.endsWith('/sign-out'))loggedOut=true;
return {status:()=>loggedOut&&url.endsWith('/nodes')?401:mode==='delete-pending'&&options.method==='DELETE'?202:200,dispose:async()=>{},json:async()=>{
if(mode==='nonjson')throw new Error(secret);
if(url.endsWith('/get-session'))return loggedOut?null:{session:{token:secret}};
if(url.endsWith('/state')&&stateCalls===2&&['state-null','sleep-state-null'].includes(mode))return {state:null};
if(url.endsWith('/state')&&stateCalls===2&&mode==='state-missing')return {};
// Exact e2 route: resolveChatAgentState may merge a persisted plan before an ACP exists.
if(url.endsWith('/state')&&mode==='pending-agent')return {state:{activity:'idle',activityAt:0,statusError:null,promptStartedAt:null,agentType:null,lastStopReason:null,runtimeWorkState:null,runtimeWorkCount:null,runtimeWorkSource:null,runtimeWorkUpdatedAt:null,runtimeWorkProgressAt:null,currentPlan:[],planUpdatedAt:0},agentSessionId:null,agentType:null};
if(url.endsWith('/state')&&mode==='source-idle-no-agent')return {state:{activity:'idle',activityAt:0,runtimeWorkState:'inactive',runtimeWorkCount:0,statusError:null,currentPlan:null,planUpdatedAt:null,promptStartedAt:null,lastStopReason:null,agentType:null,runtimeWorkUpdatedAt:null,runtimeWorkProgressAt:null,runtimeWorkSource:null},agentSessionId:null,agentType:null};
if(url.endsWith('/state')&&mode==='null-to-uuid'&&stateCalls===1)return {state:{activity:'idle',activityAt:0,runtimeWorkState:null,runtimeWorkCount:null},agentSessionId:null};
if(url.endsWith('/state')&&mode==='bad-agent')return {state:{activity:'idle'},agentSessionId:secret};
if(url.endsWith('/state'))return {state:{activity:['recovering','error'].includes(mode)?mode:'idle',runtimeWorkState:'inactive',runtimeWorkCount:0,activityAt:mode==='fallback-clock'?0:Date.now(),runtimeWorkUpdatedAt:mode==='fallback-clock'?0:Date.now(),secret},agentSessionId:['uuid-agent','null-to-uuid','fallback-clock'].includes(mode)?'${UUID}':'${ID}',agentType:'openai-codex'};
if(url.endsWith('/submit'))return {taskId:'${ID}',sessionId:'${UUID}',status:'queued',branchName:'sam/cell',secret};
if(url.endsWith('/prompt'))return {accepted:mode!=='accepted-false',status:mode==='prompt-failed'?'failed':'queued',secret};
if(url.endsWith('/stop'))return {status:'stopped',workspaceDeleted:mode!=='deleted-false'};
if(url.endsWith('/sleep'))return {status:mode==='sleep-failed'?'failed':'sleeping',workspaceId:'${ID}',chatSessionId:'${UUID}',snapshotExpiresAt:'2026-10-16T00:00:00.000Z',success:mode!=='sleep-false'};
if(options.method==='DELETE')return {success:mode!=='success-false',deletionStatus:mode==='delete-pending'?'pending':'confirmed',...(mode==='delete-pending'?{workspaceStatus:'stopping',reason:secret}:{})};
if(url.includes('/library/'))return JSON.parse(readFileSync(url.includes('/${PROBE}/')?process.env.QUEUE_PROBE:url.includes('/${OTHER}/')?process.env.QUEUE_EXPECTATIONS:process.env.QUEUE_BASELINE,'utf8'));
if(url.endsWith('/tasks/${ID}'))return {id:mode==='task-mismatch'?'${OTHER}':'${ID}',status:'completed',workspaceId:'${ID}',completionEvidence:{notes:secret},outputPrUrl:secret,secret};
if(url.endsWith('/workspaces/${ID}'))return {id:mode==='workspace-mismatch'?'${OTHER}':'${ID}',nodeId:'${ID}',status:'running'};
return [{id:'${ID}',status:mode==='malformed'?secret:['recovery','evicted','deleted'].includes(mode)?mode:'running',nodeId:null,createdAt:'2026-10-15T00:00:00.000Z',updatedAt:'2026-10-15T00:00:00.000Z',secret}];}};
}}}),close:async()=>{note({closed:true});if(mode==='close')throw new Error(secret);if(mode==='hang-close')await new Promise(()=>{});}}}};`;
function fixture(mode,commands,{deadline=2500,invalidBaseline=false,invalidExpectations=false,screenshots=false,reuse=false,invalidProbe=false}={}){
 const root=mkdtempSync(join(tmpdir(),'sam-safe-queue-'));
 try{
  mkdirSync(join(root,'in'));const module=join(root,'fake.mjs');writeFileSync(module,fake);
  writeFileSync(join(root,'baseline.json'),JSON.stringify(invalidBaseline?{...baseline,stagedTracked:CANARY}:baseline));
  writeFileSync(join(root,'expectations.json'),JSON.stringify(invalidExpectations?{...expectations,prs:[{number:1,url:CANARY,state:'OPEN',headRefName:'sam/cell'}]}:expectations));
  writeFileSync(join(root,'probe.json'),JSON.stringify(invalidProbe?{checks:{prepared:CANARY,localCommitUnpublished:true},statuses:{probe:0}}:{checks:{prepared:true,localCommitUnpublished:true},statuses:{probe:0}}));
  commands.forEach((c,i)=>writeFileSync(join(root,'in',String(i+1).padStart(4,'0')+'.json'),JSON.stringify(c)));
  const invoke=()=>spawnSync(process.execPath,[join(here,'safe-controller.mjs'),join(here,'queue-controller.mjs'),String(deadline)],{encoding:'utf8',timeout:6000,env:{...process.env,SAM_PLAYWRIGHT_PRIMARY_USER:CANARY,SAM_VERIFICATION_ROOT:root,SAM_VERIFICATION_PROJECT_ID:ID,SAM_VERIFICATION_REPOSITORY:'owner/disposable',SAM_VERIFICATION_API_ORIGIN:'https://api.example.invalid',SAM_VERIFICATION_APP_ORIGIN:'https://app.example.invalid',SAM_VERIFICATION_PLAYWRIGHT_MODULE:pathToFileURL(module).href,SAM_VERIFICATION_DURATION_MS:'2000',SAM_VERIFICATION_SCREENSHOTS:screenshots?'completed-fixture-summary':'',QUEUE_FAKE_MODE:mode,QUEUE_FAKE_EVENTS:join(root,'events.jsonl'),QUEUE_BASELINE:join(root,'baseline.json'),QUEUE_EXPECTATIONS:join(root,'expectations.json'),QUEUE_PROBE:join(root,'probe.json'),DEBUG:'pw:api'}});
  const result=invoke();
  assert.equal(result.signal,null);assert.equal(result.status,0);assert.ok(!result.stdout.includes(CANARY));assert.ok(!result.stderr.includes(CANARY));assert.equal(result.stderr,'');
  const publicResult=JSON.parse(result.stdout);assert.deepEqual(Object.keys(publicResult).sort(),['category','checks','status']);
  const outputs={};for(const folder of ['out','private/state','private/artifacts'])if(existsSync(join(root,folder)))for(const name of readdirSync(join(root,folder))){const text=readFileSync(join(root,folder,name),'utf8');assert.ok(!text.includes(CANARY));outputs[folder+'/'+name]=name.endsWith('.png')?{privateImage:true}:JSON.parse(text);}
  if(existsSync(join(root,'ready.json')))assert.ok(!readFileSync(join(root,'ready.json'),'utf8').includes(CANARY));
  const events=existsSync(join(root,'events.jsonl'))?readFileSync(join(root,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse):[];
  let replay;
  if(reuse){const retry=invoke();assert.equal(retry.status,0);assert.ok(!retry.stdout.includes(CANARY));assert.equal(retry.stderr,'');replay=JSON.parse(retry.stdout);const after=readFileSync(join(root,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.deepEqual(after,events);}
  return {publicResult,outputs,events,replay};
 }finally{rmSync(root,{recursive:true,force:true});}
}
const getNodes={op:'request',path:'/api/nodes'};
const submit={op:'request',path:`/api/projects/${ID}/tasks/submit`,method:'POST',data:{message:'synthetic fixture',agentProfileId:OTHER,taskMode:'task'}};
const state={op:'request',path:`/api/projects/${ID}/sessions/${UUID}/state`};
const prompt={op:'request',path:`/api/projects/${ID}/sessions/${UUID}/prompt`,method:'POST',data:{content:'synthetic followup'}};
const artifact=schema=>({op:'artifact',artifactId:schema==='baseline'?ID:OTHER,taskId:ID,branch:'sam/cell',schema});

test('actual supervised queue lifecycle has private typed sinks, fixed public output and normal same-context logout',()=>{
 const v=fixture('normal',[getNodes,submit,state,prompt,artifact('baseline'),artifact('expectations'),{op:'stop'}]);
 assert.equal(v.publicResult.category,'ok');assert.equal(v.outputs['private/state/0002.json'].sessionId,UUID);
 assert.equal(v.outputs['private/state/0002.json'].branchName,'sam/cell');
 assert.equal(v.outputs[`private/artifacts/${ID}-expectations.json`].prs.length,0);
 assert.ok(v.events.some(e=>e.logout&&e.normalOrigin&&e.redirectsDisabled));assert.ok(v.events.some(e=>e.closed));
 for(const [key,value]of Object.entries(v.outputs))if(key.startsWith('out/'))assert.deepEqual(Object.keys(value).sort(),['category','checks','status']);
});
test('actual queue suppresses native/launch/request/parse/close errors and whole-job hangs',()=>{
 for(const mode of ['startup','network','timeout','nonjson','malformed','close','hung','hang-close']){
  const v=fixture(mode,[getNodes,{op:'stop'}],{deadline:mode.startsWith('hang')||mode==='hung'?500:2500});
  assert.notEqual(v.publicResult.category,'ok',mode);
 }
});
test('prompt cannot replace initial setup before a measured idle state',()=>{
 const v=fixture('normal',[submit,prompt,{op:'stop'}]);assert.notEqual(v.outputs['out/0002.json'].category,'ok');
 assert.ok(!v.outputs['private/state/0002.json']);
});
test('artifact sinks reject non-synthetic baseline or credential-shaped PR URL without a raw fallback',()=>{
 let v=fixture('normal',[artifact('baseline'),{op:'stop'}],{invalidBaseline:true});assert.notEqual(v.outputs['out/0001.json'].category,'ok');assert.ok(!v.outputs[`private/artifacts/${ID}-baseline.json`]);
 v=fixture('normal',[artifact('baseline'),artifact('expectations'),{op:'stop'}],{invalidExpectations:true});assert.notEqual(v.outputs['out/0002.json'].category,'ok');assert.ok(!v.outputs[`private/artifacts/${ID}-expectations.json`]);
});
test('exact artifact schemas reject partial baselines and incomplete PR inventory',()=>{
 assert.throws(()=>baselineArtifact({},'sam/cell'));assert.throws(()=>baselineArtifact({...baseline,extra:CANARY},'sam/cell'));
 assert.throws(()=>expectationsArtifact({...expectations,prs:[...Array(100)].map((_,i)=>({number:i+1,url:`https://github.com/owner/disposable/pull/${i+1}`,state:'OPEN',headRefName:'sam/cell'}))},baseline,'owner/disposable'));
});

const task={op:'request',path:`/api/projects/${ID}/tasks/${ID}`};
test('screenshots require explicit completed-fixture approval and reject a navigation redirect or screenshot error',()=>{
 const capture={op:'screenshot',taskId:ID};
 let v=fixture('normal',[submit,task,capture,{op:'stop'}]);assert.notEqual(v.outputs['out/0003.json'].category,'ok');
 v=fixture('normal',[submit,task,capture,{op:'stop'}],{screenshots:true});assert.equal(v.outputs['out/0003.json'].category,'ok');assert.ok(v.outputs[`private/artifacts/${ID}-summary.png`]);
 for(const mode of ['screenshot-redirect','screenshot-error']){v=fixture(mode,[submit,task,capture,{op:'stop'}],{screenshots:true});assert.notEqual(v.outputs['out/0003.json'].category,'ok');assert.ok(!v.outputs[`private/artifacts/${ID}-summary.png`]);}
});

const workspace={op:'request',path:`/api/workspaces/${ID}`};
const sleep={op:'request',path:`/api/workspaces/${ID}/sleep`,method:'POST'};
test('every state read invalidates stale idle authorization, including null/missing/error responses',()=>{
 for(const mode of ['state-null','state-missing','state-network']){const v=fixture(mode,[submit,state,state,prompt,{op:'stop'}]);assert.notEqual(v.outputs['out/0004.json'].category,'ok');assert.ok(!v.outputs['private/state/0004.json']);}
});
test('action and prompt results require affirmative route-specific success',()=>{
 for(const mode of ['accepted-false','prompt-failed']){const v=fixture(mode,[submit,state,prompt,{op:'stop'}]);assert.notEqual(v.outputs['out/0003.json'].category,'ok');}
 let v=fixture('success-false',[{op:'request',path:`/api/nodes/${ID}`,method:'DELETE'},{op:'stop'}]);assert.notEqual(v.outputs['out/0001.json'].category,'ok');
 v=fixture('deleted-false',[{op:'request',path:`/api/projects/${ID}/sessions/${UUID}/stop`,method:'POST'},{op:'stop'}]);assert.notEqual(v.outputs['out/0001.json'].category,'ok');
 for(const mode of ['sleep-false','sleep-failed']){v=fixture(mode,[submit,task,workspace,sleep,{op:'stop'}]);assert.notEqual(v.outputs['out/0004.json'].category,'ok');}
});
test('supported wake is one normal prompt after an affirmative sleep result, not an invented wake route',()=>{
 const v=fixture('sleep-state-null',[submit,task,workspace,state,sleep,state,prompt,{op:'stop'}]);assert.equal(v.outputs['out/0005.json'].category,'ok');assert.equal(v.outputs['out/0007.json'].category,'ok');
 const bad=fixture('normal',[{op:'request',path:`/api/workspaces/${ID}/wake`,method:'POST'},{op:'stop'}]);assert.notEqual(bad.outputs['out/0001.json'].category,'ok');
});

test('a previously used queue directory cannot replay old mutations or log in again',()=>{const v=fixture('normal',[submit,{op:'stop'}],{reuse:true});assert.notEqual(v.replay.category,'ok');});

test('private probe artifacts retain only fixed boolean/status labels, never arbitrary output or misleading empty objects',()=>{
 assert.deepEqual(probeArtifact({checks:{prepared:true,localCommitUnpublished:true},statuses:{probe:0}},'a-prepare'),{checks:{prepared:true,localCommitUnpublished:true},statuses:{probe:0}});
 assert.throws(()=>probeArtifact({checks:{headUnchanged:true},statuses:{probe:0}},'a-check'));
 for(const value of [{checks:{},statuses:{}},{checks:{[CANARY]:true},statuses:{probe:0}},{checks:{headUnchanged:CANARY},statuses:{probe:0}},{checks:{headUnchanged:true},statuses:{probe:CANARY}},{checks:{headUnchanged:true},statuses:{probe:0},error:CANARY}])assert.throws(()=>probeArtifact(value,'a-prepare'));
});

test('actual private probe sink requires the complete named phase and rejects raw/partial scalar lookalikes',()=>{const cmd={op:'artifact',schema:'probe',probePhase:'a-prepare',artifactId:PROBE,taskId:ID,branch:'sam/cell'};let v=fixture('normal',[cmd,{op:'stop'}]);assert.equal(v.outputs['out/0001.json'].category,'ok');assert.ok(v.outputs[`private/artifacts/${ID}-probe-a-prepare.json`]);v=fixture('normal',[cmd,{op:'stop'}],{invalidProbe:true});assert.notEqual(v.outputs['out/0001.json'].category,'ok');assert.ok(!v.outputs[`private/artifacts/${ID}-probe-a-prepare.json`]);});

const stopSession={op:'request',path:`/api/projects/${ID}/sessions/${UUID}/stop`,method:'POST'};
const deleteNode={op:'request',path:`/api/nodes/${ID}`,method:'DELETE'};
const deleteWorkspace={op:'request',path:`/api/workspaces/${ID}`,method:'DELETE'};
test('mutation scope is bound before fetch to accepted submit and canonical task/workspace associations',()=>{
 for(const cmd of [stopSession,sleep,deleteNode,deleteWorkspace]){
  const v=fixture('normal',[getNodes,cmd,{op:'stop'}]);
  assert.notEqual(v.outputs['out/0002.json'].category,'ok');assert.ok(!v.events.some(e=>e.path===cmd.path));
 }
 for(const cmd of [sleep,deleteNode,deleteWorkspace]){
  const unrelated={...cmd,path:cmd.path.replace(ID,OTHER)};
  const v=fixture('normal',[submit,task,workspace,unrelated,{op:'stop'}]);
  assert.notEqual(v.outputs['out/0004.json'].category,'ok');assert.ok(!v.events.some(e=>e.path===unrelated.path));
 }
 const unrelatedStop={...stopSession,path:stopSession.path.replace(UUID,'22222222-2222-4222-8222-222222222222')};
 let v=fixture('normal',[submit,unrelatedStop,{op:'stop'}]);assert.ok(!v.events.some(e=>e.path===unrelatedStop.path));
 v=fixture('normal',[submit,task,workspace,sleep,stopSession,deleteWorkspace,{op:'stop'}]);
 for(const index of [4,5,6])assert.equal(v.outputs[`out/${String(index).padStart(4,'0')}.json`].category,'ok');
 v=fixture('normal',[submit,task,workspace,deleteNode,{op:'stop'}]);assert.notEqual(v.outputs['out/0004.json'].category,'ok');assert.ok(!v.events.some(e=>e.path===deleteNode.path));
 v=fixture('task-mismatch',[submit,task,deleteWorkspace,{op:'stop'}]);assert.notEqual(v.outputs['out/0002.json'].category,'ok');assert.ok(!v.events.some(e=>e.path===deleteWorkspace.path));
 v=fixture('workspace-mismatch',[submit,task,workspace,deleteNode,{op:'stop'}]);
 assert.notEqual(v.outputs['out/0003.json'].category,'ok');assert.ok(!v.events.some(e=>e.path===deleteNode.path));
});

test('canonical startup state accepts null agent identity and recovering/error without authorizing a prompt',()=>{
 for(const mode of ['pending-agent','source-idle-no-agent','recovering','error']){
  const v=fixture(mode,[submit,state,prompt,{op:'stop'}]);
  assert.equal(v.outputs['out/0002.json'].category,'ok',mode);
  assert.notEqual(v.outputs['out/0003.json'].category,'ok',mode);
  assert.ok(!v.events.some(e=>e.path===prompt.path),mode);
 }
 const v=fixture('bad-agent',[submit,state,{op:'stop'}]);assert.notEqual(v.outputs['out/0002.json'].category,'ok');
});

test('pinned source node/workspace response statuses remain typed through list acceptance',()=>{
 for(const mode of ['recovery','evicted','deleted']){const v=fixture(mode,[getNodes,{op:'stop'}]);assert.equal(v.outputs['out/0001.json'].category,'ok');assert.equal(v.outputs['private/state/0001.json'][0].status,mode);}
});

test('state-only UUID identity and null-to-UUID startup require fresh real activity evidence before prompt',()=>{
 for(const mode of ['normal','uuid-agent']){const v=fixture(mode,[submit,state,prompt,{op:'stop'}]);assert.equal(v.outputs['out/0003.json'].category,'ok');}
 let v=fixture('null-to-uuid',[submit,state,state,prompt,{op:'stop'}]);assert.equal(v.outputs['out/0002.json'].category,'ok');assert.equal(v.outputs['out/0004.json'].category,'ok');
 v=fixture('fallback-clock',[submit,state,prompt,{op:'stop'}]);assert.equal(v.outputs['out/0002.json'].category,'ok');assert.notEqual(v.outputs['out/0003.json'].category,'ok');assert.ok(!v.events.some(e=>e.path===prompt.path));
});
test('source workspace deletion pending202 is incomplete; only confirmed deletion is accepted',()=>{
 let v=fixture('delete-pending',[submit,task,deleteWorkspace,{op:'stop'}]);assert.notEqual(v.outputs['out/0003.json'].category,'ok');assert.equal(v.outputs['out/0003.json'].status,202);assert.ok(!v.outputs['private/state/0003.json']);
 v=fixture('normal',[submit,task,deleteWorkspace,{op:'stop'}]);assert.equal(v.outputs['out/0003.json'].category,'ok');assert.equal(v.outputs['private/state/0003.json'].deletionConfirmed,true);
});

test('explicit existing-node submission is bound to the trusted reuse node and rejects a foreign node',()=>{
 const prior=process.env.SAM_VERIFICATION_REUSE_NODE_ID;process.env.SAM_VERIFICATION_REUSE_NODE_ID=ID;
 try{const own=fixture('normal',[{...submit,data:{...submit.data,nodeId:ID}},{op:'stop'}]);assert.equal(own.outputs['out/0001.json'].category,'ok');const foreign=fixture('normal',[{...submit,data:{...submit.data,nodeId:OTHER}},{op:'stop'}]);assert.notEqual(foreign.outputs['out/0001.json'].category,'ok');assert.ok(!foreign.events.some(e=>e.path?.endsWith('/tasks/submit')));}finally{if(prior===undefined)delete process.env.SAM_VERIFICATION_REUSE_NODE_ID;else process.env.SAM_VERIFICATION_REUSE_NODE_ID=prior;}
});
