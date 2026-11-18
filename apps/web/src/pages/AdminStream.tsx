import { BoxLogsNotice } from '../components/admin/BoxLogsNotice';
import { LogStream } from '../components/admin/LogStream';
import { usePlatformCapabilities } from '../hooks/usePlatformCapabilities';

export function AdminStream() {
  const { liveLogStream } = usePlatformCapabilities();
  // Once the capabilities answer says no tail worker feeds the stream, LogStream is unmounted, so
  // no WebSocket stays open to it. Before the answer arrives every service is assumed present
  // (usePlatformCapabilities), so a cold load on a self-hosted box may try one connection, which
  // the API refuses with FEATURE_UNAVAILABLE.
  return liveLogStream ? <LogStream /> : <BoxLogsNotice surface="stream" />;
}
