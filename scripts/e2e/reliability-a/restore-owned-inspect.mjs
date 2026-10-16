import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {inspectOwnedFixture} from './owner-terminal-inspect.mjs';
import {idleLeaseEnded} from './queue-controller.mjs';
const root='/tmp/reliability-vm-claude-owner-inspect',api='https://api.sammy.party';
const project='01KJNR9R3TEN3KX1ETE33852R8',task='01M51CCMB1S684RXVNBNDQRDAS',session='1135ad88-96dd-4ec2-a1d1-5813d295d2a5',branch='sam/authorized-one-required-reliability-dqrdas',profile='01KRS7Z2R88JFC73ARA7DV9WTK';
const id=v=>typeof v==='string'&&/^[0-9A-HJKMNP-TV-Z]{26}$/.test(v);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
// Called only AFTER exact task/owner/session/branch binding and accepted same-run recovery proof.
export function pendingRecovery(status,workspaceId,originalHttpStatus){
 return (status==='queued'&&workspaceId===null)||(workspaceId==='01M51CJ70CX1ZYQ3M8TDVGM885'&&originalHttpStatus===404&&['sleeping','queued'].includes(status));
}
const evidence=v=>({status:['sleeping','in_progress','completed'].includes(v.status)?v.status:'other',completedAt:v.completedAt??null,evidenceSha256:createHash('sha256').update(JSON.stringify(v.completionEvidence??null)).digest('hex')});
export async function run({requestSafe,logoutSafe,summary}){
 let browser,c,page,owner,ws,lastState,restored=false,finished=false;
 const clock=JSON.parse(await readFile(root+'/clock.json','utf8')),hard=clock.hard,action=hard-360000;
 let out={stage:'login',ok:false,authCleanup:false,browserClosed:false,sleepAvailable:false};
 const save=async()=>writeFile(root+'/continuation-progress.json',JSON.stringify({...out,observedAt:Date.now()}),{mode:0o600});
 const get=async(path,subcheck,original404=false)=>{out.subcheck=subcheck;const r=await c.request.fetch(api+path,{headers:{Origin:api},timeout:10000,maxRedirects:0,failOnStatusCode:false});try{out.httpStatus=r.status();await save();if(r.status()===404&&original404)return null;if(r.status()!==200)throw 0;const b=await r.body();if(b.length>250000)throw 0;return JSON.parse(b.toString('utf8'));}finally{await r.dispose();}};
 const bind=async()=>{
  const t=await get(`/api/projects/${project}/tasks/${task}`,'task'),s=await get(`/api/projects/${project}/sessions/${session}?limit=1`,'session');
  out.subcheck='task-session-binding';await save();if(t.id!==task||t.userId!==owner||t.projectId!==project||t.outputBranch!==branch||s.session?.id!==session||s.session.taskId!==task)throw 0;
  return t;
 };
 const readRuntime=async()=>{
  const t=await bind();out.pendingRecovery=false;
  if(pendingRecovery(t.status,t.workspaceId,null)){ws=undefined;out.pendingRecovery=true;out.idle=false;await save();return t;}
  if(!id(t.workspaceId))throw 0;
  const w=await get('/api/workspaces/'+t.workspaceId,'workspace',t.workspaceId==='01M51CJ70CX1ZYQ3M8TDVGM885');
  if(!w&&pendingRecovery(t.status,t.workspaceId,404)){ws=undefined;out.pendingRecovery=true;out.idle=false;await save();return t;}
  out.subcheck='workspace-binding';await save();if(!w||w.id!==t.workspaceId||w.projectId!==project||w.chatSessionId!==session||w.branch!==branch||w.repository!=='serverspresentation2025/crewai')throw 0;ws=w;
  const a=await get(`/api/projects/${project}/sessions/${session}/state`,'runtime-state');
  lastState=a.state;
  out.taskStatus=evidence(t).status;out.workspaceId=ws?.id;out.nodeId=id(ws?.nodeId)?ws.nodeId:undefined;out.workspaceRunning=ws?.status==='running';out.agentSessionId=id(a.agentSessionId)?a.agentSessionId:undefined;out.agentClaude=a.agentType==='claude-code';
  out.idle=idleLeaseEnded(a.state,clock.started,Date.now(),300000,1800000);await save();return t;
 };
 try{
  if(Date.now()>=action||hard-clock.started!==1500000)throw 0;
  const {chromium}=await import('/tmp/reliability-browser-deps/node_modules/playwright/index.mjs');browser=await chromium.launch({headless:true});c=await browser.newContext();
  let r=await requestSafe(c,api,{path:'/api/auth/token-login',method:'POST',data:{token:process.env.SAM_PLAYWRIGHT_PRIMARY_USER}});delete process.env.SAM_PLAYWRIGHT_PRIMARY_USER;out.loginStatus=r.status;if(r.category!=='ok')throw 0;
  owner=(await get('/api/auth/get-session','owner'))?.user?.id;if(typeof owner!=='string'||!owner)throw 0;
  const accepted=JSON.parse(await readFile(root+'/accepted-recovery.json','utf8'));
  if(accepted.promptStatus!==202||accepted.authCleanup!==true||accepted.browserClosed!==true)throw 0;
  const original=JSON.parse(await readFile(root+'/task-before.json','utf8'));if(original.status!=='sleeping')throw 0;
  await bind();restored=true;out.stage='restore-idle';await save();
  while(Date.now()<action){await readRuntime();if(out.workspaceRunning&&out.agentClaude&&out.agentSessionId&&out.idle)break;await pause(10000);}
  if(!out.workspaceRunning||!out.agentClaude||!out.agentSessionId||!out.idle||Date.now()>=action)throw 0;
  out.stage='independent-grant';await save();
  let grant;
  while(Date.now()<action){try{grant=JSON.parse(await readFile(root+'/grant.json','utf8'));break;}catch{await pause(1000);}}
  if(!grant||grant.workspaceId!==out.workspaceId||grant.nodeId!==out.nodeId||grant.agentSessionId!==out.agentSessionId||grant.ownerId!==owner)throw 0;
  page=await c.newPage();await page.goto('https://app.sammy.party',{waitUntil:'domcontentloaded',timeout:20000});
  out.stage='inspect';await save();
  // Owned page cancellation bounds the browser transport inside the caller's finite job.
  const transportDeadline=setTimeout(()=>{void page.close().catch(()=>{});},80000);
  let inspection;try{inspection=await inspectOwnedFixture({context:c,page,grant});}finally{clearTimeout(transportDeadline);}
  await writeFile(root+'/inspection.json',JSON.stringify(inspection),{mode:0o600,flag:'wx'});out.inspectionOk=inspection.ok;out.inspectionStage=inspection.stage;out.terminalClosed=inspection.terminalClosed;out.quiescence=inspection.quiescence;
  await writeFile(root+'/task-after.json',JSON.stringify(evidence(await bind())),{mode:0o600,flag:'wx'});finished=true;
 }catch{out.failedSubcheck=out.subcheck??'caller';out.failedHttpStatus=out.httpStatus??0;}finally{
  delete process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
  if(restored){
   out.stage='preserve';await save();
   try{
    while(Date.now()<hard-120000){await readRuntime();if(out.idle&&ws?.status==='running'){
      const r=await requestSafe(c,api,{path:`/api/workspaces/${ws.id}/sleep`,method:'POST',data:{},timeoutMs:90000},v=>{out.sleepAvailable=v?.status==='sleeping'&&v.workspaceId===ws.id&&v.chatSessionId===session&&typeof v.snapshotExpiresAt==='string';return out.sleepAvailable;});out.sleepStatus=r.status;break;
     }if(ws?.status==='sleeping'){out.sleepAvailable=true;break;}await pause(10000);}
   }catch{}
  }
  if(c)try{const a=await logoutSafe(c,api),b=await requestSafe(c,api,{path:'/api/auth/get-session'},v=>v===null),d=await requestSafe(c,api,{path:'/api/nodes'});out.authCleanup=a.category==='ok'&&b.category==='ok'&&[401,403].includes(d.status);}catch{}
  if(browser)try{await browser.close();out.browserClosed=true;}catch{}
 }
 out.ok=finished&&out.sleepAvailable&&out.authCleanup&&out.browserClosed;out.stage='terminal';await save();
 return summary(out.ok?'ok':'controller',out.sleepStatus??out.loginStatus??0,out.ok);
}
