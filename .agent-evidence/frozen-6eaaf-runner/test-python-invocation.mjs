import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,chmodSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pythonInvocationBlock,probeStepsScript} from './python-invocation.mjs';
const folder=mkdtempSync('/workspaces/reliability-python-regression-');
try{
 const probe=join(folder,'git-probe.py'),output=join(folder,'check.json');
 writeFileSync(probe,'#!/usr/bin/env python3\nimport json,sys\nprint(json.dumps({"absoluteInterpreter":sys.executable.startswith("/")}))\nprint("PRIVATE_CANARY_do_not_emit",file=sys.stderr)\n');chmodSync(probe,0o700);
 const direct=spawnSync('/bin/bash',['-c',`'${probe}'`],{env:{PATH:''},encoding:'utf8'});
 assert.notEqual(direct.status,0);
 const block=pythonInvocationBlock(probeStepsScript([{script:probe,args:[],output}]),folder,'wake-check');
 const fixed=spawnSync('/bin/bash',['-c',block],{env:{PATH:''},encoding:'utf8',timeout:10000});
 assert.equal(fixed.status,0);assert.equal(fixed.stdout,'');assert.equal(fixed.stderr,'');
 assert.deepEqual(JSON.parse(readFileSync(output,'utf8')),{absoluteInterpreter:true});
 assert.deepEqual(JSON.parse(readFileSync(join(folder,'wake-check-invocation.json'),'utf8')),{interpreterExists:true,invocationStatus:0});
 console.log('stripped_PATH_direct_shebang_fails_absolute_same_block_probe_PASS_private_streams_PASS');
}finally{rmSync(folder,{recursive:true,force:true});}
