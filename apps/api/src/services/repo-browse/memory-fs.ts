/**
 * Minimal in-memory filesystem implementing the subset isomorphic-git needs
 * (promises API). Pure JS Map — no OS/virtual-fs permissions — so it works in
 * the Workers runtime, where the built-in `node:fs` virtual fs rejects `mkdir`
 * ("operation not permitted"). Proven against real workerd (idea §10 spike).
 */

type NodeType = 'file' | 'dir' | 'symlink';

interface FsNode {
  type: NodeType;
  content?: Uint8Array;
  target?: string;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

interface FsError extends Error {
  code: string;
}

function fsError(code: string, message: string): FsError {
  const e = new Error(`${code}: ${message}`) as FsError;
  e.code = code;
  return e;
}

function normalize(p: string): string {
  if (!p || p === '.') return '/';
  const parts: string[] = [];
  for (const seg of String(p).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
}

function dirname(p: string): string {
  const n = normalize(p);
  if (n === '/') return '/';
  const i = n.lastIndexOf('/');
  return i <= 0 ? '/' : n.slice(0, i);
}

class Stat {
  type: NodeType;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  uid = 1;
  gid = 1;
  dev = 1;
  ino: number;

  constructor(node: FsNode) {
    this.type = node.type;
    this.mode = node.mode;
    this.size = node.type === 'file' ? (node.content?.length ?? 0) : 0;
    this.mtimeMs = node.mtimeMs;
    this.ctimeMs = node.ctimeMs;
    this.ino = node.ino;
  }
  isFile(): boolean {
    return this.type === 'file';
  }
  isDirectory(): boolean {
    return this.type === 'dir';
  }
  isSymbolicLink(): boolean {
    return this.type === 'symlink';
  }
}

export class MemoryFS {
  private m = new Map<string, FsNode>();
  private ino = 1;
  /** isomorphic-git prefers `fs.promises`; point it at ourselves. */
  readonly promises: MemoryFS;

  constructor() {
    this.m.set('/', { type: 'dir', mode: 0o040755, mtimeMs: Date.now(), ctimeMs: Date.now(), ino: 0 });
    this.promises = this;
  }

  private get(p: string): FsNode | undefined {
    return this.m.get(normalize(p));
  }

  private ensureParentDir(p: string): void {
    const d = dirname(p);
    const node = this.m.get(d);
    if (!node) throw fsError('ENOENT', `no such file or directory, '${p}'`);
    if (node.type !== 'dir') throw fsError('ENOTDIR', `not a directory, '${d}'`);
  }

  async mkdir(p: string, opts: { recursive?: boolean } = {}): Promise<void> {
    const path = normalize(p);
    if (path === '/') return;
    if (this.m.has(path)) {
      if (opts.recursive) return;
      throw fsError('EEXIST', `file already exists, mkdir '${p}'`);
    }
    if (opts.recursive) {
      const segs = path.slice(1).split('/');
      let cur = '';
      for (const s of segs) {
        cur += '/' + s;
        if (!this.m.has(cur)) {
          this.m.set(cur, { type: 'dir', mode: 0o040755, mtimeMs: Date.now(), ctimeMs: Date.now(), ino: this.ino++ });
        }
      }
      return;
    }
    this.ensureParentDir(path);
    this.m.set(path, { type: 'dir', mode: 0o040755, mtimeMs: Date.now(), ctimeMs: Date.now(), ino: this.ino++ });
  }

  async rmdir(p: string): Promise<void> {
    const path = normalize(p);
    if (!this.m.has(path)) throw fsError('ENOENT', `no such file or directory, rmdir '${p}'`);
    this.m.delete(path);
  }

  async writeFile(p: string, data: Uint8Array | string, opts: { mode?: number } | string = {}): Promise<void> {
    const path = normalize(p);
    this.ensureParentDir(path);
    const content = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
    const mode = (typeof opts === 'object' && opts.mode) || 0o100644;
    this.m.set(path, { type: 'file', content, mode, mtimeMs: Date.now(), ctimeMs: Date.now(), ino: this.ino++ });
  }

  async readFile(p: string, opts: { encoding?: string } | string = {}): Promise<Uint8Array | string> {
    const node = this.get(p);
    if (!node) throw fsError('ENOENT', `no such file or directory, open '${p}'`);
    if (node.type === 'dir') throw fsError('EISDIR', `illegal operation on a directory, read '${p}'`);
    const encoding = typeof opts === 'string' ? opts : opts.encoding;
    if (encoding) return new TextDecoder().decode(node.content);
    return node.content ?? new Uint8Array();
  }

  async unlink(p: string): Promise<void> {
    const path = normalize(p);
    if (!this.m.has(path)) throw fsError('ENOENT', `no such file or directory, unlink '${p}'`);
    this.m.delete(path);
  }

  async readdir(p: string): Promise<string[]> {
    const path = normalize(p);
    const node = this.m.get(path);
    if (!node) throw fsError('ENOENT', `no such file or directory, scandir '${p}'`);
    if (node.type !== 'dir') throw fsError('ENOTDIR', `not a directory, scandir '${p}'`);
    const prefix = path === '/' ? '/' : path + '/';
    const names = new Set<string>();
    for (const key of this.m.keys()) {
      if (key === path || !key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (!rest) continue;
      const first = rest.split('/')[0];
      if (first) names.add(first);
    }
    return [...names];
  }

  async stat(p: string): Promise<Stat> {
    const node = this.resolveSymlink(p);
    if (!node) throw fsError('ENOENT', `no such file or directory, stat '${p}'`);
    return new Stat(node);
  }

  async lstat(p: string): Promise<Stat> {
    const node = this.get(p);
    if (!node) throw fsError('ENOENT', `no such file or directory, lstat '${p}'`);
    return new Stat(node);
  }

  private resolveSymlink(p: string): FsNode | undefined {
    let node = this.get(p);
    let hops = 0;
    let cur = p;
    while (node && node.type === 'symlink' && hops++ < 10) {
      const target = node.target ?? '';
      cur = target.startsWith('/') ? target : dirname(cur) + '/' + target;
      node = this.m.get(normalize(cur));
    }
    return node;
  }

  async symlink(target: string, p: string): Promise<void> {
    const path = normalize(p);
    this.ensureParentDir(path);
    this.m.set(path, { type: 'symlink', target: String(target), mode: 0o120000, mtimeMs: Date.now(), ctimeMs: Date.now(), ino: this.ino++ });
  }

  async readlink(p: string): Promise<string> {
    const node = this.get(p);
    if (!node || node.type !== 'symlink') throw fsError('EINVAL', `invalid argument, readlink '${p}'`);
    return node.target ?? '';
  }

  async chmod(p: string, mode: number): Promise<void> {
    const node = this.get(p);
    if (node) node.mode = mode;
  }
}
