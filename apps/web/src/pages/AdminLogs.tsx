import { BoxLogsNotice } from '../components/admin/BoxLogsNotice';
import { LogViewer } from '../components/admin/LogViewer';
import { usePlatformCapabilitiesStatus } from '../hooks/usePlatformCapabilities';

export function AdminLogs() {
  const { capabilities, known } = usePlatformCapabilitiesStatus();
  // Wait for the answer: LogViewer queries Workers Observability as soon as it mounts, and an
  // installation without log search would refuse that query.
  if (!known) return null;
  return capabilities.logSearch ? <LogViewer /> : <BoxLogsNotice surface="search" />;
}
