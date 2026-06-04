import * as pulumi from "@pulumi/pulumi";
import { vi } from "vitest";

export interface RegisteredResource {
  type: string;
  name: string;
  inputs: Record<string, unknown>;
  options: pulumi.ResourceOptions;
}

const resourceRecorder = vi.hoisted(() => {
  const resources: RegisteredResource[] = [];

  return {
    resources,
    record(
      type: string,
      name: string,
      inputs: Record<string, unknown>,
      options: pulumi.ResourceOptions = {}
    ): void {
      const existing = resources.find(
        (resource) => resource.type === type && resource.name === name
      );
      const registration = {
        type,
        name,
        inputs,
        options,
      };

      if (existing) {
        Object.assign(existing, registration);
        return;
      }

      resources.push(registration);
    },
  };
});

const registeredResources = resourceRecorder.resources;

vi.mock("@pulumi/cloudflare", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pulumi/cloudflare")>();

  return {
    ...actual,
    D1Database: class extends actual.D1Database {
      constructor(name: string, args: ResourceInputs, opts?: pulumi.CustomResourceOptions) {
        resourceRecorder.record(
          "cloudflare:index/d1Database:D1Database",
          name,
          args,
          opts
        );
        super(name, args, opts);
      }
    },
    WorkersKvNamespace: class extends actual.WorkersKvNamespace {
      constructor(name: string, args: ResourceInputs, opts?: pulumi.CustomResourceOptions) {
        resourceRecorder.record(
          "cloudflare:index/workersKvNamespace:WorkersKvNamespace",
          name,
          args,
          opts
        );
        super(name, args, opts);
      }
    },
    R2Bucket: class extends actual.R2Bucket {
      constructor(name: string, args: ResourceInputs, opts?: pulumi.CustomResourceOptions) {
        resourceRecorder.record("cloudflare:index/r2Bucket:R2Bucket", name, args, opts);
        super(name, args, opts);
      }
    },
    Record: class extends actual.Record {
      constructor(name: string, args: ResourceInputs, opts?: pulumi.CustomResourceOptions) {
        resourceRecorder.record("cloudflare:index/record:Record", name, args, opts);
        super(name, args, opts);
      }
    },
    WorkersRoute: class extends actual.WorkersRoute {
      constructor(name: string, args: ResourceInputs, opts?: pulumi.CustomResourceOptions) {
        resourceRecorder.record(
          "cloudflare:index/workersRoute:WorkersRoute",
          name,
          args,
          opts
        );
        super(name, args, opts);
      }
    },
    PagesProject: class extends actual.PagesProject {
      constructor(name: string, args: ResourceInputs, opts?: pulumi.CustomResourceOptions) {
        resourceRecorder.record(
          "cloudflare:index/pagesProject:PagesProject",
          name,
          args,
          opts
        );
        super(name, args, opts);
      }
    },
    OriginCaCertificate: class extends actual.OriginCaCertificate {
      constructor(name: string, args: ResourceInputs, opts?: pulumi.CustomResourceOptions) {
        resourceRecorder.record(
          "cloudflare:index/originCaCertificate:OriginCaCertificate",
          name,
          args,
          opts
        );
        super(name, args, opts);
      }
    },
  };
});

vi.mock("@pulumi/random", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pulumi/random")>();

  return {
    ...actual,
    RandomId: class extends actual.RandomId {
      constructor(name: string, args: ResourceInputs, opts?: pulumi.CustomResourceOptions) {
        resourceRecorder.record("random:index/randomId:RandomId", name, args, opts);
        super(name, args, opts);
      }
    },
  };
});

vi.mock("@pulumi/tls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pulumi/tls")>();

  return {
    ...actual,
    PrivateKey: class extends actual.PrivateKey {
      constructor(name: string, args: ResourceInputs, opts?: pulumi.CustomResourceOptions) {
        resourceRecorder.record("tls:index/privateKey:PrivateKey", name, args, opts);
        super(name, args, opts);
      }
    },
    CertRequest: class extends actual.CertRequest {
      constructor(name: string, args: ResourceInputs, opts?: pulumi.CustomResourceOptions) {
        resourceRecorder.record("tls:index/certRequest:CertRequest", name, args, opts);
        super(name, args, opts);
      }
    },
  };
});

type ResourceInputs = Record<string, unknown>;

// Mock Pulumi runtime before any resources are created
pulumi.runtime.setMocks({
  newResource: (args: pulumi.runtime.MockResourceArgs): { id: string; state: Record<string, unknown> } => {
    const existing = registeredResources.find(
      (resource) => resource.type === args.type && resource.name === args.name
    );
    if (!existing) {
      registeredResources.push({
        type: args.type,
        name: args.name,
        inputs: args.inputs,
        options: {},
      });
    }

    // Generate deterministic IDs based on resource name
    const id = `${args.name}-test-id`;

    // Return mock state based on resource type
    switch (args.type) {
      case "cloudflare:index/d1Database:D1Database":
        return {
          id,
          state: {
            ...args.inputs,
            id,
            name: args.inputs.name || `sam-test`,
          },
        };
      case "cloudflare:index/workersKvNamespace:WorkersKvNamespace":
        return {
          id,
          state: {
            ...args.inputs,
            id,
            title: args.inputs.title || `sam-test-sessions`,
          },
        };
      case "cloudflare:index/r2Bucket:R2Bucket":
        return {
          id,
          state: {
            ...args.inputs,
            id,
            name: args.inputs.name || `sam-test-assets`,
          },
        };
      case "cloudflare:index/pagesProject:PagesProject":
        return {
          id,
          state: {
            ...args.inputs,
            id,
            subdomain: `${args.name}-actual.pages.dev`,
          },
        };
      case "cloudflare:index/record:Record":
        return {
          id,
          state: {
            ...args.inputs,
            id,
            hostname: `${args.inputs.name}.example.com`,
          },
        };
      case "random:index/randomId:RandomId":
        return {
          id,
          state: {
            ...args.inputs,
            id,
            b64Std: `${args.name}-mock-secret`,
          },
        };
      case "tls:index/privateKey:PrivateKey":
        return {
          id,
          state: {
            ...args.inputs,
            id,
            privateKeyPem: `${args.name}-private-key-pem`,
            privateKeyPemPkcs8: `${args.name}-private-key-pkcs8`,
            publicKeyPem: `${args.name}-public-key-pem`,
          },
        };
      case "tls:index/certRequest:CertRequest":
        return {
          id,
          state: {
            ...args.inputs,
            id,
            certRequestPem: `${args.name}-csr-pem`,
          },
        };
      case "cloudflare:index/originCaCertificate:OriginCaCertificate":
        return {
          id,
          state: {
            ...args.inputs,
            id,
            certificate: `${args.name}-certificate-pem`,
          },
        };
      default:
        return {
          id,
          state: args.inputs,
        };
    }
  },
  call: (args: pulumi.runtime.MockCallArgs) => {
    return args.inputs;
  },
});

// Set mock config values for testing
// Config key format: "project:key" where project is from Pulumi.yaml name field
pulumi.runtime.setConfig("project:cloudflareAccountId", "test-account-id-00000000000000000000");
pulumi.runtime.setConfig("project:cloudflareZoneId", "test-zone-id-000000000000000000000");
pulumi.runtime.setConfig("project:baseDomain", "example.com");

export function getRegisteredResources(): RegisteredResource[] {
  return [...registeredResources];
}

export function findRegisteredResource(name: string, type?: string): RegisteredResource {
  const resource = registeredResources.find(
    (candidate) => candidate.name === name && (!type || candidate.type === type)
  );

  if (!resource) {
    throw new Error(`No registered resource found for ${type ? `${type} ` : ""}${name}`);
  }

  return resource;
}

// Export helper for getting output values in tests
export async function getOutputValue<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((resolve) => {
    output.apply((value) => {
      resolve(value);
      return value;
    });
  });
}

export function getSecretStatus<T>(output: pulumi.Output<T>): Promise<boolean> {
  return pulumi.isSecret(output);
}
