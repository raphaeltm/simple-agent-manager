/** Verification-only second restore of ONE retained case. No submission/setup path. */
import {readFile,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {run as lifecycle} from './prospective-vm-controller.mjs';
import {identity,repository} from './prospective-vm.mjs';
import {baselineArtifact,expectationsArtifact} from './queue-controller.mjs';
const sourceRoot='/tmp/reliability-prospective-vm-claude-001';
export const originalEvidenceSha256='9715d238b6fcf5cc1e45e065ea041e87e8b72b38b6776664827467a6e74c14d2';
const sha=b=>createHash('sha256').update(b).digest('hex');
export function resumeIdentity(own){
 identity(own);
 if(own.taskId!=='01M51Q2J7AQEKAKZAKZ39NFXWP'||own.sessionId!=='f5f56c5b-e9fb-4218-b327-bd9d4b7e25e9'||own.branch!=='sam/authorized-one-clean-prospective-9nfxwp'||own.agentProfileId!=='01KRS7Z2R88JFC73ARA7DV9WTK'||own.agentType!=='claude-code')throw 0;
}
export async function retainedOriginals(own){
 resumeIdentity(own);const dir=await lstat(sourceRoot);if(!dir.isDirectory()||dir.isSymbolicLink())throw 0;
 const names=['config.json','clock.json','final.json','setup-result.json','turn-check-result.json','setup/done.json','setup/asset-hashes.json','setup/prepare.json','setup/baseline.json','setup/check.json','setup/record.json','setup/expectations.json','turn-check/done.json','turn-check/asset-hashes.json','turn-check/check.json','turn-check/publication.json'].sort();
 const bytes={},digests={};
 for(const name of names){const st=await lstat(sourceRoot+'/'+name);if(!st.isFile()||st.isSymbolicLink()||st.size>131072)throw 0;bytes[name]=await readFile(sourceRoot+'/'+name);digests[name]=sha(bytes[name]);}
 if(sha(JSON.stringify(digests))!==originalEvidenceSha256)throw Error('retained-digest');
 const config=JSON.parse(bytes['config.json']),final=JSON.parse(bytes['final.json']);
 resumeIdentity(config.own);if(Object.keys(own).filter(k=>k!=='receipt').some(k=>own[k]!==config.own[k])||Object.keys(own.receipt).some(k=>own.receipt[k]!==config.own.receipt[k])||final.ok!==false||final.stage!=='wake-check'||!final.authCleanup||!final.browserClosed||!final.retained)throw 0;
 const baseline=bytes['setup/baseline.json'],expectations=bytes['setup/expectations.json'];
 expectationsArtifact(JSON.parse(expectations),baselineArtifact(JSON.parse(baseline),own.branch),repository);
 return {baseline,expectations,proof:{originalEvidenceSha256,baselineSha256:digests['setup/baseline.json'],expectationsSha256:digests['setup/expectations.json'],setupManifestSha256:digests['setup/done.json'],turnCheckManifestSha256:digests['turn-check/done.json'],firstWakePass:false,historicalCause:'unknown'}};
}
/** Separate coverage ledger: never imports historical events as current PASS. */
export class ContinuationSequence{
 constructor(own,started,hard){resumeIdentity(own);if(!Number.isSafeInteger(started)||!Number.isSafeInteger(hard)||hard<=started||hard-started>2700000)throw 0;this.started=started;this.hard=hard;this.events=[];}
 append(kind,proof,now){
  const order=['retained-originals','wake','wake-check','complete','observe'];
  if(kind!==order[this.events.length]||!Number.isSafeInteger(now)||now<this.started||now>=this.hard-120000||(this.events.length&&now<this.events.at(-1).at)||proof?.ok!==true)throw 0;
  if(kind==='retained-originals'&&(!proof.hostBytesRetained||proof.originalEvidenceSha256!==originalEvidenceSha256||proof.firstWakePass!==false))throw 0;
  if(kind==='wake'&&(!proof.actualHarness||!proof.freshInactive||!proof.prompt202))throw 0;
  if(kind==='complete'&&(!proof.actualTool||!proof.completionEvidence||!(Date.parse(proof.canonicalCompletedAt)>this.events[0].at)))throw 0;
  if(kind==='observe'&&(!proof.independentRuntime||!proof.originalBaseline||!proof.originalExpectations||!proof.afterCanonical||!proof.allRefsAllPrStates))throw 0;
  this.events.push({kind,at:now,proof});return this;
 }
 get pass(){return this.events.length===5;}
}
export async function run(context){return lifecycle(context,true);}
