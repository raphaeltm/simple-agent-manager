import { Navigate, useLocation } from 'react-router';

/**
 * Old settings URLs keep working: the former Cloud Provider, Connections and
 * agent tabs redirect into Settings → Agents / Infrastructure with their query
 * string intact.
 */
export function SettingsRedirect({ to }: Readonly<{ to: string }>) {
  const { search } = useLocation();
  return <Navigate to={`${to}${search}`} replace />;
}

/**
 * `/settings/cloud-provider` is also the Google Cloud OAuth return address
 * (`apps/api/src/routes/google-auth.ts`), so a `gcp_setup` / `gcp_error` result
 * reopens the Google Cloud connect step where `GcpCredentialForm` resumes it.
 */
export function LegacyCloudProviderRedirect() {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  if (params.has('gcp_setup') || params.has('gcp_error')) params.set('connect', 'gcp');
  const query = params.toString();
  return <Navigate to={`/settings/infrastructure${query ? `?${query}` : ''}`} replace />;
}
