/**
 * Hetzner Cloud API service.
 * Handles token validation and server management.
 */

const HETZNER_API_BASE = 'https://api.hetzner.cloud/v1';

/**
 * Validate a Hetzner API token by making a test request.
 * Returns true if valid, throws an error if invalid.
 */
export async function validateHetznerToken(token: string): Promise<boolean> {
  const response = await fetch(`${HETZNER_API_BASE}/datacenters`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Invalid Hetzner API token');
    }
    throw new Error(`Hetzner API error: ${response.status}`);
  }

  return true;
}

/**
 * Server type mapping from our size names to Hetzner server types.
 */
export const SERVER_TYPES: Record<string, string> = {
  small: 'cx23',
  medium: 'cx33',
  large: 'cx43',
};

/**
 * Location mapping.
 */
export const LOCATIONS = ['nbg1', 'fsn1', 'hel1'] as const;

export interface CreateServerOptions {
  name: string;
  serverType: string;
  location: string;
  image: string;
  userData: string;
  labels?: Record<string, string>;
}

export interface HetznerServer {
  id: number;
  name: string;
  publicNet: {
    ipv4: {
      ip: string;
    };
  };
  status: string;
}

/**
 * Create a new Hetzner server.
 */
export async function createServer(
  token: string,
  options: CreateServerOptions
): Promise<HetznerServer> {
  const response = await fetch(`${HETZNER_API_BASE}/servers`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: options.name,
      server_type: options.serverType,
      location: options.location,
      image: options.image,
      user_data: options.userData,
      labels: options.labels || {},
      start_after_create: true,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(error.error?.message || `Failed to create server: ${response.status}`);
  }

  const data = await response.json() as { server: { id: number; name: string; public_net: { ipv4: { ip: string } }; status: string } };
  return {
    id: data.server.id,
    name: data.server.name,
    publicNet: {
      ipv4: {
        ip: data.server.public_net.ipv4.ip,
      },
    },
    status: data.server.status,
  };
}

/**
 * Delete a Hetzner server.
 */
export async function deleteServer(
  token: string,
  serverId: string
): Promise<void> {
  const response = await fetch(`${HETZNER_API_BASE}/servers/${serverId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok && response.status !== 404) {
    const error = await response.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(error.error?.message || `Failed to delete server: ${response.status}`);
  }
}

/**
 * Get server status.
 */
export async function getServerStatus(
  token: string,
  serverId: string
): Promise<string | null> {
  const response = await fetch(`${HETZNER_API_BASE}/servers/${serverId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Failed to get server status: ${response.status}`);
  }

  const data = await response.json() as { server: { status: string } };
  return data.server.status;
}

/**
 * Power off a server.
 */
export async function powerOffServer(
  token: string,
  serverId: string
): Promise<void> {
  const response = await fetch(`${HETZNER_API_BASE}/servers/${serverId}/actions/poweroff`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(error.error?.message || `Failed to power off server: ${response.status}`);
  }
}

/**
 * Power on a server.
 */
export async function powerOnServer(
  token: string,
  serverId: string
): Promise<void> {
  const response = await fetch(`${HETZNER_API_BASE}/servers/${serverId}/actions/poweron`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(error.error?.message || `Failed to power on server: ${response.status}`);
  }
}
