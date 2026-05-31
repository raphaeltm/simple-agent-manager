import * as v from 'valibot';

export const ResourceRequirementsSchema = v.object({
  minVcpu: v.optional(v.number()),
  minMemoryMb: v.optional(v.number()),
  minDiskMb: v.optional(v.number()),
  exclusiveNode: v.optional(v.boolean()),
  maxCoTenants: v.optional(v.number()),
  preset: v.optional(v.string()),
});

