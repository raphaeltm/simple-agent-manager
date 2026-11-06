// @ts-expect-error Self-contained JavaScript is embedded for the native Node supervisor.
import { canonicalSourceBootstrap } from '../../../scripts/deploy/installer-source-cache.mjs';
import { sourcePolicyFactory } from './source-policy';
// Native managed-image bootstrap. This module is appended to the owner-account
// maintenance Worker; no public Worker route forwards to the builder binding.
// Native API references: /containers/api/durable-object-container/ (2026-09-30).
const supervisor = String.raw`
const http = require('node:http');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
let state = 'running';
fs.mkdirSync('/sam/job', {recursive:true,mode:448});
if(process.env.SAM_ENGINE_CHECKPOINT)fs.writeFileSync('/sam/job/checkpoint.json',process.env.SAM_ENGINE_CHECKPOINT,{mode:384});
const boot = 'set -eu; umask 077; export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y -qq --no-install-recommends git ca-certificates; test "$(git -C /sam/source rev-parse HEAD)" = "$SAM_SOURCE_COMMIT"; exec bash /sam/source/scripts/deploy/installer-builder-bootstrap.sh';
async function begin(){
 try {
  if(process.env.SAM_BUILD_FIT_ONLY==='1'){const {execFileSync}=require('node:child_process');execFileSync('git',['clone','https://github.com/raphaeltm/simple-agent-manager.git','/sam/source'],{stdio:'ignore'});execFileSync('git',['-C','/sam/source','checkout','--detach',process.env.SAM_SOURCE_COMMIT],{stdio:'ignore'});}
  else await (${canonicalSourceBootstrap})();
  const child = spawn('sh', ['-c', boot], {stdio:'ignore',env:process.env});
  child.once('error', () => {state='failed';});
  child.once('close', code => {state=code===0?'completed':'failed';});
 }catch{state='failed';}
}
// Initial OS tooling is required before signed source storage/bootstrap.
const tools=spawn('sh',['-c','apt-get update -qq && apt-get install -y -qq --no-install-recommends git ca-certificates curl'],{stdio:'ignore'});
tools.once('error',()=>{state='failed';});
tools.once('close',code=>{if(code===0)void begin();else state='failed';});
http.createServer((req,res) => {
 if(req.method!=='GET'||req.url!=='/status'||req.headers.authorization!=='Bearer '+process.env.SAM_JOB_NONCE){res.writeHead(403);res.end();return;}
 let checkpoint;
 try { const s=fs.statSync('/sam/job/checkpoint.json');if(s.size<=16384)checkpoint=JSON.parse(fs.readFileSync('/sam/job/checkpoint.json','utf8')); }catch{}
 let sourceIdentity;
 try { const s=fs.statSync('/sam/source/.wrangler/installer-source-identity.json');if(s.size<=4096)sourceIdentity=JSON.parse(fs.readFileSync('/sam/source/.wrangler/installer-source-identity.json','utf8')); }catch{}
 let runtimeTrust;
 try { const s=fs.statSync('/sam/job/codex/installation-codex-trust.json');if(s.size<=32768)runtimeTrust=JSON.parse(fs.readFileSync('/sam/job/codex/installation-codex-trust.json','utf8')); }catch{}
 let result;
 try { const s=fs.statSync('/sam/job/checkpoint.json.result');if(s.size<=8192)result=JSON.parse(fs.readFileSync('/sam/job/checkpoint.json.result','utf8')); }catch{}
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({state,checkpoint,sourceIdentity,runtimeTrust,result}));
}).listen(8080,'0.0.0.0');
`;

export const builderSource = String.raw`
const BUILDER_SUPERVISOR=${JSON.stringify(supervisor)};
const builderSourcePolicy=${sourcePolicyFactory};
function builderJson(value,status=200){return Response.json(value,{status,headers:{'Cache-Control':'no-store'}});}
function builderSafeSourceIdentity(value,commit){
 if(!value||value.version!==1||value.commit!==commit||!/^[a-f0-9]{40}$/.test(value.tree)||!/^[a-f0-9]{64}$/.test(value.bundleSHA256)||!Number.isSafeInteger(value.bundleBytes)||value.bundleBytes<=0||value.bundleBytes>1073741824)return undefined;
 return {version:1,commit:value.commit,tree:value.tree,bundleSHA256:value.bundleSHA256,bundleBytes:value.bundleBytes};
}
function builderSafeTrust(value,older=true){
 if(!value||value.version!==1||typeof value.identity!=='string'||!/^sam-codex-acp-[a-zA-Z0-9.+-]+-installation-[a-f0-9]{16}$/.test(value.identity)||!Number.isSafeInteger(value.archiveBytes)||value.archiveBytes<=0||value.archiveBytes>314572800)return undefined;
 const selected={version:1,identity:value.identity,archiveBytes:value.archiveBytes};
 for(const key of ['archiveSHA256','catalogSHA256','noticesSHA256','sourceSHA256','reviewSHA256','installerSHA256']){if(value[key]!==undefined){if(!/^[a-f0-9]{64}$/.test(value[key]))return undefined;selected[key]=value[key];}}
 if(!selected.archiveSHA256||!selected.catalogSHA256||!selected.noticesSHA256)return undefined;
 if(older&&value.previous){const previous=builderSafeTrust(value.previous,false);if(previous)selected.previous=previous;}
 return selected;
}
function builderSafeCheckpoint(value){
 if(!value||value.schemaVersion!==1||!/^[a-f0-9]{64}$/.test(value.fingerprint)||!Array.isArray(value.completed)||value.completed.length>64||value.completed.some(x=>typeof x!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(x))||!['running','failed','completed'].includes(value.status))return undefined;
 if(value.activePhase!==undefined&&(typeof value.activePhase!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(value.activePhase)))return undefined;
 return {schemaVersion:1,fingerprint:value.fingerprint,completed:value.completed,status:value.status,...(value.activePhase?{activePhase:value.activePhase}:{})};
}
export class InstallationBuilder{
 constructor(ctx,env){this.ctx=ctx;this.env=env;this.queue=Promise.resolve();}
 serialized(action){const pending=this.queue.then(action);this.queue=pending.catch(()=>undefined);return pending;}
 async fetch(request){return this.serialized(async()=>{try{return await this.handle(request);}catch{return builderJson({error:'BUILDER_UNAVAILABLE'},503);}});}
 async handle(request){
  if(!this.env.BUILDER_CONTROL_SECRET||request.headers.get('Authorization')!=='Bearer '+this.env.BUILDER_CONTROL_SECRET)return builderJson({error:'FORBIDDEN'},403);
  const path=new URL(request.url).pathname;
  if(path==='/status'&&request.method==='GET'){await this.reconcile();return builderJson(this.publicJob(await this.ctx.storage.get('job')));}
  if(path==='/result'&&request.method==='GET'){await this.reconcile();const job=await this.ctx.storage.get('job');return builderJson(job?.result||{error:'RESULT_UNAVAILABLE'},job?.result?200:409);}
  if(path==='/cancel'&&request.method==='POST'){const job=await this.ctx.storage.get('job');if(!job)return builderJson({error:'NO_JOB'},404);await this.stop(job,'cancelled');return builderJson(this.publicJob(job));}
  if((path==='/start'||path==='/resume')&&request.method==='POST'){
   const raw=await request.text();if(raw.length>8192)return builderJson({error:'INVALID_JOB'},400);
   let input;try{input=JSON.parse(raw);}catch{return builderJson({error:'INVALID_JOB'},400);}
   const previous=await this.ctx.storage.get('job');
   if(path==='/resume'){
    if(!previous||input.jobId!==previous.id||!['failed','interrupted','timed_out','cancelled'].includes(previous.status))return builderJson({error:'NOT_RESUMABLE'},409);
    if(!builderSourcePolicy.matches(previous.sourceValidation,previous.config))return builderJson({error:'SOURCE_NOT_VALIDATED'},409);
    // Destroy first, including on uncertain startup/monitor results. Never attach
    // a second deployment process to a container whose status is unknown.
    await this.ctx.container.destroy('SAM explicit resume');
    await this.launch(previous.config,previous.id,previous.checkpoint,previous.sourceValidation,previous.sourceIdentity);return builderJson(this.publicJob(await this.ctx.storage.get('job')),202);
   }
   if(previous&&['starting','running'].includes(previous.status))return builderJson({error:'JOB_ACTIVE'},409);
   if(!input||typeof input!=='object'||!/^[a-f0-9]{32}$/.test(input.jobId)||!/^[a-f0-9]{40}$/.test(input.sourceCommit)||!['production','staging'].includes(input.environment)||!/^[a-f0-9]{32}$/.test(input.accountId)||!/^[a-f0-9]{32}$/.test(input.zoneId)||input.accountId!==this.env.CF_ACCOUNT_ID)return builderJson({error:'INVALID_JOB'},400);
   const domain=x=>typeof x==='string'&&x.length<=253&&x.includes('.')&&x.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
   if(!domain(input.zoneName)||!domain(input.baseDomain)||(input.baseDomain!==input.zoneName&&!input.baseDomain.endsWith('.'+input.zoneName))||!/^s[a-f0-9]{6}$/.test(input.prefix)||input.previousSourceCommit!==undefined&&!/^[a-f0-9]{40}$/.test(input.previousSourceCommit)||typeof input.ownerEmail!=='string'||input.ownerEmail.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.ownerEmail))return builderJson({error:'INVALID_JOB'},400);
   if(!input.workersDev||!['create','preserve'].includes(input.workersDev.action)||typeof input.workersDev.subdomain!=='string'||!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(input.workersDev.subdomain))return builderJson({error:'INVALID_JOB'},400);
   const config={workersDev:{action:input.workersDev.action,subdomain:input.workersDev.subdomain},ownerEmail:input.ownerEmail,sourceCommit:input.sourceCommit,accountId:input.accountId,zoneId:input.zoneId,zoneName:input.zoneName,baseDomain:input.baseDomain,environment:input.environment,prefix:input.prefix,...(input.previousSourceCommit?{previousSourceCommit:input.previousSourceCommit}:{})};
   const verified=await builderSourcePolicy.verify(config.sourceCommit,config.previousSourceCommit);
   if(!verified.ok)return builderJson({error:'SOURCE_NOT_SUPPORTED',reason:verified.reason},verified.reason==='source-unavailable'?503:409);
   await this.ctx.container.destroy('SAM clean job boundary');
   await this.launch(config,input.jobId,undefined,verified.proof);return builderJson(this.publicJob(await this.ctx.storage.get('job')),202);
  }
  return builderJson({error:'NOT_FOUND'},404);
 }
 publicJob(job){return job?{jobId:job.id,status:job.status,sourceCommit:job.config.sourceCommit,deadline:job.deadline,checkpoint:job.checkpoint}: {status:'idle'};}
 async persist(job){await this.ctx.storage.put('job',job);if(this.env.BUILDER_ARTIFACTS){try{await this.env.BUILDER_ARTIFACTS.put('installer/jobs/'+job.id+'/state.json',JSON.stringify(this.publicJob(job)));}catch{/* Durable Object remains the authoritative checkpoint. */}}}
 async launch(config,id,checkpoint,sourceValidation,sourceIdentity){
  const seconds=Number(this.env.BUILDER_MAX_SECONDS||3600),poll=Number(this.env.BUILDER_POLL_SECONDS||15),instance=this.env.BUILDER_INSTANCE||'standard-3';
  if(!Number.isInteger(seconds)||seconds<60||seconds>14400||!Number.isInteger(poll)||poll<5||poll>60||!['standard-1','standard-2','standard-3','standard-4'].includes(instance))throw new Error('Invalid builder limits');
  const required=['CF_API_TOKEN','CF_RUNTIME_API_TOKEN','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','PULUMI_CONFIG_PASSPHRASE','SAM_ARTIFACTS_BUCKET'];
  if(required.some(key=>typeof this.env[key]!=='string'||!this.env[key]))throw new Error('Missing builder authority');
  const nonce=[...crypto.getRandomValues(new Uint8Array(32))].map(x=>x.toString(16).padStart(2,'0')).join('');
  const job={id,config,checkpoint,sourceValidation,sourceIdentity,status:'starting',deadline:Date.now()+seconds*1000,nonce,pollSeconds:poll};
  await this.persist(job);await this.ctx.storage.setAlarm(Math.min(job.deadline,Date.now()+poll*1000));
  const env={SAM_JOB_NONCE:nonce,SAM_SOURCE_COMMIT:config.sourceCommit,SAM_PREVIOUS_SOURCE_COMMIT:config.previousSourceCommit||'',SAM_ENGINE_CONFIG:JSON.stringify(config),SAM_JOB_DIRECTORY:'/sam/job',CF_ACCOUNT_ID:config.accountId,SAM_ENGINE_CHECKPOINT:checkpoint?JSON.stringify(checkpoint):''};
  if(sourceIdentity)env.SAM_SOURCE_IDENTITY=JSON.stringify(sourceIdentity);
  for(const key of required)env[key]=this.env[key];
  this.ctx.container.start({image:'cloudflare/debian-trixie',instance,enableInternet:true,entrypoint:['node','-e',BUILDER_SUPERVISOR],env,labels:{job:id}});
  job.status='running';await this.persist(job);
 }
 async stop(job,status){
  // Persist terminal intent before destroy, retaining the alarm until stop succeeds.
  job.status=status;job.stopping=true;await this.ctx.storage.put('job',job);
  await this.ctx.container.destroy('SAM builder '+status);
  delete job.stopping;await this.ctx.storage.put('job',job);await this.ctx.storage.deleteAlarm();
  await this.persist(job);
 }
 async reconcile(){
  const job=await this.ctx.storage.get('job');if(!job)return;
  if(job.stopping){await this.stop(job,job.status);return;}
  if(!['starting','running'].includes(job.status))return;
  if(Date.now()>=job.deadline){await this.stop(job,'timed_out');return;}
  // Keep an alarm armed even when inspect/status transport fails.
  await this.ctx.storage.setAlarm(Math.min(job.deadline,Date.now()+job.pollSeconds*1000));
  const info=await this.ctx.container.inspect();
  if(!info){job.status='interrupted';await this.persist(job);await this.ctx.storage.deleteAlarm();return;}
  if(info.labels?.job!==job.id){await this.stop(job,'failed');return;}
  try{
   const port=this.ctx.container.getTcpPort(8080);
   const response=await port.fetch('http://builder/status',{headers:{Authorization:'Bearer '+job.nonce},signal:AbortSignal.timeout(5000)});
   if(!response.ok)return;
   const text=await response.text();if(text.length>65536){await this.stop(job,'failed');return;}
   const value=JSON.parse(text);
   if(value.sourceIdentity){const identity=builderSafeSourceIdentity(value.sourceIdentity,job.config.sourceCommit);if(!identity||(job.sourceIdentity&&JSON.stringify(job.sourceIdentity)!==JSON.stringify(identity))){await this.stop(job,'failed');return;}job.sourceIdentity=identity;}
   const checkpoint=builderSafeCheckpoint(value.checkpoint);if(checkpoint)job.checkpoint=checkpoint;
   if(value.result&&typeof value.result.setupToken==='string'&&value.result.setupToken.length>=16&&value.result.setupToken.length<=4096&&value.result.appUrl==='https://app.'+job.config.baseDomain)job.result={setupToken:value.result.setupToken,appUrl:value.result.appUrl};
   if(value.runtimeTrust&&this.env.BUILDER_ARTIFACTS){const selected=builderSafeTrust(value.runtimeTrust);if(selected)await this.env.BUILDER_ARTIFACTS.put('installer/jobs/'+job.id+'/codex-trust.json',JSON.stringify(selected));}
   if(value.state==='completed'||value.state==='failed'){await this.stop(job,value.state);return;}
   await this.persist(job);
  }catch{/* Status is advisory; the durable absolute deadline still stops compute. */}
 }
 async alarm(){return this.serialized(async()=>{try{await this.reconcile();}catch{const job=await this.ctx.storage.get('job');if(job&&(['starting','running'].includes(job.status)||job.stopping))await this.ctx.storage.setAlarm(Math.min(job.deadline,Date.now()+5000));}});}
}
`;
