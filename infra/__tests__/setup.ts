import * as pulumi from "@pulumi/pulumi";

// Mock Pulumi runtime before any resources are created
pulumi.runtime.setMocks({
  newResource: (args: pulumi.runtime.MockResourceArgs): { id: string; state: Record<string, unknown> } => {
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
      case "cloudflare:index/record:Record":
        return {
          id,
          state: {
            ...args.inputs,
            id,
            hostname: `${args.inputs.name}.example.com`,
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

// Export helper for getting output values in tests
export async function getOutputValue<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((resolve) => {
    output.apply((value) => {
      resolve(value);
      return value;
    });
  });
}
