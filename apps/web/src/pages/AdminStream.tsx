import { BoxLogsNotice } from '../components/admin/BoxLogsNotice';
import { LogStream } from '../components/admin/LogStream';
import { usePlatformCapabilitiesStatus } from '../hooks/usePlatformCapabilities';

export function AdminStream() {
  const { capabilities, known } = usePlatformCapabilitiesStatus();
  // Wait for the answer: LogStream opens a WebSocket as soon as it mounts, and nothing feeds the
  // stream on an installation without a tail worker.
  if (!known) return null;
  return capabilities.liveLogStream ? <LogStream /> : <BoxLogsNotice surface="stream" />;
}
