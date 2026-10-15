import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const supervisor=fileURLToPath(new URL('./safe-controller.mjs',import.meta.url));
const canary='cookie=ghs_'+'Q'.repeat(36);
test('actual supervised diagnostic is owner-bound, uniquely selected and canary-free',async()=>{
  const source=await readFile(new URL('./diagnose-fixture-delivery.mjs',import.meta.url),'utf8');
  for(const mode of ['ok','foreign','duplicate','truncated','missing','denied','network']){
    const dir=await mkdtemp(join(tmpdir(),'sam-delivery-projection-'));
    try{
      const row={id:'11111111-1111-4111-8111-111111111111',targetSessionId:'675e6493-dd46-49e3-85a5-54d6b58ef6be',
        sourceKind:'user_followup',createdAt:Date.parse('2026-10-15T21:27:30Z'),deliveryState:'retry_wait',deliveryAttempts:2,
        receiptState:null,lastError:canary,terminalReason:canary,nextAttemptAt:null,attemptStartedAt:null,lastDeliveryAt:null,
        expiresAt:null,acceptedAt:null,deliveredAt:null,receiptCheckedAt:null,content:canary,metadata:{private:canary},runtimeIdentity:canary};
      const payload={featureConfig:{deliveryEnabled:true,legacyVmCompatEnabled:false,supervisorEnabled:true,secret:canary},deliveries:[row],deliveryTotal:1,sessionState:{content:canary}};
      if(mode==='foreign')row.targetSessionId='00000000-0000-4000-8000-000000000000';
      if(mode==='duplicate'){payload.deliveries.push({...row,id:'22222222-2222-4222-8222-222222222222'});payload.deliveryTotal=2;}
      if(mode==='truncated')payload.deliveryTotal=51;
      if(mode==='missing')row.createdAt=0;
      const mock=join(dir,'mock.mjs');
      await writeFile(mock,`const canary=${JSON.stringify(canary)},mode=${JSON.stringify(mode)},payload=${JSON.stringify(payload)};
        export const chromium={launch:async()=>({newContext:async()=>({request:{fetch:async(url,options)=>{
          console.log(canary);console.error(canary);
          if(options.headers.Origin!=='https://api.sammy.party'||options.maxRedirects!==0)throw new Error(canary);
          const path=new URL(url).pathname;
          if(!['/api/auth/token-login','/api/auth/sign-out','/api/auth/get-session','/api/nodes','/api/projects/01KJNR9R3TEN3KX1ETE33852R8/sessions/675e6493-dd46-49e3-85a5-54d6b58ef6be/durability'].includes(path))throw new Error(canary);
          if(options.method==='DELETE')throw new Error(canary);
          if(path.endsWith('/durability')&&mode==='network')throw new Error(canary);
          const status=path==='/api/nodes'||path.endsWith('/durability')&&mode==='denied'?403:200;
          return {status:()=>status,json:async()=>path==='/api/auth/get-session'?null:payload,dispose:async()=>{}};
        }}}),close:async()=>{}})};`);
      const entry=join(dir,'entry.mjs');
      await writeFile(entry,source.replace("'/tmp/reliability-browser-deps/node_modules/playwright/index.mjs'",JSON.stringify(pathToFileURL(mock).href)));
      const child=spawnSync(process.execPath,[supervisor,entry,'3000'],{encoding:'utf8',timeout:5000,
        env:{...process.env,SAM_PLAYWRIGHT_PRIMARY_USER:canary}});
      assert.equal(child.error,undefined);assert.equal(child.status,0);assert.equal(child.stderr,'');assert.ok(!child.stdout.includes(canary));
      const result=JSON.parse(child.stdout);
      assert.equal(result.category,mode==='ok'?'ok':'controller');
      const output=join(dir,'durability-result.json');
      if(mode==='ok'){
        const raw=await readFile(output,'utf8');assert.ok(!raw.includes(canary));
        const safe=JSON.parse(raw);assert.equal(safe.delivery.terminalReason,'unknown');assert.equal(safe.delivery.hasLastError,true);
        assert.equal(safe.delivery.deliveryState,'retry_wait');assert.equal(safe.delivery.deliveryAttempts,2);
        assert.deepEqual(Object.keys(safe).sort(),['delivery','deliveryTotal','featureConfig','projectId','sessionId']);
        assert.equal((await stat(output)).mode&0o777,0o600);
        for(const key of ['content','metadata','lastError','runtimeIdentity'])assert.equal(Object.hasOwn(safe.delivery,key),false);
      }else await assert.rejects(readFile(output));
    }finally{await rm(dir,{recursive:true,force:true});}
  }
});
