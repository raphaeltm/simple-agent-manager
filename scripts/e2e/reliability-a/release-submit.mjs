// Single-use owner submission; no retries, cleanup mutation, or generic request surface.
import {readFile,writeFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
export async function run({requestSafe,logoutSafe,summary}){
 const api='https://api.sammy.party', project='01KJNR9R3TEN3KX1ETE33852R8';
 let c,root,stage='config',loginStatus=0,submitStatus=0,attempted=false,accepted=false,authCleanup=false;
 const exact=(v,k)=>v&&typeof v==='object'&&Object.keys(v).sort().join()===k.sort().join();
 const save=(name,v)=>writeFile(root+'/'+name,JSON.stringify(v),{mode:0o600,flag:'wx'});
 try{
  root=process.env.SAM_PROSPECTIVE_ROOT;if(!isAbsolute(root)||root==='/')throw 0;
  const admission=JSON.parse(await readFile(root+'/admission.json','utf8'));
  if(!exact(admission,['started','hard','observedAt','vmCount','claimCount','duplicateCount','slotReleased'])||![admission.started,admission.hard,admission.observedAt].every(Number.isSafeInteger)||admission.started>Date.now()||admission.hard-admission.started!==2700000||admission.observedAt<Date.now()-60000||admission.observedAt>Date.now()||admission.vmCount!==0||admission.claimCount!==0||admission.duplicateCount!==0||admission.slotReleased!==true||Date.now()>admission.hard-600000)throw 0;
  const {request}=await import('/tmp/reliability-browser-deps/node_modules/playwright/index.mjs');c={request:await request.newContext({baseURL:api,timeout:15000})};
  stage='login';const login=await requestSafe(c,api,{path:'/api/auth/token-login',method:'POST',data:{token:process.env.SAM_PLAYWRIGHT_PRIMARY_USER}});delete process.env.SAM_PLAYWRIGHT_PRIMARY_USER;loginStatus=login.status;if(login.category!=='ok'||login.status!==200)throw 0;
  const get=async path=>{const r=await c.request.get(api+path,{headers:{Origin:api},timeout:10000,maxRedirects:0});try{if(r.status()!==200)throw 0;return await r.json();}finally{await r.dispose();}};
  const owner=(await get('/api/auth/get-session'))?.user?.id;
  const p=await get('/api/projects/'+project);if(!owner||p.id!==project||p.repository!=='serverspresentation2025/crewai')throw 0;
  const profile=await get(`/api/projects/${project}/agent-profiles/01KXG9MJRZ36FFJX0RVNW67SWB`);if(profile.id!=='01KXG9MJRZ36FFJX0RVNW67SWB'||profile.agentType!=='openai-codex'||profile.runtime!==null||profile.vmSizeOverride!==null||profile.resourceRequirementsJson!==null)throw 0;
  if(Date.now()>admission.observedAt+60000||Date.now()>admission.hard-600000)throw 0;
  const message='Reliability A Codex VM nonpublication acceptance. Call get_instructions first. This is an authorized disposable staging fixture, not implementation work. Do not edit files, run shell commands, publish Git changes, create PRs, complete_task, or start background work. The owner will prepare and measure a controlled fixture through the standard terminal. Return control with READY and await the next owner instruction.';
  stage='submit';await save('submission-attempt.json',{at:Date.now(),started:admission.started,hard:admission.hard,projectId:project,agentProfileId:profile.id,workspaceProfile:'full'});attempted=true;
  const r=await c.request.post(api+`/api/projects/${project}/tasks/submit`,{headers:{Origin:api},data:{message,agentProfileId:profile.id,workspaceProfile:'full',taskMode:'task'},timeout:30000,maxRedirects:0});
  let receipt;try{submitStatus=r.status();if(submitStatus!==202)throw 0;const v=await r.json();if(!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(v.taskId)||! /^[0-9a-f-]{36}$/.test(v.sessionId)||! /^sam\/[a-z0-9][a-z0-9/-]{0,150}$/.test(v.branchName)||v.status!=='queued')throw 0;receipt={taskId:v.taskId,sessionId:v.sessionId,branchName:v.branchName,status:v.status};await save('accepted-receipt.json',receipt);accepted=true;}finally{await r.dispose();}
  const own={taskId:receipt.taskId,sessionId:receipt.sessionId,branch:receipt.branchName,agentProfileId:profile.id,agentType:'openai-codex',receipt};
  const observerReceipt={taskId:'01M50VYZ60RQXXTGSVPXW6FRXD',sessionId:'4e5282b9-0cd5-454f-a8f0-db160b9823fe',branchName:'sam/bootstrap-only-authorized-reliability-w6frxd',status:'queued'};
  const observer={taskId:observerReceipt.taskId,sessionId:observerReceipt.sessionId,branch:observerReceipt.branchName,agentProfileId:'01KYQ5YDHC1VS0BZ9F3NY97FNH',agentType:'openai-codex',receipt:observerReceipt};
  await save('config.json',{started:admission.started,hard:admission.hard,own,observer,evidencePrUrl:'https://github.com/raphaeltm/simple-agent-manager/pull/2355'});stage='done';
 }catch{}finally{
  delete process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
  if(c)try{const a=await logoutSafe(c,api),b=await requestSafe(c,api,{path:'/api/auth/get-session'},v=>v===null),d=await requestSafe(c,api,{path:'/api/projects/'+project});authCleanup=a.category==='ok'&&b.category==='ok'&&[401,403].includes(d.status);}catch{}
  if(c)await c.request.dispose().catch(()=>{});
  if(root)try{await save('submission-result.json',{stage,loginStatus,submitStatus,attempted,receiptValidated:accepted,acceptanceUnknown:attempted&&!accepted,authCleanup,at:Date.now()});}catch{}
 }
 return summary(stage==='done'&&authCleanup?'ok':'controller',submitStatus,accepted&&authCleanup);
}
