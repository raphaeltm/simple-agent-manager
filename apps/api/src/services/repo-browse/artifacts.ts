import type {
  RepoBranchesResponse,
  RepoCompareFile,
  RepoCompareResponse,
  RepoFileContent,
  RepoTreeEntry,
  RepoTreeResponse,
} from '@simple-agent-manager/shared';
import { createPatch } from 'diff';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';

import type { Env } from '../../env';
import { errors } from '../../middleware/error';
import { MemoryFS } from './memory-fs';
import type { RepoBrowser } from './types';
import { basename, guessContentType, isBinaryBytes, maxCompareFiles, maxInlineBytes } from './util';

const DEFAULT_ARTIFACTS_TOKEN_TTL = 3600;
const DIR = '/repo';

/** isomorphic-git's fs param type (our MemoryFS satisfies the promises shape). */
type IsoFs = Parameters<typeof git.clone>[0]['fs'];
type OnAuth = Parameters<typeof git.clone>[0]['onAuth'];

interface ArtifactsRepoInfo {
  remote: string;
  onAuth: OnAuth;
}

function countPatchLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

/**
 * Cloudflare Artifacts implementation of {@link RepoBrowser} using isomorphic-git
 * in the Worker runtime. Artifacts does NOT support partial-clone `filter`, so we
 * use shallow (`depth: 1`) single-branch clone/fetch into an in-memory fs and read
 * trees/blobs locally. Proven against real workerd (idea §10). Access is governed
 * by project membership (no GitHub user∩app gate applies).
 */
export class ArtifactsRepoBrowser implements RepoBrowser {
  private infoPromise: Promise<ArtifactsRepoInfo> | null = null;

  constructor(
    private readonly repoId: string,
    private readonly defaultBranch: string,
    private readonly env: Env
  ) {}

  private async info(): Promise<ArtifactsRepoInfo> {
    if (!this.infoPromise) {
      this.infoPromise = (async () => {
        const binding = this.env.ARTIFACTS;
        if (!binding) throw errors.badRequest('Artifacts is not enabled on this deployment');
        const repo = await binding.get(this.repoId);
        const ttl = parseInt(this.env.ARTIFACTS_TOKEN_TTL_SECONDS || '', 10) || DEFAULT_ARTIFACTS_TOKEN_TTL;
        const token = await repo.createToken('read', ttl);
        const onAuth: OnAuth = () => ({ username: 'x', password: token.plaintext });
        return { remote: repo.remote, onAuth };
      })();
    }
    return this.infoPromise;
  }

  /** Shallow single-branch clone of `ref` into a fresh in-memory fs. */
  private async cloneRef(ref: string): Promise<IsoFs> {
    const { remote, onAuth } = await this.info();
    const fs = new MemoryFS() as unknown as IsoFs;
    // noCheckout: we read objects via walk/readBlob, never the working tree — this
    // avoids writing a second copy of every blob into the in-memory fs.
    await git.clone({ fs, http, dir: DIR, url: remote, ref, singleBranch: true, depth: 1, noCheckout: true, onAuth });
    return fs;
  }

  async listBranches(): Promise<RepoBranchesResponse> {
    const { remote, onAuth } = await this.info();
    const refs = await git.listServerRefs({
      http,
      url: remote,
      prefix: 'refs/heads/',
      onAuth,
    });
    const names = refs
      .map((r) => r.ref.replace(/^refs\/heads\//, ''))
      .filter((n) => n.length > 0);
    // Default branch first, then the rest alphabetically.
    const rest = names.filter((n) => n !== this.defaultBranch).sort((a, b) => a.localeCompare(b));
    const ordered = names.includes(this.defaultBranch) ? [this.defaultBranch, ...rest] : rest;
    return {
      branches: ordered.map((name) => ({ name, isDefault: name === this.defaultBranch })),
      truncated: false,
    };
  }

  async listTree(ref: string): Promise<RepoTreeResponse> {
    const fs = await this.cloneRef(ref);
    const entries: RepoTreeEntry[] = [];
    await git.walk({
      fs,
      dir: DIR,
      trees: [git.TREE({ ref })],
      map: async (filepath, [entry]) => {
        if (filepath === '.' || !entry) return null;
        const type = await entry.type();
        if (type !== 'blob' && type !== 'tree') return null;
        entries.push({ path: filepath, name: basename(filepath), type, size: null });
        return null;
      },
    });
    return { ref, path: '', entries, truncated: false };
  }

  private async readFileBytes(fs: IsoFs, ref: string, path: string): Promise<Uint8Array> {
    const oid = await git.resolveRef({ fs, dir: DIR, ref });
    try {
      const { blob } = await git.readBlob({ fs, dir: DIR, oid, filepath: path });
      return blob;
    } catch {
      throw errors.notFound('File');
    }
  }

  async getFile(ref: string, path: string): Promise<RepoFileContent> {
    const fs = await this.cloneRef(ref);
    const bytes = await this.readFileBytes(fs, ref, path);
    const size = bytes.length;
    const base: RepoFileContent = { ref, path, size, isBinary: false, tooLarge: false, content: null, rawUrl: null };
    if (size > maxInlineBytes(this.env)) return { ...base, tooLarge: true };
    if (isBinaryBytes(bytes)) return { ...base, isBinary: true };
    return { ...base, content: new TextDecoder().decode(bytes) };
  }

  async getRawFile(ref: string, path: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    const fs = await this.cloneRef(ref);
    const bytes = await this.readFileBytes(fs, ref, path);
    return { bytes, contentType: guessContentType(path) };
  }

  async compare(base: string, head: string): Promise<RepoCompareResponse> {
    const { remote, onAuth } = await this.info();
    const fs = new MemoryFS() as unknown as IsoFs;
    await git.clone({ fs, http, dir: DIR, url: remote, ref: base, singleBranch: true, depth: 1, noCheckout: true, onAuth });
    await git.fetch({ fs, http, dir: DIR, url: remote, ref: head, singleBranch: true, depth: 1, onAuth });

    const baseOid = await git.resolveRef({ fs, dir: DIR, ref: base });
    const headOid = await git
      .resolveRef({ fs, dir: DIR, ref: `refs/remotes/origin/${head}` })
      .catch(() => git.resolveRef({ fs, dir: DIR, ref: head }));

    const fileCap = maxCompareFiles(this.env);
    let truncated = false;
    const files: RepoCompareFile[] = [];
    await git.walk({
      fs,
      dir: DIR,
      trees: [git.TREE({ ref: baseOid }), git.TREE({ ref: headOid })],
      map: async (filepath, [a, b]) => {
        if (filepath === '.') return null;
        const aType = a ? await a.type() : null;
        const bType = b ? await b.type() : null;
        if (aType === 'tree' || bType === 'tree') return null; // walk auto-recurses
        const aOid = a ? await a.oid() : null;
        const bOid = b ? await b.oid() : null;
        if (aOid === bOid) return null;
        // Bound Worker CPU/memory: stop materializing diffs past the cap.
        if (files.length >= fileCap) {
          truncated = true;
          return null;
        }

        const aBytes = aOid ? (await git.readBlob({ fs, dir: DIR, oid: aOid })).blob : new Uint8Array();
        const bBytes = bOid ? (await git.readBlob({ fs, dir: DIR, oid: bOid })).blob : new Uint8Array();
        const status = !aOid ? 'added' : !bOid ? 'removed' : 'modified';

        if (isBinaryBytes(aBytes) || isBinaryBytes(bBytes)) {
          files.push({
            path: filepath, status, additions: 0, deletions: 0,
            patch: null, patchTruncated: false, isBinary: true,
          });
          return null;
        }
        const aText = new TextDecoder().decode(aBytes);
        const bText = new TextDecoder().decode(bBytes);
        const patch = createPatch(filepath, aText, bText);
        const { additions, deletions } = countPatchLines(patch);
        files.push({ path: filepath, status, additions, deletions, patch, patchTruncated: false, isBinary: false });
        return null;
      },
    });

    files.sort((x, y) => x.path.localeCompare(y.path));
    return {
      base,
      head,
      files,
      totalAdditions: files.reduce((n, f) => n + f.additions, 0),
      totalDeletions: files.reduce((n, f) => n + f.deletions, 0),
      filesChanged: files.length,
      truncated,
    };
  }
}

export function createArtifactsRepoBrowser(opts: {
  repoId: string;
  defaultBranch: string;
  env: Env;
}): ArtifactsRepoBrowser {
  return new ArtifactsRepoBrowser(opts.repoId, opts.defaultBranch, opts.env);
}
