// =============================================================================
// User
// =============================================================================
export type UserRole = 'superadmin' | 'admin' | 'user';
export type UserStatus = 'active' | 'pending' | 'suspended';

export interface User {
  id: string;
  githubId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// Admin User Management
// =============================================================================
export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
}

export interface AdminUsersResponse {
  users: AdminUser[];
}

export interface AdminUserActionRequest {
  action: 'approve' | 'suspend';
}

export interface AdminUserRoleRequest {
  role: Exclude<UserRole, 'superadmin'>;
}
