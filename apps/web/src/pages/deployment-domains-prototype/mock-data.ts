export type DomainVerificationStatus = 'verified' | 'pending' | 'failed';
export type DomainServingStatus =
  | 'serving'
  | 'pending_apply'
  | 'pending_dns'
  | 'failed'
  | 'route_missing';

export interface PublicRouteMock {
  id: string;
  service: string;
  port: number;
  hostname: string;
  hostPort: number;
  releaseVersion: number;
  status: 'published' | 'changed' | 'removed';
}

export interface CustomDomainMock {
  id: string;
  hostname: string;
  routeId: string;
  service: string;
  port: number;
  verificationStatus: DomainVerificationStatus;
  servingStatus: DomainServingStatus;
  cnameTarget: string | null;
  createdAt: string;
  verifiedAt: string | null;
  checkedAt: string | null;
  error: string | null;
}

export const environmentMock = {
  projectName: 'acme/customer-portal',
  name: 'Production',
  status: 'active',
  releaseVersion: 42,
  releaseStatus: 'applied',
  observedAt: '2026-06-24T13:42:00.000Z',
  nodeName: 'deployment-nbg1-cx33-04',
  nodeIp: '138.199.146.229',
};

export const publicRoutes: PublicRouteMock[] = [
  {
    id: 'web-8080',
    service: 'web',
    port: 8080,
    hostname: 'r1-web-8080-01kvwbxqz3.apps.sammy.party',
    hostPort: 36120,
    releaseVersion: 42,
    status: 'published',
  },
  {
    id: 'api-3000',
    service: 'api',
    port: 3000,
    hostname: 'r2-api-3000-01kvwbxqz3.apps.sammy.party',
    hostPort: 36121,
    releaseVersion: 42,
    status: 'published',
  },
  {
    id: 'admin-9090',
    service: 'admin-console-with-a-long-service-name',
    port: 9090,
    hostname: 'r3-admin-console-with-a-long-service-name-9090-01kvwbxqz3.apps.sammy.party',
    hostPort: 36122,
    releaseVersion: 41,
    status: 'changed',
  },
  {
    id: 'docs-5173',
    service: 'docs',
    port: 5173,
    hostname: 'r4-docs-5173-01kvwbxqz3.apps.sammy.party',
    hostPort: 36123,
    releaseVersion: 42,
    status: 'published',
  },
  {
    id: 'removed-worker-7000',
    service: 'legacy-worker',
    port: 7000,
    hostname: 'r5-legacy-worker-7000-01kvwbxqz3.apps.sammy.party',
    hostPort: 36124,
    releaseVersion: 37,
    status: 'removed',
  },
];

export const customDomains: CustomDomainMock[] = [
  {
    id: 'dom_active',
    hostname: 'app.acme.example',
    routeId: 'web-8080',
    service: 'web',
    port: 8080,
    verificationStatus: 'verified',
    servingStatus: 'serving',
    cnameTarget: 'r1-web-8080-01kvwbxqz3.apps.sammy.party',
    createdAt: '2026-06-24T09:10:00.000Z',
    verifiedAt: '2026-06-24T09:14:08.000Z',
    checkedAt: '2026-06-24T13:37:12.000Z',
    error: null,
  },
  {
    id: 'dom_pending_dns',
    hostname: 'preview.customer.io',
    routeId: 'web-8080',
    service: 'web',
    port: 8080,
    verificationStatus: 'pending',
    servingStatus: 'pending_dns',
    cnameTarget: 'r1-web-8080-01kvwbxqz3.apps.sammy.party',
    createdAt: '2026-06-24T12:02:42.000Z',
    verifiedAt: null,
    checkedAt: '2026-06-24T13:20:11.000Z',
    error: null,
  },
  {
    id: 'dom_failed',
    hostname: 'dashboard.partner-example.net',
    routeId: 'api-3000',
    service: 'api',
    port: 3000,
    verificationStatus: 'failed',
    servingStatus: 'failed',
    cnameTarget: 'r2-api-3000-01kvwbxqz3.apps.sammy.party',
    createdAt: '2026-06-23T22:11:14.000Z',
    verifiedAt: null,
    checkedAt: '2026-06-24T13:18:22.000Z',
    error:
      'dashboard.partner-example.net resolves to old.hosting-vendor.example instead of r2-api-3000-01kvwbxqz3.apps.sammy.party.',
  },
  {
    id: 'dom_pending_apply',
    hostname: 'api.acme.example',
    routeId: 'api-3000',
    service: 'api',
    port: 3000,
    verificationStatus: 'verified',
    servingStatus: 'pending_apply',
    cnameTarget: 'r2-api-3000-01kvwbxqz3.apps.sammy.party',
    createdAt: '2026-06-24T13:03:44.000Z',
    verifiedAt: '2026-06-24T13:06:15.000Z',
    checkedAt: '2026-06-24T13:06:15.000Z',
    error: null,
  },
  {
    id: 'dom_route_missing',
    hostname: 'old-worker.ops.example',
    routeId: 'removed-worker-7000',
    service: 'legacy-worker',
    port: 7000,
    verificationStatus: 'verified',
    servingStatus: 'route_missing',
    cnameTarget: null,
    createdAt: '2026-06-20T15:24:00.000Z',
    verifiedAt: '2026-06-20T15:29:51.000Z',
    checkedAt: '2026-06-24T13:10:03.000Z',
    error: 'The legacy-worker:7000 public route is not present in release v42.',
  },
  {
    id: 'dom_long',
    hostname:
      'staging-for-a-very-large-enterprise-customer-with-an-overly-specific-subdomain.customer-portal.example-services.dev',
    routeId: 'web-8080',
    service: 'web',
    port: 8080,
    verificationStatus: 'pending',
    servingStatus: 'pending_dns',
    cnameTarget: 'r1-web-8080-01kvwbxqz3.apps.sammy.party',
    createdAt: '2026-06-24T12:44:51.000Z',
    verifiedAt: null,
    checkedAt: null,
    error: null,
  },
  {
    id: 'dom_docs_active',
    hostname: 'docs.acme.example',
    routeId: 'docs-5173',
    service: 'docs',
    port: 5173,
    verificationStatus: 'verified',
    servingStatus: 'serving',
    cnameTarget: 'r4-docs-5173-01kvwbxqz3.apps.sammy.party',
    createdAt: '2026-06-21T10:12:01.000Z',
    verifiedAt: '2026-06-21T10:17:09.000Z',
    checkedAt: '2026-06-24T13:01:31.000Z',
    error: null,
  },
  {
    id: 'dom_docs_pending',
    hostname: 'helpdesk.acme.example',
    routeId: 'docs-5173',
    service: 'docs',
    port: 5173,
    verificationStatus: 'pending',
    servingStatus: 'pending_dns',
    cnameTarget: 'r4-docs-5173-01kvwbxqz3.apps.sammy.party',
    createdAt: '2026-06-24T11:18:21.000Z',
    verifiedAt: null,
    checkedAt: '2026-06-24T11:21:50.000Z',
    error: null,
  },
  {
    id: 'dom_api_mobile',
    hostname: 'm-api.customer-app.example',
    routeId: 'api-3000',
    service: 'api',
    port: 3000,
    verificationStatus: 'verified',
    servingStatus: 'serving',
    cnameTarget: 'r2-api-3000-01kvwbxqz3.apps.sammy.party',
    createdAt: '2026-06-22T17:05:11.000Z',
    verifiedAt: '2026-06-22T17:07:16.000Z',
    checkedAt: '2026-06-24T12:58:40.000Z',
    error: null,
  },
  {
    id: 'dom_internal_failed',
    hostname: 'internal-ops.partner-example.net',
    routeId: 'admin-9090',
    service: 'admin-console-with-a-long-service-name',
    port: 9090,
    verificationStatus: 'failed',
    servingStatus: 'failed',
    cnameTarget: 'r3-admin-console-with-a-long-service-name-9090-01kvwbxqz3.apps.sammy.party',
    createdAt: '2026-06-24T10:44:09.000Z',
    verifiedAt: null,
    checkedAt: '2026-06-24T12:40:09.000Z',
    error:
      'CNAME is proxied through Cloudflare. Set the record to DNS only before verifying in SAM.',
  },
];
