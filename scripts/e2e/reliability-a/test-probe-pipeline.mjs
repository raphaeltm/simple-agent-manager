import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {probeArtifact,baselineArtifact,expectationsArtifact} from './queue-controller.mjs';
const here=dirname(fileURLToPath(import.meta.url));
// Every child stream remains captured. Assertion failures contain fixed labels only.
function execute(binary,args,cwd,expectedStatus=0,extraEnv={}){
 const result=spawnSync(binary,args,{cwd,encoding:'utf8',timeout:20000,env:{...process.env,GIT_AUTHOR_NAME:'Synthetic Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Synthetic Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid',...extraEnv}});
 assert.equal(result.status,expectedStatus,'actual command must have expected status');
 assert.equal(result.signal,null,'actual command must remain bounded');
 return result.stdout;
}
test('actual reviewed A CLI prepare/check stdout and baseline pass exact consumer schemas through real Git',()=>{
 const root=mkdtempSync(join(tmpdir(),'sam-a-pipeline-'));
 try{
  const bare=join(root,'remote.git'),repo=join(root,'repo');mkdirSync(repo);
  execute('git',['init','--bare','--quiet',bare],root);
  execute('git',['--git-dir='+bare,'symbolic-ref','HEAD','refs/heads/main'],root);
  execute('git',['init','--quiet','--initial-branch=main'],repo);
  execute('git',['commit','--quiet','--allow-empty','-m','synthetic remote baseline'],repo);
  execute('git',['remote','add','origin',bare],repo);
  execute('git',['push','--quiet','origin','main'],repo);
  execute('git',['switch','--quiet','-c','sam/pipeline'],repo);
  const prepare=JSON.parse(execute('python3',[join(here,'git-probe.py'),'prepare','--disposable-repository'],repo));
  const prepared=probeArtifact(prepare,'a-prepare');
  assert.equal(Object.values(prepared.checks).every(v=>v===true),true,'actual prepare checks');
  assert.equal(prepared.statuses.probe,0,'actual prepare status');
  const baseline=baselineArtifact(JSON.parse(readFileSync(join(repo,'.reliability-a/baseline.json'),'utf8')),'sam/pipeline');
  assert.throws(()=>probeArtifact(baseline,'a-prepare'),'baseline is not prepare stdout');
  assert.equal(baseline.branch,'sam/pipeline','actual baseline branch');
  const check=JSON.parse(execute('python3',[join(here,'git-probe.py'),'check'],repo));
  const checked=probeArtifact(check,'a-check');
  assert.equal(Object.values(checked.checks).every(v=>v===true),true,'actual check checks');
  assert.equal(checked.statuses.probe,0,'actual check status');
  // Run the actual observer too: Git refs come from this real local remote; gh inventory is synthetic empty.
  const bin=join(root,'bin');mkdirSync(bin);
  writeFileSync(join(bin,'git'),`#!/usr/bin/env python3\nimport os,sys\na=sys.argv[1:]\nif a==['ls-remote','--heads','https://github.com/owner/disposable.git']:a=['ls-remote','--heads',os.environ['PIPELINE_REMOTE']]\nos.execv('/usr/bin/git',['git',*a])\n`);chmodSync(join(bin,'git'),0o700);
  writeFileSync(join(bin,'gh'),"#!/bin/sh\nprintf '[]\\n'\n");chmodSync(join(bin,'gh'),0o700);
  const expectationPath=join(root,'expectations.json');
  const record=JSON.parse(execute('python3',[join(here,'terminal-observer.py'),'record','--repository','owner/disposable','--branch','sam/pipeline','--baseline',join(repo,'.reliability-a/baseline.json'),'--expectations',expectationPath],repo,0,{PATH:bin+':'+process.env.PATH,PIPELINE_REMOTE:bare}));
  assert.equal(Object.values(probeArtifact(record,'observer-record').checks).every(v=>v===true),true,'actual observer record phase');
  const expectation=JSON.parse(readFileSync(expectationPath,'utf8'));
  assert.equal(expectation.recordedAt.endsWith('+00:00'),true,'actual Python UTC encoding');
  const accepted=expectationsArtifact(expectation,baseline,'owner/disposable');
  assert.equal(accepted.recordedAt,expectation.recordedAt,'actual generated file accepted unchanged');
  for(const recordedAt of ['2026-10-15T00:00:00+01:00','SYNTHETIC_CANARY','2026-10-15T00:00:00'])assert.throws(()=>expectationsArtifact({...expectation,recordedAt},baseline,'owner/disposable'),'nonproducer timestamp rejected');
  writeFileSync(join(repo,'.workflow-state.md'),'synthetic tamper');
  const failedCheck=probeArtifact(JSON.parse(execute('python3',[join(here,'git-probe.py'),'check'],repo,1)),'a-check');
  assert.equal(Object.values(failedCheck.checks).every(v=>v===true),false,'schema transfer is not phase success');
  assert.equal(failedCheck.statuses.probe,1,'actual failed phase status remains visible');
  for(const value of [{},{checks:{probeCompleted:false},statuses:{probe:1}},baseline,{...prepare,raw:'SYNTHETIC_CANARY'}])assert.throws(()=>probeArtifact(value,'a-prepare'),'nonmatching transfer must reject');
 }finally{rmSync(root,{recursive:true,force:true});}
});
