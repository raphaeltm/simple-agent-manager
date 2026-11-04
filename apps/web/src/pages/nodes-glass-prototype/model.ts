// PROTOTYPE ONLY — derivations for /prototype/nodes-glass.
//
// Capacity mirrors the scheduler (apps/api/src/services/workspace-resource-capacity.ts):
// CPU budget = vCPU × 1000 millicores, usable memory = RAM − 512 MB host reserve.
// CPU is compressible (going over a reservation makes work slower, not broken);
// memory is not (going over it is how an OOM kill starts). The concepts colour them
// differently for that reason.

import type { ProtoMachine, ProtoSession } from './mock-data';

export const HOST_RESERVE_MB = 512;

export function machineCapacity(m: ProtoMachine) {
  return {
    cpuMillis: m.vcpu * 1000,
    memoryMb: m.memoryMb - HOST_RESERVE_MB,
    diskMb: m.diskGb * 1024,
  };
}

export function sum(sessions: ProtoSession[], pick: (s: ProtoSession) => number): number {
  return sessions.reduce((total, s) => total + pick(s), 0);
}

export function machineTotals(m: ProtoMachine) {
  const cap = machineCapacity(m);
  const reservedCpu = sum(m.sessions, (s) => s.reserved.cpuMillis);
  const reservedMem = sum(m.sessions, (s) => s.reserved.memoryMb);
  const usedCpu = sum(m.sessions, (s) => s.used.cpuMillis);
  const usedMem = sum(m.sessions, (s) => s.used.memoryMb);
  const exclusive = m.sessions.some((s) => s.reserved.exclusiveNode);
  return {
    cap,
    reservedCpu,
    reservedMem,
    usedCpu,
    usedMem,
    exclusive,
    reservedMemShare: exclusive ? 1 : reservedMem / cap.memoryMb,
    reservedCpuShare: exclusive ? 1 : reservedCpu / cap.cpuMillis,
    usedMemShare: usedMem / cap.memoryMb,
    usedCpuShare: Math.min(1, usedCpu / cap.cpuMillis),
  };
}

/** The share of the machine a session holds: its larger of CPU and memory share. */
export function sessionShare(m: ProtoMachine, s: ProtoSession): number {
  const cap = machineCapacity(m);
  if (s.reserved.exclusiveNode) return 1;
  return Math.max(s.reserved.cpuMillis / cap.cpuMillis, s.reserved.memoryMb / cap.memoryMb);
}

export type Pressure = 'ok' | 'tight' | 'over';

/** Memory pressure of one session against its own reservation. */
export function memoryPressure(s: ProtoSession): Pressure {
  const ratio = s.used.memoryMb / s.reserved.memoryMb;
  if (ratio > 1) return 'over';
  if (ratio >= 0.9) return 'tight';
  return 'ok';
}

export function formatGb(mb: number): string {
  const gb = mb / 1024;
  if (gb >= 10) return `${Math.round(gb)} GB`;
  return `${(Math.round(gb * 10) / 10).toFixed(1)} GB`;
}

export function formatGbBare(mb: number): string {
  return formatGb(mb).replace(' GB', '');
}

export function formatVcpu(millis: number): string {
  const v = millis / 1000;
  if (millis > 0 && millis < 100) return '<0.1 vCPU';
  if (v >= 10) return `${Math.round(v)} vCPU`;
  return `${(Math.round(v * 10) / 10).toFixed(1)} vCPU`;
}

export function formatVcpuBare(millis: number): string {
  return formatVcpu(millis).replace(' vCPU', '');
}

export function formatEur(value: number, digits = 3): string {
  if (value > 0 && value < 0.001) return '<€0.001';
  return `€${value.toFixed(digits)}`;
}

export function formatAge(minutes: number): string {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function machineTitle(m: ProtoMachine): string {
  return `${m.provider} ${m.instanceType}`;
}

export function machineSpec(m: ProtoMachine): string {
  return `${m.vcpu} vCPU · ${Math.round(m.memoryMb / 1024)} GB · ${m.diskGb} GB disk`;
}

export function machineSpecShort(m: ProtoMachine): string {
  return `${m.vcpu} vCPU · ${Math.round(m.memoryMb / 1024)} GB`;
}

/** How many more sessions of the median reserved size still fit. */
export function roomFor(m: ProtoMachine): number | null {
  if (m.state === 'starting' || m.state === 'error') return null;
  const t = machineTotals(m);
  if (t.exclusive) return 0;
  const sizes = m.sessions.map((s) => s.reserved.memoryMb).sort((a, b) => a - b);
  const typical = sizes[Math.floor(sizes.length / 2)] ?? 2048;
  const freeMem = t.cap.memoryMb - t.reservedMem;
  const cpus = m.sessions.map((s) => s.reserved.cpuMillis).sort((a, b) => a - b);
  const typicalCpu = cpus[Math.floor(cpus.length / 2)] ?? 1000;
  const freeCpu = t.cap.cpuMillis - t.reservedCpu;
  return Math.max(0, Math.min(Math.floor(freeMem / typical), Math.floor(freeCpu / typicalCpu)));
}

export const SESSION_STATE_LABEL = {
  working: 'Working',
  idle: 'Idle',
  'needs-you': 'Needs you',
} as const;
