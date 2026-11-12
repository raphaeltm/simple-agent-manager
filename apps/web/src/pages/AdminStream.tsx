import { BoxLogsNotice } from '../components/admin/BoxLogsNotice';
import { LogStream } from '../components/admin/LogStream';
import { usePlatformCapabilities } from '../hooks/usePlatformCapabilities';

export function AdminStream() {
  const { liveLogStream } = usePlatformCapabilities();
  // Not mounting LogStream also means no WebSocket is opened to a stream nothing feeds.
  return liveLogStream ? <LogStream /> : <BoxLogsNotice surface="stream" />;
}
