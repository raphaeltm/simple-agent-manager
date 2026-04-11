import type { AdminUserQuotaSummary, QuotaSource } from '@simple-agent-manager/shared';
import { Body, Card, CardTitle, SectionHeading, Spinner } from '@simple-agent-manager/ui';
import { Gauge, Save, Trash2, UserCog } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import {
  fetchAdminUserQuotas,
  removeAdminUserQuota,
  updateAdminDefaultQuota,
  updateAdminUserQuota,
} from '../lib/api';

function formatSource(source: QuotaSource): string {
  switch (source) {
    case 'user_override':
      return 'Override';
    case 'default':
      return 'Default';
    case 'unlimited':
      return 'Unlimited';
  }
}

function QuotaBar({ used, limit }: { used: number; limit: number | null }) {
  if (limit === null || limit === 0) return null;
  const pct = Math.min(100, (used / limit) * 100);
  const color = pct >= 90 ? 'bg-error' : pct >= 75 ? 'bg-warning' : 'bg-success';
  return (
    <div className="w-full max-w-[120px] h-2 bg-surface rounded-full overflow-hidden">
      <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function UserQuotaRow({
  user,
  onEdit,
  onRemove,
}: {
  user: AdminUserQuotaSummary;
  onEdit: (userId: string) => void;
  onRemove: (userId: string) => void;
}) {
  return (
    <div className="px-4 py-3 border-b border-border-default flex items-center gap-3">
      {user.avatarUrl ? (
        <img src={user.avatarUrl} alt="" className="w-8 h-8 rounded-full flex-shrink-0" />
      ) : (
        <div className="w-8 h-8 rounded-full bg-surface flex items-center justify-center flex-shrink-0 border border-border-default">
          <span className="text-fg-muted text-xs font-medium">
            {(user.name ?? user.email ?? '?')[0]?.toUpperCase()}
          </span>
        </div>
      )}
      <div className="flex-1 min-w-0">
        <p className="sam-type-body font-medium truncate m-0">
          {user.name ?? user.email ?? user.userId}
        </p>
        {user.name && user.email && (
          <p className="sam-type-caption text-fg-muted truncate m-0">{user.email}</p>
        )}
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 sm:hidden">
          <span className="sam-type-caption tabular-nums">
            {user.currentUsage.toFixed(2)} / {user.monthlyVcpuHoursLimit?.toFixed(0) ?? '∞'} vCPU-hrs
          </span>
          <span className="sam-type-caption text-fg-muted">{formatSource(user.source)}</span>
        </div>
      </div>

      {/* Desktop stats */}
      <div className="hidden sm:flex items-center gap-4">
        <div className="flex items-center gap-2 min-w-[180px]">
          <QuotaBar used={user.currentUsage} limit={user.monthlyVcpuHoursLimit} />
          <span className="sam-type-caption tabular-nums whitespace-nowrap">
            {user.currentUsage.toFixed(2)} / {user.monthlyVcpuHoursLimit?.toFixed(0) ?? '∞'}
          </span>
        </div>
        <span className="sam-type-caption text-fg-muted w-16">{formatSource(user.source)}</span>
        {user.percentUsed !== null && (
          <span className="sam-type-caption tabular-nums w-12 text-right">{user.percentUsed}%</span>
        )}
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onEdit(user.userId)}
          className="p-1.5 rounded hover:bg-surface-hover transition-colors text-fg-muted hover:text-fg-primary"
          title="Edit quota"
        >
          <UserCog size={16} />
        </button>
        {user.source === 'user_override' && (
          <button
            type="button"
            onClick={() => onRemove(user.userId)}
            className="p-1.5 rounded hover:bg-surface-hover transition-colors text-fg-muted hover:text-error"
            title="Remove override"
          >
            <Trash2 size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

export function AdminComputeQuotas() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [defaultLimit, setDefaultLimit] = useState<string>('');
  const [defaultSaving, setDefaultSaving] = useState(false);
  const [users, setUsers] = useState<AdminUserQuotaSummary[]>([]);

  // Edit modal state
  const [editUserId, setEditUserId] = useState<string | null>(null);
  const [editLimit, setEditLimit] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchAdminUserQuotas();
      setDefaultLimit(
        data.defaultQuota.monthlyVcpuHoursLimit !== null
          ? String(data.defaultQuota.monthlyVcpuHoursLimit)
          : ''
      );
      setUsers(data.users);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load quota data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleSaveDefault = async () => {
    setDefaultSaving(true);
    try {
      const limit = defaultLimit.trim() === '' ? null : parseFloat(defaultLimit);
      if (limit !== null && (isNaN(limit) || limit < 0)) {
        setError('Default limit must be a non-negative number or empty for unlimited');
        return;
      }
      await updateAdminDefaultQuota(limit);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save default quota');
    } finally {
      setDefaultSaving(false);
    }
  };

  const handleEditUser = (userId: string) => {
    const user = users.find((u) => u.userId === userId);
    setEditUserId(userId);
    setEditLimit(
      user?.source === 'user_override' && user.monthlyVcpuHoursLimit !== null
        ? String(user.monthlyVcpuHoursLimit)
        : ''
    );
  };

  const handleSaveUserQuota = async () => {
    if (!editUserId) return;
    setEditSaving(true);
    try {
      const limit = editLimit.trim() === '' ? null : parseFloat(editLimit);
      if (limit !== null && (isNaN(limit) || limit < 0)) {
        setError('User limit must be a non-negative number or empty to use default');
        return;
      }
      await updateAdminUserQuota(editUserId, limit);
      setEditUserId(null);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save user quota');
    } finally {
      setEditSaving(false);
    }
  };

  const handleRemoveOverride = async (userId: string) => {
    try {
      await removeAdminUserQuota(userId);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove override');
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <Card>
          <Body className="text-error">{error}</Body>
        </Card>
      )}

      {/* Default Quota */}
      <section>
        <SectionHeading>Default Quota</SectionHeading>
        <Card>
          <div className="p-4">
            <Body className="text-fg-muted mb-3">
              Platform-wide default monthly vCPU-hours limit. Applies to all users without a
              per-user override. Leave empty for unlimited.
            </Body>
            <div className="flex items-end gap-3">
              <div className="flex-1 max-w-xs">
                <label htmlFor="default-limit" className="sam-type-caption text-fg-muted block mb-1">
                  Monthly vCPU-hours limit
                </label>
                <input
                  id="default-limit"
                  type="number"
                  min="0"
                  step="1"
                  placeholder="Unlimited"
                  value={defaultLimit}
                  onChange={(e) => setDefaultLimit(e.target.value)}
                  className="w-full rounded-md border border-border-default bg-surface px-3 py-2 sam-type-body text-fg-primary placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent-primary"
                />
              </div>
              <button
                type="button"
                onClick={handleSaveDefault}
                disabled={defaultSaving}
                className="inline-flex items-center gap-2 rounded-md bg-accent-primary px-4 py-2 sam-type-body font-medium text-accent-on-primary hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                <Save size={16} />
                {defaultSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </Card>
      </section>

      {/* User Quotas */}
      <section>
        <SectionHeading>
          <span className="flex items-center gap-2">
            <Gauge size={18} />
            User Quotas ({users.length})
          </span>
        </SectionHeading>
        <Card>
          {users.length === 0 ? (
            <div className="p-6 text-center">
              <Body className="text-fg-muted">No users with compute usage this period</Body>
            </div>
          ) : (
            <div>
              {users.map((user) => (
                <UserQuotaRow
                  key={user.userId}
                  user={user}
                  onEdit={handleEditUser}
                  onRemove={handleRemoveOverride}
                />
              ))}
            </div>
          )}
        </Card>
      </section>

      {/* Edit User Quota Modal */}
      {editUserId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-full max-w-md mx-4">
            <div className="p-6">
              <CardTitle>Edit User Quota</CardTitle>
              <Body className="text-fg-muted mt-2 mb-4">
                Set a custom vCPU-hours limit for this user. Leave empty to use the platform default.
                Set to 0 to block compute.
              </Body>
              <div className="mb-4">
                <label htmlFor="user-limit" className="sam-type-caption text-fg-muted block mb-1">
                  Monthly vCPU-hours limit
                </label>
                <input
                  id="user-limit"
                  type="number"
                  min="0"
                  step="1"
                  placeholder="Use default"
                  value={editLimit}
                  onChange={(e) => setEditLimit(e.target.value)}
                  className="w-full rounded-md border border-border-default bg-surface px-3 py-2 sam-type-body text-fg-primary placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent-primary"
                />
              </div>
              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setEditUserId(null)}
                  className="rounded-md border border-border-default px-4 py-2 sam-type-body text-fg-primary hover:bg-surface-hover transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveUserQuota}
                  disabled={editSaving}
                  className="inline-flex items-center gap-2 rounded-md bg-accent-primary px-4 py-2 sam-type-body font-medium text-accent-on-primary hover:opacity-90 disabled:opacity-50 transition-opacity"
                >
                  <Save size={16} />
                  {editSaving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
