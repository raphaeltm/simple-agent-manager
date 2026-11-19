/** Teardown acts on exact live identities, never Compose's broad project-name sweep. */
import { dirname, resolve } from 'node:path';
import { readRecord } from '../../deploy/selfhost/created-resources.mjs';
import { check } from './backup-lib';
import { composeProjectFor, expectedComposeProjectFor } from './install-record';
import type { TeardownContext } from './teardown-box';

interface Container { id: string; labels: Record<string,string> }
interface Volume { name: string; createdAt: string; labels: Record<string,string> }
export interface ComposeInventory { containers: Container[]; volumes: Volume[] }
function labels(value: unknown): Record<string,string> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(v=>typeof v !== 'string')) throw new Error('Unreadable Docker ownership labels');
  return value as Record<string,string>;
}
function result(ctx: TeardownContext, args: string[]): string {
  return check(ctx.run('docker',args),'read Docker ownership metadata').stdout.trim();
}
function parse(text: string): Record<string,unknown> {
  try { const value:unknown=JSON.parse(text); if(!value || typeof value!=='object' || Array.isArray(value)) throw new Error(); return value as Record<string,unknown>; }
  catch { throw new Error('Unreadable Docker ownership metadata'); }
}
function projectProof(ctx: TeardownContext): string {
  const project=composeProjectFor(ctx.box,ctx.stateDir);
  if(project!==expectedComposeProjectFor(ctx.box,ctx.stateDir) || !ctx.installationId) throw new Error('Refused: no exact installation Compose identity');
  const record=readRecord(ctx.recordFile).resources;
  const installs=record.filter(r=>r.cloud==='box' && r.kind==='installation' && !r.removedAt);
  const projects=record.filter(r=>r.cloud==='box' && r.kind==='compose-project' && r.name===project && r.action==='created' && r.attributes?.installation===ctx.installationId && r.attributes?.environment==='selfhost' && r.attributes?.stateDir===resolve(ctx.stateDir));
  if(installs.length!==1 || installs[0]?.name!==ctx.installationId || installs[0]?.attributes?.domain!==ctx.domain || installs[0]?.attributes?.environment!=='selfhost' || installs[0]?.attributes?.composeProject!==project || projects.length!==1) throw new Error('Refused: missing exact installation Compose receipt');
  return project;
}
export function readComposeInventory(ctx: TeardownContext): ComposeInventory {
  const project=projectProof(ctx);
  const names=(args:string[])=>result(ctx,args).split('\n').filter(Boolean);
  const ids=names(['container','ls','--all','--no-trunc','--filter',`label=com.docker.compose.project=${project}`,'--format','{{.ID}}']);
  if(new Set(ids).size!==ids.length || ids.some(id=>!/^[a-f0-9]{64}$/.test(id))) throw new Error('Refused: ambiguous Docker container inventory');
  const containers=ids.map(id=>{
    const raw=parse(result(ctx,['container','inspect','--format','{"id":{{json .Id}},"labels":{{json .Config.Labels}}}',id]));
    const meta=labels(raw.labels);
    const files=meta['com.docker.compose.project.config_files']?.split(',').map(file=>resolve(file));
    if(raw.id!==id || meta['com.docker.compose.project']!==project || !meta['com.docker.compose.service'] || meta['com.docker.compose.project.working_dir']!==dirname(ctx.composeFiles[0] ?? '') || JSON.stringify(files)!==JSON.stringify(ctx.composeFiles.map(file=>resolve(file)))) throw new Error('Refused: foreign Docker container configuration scope');
    return {id,labels:meta};
  });
  const volumes=names(['volume','ls','--filter',`label=com.docker.compose.project=${project}`,'--format','{{.Name}}']).map(name=>{
    if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) throw new Error('Refused: invalid Docker volume name');
    const raw=parse(result(ctx,['volume','inspect','--format','{"name":{{json .Name}},"createdAt":{{json .CreatedAt}},"labels":{{json .Labels}}}',name]));
    const meta=labels(raw.labels);
    if(raw.name!==name || typeof raw.createdAt!=='string' || !raw.createdAt || meta['com.docker.compose.project']!==project || name!==`${project}_${meta['com.docker.compose.volume']}`) throw new Error('Refused: foreign Docker volume configuration scope');
    return {name,createdAt:raw.createdAt,labels:meta};
  });
  if(new Set(volumes.map(v=>v.name)).size!==volumes.length) throw new Error('Refused: duplicate Docker volume inventory');
  return {containers:containers.sort((a,b)=>a.id.localeCompare(b.id)),volumes:volumes.sort((a,b)=>a.name.localeCompare(b.name))};
}
export function assertComposeInventory(ctx: TeardownContext, expected: ComposeInventory): void {
  if(JSON.stringify(readComposeInventory(ctx))!==JSON.stringify(expected)) throw new Error('Refused: Docker identities or ownership changed since inventory');
}
export function stopContainers(ctx: TeardownContext, inventory: ComposeInventory): void {
  assertComposeInventory(ctx,inventory);
  if(inventory.containers.length) check(ctx.run('docker',['container','stop',...inventory.containers.map(c=>c.id)]),'stop owned containers');
}
export function removeContainers(ctx: TeardownContext, inventory: ComposeInventory, volumes: boolean): void {
  assertComposeInventory(ctx,inventory);
  // Exact ids, individually re-fetched just above, cannot select a replacement container.
  if(inventory.containers.length) check(ctx.run('docker',['container','rm','--force',...inventory.containers.map(c=>c.id)]),'remove owned containers');
  if(volumes) for(const volume of inventory.volumes) {
    const current=readComposeInventory(ctx);
    if(!current.volumes.some(v=>JSON.stringify(v)===JSON.stringify(volume))) throw new Error('Refused: Docker volume identity changed before removal');
    check(ctx.run('docker',['volume','rm',volume.name]),'remove owned volume');
  }
}
