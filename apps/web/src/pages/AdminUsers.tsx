import { useEffect, useState, useCallback } from 'react';
import { Button, Card, Spinner, StatusBadge, Body } from '@simple-agent-manager/ui';
import { useAuth } from '../components/AuthProvider';
import { useIsMobile } from '../hooks/useIsMobile';
import { listAdminUsers, approveOrSuspendUser, changeUserRole } from '../lib/api';
import type { AdminUser, UserStatus } from '@simple-agent-manager/shared';

type StatusFilter = 'all' | UserStatus;

export function AdminUsers() {
  const { user: currentUser } = useAuth();
  const isMobile = useIsMobile();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchUsers = useCallback(async () => {
    try {
      setError(null);
      const statusParam = filter === 'all' ? undefined : filter;
      const res = await listAdminUsers(statusParam);
      setUsers(res.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    setLoading(true);
    fetchUsers();
  }, [fetchUsers]);

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
        <div
          style={{
            padding: 'var(--sam-space-3)',
            marginBottom: 'var(--sam-space-4)',
            borderRadius: 'var(--sam-radius-sm)',
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            color: '#f87171',
            fontSize: 'var(--sam-type-secondary-size)',
          }}
        >
          {error}
        </div>
      )}

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 'var(--sam-space-2)', marginBottom: 'var(--sam-space-4)' }}>
        {filters.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            style={{
              padding: 'var(--sam-space-2) var(--sam-space-3)',
              borderRadius: 'var(--sam-radius-sm)',
              border: 'none',
              cursor: 'pointer',
              fontSize: 'var(--sam-type-secondary-size)',
              fontWeight: 500,
              color: filter === f.value ? 'var(--sam-color-accent-primary)' : 'var(--sam-color-fg-muted)',
              background: filter === f.value ? 'var(--sam-color-bg-surface-hover)' : 'transparent',
              transition: 'all 150ms ease',
            }}
          >
            {f.label}
            {f.value === 'pending' && pendingCount > 0 && filter !== 'pending' && (
              <span
                style={{
                  marginLeft: 'var(--sam-space-1)',
                  padding: '0 6px',
                  borderRadius: '9999px',
                  fontSize: '0.7rem',
                  fontWeight: 700,
                  backgroundColor: 'rgba(245, 158, 11, 0.2)',
                  color: '#fbbf24',
                }}
              >
                {pendingCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {loading && users.length === 0 ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sam-space-8)' }}>
          <Spinner size="lg" />
        </div>
      ) : users.length === 0 ? (
        <Card>
          <div style={{ padding: 'var(--sam-space-6)', textAlign: 'center' }}>
            <Body style={{ color: 'var(--sam-color-fg-muted)' }}>
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
                    style={{
                      padding: 'var(--sam-space-3) var(--sam-space-4)',
                      borderBottom: '1px solid var(--sam-color-border-default)',
                    }}
                  >
                    {/* User info row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-3)' }}>
                      <UserAvatar user={u} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 500, color: 'var(--sam-color-fg-primary)', fontSize: 'var(--sam-type-secondary-size)' }}>
                          {u.name || 'Unnamed'}
                          {isCurrentUser && (
                            <span style={{ color: 'var(--sam-color-fg-muted)', fontWeight: 400 }}> (you)</span>
                          )}
                        </div>
                        <div style={{ color: 'var(--sam-color-fg-muted)', fontSize: '0.75rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {u.email}
                        </div>
                      </div>
                    </div>
                    {/* Badges + date row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)', marginTop: 'var(--sam-space-2)', flexWrap: 'wrap' }}>
                      <UserRoleBadge role={u.role} />
                      <UserStatusBadge status={u.status} />
                      <span style={{ color: 'var(--sam-color-fg-muted)', fontSize: 'var(--sam-type-caption-size)', marginLeft: 'auto' }}>
                        {new Date(u.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                    {/* Actions row */}
                    {!isSuperadminUser && !isCurrentUser && (
                      <div style={{ display: 'flex', gap: 'var(--sam-space-2)', marginTop: 'var(--sam-space-2)', flexWrap: 'wrap' }}>
                        <UserActions user={u} isLoading={isLoading} onAction={handleAction} onRoleChange={handleRoleChange} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            /* Desktop: table layout */
            <div style={{ overflow: 'auto' }}>
              <table
                style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: 'var(--sam-type-secondary-size)',
                }}
              >
                <thead>
                  <tr
                    style={{
                      borderBottom: '1px solid var(--sam-color-border-default)',
                      textAlign: 'left',
                    }}
                  >
                    <th style={thStyle}>User</th>
                    <th style={thStyle}>Role</th>
                    <th style={thStyle}>Status</th>
                    <th style={thStyle}>Joined</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>Actions</th>
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
                        style={{ borderBottom: '1px solid var(--sam-color-border-default)' }}
                      >
                        <td style={tdStyle}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-3)' }}>
                            <UserAvatar user={u} />
                            <div>
                              <div style={{ fontWeight: 500, color: 'var(--sam-color-fg-primary)' }}>
                                {u.name || 'Unnamed'}
                                {isCurrentUser && (
                                  <span style={{ color: 'var(--sam-color-fg-muted)', fontWeight: 400 }}> (you)</span>
                                )}
                              </div>
                              <div style={{ color: 'var(--sam-color-fg-muted)', fontSize: '0.75rem' }}>
                                {u.email}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td style={tdStyle}>
                          <UserRoleBadge role={u.role} />
                        </td>
                        <td style={tdStyle}>
                          <UserStatusBadge status={u.status} />
                        </td>
                        <td style={tdStyle}>
                          <span style={{ color: 'var(--sam-color-fg-muted)' }}>
                            {new Date(u.createdAt).toLocaleDateString()}
                          </span>
                        </td>
                        <td style={{ ...tdStyle, textAlign: 'right' }}>
                          {!isSuperadminUser && !isCurrentUser && (
                            <div style={{ display: 'flex', gap: 'var(--sam-space-2)', justifyContent: 'flex-end' }}>
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

const thStyle = {
  padding: 'var(--sam-space-3) var(--sam-space-4)',
  fontWeight: 600 as const,
  color: 'var(--sam-color-fg-muted)',
  fontSize: '0.75rem',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.05em',
};

const tdStyle = {
  padding: 'var(--sam-space-3) var(--sam-space-4)',
};

function UserAvatar({ user }: { user: AdminUser }) {
  if (user.avatarUrl) {
    return (
      <img
        src={user.avatarUrl}
        alt=""
        style={{ width: 32, height: 32, borderRadius: 'var(--sam-radius-full)', flexShrink: 0 }}
      />
    );
  }
  return (
    <div
      style={{
        width: 32,
        height: 32,
        borderRadius: 'var(--sam-radius-full)',
        backgroundColor: 'var(--sam-color-bg-surface-hover)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '0.75rem',
        fontWeight: 600,
        color: 'var(--sam-color-fg-muted)',
        flexShrink: 0,
      }}
    >
      {(user.name || user.email)[0]?.toUpperCase()}
    </div>
  );
}

function UserRoleBadge({ role }: { role: string }) {
  if (role === 'superadmin') return <StatusBadge status="running" label="Superadmin" />;
  if (role === 'admin') return <StatusBadge status="creating" label="Admin" />;
  return <span style={{ color: 'var(--sam-color-fg-muted)', fontSize: 'var(--sam-type-secondary-size)' }}>User</span>;
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
