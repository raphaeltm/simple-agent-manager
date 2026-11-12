/**
 * Garbage collection for a SAM-hosted repository, adapted from dgit's `RepoCell.runGc`
 * (https://github.com/littledivy/durable-git, MIT, commit d5eba04; see src/vendor/dgit/UPSTREAM.md).
 *
 * After a force push or a branch deletion, objects no longer reachable from any ref still occupy
 * storage and count toward the repository's caps. This walks the graph from every ref and HEAD,
 * keeps thin-pack delta bases, moves reachable pack objects to loose storage, drops the packs, and
 * deletes unreachable loose objects. Huge repositories (beyond SAM's own object cap anyway) skip.
 */
import { isGitlinkMode, parseCommit, parseTag, parseTree } from '../vendor/dgit/git/objects';
import { OidSet } from '../vendor/dgit/git/oidset';
import type { GitStore } from '../vendor/dgit/git/store';

const GC_MAX_OBJECTS = 300_000;
/** The Durable Object SQLite ceiling a migration must not cross while duplicating objects. */
const DO_STORAGE_CAP = 10 * 1024 * 1024 * 1024;

export interface HostedGitGcResult {
  removed: number;
  kept: number;
  skipped?: boolean;
}

export async function runHostedGitGc(store: GitStore): Promise<HostedGitGcResult> {
  if (store.objectCount() > GC_MAX_OBJECTS) {
    return { removed: 0, kept: store.objectCount(), skipped: true };
  }
  const reachable = new OidSet(Math.max(store.objectCount(), 4096));
  const stack: string[] = store.refs().map((r: { target: string }) => r.target);
  const head = store.resolveHead();
  if (head) stack.push(head);
  for (let oid = stack.pop(); oid !== undefined; oid = stack.pop()) {
    if (!reachable.addHex(oid)) continue;
    const meta = store.typeAndSize(oid);
    if (!meta || meta.type === 'blob') continue;
    const obj = await store.get(oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree, ...c.parents);
    } else if (obj.type === 'tag') {
      const t = parseTag(obj.data);
      if (t.object) stack.push(t.object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (!isGitlinkMode(e.mode)) stack.push(e.oid);
      }
    }
  }
  // Thin-pack delta bases are a second reference edge, often unreachable from any ref.
  for (const b of store.packs.baseOids()) reachable.addHex(b);

  const packCount = store.packs.countObjects();
  const noHeadroom =
    packCount > 0 && store.dbSize() + store.packs.totalPackBytes() > DO_STORAGE_CAP;
  let removed = 0;
  if (packCount > 0 && !noHeadroom) {
    // Migrate reachable pack objects to loose storage first, then drop the packs.
    let migrated = 0;
    for (let i = 0; i < reachable.size; i++) {
      const oid = reachable.atHex(i);
      if (store.packs.lookup(oid)) {
        const obj = await store.get(oid);
        if (obj) {
          store.put(oid, obj.type, obj.data);
          migrated++;
        }
      }
    }
    removed += packCount - migrated;
    store.packs.reset();
  }
  for (const oid of store.allOids()) {
    if (!reachable.hasHex(oid)) {
      store.deleteObject(oid);
      removed++;
    }
  }
  return noHeadroom
    ? { removed, kept: reachable.size, skipped: true }
    : { removed, kept: reachable.size };
}
