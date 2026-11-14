/**
 * Boot disk size for SAM-created GCP VMs. The disk scales with the machine so a bigger node can
 * hold as many workspaces as its CPU and memory allow: every workspace reserves disk too, and a
 * flat 50 GB disk made disk the first dimension to run out on 8-vCPU nodes.
 *
 * One function decides the size for the catalog (the offering's `diskGb`, which becomes the pool
 * candidate's disk), for the price, and for the VM `GcpProvider.createVM` inserts, so all of them
 * agree. Both numbers are admin settings (`gcpCatalog.bootDiskGbPerVcpu`,
 * `gcpCatalog.bootDiskMinGb`) resolved by the API and passed to the provider.
 */

export interface GcpBootDiskPolicy {
  /** GB of boot disk per vCPU. */
  gbPerVcpu: number;
  /** Smallest boot disk SAM creates, whatever the vCPU count. */
  minGb: number;
}

export const DEFAULT_GCP_BOOT_DISK_GB_PER_VCPU = 20;
export const DEFAULT_GCP_BOOT_DISK_MIN_GB = 50;
/** Smallest boot disk the Ubuntu images SAM boots accept. */
export const GCP_BOOT_DISK_FLOOR_GB = 10;
/** Persistent Disk's own ceiling for a single disk is far above this; it bounds a typo. */
export const GCP_BOOT_DISK_MAX_GB = 4_096;

export const DEFAULT_GCP_BOOT_DISK_POLICY: GcpBootDiskPolicy = Object.freeze({
  gbPerVcpu: DEFAULT_GCP_BOOT_DISK_GB_PER_VCPU,
  minGb: DEFAULT_GCP_BOOT_DISK_MIN_GB,
});

/** Boot disk GB for a machine with `vcpus` vCPUs: `max(minGb, gbPerVcpu × vcpus)`, capped. */
export function gcpBootDiskSizeGb(
  vcpus: number | null | undefined,
  policy: GcpBootDiskPolicy = DEFAULT_GCP_BOOT_DISK_POLICY
): number {
  const perVcpu =
    typeof vcpus === 'number' && Number.isFinite(vcpus) && vcpus > 0
      ? Math.ceil(policy.gbPerVcpu * vcpus)
      : 0;
  const size = Math.max(policy.minGb, perVcpu, GCP_BOOT_DISK_FLOOR_GB);
  return Math.min(size, GCP_BOOT_DISK_MAX_GB);
}

/**
 * vCPUs a machine type name states (`e2-standard-8` → 8). Shared-core and custom names
 * (`e2-medium`, `e2-custom-4-8192`) state none, so the policy floor applies to them.
 */
export function gcpMachineTypeNamedVcpus(machineType: string): number | null {
  const match = /^[a-z][a-z0-9]*-(?:standard|highmem|highcpu)-(\d+)$/.exec(machineType.trim());
  return match ? Number(match[1]) : null;
}

/** Validate a policy built from admin settings; falls back to the defaults field by field. */
export function normalizeGcpBootDiskPolicy(
  input: Partial<GcpBootDiskPolicy> | null | undefined
): GcpBootDiskPolicy {
  const gbPerVcpu = positiveFinite(input?.gbPerVcpu) ?? DEFAULT_GCP_BOOT_DISK_GB_PER_VCPU;
  const minGb = positiveFinite(input?.minGb) ?? DEFAULT_GCP_BOOT_DISK_MIN_GB;
  return {
    gbPerVcpu,
    minGb: Math.min(Math.max(Math.ceil(minGb), GCP_BOOT_DISK_FLOOR_GB), GCP_BOOT_DISK_MAX_GB),
  };
}

function positiveFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
