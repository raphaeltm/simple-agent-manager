import * as v from 'valibot';

const CredentialProviderSchema = v.picklist(['hetzner', 'scaleway', 'gcp']);
const VMSizeSchema = v.picklist(['small', 'medium', 'large']);

export const CreateNodeSchema = v.object({
  name: v.string(),
  vmSize: v.optional(VMSizeSchema),
  vmLocation: v.optional(v.string()),
  provider: v.optional(CredentialProviderSchema),
});

export const UpdateNodeLabelSchema = v.object({
  label: v.optional(v.string()),
  status: v.optional(v.string()),
});

export const PatchNodeSchema = v.object({
  label: v.optional(v.string()),
});
