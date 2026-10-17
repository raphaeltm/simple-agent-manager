import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const adapter = fileURLToPath(new URL('./safe-controller.mjs', import.meta.url));
const canary = 'session_cookie=ghs_' + 'X'.repeat(36);
async function run(source, deadline = 1500) {
  const dir = await mkdtemp(join(tmpdir(), 'sam-controller-canary-'));
  try {
    const entry = join(dir, 'entry.mjs');
    await writeFile(entry, source);
    const child = spawnSync(process.execPath, [adapter, entry, String(deadline)], { encoding: 'utf8', timeout: deadline + 3000 });
    assert.equal(child.error, undefined);
    assert.equal(child.stderr, '');
    assert.ok(!child.stdout.includes(canary));
    const value = JSON.parse(child.stdout);
    assert.deepEqual(Object.keys(value).sort(), ['category', 'checks', 'status']);
    assert.equal(typeof value.status, 'number');
    assert.ok(Object.values(value.checks).every(v => typeof v === 'boolean'));
    return value;
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const privateNoise = `console.log(${JSON.stringify(canary)});console.error(${JSON.stringify(canary)});process.stdout.write(${JSON.stringify(canary)});process.stderr.write(${JSON.stringify(canary)});`;
test('startup, outer/cleanup errors and native/subprocess streams are private', async () => {
  for (const body of [
    `${privateNoise}throw new Error(${JSON.stringify(canary)});`,
    `export async function run(){${privateNoise}throw new Error(${JSON.stringify(canary)});}`,
    `import{spawnSync}from'node:child_process';export async function run(){spawnSync(process.execPath,['-e',${JSON.stringify(privateNoise)}],{stdio:'inherit'});try{return {}}finally{throw new Error(${JSON.stringify(canary)})}}`,
    `export async function run(){process.send({kind:'finished',result:{error:${JSON.stringify(canary)}}});await new Promise(()=>{});}`,
  ]) assert.ok(['controller','configuration'].includes((await run(body)).category));
});
test('actual async request boundary categories and same-context Origin logout', async () => {
  for (const [mode, expected] of [['ok','ok'],['network','network'],['timeout','timeout'],['http','response'],['json','malformed'],['consumer','malformed'],['dispose','ok']]) {
    const source = `export async function run({requestSafe,logoutSafe}){
      const mode=${JSON.stringify(mode)}, canary=${JSON.stringify(canary)};
      const response={status:()=>mode==='http'?403:200,json:async()=>{console.log(canary);if(mode==='json')throw new Error(canary);return {cookie:canary};},dispose:async()=>{if(mode==='dispose')throw new Error(canary);}};
      const context={request:{fetch:async(url,options)=>{console.log(canary);console.error(canary);
        if(options.headers.Origin!=='https://stage.example.invalid'||options.maxRedirects!==0||options.failOnStatusCode!==false)throw new Error('bad config');
        if(mode==='network')throw new Error(canary);
        if(mode==='timeout'){const e=new Error(canary);e.name='TimeoutError';throw e;}
        return response;}}};
      if(mode==='ok')return logoutSafe(context,'https://stage.example.invalid');
      return requestSafe(context,'https://stage.example.invalid',{path:'/api/tasks'},()=>{if(mode==='consumer')throw new Error(canary);return true;});
    }`;
    assert.equal((await run(source)).category, expected);
  }
});
test('whole-job deadline contains hung fetch, disposal and launch', async () => {
  for (const source of [
    `export async function run(){setInterval(()=>{},100);await new Promise(()=>{});}`,
    `export async function run({requestSafe}){return requestSafe({request:{fetch:async()=>new Promise(()=>{})}},'https://stage.example.invalid',{path:'/api/tasks'});}`,
    `export async function run({requestSafe}){return requestSafe({request:{fetch:async()=>({status:()=>200,dispose:async()=>new Promise(()=>{})})}},'https://stage.example.invalid',{path:'/api/tasks'});}`,
  ]) assert.equal((await run(source, 200)).category, 'timeout');
});
test('malformed inputs, nonJSON and private consumers never become public raw data', async () => {
  for (const path of ['https://evil.invalid/api/a', '//evil.invalid/api/a','/api/../outside','/api/a?cookie='+canary,'/api/\\evil']) {
    const value = await run(`export async function run({requestSafe}){return requestSafe({request:{fetch:()=>{throw new Error(${JSON.stringify(canary)})}}},'https://stage.example.invalid',{path:${JSON.stringify(path)}});}`);
    assert.equal(value.checks.requestSucceeded, false);
  }
  const value = await run(`export async function run({requestSafe}){return requestSafe({request:{fetch:async()=>({status:()=>200,json:async()=>${JSON.stringify(canary)},dispose:async()=>{}})}},'https://stage.example.invalid',{path:'/api/a'},()=>${JSON.stringify(canary)});}`);
  assert.equal(value.category, 'malformed');
});
test('typed private state drops secrets and rejects malformed selected fields', async () => {
  const { privateState } = await import('./safe-controller.mjs');
  assert.deepEqual(privateState({ id: '01M500AK29N2DS0YQ7D6N3KA0S', status: 'running', cookie: canary }),
    { id: '01M500AK29N2DS0YQ7D6N3KA0S', status: 'running' });
  for (const value of [{ id: canary }, { status: canary }, { runtimeWorkCount: -1 }, { completedAt: canary }, { cookie: canary }]) assert.equal(privateState(value), null);
});
test('screenshot navigation, capture and outer cleanup failures are private', async () => {
  for (const mode of ['goto','screenshot']) {
    const value = await run(`export async function run({screenshotSafe}){const fail=async()=>{${privateNoise}throw new Error(${JSON.stringify(canary)})};return screenshotSafe({goto:${mode === 'goto' ? 'fail' : 'async()=>{}'},screenshot:fail},'https://app.example.invalid','/project','/private/image.png');}`);
    assert.equal(value.category, 'controller');
  }
});
