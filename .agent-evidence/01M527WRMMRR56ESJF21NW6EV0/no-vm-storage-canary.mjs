/** One harmless owner Library canary, no runtime or task mutation. */
import {writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
export async function run({requestSafe,logoutSafe,summary}){
 const api='https://api.sammy.party',project='01KJNR9R3TEN3KX1ETE33852R8',task='01M527WRMMRR56ESJF21NW6EV0',session='8d0245f8-8799-40c1-9848-4650dd5b90d4',branch='sam/authorized-one-clean-prospective-nw6ev0';
 let browser,c,response,stage='configuration',auth=false,closed=false,pass=false;
 const out={kind:'no-vm-storage-canary',taskId:task,started:Date.now(),status:{},checks:{},schema:{}};
 const bytes=Buffer.from(JSON.stringify({kind:'harmless-library-canary',taskId:task,sourceSha:'b5043f599b5e23792be6d3563781d8b2ad9820a9'}));
 const filename='storage-canary-'+sha(bytes)+'.json',directory='/engineering/reliability/'+task+'/no-vm-canary/';
 try{
  if(Date.now()>=1792153178018-300000)throw 0;
  const {chromium}=await import('/tmp/reliability-browser-deps/node_modules/playwright/index.mjs');browser=await chromium.launch({headless:true});c=await browser.newContext();
  stage='login';const token=process.env.SAM_PLAYWRIGHT_PRIMARY_USER;delete process.env.SAM_PLAYWRIGHT_PRIMARY_USER;const l=await requestSafe(c,api,{path:'/api/auth/token-login',method:'POST',data:{token}});out.status.login=l.status;if(l.category!=='ok')throw 0;
  let owner;const u=await requestSafe(c,api,{path:'/api/auth/get-session'},v=>{owner=v?.user?.id;return typeof owner==='string'&&owner.length>0;});if(u.category!=='ok')throw 0;
  stage='binding';const t=await requestSafe(c,api,{path:`/api/projects/${project}/tasks/${task}`},v=>v?.id===task&&v.userId===owner&&v.projectId===project&&v.outputBranch===branch&&v.status==='sleeping');out.checks.sleepingCanonicalBound=t.category==='ok';if(!out.checks.sleepingCanonicalBound)throw 0;
  stage='upload';response=await c.request.fetch(`${api}/api/projects/${project}/library/upload`,{method:'POST',headers:{Origin:api},multipart:{file:{name:filename,mimeType:'application/json',buffer:bytes},directory,uploadSource:'agent',uploadTaskId:task,uploadSessionId:session},timeout:30000,maxRedirects:0,failOnStatusCode:false});out.status.upload=response.status();if(out.status.upload!==201)throw 0;
  const raw=await response.body();if(raw.length>32768)throw 0;const v=JSON.parse(raw);await response.dispose();response=null;
  stage='metadata';out.schema.replacedAtPresent=Object.hasOwn(v,'replacedAt');out.schema.replacedAtNull=v.replacedAt===null;out.checks.fixedMetadataMatches=/^[0-9A-HJKMNP-TV-Z]{26}$/.test(v.id)&&v.projectId===project&&v.filename===filename&&v.directory===directory&&v.uploadTaskId===task&&v.uploadSessionId===session&&v.uploadSource==='agent'&&v.sizeBytes===bytes.length&&v.status==='ready';out.checks.frozenStrictMetadataWouldAccept=out.checks.fixedMetadataMatches&&v.replacedAt===null;if(!out.checks.fixedMetadataMatches)throw 0;
  out.fileId=v.id;stage='download';response=await c.request.fetch(`${api}/api/projects/${project}/library/${v.id}/download`,{headers:{Origin:api},timeout:30000,maxRedirects:0,failOnStatusCode:false});out.status.download=response.status();if(out.status.download!==200)throw 0;const downloaded=await response.body();await response.dispose();response=null;
  stage='hash';out.checks.exactBytes=downloaded.equals(bytes);out.checks.sha256Matches=sha(downloaded)===sha(bytes);out.sha256=sha(bytes);pass=out.checks.exactBytes&&out.checks.sha256Matches;
 }catch{}finally{
  delete process.env.SAM_PLAYWRIGHT_PRIMARY_USER;if(response)try{await response.dispose();}catch{}
  if(c)try{const a=await logoutSafe(c,api),b=await requestSafe(c,api,{path:'/api/auth/get-session'},v=>v===null),d=await requestSafe(c,api,{path:'/api/nodes'});auth=a.category==='ok'&&b.category==='ok'&&[401,403].includes(d.status);}catch{}
  if(browser)try{await browser.close();closed=true;}catch{}
 }
 out.stage=stage;out.storageRoundtripPass=pass;out.authCleanup=auth;out.browserClosed=closed;out.finished=Date.now();out.ok=pass&&auth&&closed;
 await writeFile('/workspaces/simple-agent-manager/.agent-evidence/01M527WRMMRR56ESJF21NW6EV0/no-vm-canary-result.json',JSON.stringify(out),{mode:0o600,flag:'wx'});return summary(out.ok?'ok':'controller',out.status.download??out.status.upload??0,out.ok);
}
