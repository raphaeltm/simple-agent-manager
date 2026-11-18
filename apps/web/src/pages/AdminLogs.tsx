import { BoxLogsNotice } from '../components/admin/BoxLogsNotice';
import { LogViewer } from '../components/admin/LogViewer';
import { usePlatformCapabilities } from '../hooks/usePlatformCapabilities';

export function AdminLogs() {
  const { logSearch } = usePlatformCapabilities();
  return logSearch ? <LogViewer /> : <BoxLogsNotice surface="search" />;
}
