import type { User } from '@simple-agent-manager/shared';

import { request } from './client';

export async function getCurrentUser(): Promise<User> {
  return request<User>('/api/auth/me');
}
