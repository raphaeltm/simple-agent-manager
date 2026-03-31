import * as v from 'valibot';

export const AdminUserActionSchema = v.object({
  action: v.picklist(['approve', 'suspend']),
});

export const AdminUserRoleSchema = v.object({
  role: v.picklist(['admin', 'user']),
});

export const AnalyticsForwardSchema = v.object({
  startDate: v.optional(v.string()),
  endDate: v.optional(v.string()),
});
