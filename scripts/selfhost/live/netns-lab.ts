/**
 * A two-namespace lab for the egress fence (live/fence-netns.live.test.ts).
 *
 *   fenced netns: lo + veth 10.99.0.1/30, fd99::1/64, default routes to the peer; the fence and
 *                 the probes run here, as the fenced uid and as a control uid
 *   peer netns:   veth 10.99.0.2/30, fd99::2/64, and every remote target address on lo, each with
 *                 a listener, so a control probe reaches it and only the fence can refuse it
 *
 * Needs passwordless sudo, iproute2, nftables and util-linux setpriv. Nothing touches the host's
 * own network namespace or firewall.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SUDO = '/usr/bin/sudo';
const IP = '/usr/sbin/ip';
const TOOLS = ['/usr/sbin/ip', '/usr/sbin/nft', '/usr/bin/setpriv', '/bin/bash'];

/** A public address the fenced namespace holds itself (not routed anywhere). */
export const FENCED_PUBLIC_ADDRESS = '203.0.114.10';

/** Addresses the peer holds on lo: the remote rule classes plus public stand-ins. */
export const PEER_TARGETS = [
  '10.255.255.1/32',
  '169.254.169.254/32',
  '100.100.100.200/32',
  '192.168.255.1/32',
  '172.16.255.1/32',
  '93.184.216.34/32', // public stand-in
  'fd00::1/128',
  'fd20:ce::254/128',
  '2002:a9fe:a9fe::1/128',
  '2001::1/128',
  '2606:2800:220:1::1/128', // public stand-in
];

/** Why the lab cannot run here, or null. */
export function labUnavailableReason(): string | null {
  if (process.platform !== 'linux') return 'not Linux';
  if (spawnSync(SUDO, ['-n', 'true']).status !== 0) return 'no passwordless sudo';
  const missing = TOOLS.filter((tool) => spawnSync(SUDO, ['-n', 'test', '-x', tool]).status !== 0);
  return missing.length > 0 ? `missing ${missing.join(', ')}` : null;
}

function run(args: string[], input?: string): string {
  const result = spawnSync(SUDO, ['-n', ...args], { encoding: 'utf8', input });
  if (result.status !== 0) {
    throw new Error(`${args.join(' ')} failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout;
}

/** Node one-liner: TCP listeners on every address (dual stack) that answer and close. */
function listenerScript(ports: number[]): string {
  return `const net=require('net');for(const p of ${JSON.stringify(ports)}){net.createServer(s=>{s.on('error',()=>{});s.end('ok\\n')}).listen(p,'::')}`;
}

export class NetnsLab {
  readonly fenced: string;
  readonly peer: string;
  private readonly children: ChildProcess[] = [];

  constructor() {
    const id = randomBytes(3).toString('hex');
    this.fenced = `samfence-${id}`;
    this.peer = `sampeer-${id}`;
  }

  setup(peerPorts: number[], fencedPorts: number[]): void {
    const { fenced, peer } = this;
    run([IP, 'netns', 'add', fenced]);
    run([IP, 'netns', 'add', peer]);
    const vf = `vf${fenced.slice(-6)}`;
    const vp = `vp${fenced.slice(-6)}`;
    run([
      IP,
      'link',
      'add',
      vf,
      'netns',
      fenced,
      'type',
      'veth',
      'peer',
      'name',
      vp,
      'netns',
      peer,
    ]);
    const batch = (ns: string, lines: string[]): void => {
      run([IP, '-n', ns, '-batch', '-'], `${lines.join('\n')}\n`);
    };
    batch(fenced, [
      'link set lo up',
      `link set ${vf} up`,
      `addr add 10.99.0.1/30 dev ${vf}`,
      // A public address on the interface, as on a box whose public IP is on its NIC.
      `addr add ${FENCED_PUBLIC_ADDRESS}/32 dev ${vf}`,
      `addr add fd99::1/64 dev ${vf} nodad`,
      'route add default via 10.99.0.2',
      'route add ::/0 via fd99::2',
    ]);
    batch(peer, [
      'link set lo up',
      `link set ${vp} up`,
      `addr add 10.99.0.2/30 dev ${vp}`,
      `addr add fd99::2/64 dev ${vp} nodad`,
      ...PEER_TARGETS.map((address) =>
        address.includes(':') ? `addr add ${address} dev lo nodad` : `addr add ${address} dev lo`
      ),
    ]);
    this.spawn(peer, [process.execPath, '-e', listenerScript(peerPorts)]);
    this.spawn(fenced, [process.execPath, '-e', listenerScript(fencedPorts)]);
  }

  /** A long-running root process in `ns`; stopped by teardown. */
  spawn(ns: string, args: string[], env: Record<string, string> = {}): ChildProcess {
    const envArgs = Object.entries(env).map(([name, value]) => `${name}=${value}`);
    const child = spawn(SUDO, ['-n', IP, 'netns', 'exec', ns, 'env', ...envArgs, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.children.push(child);
    return child;
  }

  /** Runs `args` in `ns` as root (uid undefined) or as `uid`, returning combined output. */
  exec(
    ns: string,
    args: string[],
    uid?: number,
    input?: string
  ): { status: number; output: string } {
    const asUser =
      uid === undefined
        ? []
        : ['/usr/bin/setpriv', `--reuid=${uid}`, `--regid=${uid}`, '--clear-groups'];
    const result = spawnSync(
      SUDO,
      [
        '-n',
        IP,
        'netns',
        'exec',
        ns,
        ...asUser,
        'env',
        '-i',
        'PATH=/usr/sbin:/usr/bin:/sbin:/bin',
        ...args,
      ],
      { encoding: 'utf8', input }
    );
    return { status: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
  }

  /** SIGKILLs the processes in `ns` whose command line contains `fragment`, and nothing else. */
  killInNamespace(ns: string, fragment: string): void {
    for (const pid of this.pids(ns)) {
      let cmdline = '';
      try {
        cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
      } catch {
        continue; // already gone
      }
      if (cmdline.includes(fragment)) spawnSync(SUDO, ['-n', 'kill', '-KILL', pid]);
    }
  }

  private pids(ns: string): string[] {
    const result = spawnSync(SUDO, ['-n', IP, 'netns', 'pids', ns], { encoding: 'utf8' });
    return (result.stdout ?? '').split('\n').filter(Boolean);
  }

  nft(ns: string, args: string[], input?: string): string {
    return run([IP, 'netns', 'exec', ns, '/usr/sbin/nft', ...args], input);
  }

  teardown(): void {
    for (const child of this.children) {
      if (child.pid !== undefined)
        spawnSync(SUDO, ['-n', 'pkill', '-KILL', '-P', String(child.pid)]);
      child.kill('SIGKILL');
    }
    for (const ns of [this.fenced, this.peer]) {
      for (const pid of this.pids(ns)) spawnSync(SUDO, ['-n', 'kill', '-KILL', pid]);
      spawnSync(SUDO, ['-n', IP, 'netns', 'del', ns]);
    }
  }
}
