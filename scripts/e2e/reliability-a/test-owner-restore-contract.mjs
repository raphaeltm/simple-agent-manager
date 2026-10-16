/** Offline deployed-contract check: actual caller -> actual adapter -> actual fixed read capsule.
 * Replaces only browser/API/socket/time/filesystem boundaries. Never contacts a service.
 */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,mkdir,rm,stat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {requestSafe,logoutSafe,summary} from './safe-controller.mjs';
const apiHead='e2c81c045fa16490c7515fa80573418e60ef4017',vmHead='b467f389811eadeaf973960bb30f9fa7b9cb4678';
const deployed=path=>execFileSync('git',['show',apiHead+':'+path],{maxBuffer:2000000,stdio:['ignore','pipe','pipe']}).toString();
const mapper=deployed('apps/api/src/lib/mappers.ts');
const section=(source,start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const taskSource=section(mapper,'export function toTaskResponse(','export function toDependencyResponse(');
const workspaceSource=section(mapper,'export function toWorkspaceResponse(','export function toAgentSessionResponse(');
const taskKeys=new Set([...taskSource.matchAll(/^    (\w+):/gm)].map(m=>m[1]));
const workspaceKeys=new Set([...workspaceSource.matchAll(/^    (\w+):/gm)].map(m=>m[1]));workspaceKeys.add('hardware');
assert(taskKeys.has('workspaceId')&&!taskKeys.has('chatSessionId'));assert(workspaceKeys.has('chatSessionId'));
assert(deployed('apps/api/src/routes/chat.ts').includes('{ ...session, agentSessionId, agentType, task }'));
assert(deployed('apps/api/src/routes/chat-state.ts').includes('return c.json({ state, agentSessionId, agentType })'));
const wsSource=execFileSync('git',['show',vmHead+':packages/vm-agent/internal/server/websocket.go'],{stdio:['ignore','pipe','pipe'],maxBuffer:200000}).toString();
for(const value of ['case "create_session":','case "input":','case "close_session":','"user_requested"','Type: "session_created"','Type: "session_closed"'])assert(wsSource.includes(value));
const tokenSource=deployed('apps/api/src/routes/terminal.ts');assert(tokenSource.includes('const workspaceUrl = `https://ws-${ws.id}.${c.env.BASE_DOMAIN}`'));
const profileSource=deployed('apps/api/src/services/agent-profile-display.ts');assert(profileSource.includes('eq(schema.agentProfiles.userId, input.userId)'));
const task='01M51CCMB1S684RXVNBNDQRDAS',session='1135ad88-96dd-4ec2-a1d1-5813d295d2a5',project='01KJNR9R3TEN3KX1ETE33852R8';
const branch='sam/authorized-one-required-reliability-dqrdas',profile='01KRS7Z2R88JFC73ARA7DV9WTK';
const oldWorkspace='01M51CJ70CX1ZYQ3M8TDVGM885',workspace='01M51GKB78GQ00MXE8M7H5WE1E',node='01M51GEA2HSTJ8D6G3RHT04ZTJ',acp='01M51GQ031Q6VMEDMBNTVDXE6K';
const start=1792125871407,hard=1792127371407,canary='PRIVATE_SYNTHETIC_PROTOCOL_CANARY';
const hashes={'git-probe.py':'f061b7cd447cef55ceb08cb6a78fcb0b236ec3f347731e66d4b8447c224afa6c','b-probe.py':'889d7588ed44c8ab89e6ba7880ff20d81017f294bb7b31edfbc320ced064f509','terminal-observer.py':'d0970080ce89ab2810c0c9d758d1fc978efafe75fed91a4454f08639da88adff'};
const sha=b=>createHash('sha256').update(b).digest('hex');
const projectDto=(value,keys)=>{assert(Object.keys(value).every(k=>keys.has(k)));return value;};
const root=await mkdtemp(join(tmpdir(),'sam-owner-contract-'));
const originalSocket=globalThis.WebSocket;
let count=0;
try{
 const assets=join(root,'assets');await mkdir(assets,{mode:0o700});
 for(const [name,digest] of Object.entries(hashes)){const b=execFileSync('git',['show','e9e9d000f7ee16530432dfc5c0800e444b3de7b3:scripts/e2e/reliability-a/'+name],{stdio:['ignore','pipe','pipe']});assert.equal(sha(b),digest);await writeFile(join(assets,name),b);}
 await writeFile(join(assets,'expectations.json'),'{}');
 const repository=join(root,'repository');await mkdir(repository);execFileSync('git',['init','--initial-branch='+branch],{cwd:repository,stdio:['ignore','pipe','pipe']});
 await mkdir(join(repository,'.reliability-a'));await writeFile(join(repository,'.reliability-a/baseline.json'),'{}');
 for(const mode of ['success','original-deleted-pending','missing-assets','denied-pending','foreign-session','token-denied','bad-grant','bad-manifest','download-denied','wrong-close','sleep-denied','logout-denied','grant-deadline','persistence-failure']){
  count++;const directory=join(root,mode);await mkdir(directory,{mode:0o700});
  let time=start+10000,taskReads=0,phase='pending',input=false,closed=false,slept=false,runId,artifactDirectory;
  let contextClosed=false,loggedOut=false,tokenReads=0,persistFailure=false;const frames=[];
  const grant={workspaceId:workspace,nodeId:node,ownerId:mode==='bad-grant'?'foreign':'fixture-owner',expectedProfileOwnerId:'shared-owner',agentSessionId:acp,runtime:'vm',agentVersion:vmHead,expiresAt:time+240000,storedProfileId:profile,storedProfileObservedAt:time,receipt:{taskId:task,sessionId:session,branchName:branch,status:'queued'}};
  for(const [name,value] of Object.entries({clock:{started:start,hard},'accepted-recovery':{promptStatus:202,authCleanup:true,browserClosed:true},'task-before':{status:'sleeping'},grant}))await writeFile(join(directory,name+'.json'),JSON.stringify(value),{mode:0o600});
  const profileDto={id:profile,userId:'shared-owner',projectId:project,name:canary,agentType:'claude-code',runtime:'vm',vmSizeOverride:null};
  const response=(value,status=200)=>{const b=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));return {status:()=>status,body:async()=>b,json:async()=>JSON.parse(b.toString()),headers:async()=>({'content-length':String(b.length)}),dispose:async()=>{}};};
  const context={request:{fetch:async(url,options)=>{
   assert.equal(options.maxRedirects,0);assert(['https://api.sammy.party','https://app.sammy.party'].includes(options.headers.Origin));
   if(url.endsWith('/api/auth/token-login'))return response({success:true});
   if(url.endsWith('/api/auth/sign-out')){if(mode==='logout-denied')return response({},500);loggedOut=true;return response({success:true});}
   if(url.endsWith('/api/auth/get-session'))return response(loggedOut?null:{user:{id:'fixture-owner'}});
   if(url.endsWith('/api/nodes'))return response({nodes:[]},loggedOut?401:200);
   if(url.includes('/agent-profiles/'))return response(profileDto);
   if(url.endsWith('/agent-profiles'))return response({items:[profileDto]});
   if(url.includes('/tasks/')){taskReads++;phase=taskReads<=2?'pending':taskReads===3&&mode!=='success'?'old':taskReads<=4?'creating':taskReads===5?'running-no-acp':'running';return response(projectDto({id:task,projectId:project,userId:'fixture-owner',workspaceId:phase==='pending'?null:phase==='old'?oldWorkspace:workspace,outputBranch:branch,agentProfileHint:profile,status:phase==='pending'?'queued':phase==='old'?'sleeping':'in_progress',completedAt:null,completionEvidence:null},taskKeys));}
   if(url.endsWith('/state'))return response({agentSessionId:['creating','running-no-acp'].includes(phase)?null:acp,agentType:['creating','running-no-acp'].includes(phase)?null:'claude-code',state:{activity:'idle',runtimeWorkState:'inactive',runtimeWorkCount:0,activityAt:time,runtimeWorkUpdatedAt:time}});
   if(url.includes('/sessions/'))return response({session:{id:session,taskId:mode==='foreign-session'?node:task,workspaceId:phase==='pending'?null:phase==='old'?oldWorkspace:workspace,agentSessionId:['creating','running-no-acp'].includes(phase)?null:acp,agentType:['creating','running-no-acp'].includes(phase)?null:'claude-code',task:{id:task,outputBranch:branch}},state:null,messages:[],hasMore:false});
   if(url.endsWith('/api/workspaces/'+oldWorkspace))return response({},mode==='denied-pending'?403:404);
   if(url.endsWith('/api/workspaces/'+workspace))return response(projectDto({id:workspace,nodeId:node,projectId:project,chatSessionId:session,branch,repository:'serverspresentation2025/crewai',status:slept?'sleeping':phase==='creating'?'creating':'running',hardware:{cloudProvider:'hetzner'}},workspaceKeys));
   if(url.endsWith('/api/workspaces/'+workspace+'/sleep')){if(mode==='sleep-denied')return response({},409);slept=true;if(mode==='persistence-failure')persistFailure=true;return response({status:'sleeping',workspaceId:workspace,chatSessionId:session,snapshotExpiresAt:new Date(time+100000).toISOString()});}
   if(url.endsWith('/api/terminal/token')){tokenReads++;assert.deepEqual(options.data,{workspaceId:workspace});return response({token:canary.repeat(3),expiresAt:new Date(time+300000).toISOString(),workspaceUrl:`https://ws-${workspace}.sammy.party`},mode==='token-denied'?403:200);}
   if(url.includes('/files/download?')){
    assert(input);const u=new URL(url),name=u.searchParams.get('path').split('/').at(-1);assert(['done.json','state.json'].includes(name));assert.equal(u.searchParams.get('token'),canary.repeat(3));
    if(mode==='download-denied')return response({},403);
    let b=await readFile(join(artifactDirectory,name));if(mode==='bad-manifest'&&name==='done.json')b=Buffer.from(JSON.stringify({...JSON.parse(b),stateSha256:'0'.repeat(64)}));return response(b);
   }
   throw new Error('unexpected-route');
  }},newPage:async()=>page};
  const page={url:()=> 'https://app.sammy.party/projects/fixture',goto:async()=>{if(mode==='grant-deadline')time=hard-400000;},close:async()=>{},evaluate:async(fn,arg)=>fn(arg)};
  globalThis.WebSocket=class{
   constructor(url){assert(url.startsWith(`wss://ws-${workspace}.sammy.party/terminal/ws/multi?token=`));queueMicrotask(()=>this.onopen());}
   send(raw){const frame=JSON.parse(raw);frames.push(frame.type);this.onmessage({data:JSON.stringify({type:'output',data:{data:canary}})});
    if(frame.type==='create_session'){runId=frame.data.sessionId;assert.equal(frame.data.workDir,undefined);this.onmessage({data:JSON.stringify({type:'session_created',sessionId:runId,data:{sessionId:runId,workingDirectory:canary}})});}
    if(frame.type==='input'){
     input=true;const command=frame.data.data;assert(Buffer.byteLength(command)<=3800);const encoded=command.match(/base64\.b64decode\("([A-Za-z0-9+/=]+)"\)/)?.[1];assert(encoded);
     let capsule=gunzipSync(Buffer.from(encoded,'base64')).toString();artifactDirectory=join(directory,'artifacts');
     capsule=capsule.replace(`/workspaces/reliability-owner-inspect/${task}/${runId}`,artifactDirectory).replace('/workspaces/reliability-verification-assets',mode==='missing-assets'?join(directory,'missing-assets'):assets);
     // Run the actual read capsule, substituting only offline filesystem roots. All output private.
     execFileSync('/usr/bin/python3',['-c',capsule],{cwd:repository,timeout:30000,stdio:['ignore','pipe','pipe']});
    }
    if(frame.type==='close_session'){closed=true;if(mode!=='wrong-close')this.onmessage({data:JSON.stringify({type:'session_closed',sessionId:runId,data:{sessionId:runId,reason:'user_requested'}})});}
   }
   close(){}
  };
  globalThis.__ownerContract={now:()=>time,pause:async ms=>{time+=ms;},failWrite:()=>persistFailure,chromium:{launch:async()=>({newContext:async()=>context,close:async()=>{contextClosed=true;}})}};
  let adapter=await readFile(new URL('./owner-terminal-inspect.mjs',import.meta.url),'utf8');adapter=adapter.replace('now=Date.now,pause=ms=>new Promise(r=>setTimeout(r,ms))','now=()=>globalThis.__ownerContract.now(),pause=ms=>globalThis.__ownerContract.pause(ms)');
  await writeFile(join(directory,'owner-terminal-inspect.mjs'),adapter);
  let caller=await readFile(new URL('./restore-owned-inspect.mjs',import.meta.url),'utf8');caller=caller.replace("'/tmp/reliability-vm-claude-owner-inspect'",JSON.stringify(directory)).replace("const {chromium}=await import('/tmp/reliability-browser-deps/node_modules/playwright/index.mjs');",'const {chromium}=globalThis.__ownerContract;').replaceAll('Date.now()','globalThis.__ownerContract.now()').replace('const pause=ms=>new Promise(r=>setTimeout(r,ms));','const pause=ms=>globalThis.__ownerContract.pause(ms);');
  if(mode==='persistence-failure')caller=caller.replace("import {readFile,writeFile} from 'node:fs/promises';","import {readFile,writeFile as diskWrite} from 'node:fs/promises';const writeFile=async(...a)=>{if(globalThis.__ownerContract.failWrite()&&a[0].endsWith('continuation-progress.json'))throw new Error('private');return diskWrite(...a);};");
  await writeFile(join(directory,'caller.mjs'),caller);const module=await import(pathToFileURL(join(directory,'caller.mjs')).href);
  const result=await module.run({summary,logoutSafe,requestSafe});
  assert(contextClosed);assert.equal(loggedOut,mode!=='logout-denied');assert(!JSON.stringify(result).includes(canary));
  const success=['success','original-deleted-pending','missing-assets'].includes(mode);assert.equal(result.category,success?'ok':'controller');
  if(success){assert(input&&closed&&slept);assert.deepEqual(frames,['create_session','input','close_session']);const actual=JSON.parse(await readFile(join(directory,'inspection.json')));assert(actual.ok&&actual.quiescence);if(mode==='missing-assets')assert.equal(actual.state.checks.gitProbeHash,false);else assert(Object.values(actual.state.checks).every(Boolean));assert.equal((await stat(join(artifactDirectory,'state.json'))).mode&0o777,0o600);}
  if(['denied-pending','foreign-session','bad-grant','grant-deadline'].includes(mode))assert(!input);
  if(mode==='token-denied')assert(tokenReads===1&&!input);
  if(input)assert(closed);
 }
 console.log(JSON.stringify({deployedDtoContracts:true,callerAdapterCapsule:true,cases:count,liveCalls:0}));
}finally{globalThis.WebSocket=originalSocket;delete globalThis.__ownerContract;await rm(root,{recursive:true,force:true});}
