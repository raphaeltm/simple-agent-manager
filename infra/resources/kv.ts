import * as cloudflare from '@pulumi/cloudflare';
import { accountId, prefix, stack } from './config';

export const kvNamespace = new cloudflare.WorkersKvNamespace(`${prefix}-kv`, {
  accountId: accountId,
  title: `${prefix}-${stack}-sessions`,
});

export const kvNamespaceId = kvNamespace.id;
export const kvNamespaceName = kvNamespace.title;

export const oauthKvNamespace = new cloudflare.WorkersKvNamespace(`${prefix}-oauth-kv`, {
  accountId,
  title: `${prefix}-${stack}-oauth`,
});
export const oauthKvNamespaceId = oauthKvNamespace.id;
