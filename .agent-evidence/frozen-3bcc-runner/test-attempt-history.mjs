import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const supervisor=fileURLToPath(new URL('./safe-controller.mjs',import.meta.url));
const canary='cookie=ghs_'+'R'.repeat(36);
test('actual supervised producer-shaped activity projection bounds identity, redacts and refuses incomplete pages',async()=>{
 const source=await readFile(new URL('./diagnose-attempt-history.mjs',import.meta.url),'utf8');
 for(const mode of ['ok','foreign-session','foreign-delivery','wrong-type','has-more','equal-ms-boundary','denied','network']){
  const dir=await mkdtemp(join(tmpdir(),'sam-attempt-history-'));
  try{
   const row={id:'11111111-1111-4111-8111-111111111111',sessionId:'675e6493-dd46-49e3-85a5-54d6b58ef6be',eventType:'prompt_delivery.retry',
    actorType:'system',actorId:null,workspaceId:null,taskId:'01M50Q06GF13H5JX517T7SXX2N',createdAt:Date.parse('2026-10-15T21:30:01Z'),
    payload:{deliveryId:'01M50QD5KWSD1Q7D1EX4PJK387',attemptId:'22222222-2222-4222-8222-222222222222',attemptCount:2,mode:'submit',result:'retry',reason:canary,
      userMessageAt:Date.parse('2026-10-15T21:27:33Z'),preparationStartedAt:Date.parse('2026-10-15T21:29:30Z'),resultAppliedAt:Date.parse('2026-10-15T21:30:01Z'),runtimeAcceptedAt:null,wakeReadyAt:null,
      runtimeIdentity:canary,content:canary,detail:canary,lastError:canary,metadata:{secret:canary}}};
   const payload={events:[row],hasMore:false};
   if(mode==='foreign-session')row.sessionId='00000000-0000-4000-8000-000000000000';
   if(mode==='foreign-delivery')row.payload.deliveryId='01M50QD5KWSD1Q7D1EX4PJK388';
   if(mode==='wrong-type')row.eventType='prompt_delivery.failed';
   if(mode==='has-more')payload.hasMore=true;
   if(mode==='equal-ms-boundary'){payload.hasMore=true;payload.events=Array.from({length:100},(_,i)=>({...row,id:String(i).padStart(26,'0')}));}
   const mock=join(dir,'mock.mjs');
   await writeFile(mock,`const canary=${JSON.stringify(canary)},mode=${JSON.stringify(mode)},payload=${JSON.stringify(payload)};
    export const chromium={launch:async()=>({newContext:async()=>({request:{fetch:async(url,options)=>{
     console.log(canary);console.error(canary);
     if(options.headers.Origin!=='https://api.sammy.party'||options.maxRedirects!==0||options.method==='DELETE')throw new Error(canary);
     const target=new URL(url),path=target.pathname;
     if(path.endsWith('/activity')){
      if(options.method!=='GET'||target.origin!=='https://api.sammy.party'||path!=='/api/projects/01KJNR9R3TEN3KX1ETE33852R8/activity'
       ||target.searchParams.get('sessionId')!=='675e6493-dd46-49e3-85a5-54d6b58ef6be'||target.searchParams.get('before')!==String(Date.parse('2026-10-15T21:33:28Z'))
       ||target.searchParams.get('limit')!=='100'||target.searchParams.size!==4)throw new Error(canary);
      const type=target.searchParams.get('eventType');
      if(!['prompt_delivery.accepted','prompt_delivery.retry','prompt_delivery.failed','prompt_delivery.ambiguous'].includes(type))throw new Error(canary);
      if(mode==='network')throw new Error(canary);
      return {status:()=>mode==='denied'?403:200,json:async()=>type==='prompt_delivery.retry'?payload:{events:[],hasMore:false},dispose:async()=>{}};
     }
     if(!['/api/auth/token-login','/api/auth/sign-out','/api/auth/get-session','/api/nodes'].includes(path))throw new Error(canary);
     return {status:()=>path==='/api/nodes'?403:200,json:async()=>path==='/api/auth/get-session'?null:{},dispose:async()=>{}};
    }}}),close:async()=>{}})};`);
   const entry=join(dir,'entry.mjs');
   await writeFile(entry,source.replace("'/tmp/reliability-browser-deps/node_modules/playwright/index.mjs'",JSON.stringify(pathToFileURL(mock).href)));
   const child=spawnSync(process.execPath,[supervisor,entry,'3000'],{encoding:'utf8',timeout:5000,env:{...process.env,SAM_PLAYWRIGHT_PRIMARY_USER:canary}});
   assert.equal(child.error,undefined);assert.equal(child.status,0);assert.equal(child.stderr,'');assert.ok(!child.stdout.includes(canary));
   const pass=['ok','foreign-delivery'].includes(mode);
   assert.equal(JSON.parse(child.stdout).category,pass?'ok':'controller');
   const output=join(dir,'attempt-history-result.json');
   if(pass){
    const raw=await readFile(output,'utf8');assert.ok(!raw.includes(canary));
    const safe=JSON.parse(raw);assert.equal(safe.allPagesExhausted,true);assert.equal(safe.retentionVerified,false);assert.equal(safe.pages.length,4);
    const events=safe.pages.flatMap(x=>x.events);assert.equal(events.length,mode==='ok'?1:0);
    if(events.length){assert.equal(events[0].reason,'unknown');assert.equal(events[0].attemptCount,2);
     for(const key of ['runtimeIdentity','content','detail','lastError','metadata','payload'])assert.equal(Object.hasOwn(events[0],key),false);}
    assert.equal((await stat(output)).mode&0o777,0o600);
   }else await assert.rejects(readFile(output));
  }finally{await rm(dir,{recursive:true,force:true});}
 }
});
