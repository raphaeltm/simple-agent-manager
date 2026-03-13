import type { VMSize } from '@simple-agent-manager/shared';
import type { Provider, SizeConfig, VMConfig, VMInstance, VMStatus } from './types';
import { ProviderError } from './types';
import { providerFetch } from './provider-fetch';

const HETZNER_API_URL = 'https://api.hetzner.cloud/v1';

const HETZNER_LOCATIONS = ['fsn1', 'nbg1', 'hel1', 'ash', 'hil'] as const;

const SIZE_CONFIGS: Record<VMSize, SizeConfig> = {
  small: {
    type: 'cx23',
    price: '€3.99/mo',
    vcpu: 2,
    ramGb: 4,
    storageGb: 40,
  },
  medium: {
    type: 'cx33',
    price: '€7.49/mo',
    vcpu: 4,
    ramGb: 8,
    storageGb: 80,
  },
  large: {
    type: 'cx43',
    price: '€14.49/mo',
    vcpu: 8,
    ramGb: 16,
    storageGb: 160,
  },
};

interface HetznerServerResponse {
  server: {
    id: number;
    name: string;
    status: string;
    public_net: {
      ipv4: {
        ip: string;
      };
    };
    server_type: {
      name: string;
    };
    created: string;
    labels: Record<string, string>;
  };
}

interface HetznerServersResponse {
  servers: HetznerServerResponse['server'][];
}

export class HetznerProvider implements Provider {
  readonly name = 'hetzner';
  readonly locations: readonly string[] = HETZNER_LOCATIONS;
  readonly sizes: Readonly<Record<VMSize, SizeConfig>> = SIZE_CONFIGS;

  private readonly apiToken: string;
  private readonly datacenter: string;

  constructor(apiToken: string, datacenter?: string) {
    this.apiToken = apiToken;
    this.datacenter = datacenter || 'fsn1';
  }

  async createVM(config: VMConfig): Promise<VMInstance> {
    const sizeConfig = this.sizes[config.size];

    const response = await providerFetch(this.name, `${HETZNER_API_URL}/servers`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: config.name,
        server_type: sizeConfig.type,
        image: config.image || 'ubuntu-24.04',
        location: config.location || this.datacenter,
        user_data: config.userData,
        labels: config.labels || {},
        start_after_create: true,
      }),
    });

    const data = (await response.json()) as HetznerServerResponse;
    return this.mapServerToVMInstance(data.server);
  }

  async deleteVM(id: string): Promise<void> {
    try {
      await providerFetch(this.name, `${HETZNER_API_URL}/servers/${id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
        },
      });
    } catch (err) {
      if (err instanceof ProviderError && err.statusCode === 404) {
        return; // Idempotent: already deleted
      }
      throw err;
    }
  }

  async getVM(id: string): Promise<VMInstance | null> {
    try {
      const response = await providerFetch(this.name, `${HETZNER_API_URL}/servers/${id}`, {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
        },
      });

      const data = (await response.json()) as HetznerServerResponse;
      return this.mapServerToVMInstance(data.server);
    } catch (err) {
      if (err instanceof ProviderError && err.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  async listVMs(labels?: Record<string, string>): Promise<VMInstance[]> {
    const labelParts: string[] = [];
    if (labels) {
      for (const [key, value] of Object.entries(labels)) {
        labelParts.push(`${key}=${value}`);
      }
    }

    const url = labelParts.length > 0
      ? `${HETZNER_API_URL}/servers?label_selector=${encodeURIComponent(labelParts.join(','))}`
      : `${HETZNER_API_URL}/servers`;

    const response = await providerFetch(this.name, url, {
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
      },
    });

    const data = (await response.json()) as HetznerServersResponse;
    return data.servers.map((server) => this.mapServerToVMInstance(server));
  }

  async powerOff(id: string): Promise<void> {
    await providerFetch(this.name, `${HETZNER_API_URL}/servers/${id}/actions/poweroff`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
      },
    });
  }

  async powerOn(id: string): Promise<void> {
    await providerFetch(this.name, `${HETZNER_API_URL}/servers/${id}/actions/poweron`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
      },
    });
  }

  async validateToken(): Promise<boolean> {
    await providerFetch(this.name, `${HETZNER_API_URL}/datacenters`, {
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
      },
    });
    return true;
  }

  private mapServerToVMInstance(server: HetznerServerResponse['server']): VMInstance {
    return {
      id: String(server.id),
      name: server.name,
      ip: server.public_net.ipv4.ip,
      status: this.mapStatus(server.status),
      serverType: server.server_type.name,
      createdAt: server.created,
      labels: server.labels,
    };
  }

  private mapStatus(hetznerStatus: string): VMStatus {
    switch (hetznerStatus) {
      case 'initializing':
      case 'running':
      case 'off':
      case 'starting':
      case 'stopping':
        return hetznerStatus;
      default:
        return 'initializing';
    }
  }
}
