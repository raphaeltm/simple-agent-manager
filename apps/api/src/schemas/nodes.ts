import * as v from 'valibot';

const CredentialProviderSchema = v.picklist([
  'hetzner',
  'scaleway',
  'gcp',
  'vultr',
  'infomaniak',
  'digitalocean',
  'upcloud',
]);
const VMSizeSchema = v.picklist(['small', 'medium', 'large']);
const VMArchitectureSchema = v.picklist(['x86_64', 'arm64']);

export const CreateNodeSchema = v.object({
  name: v.string(),
  vmSize: v.optional(VMSizeSchema),
  vmLocation: v.optional(v.string()),
  provider: v.optional(CredentialProviderSchema),
  providerInstanceType: v.optional(v.string()),
  nativeOffering: v.optional(v.string()),
  bootDiskSizeGb: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  image: v.optional(v.string()),
  architecture: v.optional(VMArchitectureSchema),
});

export const UpdateNodeLabelSchema = v.object({
  label: v.optional(v.string()),
  status: v.optional(v.string()),
});

export const PatchNodeSchema = v.object({
  label: v.optional(v.string()),
});
