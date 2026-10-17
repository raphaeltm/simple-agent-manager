/** Cleanup only: cancel the exact newly accepted empty queued fixture; never adopts a workspace. */
import {writeFile} from 'node:fs/promises';
export async function run({requestSafe,logoutSafe,summary}){
 const api='https://api.sammy.party',project='01KJNR9R3TEN3KX1ETE33852R8',task='01M527WRMMRR56ESJF21NW6EV0',session='8d0245f8-8799-40c1-9848-4650dd5b90d4',branch='sam/authorized-one-clean-prospective-nw6ev0';
 let browser,c,cleaned=false,auth=false,closed=false;
 try{
  if(Date.now()>=1792153178018-120000)throw 0;
  const {chromium}=await import('/tmp/reliability-browser-deps/node_modules/playwright/index.mjs');browser=await chromium.launch({headless:true});c=await browser.newContext();
  const token=process.env.SAM_PLAYWRIGHT_PRIMARY_USER;delete process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
  const login=await requestSafe(c,api,{path:'/api/auth/token-login',method:'POST',data:{token}});if(login.category!=='ok')throw 0;
  let owner;const u=await requestSafe(c,api,{path:'/api/auth/get-session'},v=>{owner=v?.user?.id;return typeof owner==='string'&&owner.length>0;});if(u.category!=='ok')throw 0;
  const bound=await requestSafe(c,api,{path:`/api/projects/${project}/tasks/${task}`},v=>v?.id===task&&v.userId===owner&&v.projectId===project&&v.outputBranch===branch&&v.status==='queued'&&v.workspaceId===null);
  if(bound.category!=='ok')throw 0;
  const s=await requestSafe(c,api,{path:`/api/projects/${project}/sessions/${session}`},v=>v?.session?.id===session&&v.session.taskId===task);if(s.category!=='ok')throw 0;
  const cancelled=await requestSafe(c,api,{path:`/api/projects/${project}/tasks/${task}/status`,method:'POST',data:{toStatus:'cancelled',reason:'Authorized verification stopped before tested turn; cancel exact empty queued fixture.'}},v=>v?.id===task&&v.status==='cancelled'&&v.workspaceId===null);if(cancelled.category!=='ok')throw 0;
  const after=await requestSafe(c,api,{path:`/api/projects/${project}/tasks/${task}`},v=>v?.id===task&&v.status==='cancelled'&&v.workspaceId===null);cleaned=after.category==='ok';
 }catch{}finally{
  delete process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
  if(c)try{const a=await logoutSafe(c,api),b=await requestSafe(c,api,{path:'/api/auth/get-session'},v=>v===null),d=await requestSafe(c,api,{path:'/api/nodes'});auth=a.category==='ok'&&b.category==='ok'&&[401,403].includes(d.status);}catch{}
  if(browser)try{await browser.close();closed=true;}catch{}
 }
 await writeFile('/workspaces/simple-agent-manager/.agent-evidence/01M527WRMMRR56ESJF21NW6EV0/empty-case-cleanup.json',JSON.stringify({taskId:task,sessionId:session,cancelledEmptyQueued:cleaned,authCleanup:auth,browserClosed:closed,observedAt:Date.now()}),{mode:0o600,flag:'wx'});
 return summary(cleaned&&auth&&closed?'ok':'controller',cleaned?200:0,cleaned&&auth&&closed);
}
