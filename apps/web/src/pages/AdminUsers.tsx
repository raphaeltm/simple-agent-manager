import type { AdminUser, SignupApprovalConfig, UserStatus } from '@simple-agent-manager/shared';
import { Body,Button, Card, Spinner, StatusBadge } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useRef,useState } from 'react';

import { useAuth } from '../components/AuthProvider';
import { useIsMobile } from '../hooks/useIsMobile';
import { approveOrSuspendUser, changeUserRole,fetchSignupApprovalConfig, listAdminUsers, updateSignupApprovalConfig } from '../lib/api';

type StatusFilter = 'all' | UserStatus;

export function AdminUsers() {
  const { user: currentUser } = useAuth();
  const isMobile = useIsMobile();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [signupApprovalConfig, setSignupApprovalConfig] = useState<SignupApprovalConfig | null>(null);
  const [signupConfigLoading, setSignupConfigLoading] = useState(true);
  const [signupConfigSaving, setSignupConfigSaving] = useState(false);
  const hasLoadedRef = useRef(false);

  const fetchUsers = useCallback(async () => {
    if (hasLoadedRef.current) {
      setIsRefreshing(true);
    }
    try {
      setError(null);
      const statusParam = filter === 'all' ? undefined : filter;
      const res = await listAdminUsers(statusParam);
      setUsers(res.users);
      hasLoadedRef.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users');
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, [filter]);

  useEffect(() => {
    if (!hasLoadedRef.current) {
      setLoading(true);
    }
    fetchUsers();
  }, [fetchUsers]);

  useEffect(() => {
    let active = true;
    async function loadConfig() {
      try {
        setSignupConfigLoading(true);
        const res = await fetchSignupApprovalConfig();
        if (active) {
          setSignupApprovalConfig(res.config);
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : 'Failed to load signup approval setting');
        }
      } finally {
        if (active) {
          setSignupConfigLoading(false);
        }
      }
    }
    loadConfig();
    return () => {
      active = false;
    };
  }, []);

  const handleAction = async (userId: string, action: 'approve' | 'suspend') => {
    setActionLoading(userId);
    try {
      await approveOrSuspendUser(userId, action);
      await fetchUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setActionLoading(null);
    }
  };

  const handleRoleChange = async (userId: string, role: 'admin' | 'user') => {
    setActionLoading(userId);
    try {
      await changeUserRole(userId, role);
      await fetchUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Role change failed');
    } finally {
      setActionLoading(null);
    }
  };

  const handleSignupApprovalToggle = async () => {
    if (!signupApprovalConfig || signupConfigSaving) {
      return;
    }
    const nextRequireApproval = !signupApprovalConfig.requireApproval;
    setSignupConfigSaving(true);
    try {
      setError(null);
      const res = await updateSignupApprovalConfig({ requireApproval: nextRequireApproval });
      setSignupApprovalConfig(res.config);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update signup approval setting');
    } finally {
      setSignupConfigSaving(false);
    }
  };

  const filters: { label: string; value: StatusFilter }[] = [
    { label: 'All', value: 'all' },
    { label: 'Pending', value: 'pending' },
    { label: 'Active', value: 'active' },
    { label: 'Suspended', value: 'suspended' },
  ];

  const pendingCount = users.filter((u) => u.status === 'pending').length;

  return (
    <div>
      {error && (
        <div className="p-3 mb-4 rounded-sm bg-danger-tint text-danger-fg text-sm">
          {error}
        </div>
      )}

      <SignupApprovalPanel
        config={signupApprovalConfig}
        loading={signupConfigLoading}
        saving={signupConfigSaving}
        onToggle={handleSignupApprovalToggle}
      />

      {/* Filter tabs */}
      <div className="flex gap-2 mb-4 items-center">
        {filters.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`px-3 py-2 rounded-sm border-none cursor-pointer text-sm font-medium transition-all duration-150 ${
              filter === f.value
                ? 'text-accent bg-surface-hover'
                : 'text-fg-muted bg-transparent'
            }`}
          >
            {f.label}
            {f.value === 'pending' && pendingCount > 0 && filter !== 'pending' && (
              <span className="ml-1 px-1.5 rounded-full text-[0.7rem] font-bold bg-warning-tint text-warning-fg">
                {pendingCount}
              </span>
            )}
          </button>
        ))}
        {isRefreshing && <span role="status" aria-label="Refreshing users"><Spinner size="sm" /></span>}
      </div>

      {loading && users.length === 0 ? (
        <div className="flex justify-center p-8">
          <Spinner size="lg" />
        </div>
      ) : users.length === 0 ? (
        <Card>
          <div className="p-6 text-center">
            <Body className="text-fg-muted">
              No users found{filter !== 'all' ? ` with status "${filter}"` : ''}.
            </Body>
          </div>
        </Card>
      ) : (
        <Card>
          {isMobile ? (
            /* Mobile: stacked card layout */
            <div>
              {users.map((u) => {
                const isCurrentUser = u.id === currentUser?.id;
                const isSuperadminUser = u.role === 'superadmin';
                const isLoading = actionLoading === u.id;

                return (
                  <div
                    key={u.id}
                    className="px-4 py-3 border-b border-border-default"
                  >
                    {/* User info row */}
                    <div className="flex items-center gap-3">
                      <UserAvatar user={u} />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-fg-primary text-sm">
                          {u.name || 'Unnamed'}
                          {isCurrentUser && (
                            <span className="text-fg-muted font-normal"> (you)</span>
                          )}
                        </div>
                        <div className="text-fg-muted text-xs overflow-hidden text-ellipsis whitespace-nowrap">
                          {u.email}
                        </div>
                      </div>
                    </div>
                    {/* Badges + date row */}
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      <UserRoleBadge role={u.role} />
                      <UserStatusBadge status={u.status} />
                      <span className="text-fg-muted text-xs ml-auto">
                        {new Date(u.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                    {/* Actions row */}
                    {!isSuperadminUser && !isCurrentUser && (
                      <div className="flex gap-2 mt-2 flex-wrap">
                        <UserActions user={u} isLoading={isLoading} onAction={handleAction} onRoleChange={handleRoleChange} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            /* Desktop: table layout */
            <div className="overflow-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border-default text-left">
                    <th className="px-4 py-3 font-semibold text-fg-muted text-xs uppercase tracking-wide">User</th>
                    <th className="px-4 py-3 font-semibold text-fg-muted text-xs uppercase tracking-wide">Role</th>
                    <th className="px-4 py-3 font-semibold text-fg-muted text-xs uppercase tracking-wide">Status</th>
                    <th className="px-4 py-3 font-semibold text-fg-muted text-xs uppercase tracking-wide">Joined</th>
                    <th className="px-4 py-3 font-semibold text-fg-muted text-xs uppercase tracking-wide text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => {
                    const isCurrentUser = u.id === currentUser?.id;
                    const isSuperadminUser = u.role === 'superadmin';
                    const isLoading = actionLoading === u.id;

                    return (
                      <tr
                        key={u.id}
                        className="border-b border-border-default"
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <UserAvatar user={u} />
                            <div>
                              <div className="font-medium text-fg-primary">
                                {u.name || 'Unnamed'}
                                {isCurrentUser && (
                                  <span className="text-fg-muted font-normal"> (you)</span>
                                )}
                              </div>
                              <div className="text-fg-muted text-xs">
                                {u.email}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <UserRoleBadge role={u.role} />
                        </td>
                        <td className="px-4 py-3">
                          <UserStatusBadge status={u.status} />
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-fg-muted">
                            {new Date(u.createdAt).toLocaleDateString()}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          {!isSuperadminUser && !isCurrentUser && (
                            <div className="flex gap-2 justify-end">
                              <UserActions user={u} isLoading={isLoading} onAction={handleAction} onRoleChange={handleRoleChange} />
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function SignupApprovalPanel({
  config,
  loading,
  saving,
  onToggle,
}: {
  config: SignupApprovalConfig | null;
  loading: boolean;
  saving: boolean;
  onToggle: () => void;
}) {
  const requireApproval = config?.requireApproval ?? false;
  const sourceLabel = config?.source === 'runtime' ? 'Runtime override' : 'Environment default';
  const updatedAt = config?.updatedAt ? new Date(config.updatedAt).toLocaleString() : null;

  return (
    <Card className="mb-4">
      <div className="p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-sm font-semibold text-fg-primary m-0">Signup approval</h2>
            {config && (
              <span className="text-xs text-fg-muted">
                {sourceLabel}{updatedAt ? `, updated ${updatedAt}` : ''}
              </span>
            )}
          </div>
          <Body className="text-fg-muted text-sm mt-1">
            {requireApproval
              ? 'New users wait for admin approval before using SAM.'
              : 'New and pending users can use SAM while approval is off. Stored pending users are not changed to active.'}
          </Body>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {loading && <Spinner size="sm" />}
          <span className="text-sm font-medium text-fg-primary">
            {requireApproval ? 'Approval on' : 'Approval off'}
          </span>
          <button
            onClick={onToggle}
            disabled={loading || saving || !config}
            className={`relative w-11 h-6 rounded-full transition-colors border-none ${
              requireApproval ? 'bg-accent' : 'bg-border-default'
            } ${loading || saving || !config ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
            role="switch"
            aria-checked={requireApproval}
            aria-busy={saving}
            aria-label={requireApproval ? 'Turn signup approval off' : 'Turn signup approval on'}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                requireApproval ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </div>
    </Card>
  );
}

function UserAvatar({ user }: { user: AdminUser }) {
  if (user.avatarUrl) {
    return (
      <img
        src={user.avatarUrl}
        alt=""
        className="w-8 h-8 rounded-full shrink-0"
      />
    );
  }
  return (
    <div className="w-8 h-8 rounded-full bg-surface-hover flex items-center justify-center text-xs font-semibold text-fg-muted shrink-0">
      {(user.name || user.email)[0]?.toUpperCase()}
    </div>
  );
}

function UserRoleBadge({ role }: { role: string }) {
  if (role === 'superadmin') return <StatusBadge status="running" label="Superadmin" />;
  if (role === 'admin') return <StatusBadge status="creating" label="Admin" />;
  return <span className="text-fg-muted text-sm">User</span>;
}

function UserStatusBadge({ status }: { status: string }) {
  if (status === 'active') return <StatusBadge status="running" label="Active" />;
  if (status === 'pending') return <StatusBadge status="pending" label="Pending" />;
  return <StatusBadge status="error" label="Suspended" />;
}

function UserActions({ user, isLoading, onAction, onRoleChange }: {
  user: AdminUser;
  isLoading: boolean;
  onAction: (id: string, action: 'approve' | 'suspend') => void;
  onRoleChange: (id: string, role: 'admin' | 'user') => void;
}) {
  return (
    <>
      {user.status === 'pending' && (
        <Button size="sm" variant="primary" onClick={() => onAction(user.id, 'approve')} disabled={isLoading}>
          {isLoading ? 'Approving...' : 'Approve'}
        </Button>
      )}
      {user.status === 'active' && (
        <Button size="sm" variant="ghost" onClick={() => onAction(user.id, 'suspend')} disabled={isLoading}>
          Suspend
        </Button>
      )}
      {user.status === 'suspended' && (
        <Button size="sm" variant="primary" onClick={() => onAction(user.id, 'approve')} disabled={isLoading}>
          {isLoading ? 'Restoring...' : 'Restore'}
        </Button>
      )}
      {user.status === 'active' && user.role === 'user' && (
        <Button size="sm" variant="ghost" onClick={() => onRoleChange(user.id, 'admin')} disabled={isLoading}>
          Make Admin
        </Button>
      )}
      {user.status === 'active' && user.role === 'admin' && (
        <Button size="sm" variant="ghost" onClick={() => onRoleChange(user.id, 'user')} disabled={isLoading}>
          Remove Admin
        </Button>
      )}
    </>
  );
}
