import { useEffect, useState, useCallback } from 'react';
import { Navigate } from 'react-router-dom';
import { Button, Card, Spinner, StatusBadge, PageTitle, Secondary, Body } from '@simple-agent-manager/ui';
import { useAuth } from '../components/AuthProvider';
import { listAdminUsers, approveOrSuspendUser, changeUserRole } from '../lib/api';
import type { AdminUser, UserStatus } from '@simple-agent-manager/shared';

type StatusFilter = 'all' | UserStatus;

export function Admin() {
  const { isSuperadmin, user: currentUser } = useAuth();
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

  if (!isSuperadmin) {
    return <Navigate to="/dashboard" replace />;
  }

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
      <div style={{ marginBottom: 'var(--sam-space-6)' }}>
        <PageTitle>Admin</PageTitle>
        <Secondary style={{ marginTop: 'var(--sam-space-1)' }}>
          Manage user access and roles
        </Secondary>
      </div>

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

      {loading ? (
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
                          {u.avatarUrl ? (
                            <img
                              src={u.avatarUrl}
                              alt=""
                              style={{
                                width: 32,
                                height: 32,
                                borderRadius: 'var(--sam-radius-full)',
                              }}
                            />
                          ) : (
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
                              }}
                            >
                              {(u.name || u.email)[0]?.toUpperCase()}
                            </div>
                          )}
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
                        {isSuperadminUser ? (
                          <StatusBadge status="running" label="Superadmin" />
                        ) : u.role === 'admin' ? (
                          <StatusBadge status="creating" label="Admin" />
                        ) : (
                          <span style={{ color: 'var(--sam-color-fg-muted)' }}>User</span>
                        )}
                      </td>
                      <td style={tdStyle}>
                        {u.status === 'active' ? (
                          <StatusBadge status="running" label="Active" />
                        ) : u.status === 'pending' ? (
                          <StatusBadge status="pending" label="Pending" />
                        ) : (
                          <StatusBadge status="error" label="Suspended" />
                        )}
                      </td>
                      <td style={tdStyle}>
                        <span style={{ color: 'var(--sam-color-fg-muted)' }}>
                          {new Date(u.createdAt).toLocaleDateString()}
                        </span>
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        {!isSuperadminUser && !isCurrentUser && (
                          <div style={{ display: 'flex', gap: 'var(--sam-space-2)', justifyContent: 'flex-end' }}>
                            {u.status === 'pending' && (
                              <Button
                                size="sm"
                                variant="primary"
                                onClick={() => handleAction(u.id, 'approve')}
                                disabled={isLoading}
                              >
                                {isLoading ? 'Approving...' : 'Approve'}
                              </Button>
                            )}
                            {u.status === 'active' && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleAction(u.id, 'suspend')}
                                disabled={isLoading}
                              >
                                Suspend
                              </Button>
                            )}
                            {u.status === 'suspended' && (
                              <Button
                                size="sm"
                                variant="primary"
                                onClick={() => handleAction(u.id, 'approve')}
                                disabled={isLoading}
                              >
                                {isLoading ? 'Restoring...' : 'Restore'}
                              </Button>
                            )}
                            {u.status === 'active' && u.role === 'user' && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleRoleChange(u.id, 'admin')}
                                disabled={isLoading}
                              >
                                Make Admin
                              </Button>
                            )}
                            {u.status === 'active' && u.role === 'admin' && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleRoleChange(u.id, 'user')}
                                disabled={isLoading}
                              >
                                Remove Admin
                              </Button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
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
