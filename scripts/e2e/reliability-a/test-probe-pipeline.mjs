import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {probeArtifact,baselineArtifact} from './queue-controller.mjs';
const here=dirname(fileURLToPath(import.meta.url));
// Every child stream remains captured. Assertion failures contain fixed labels only.
function execute(binary,args,cwd,expectedStatus=0){
 const result=spawnSync(binary,args,{cwd,encoding:'utf8',timeout:20000,env:{...process.env,GIT_AUTHOR_NAME:'Synthetic Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Synthetic Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}});
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
  writeFileSync(join(repo,'.workflow-state.md'),'synthetic tamper');
  const failedCheck=probeArtifact(JSON.parse(execute('python3',[join(here,'git-probe.py'),'check'],repo,1)),'a-check');
  assert.equal(Object.values(failedCheck.checks).every(v=>v===true),false,'schema transfer is not phase success');
  assert.equal(failedCheck.statuses.probe,1,'actual failed phase status remains visible');
  for(const value of [{},{checks:{probeCompleted:false},statuses:{probe:1}},baseline,{...prepare,raw:'SYNTHETIC_CANARY'}])assert.throws(()=>probeArtifact(value,'a-prepare'),'nonmatching transfer must reject');
 }finally{rmSync(root,{recursive:true,force:true});}
});
