/** Preview apps must never receive control-plane or VM-agent session cookies. */
export function stripPreviewAuthCookies(headers: Headers): void {
  const cookie = headers.get('cookie');
  if (!cookie) return;
  const retained = cookie
    .split(';')
    .filter((part) => {
      const name = part
        .slice(0, part.indexOf('='))
        .trim()
        .replace(/^__(?:Secure|Host)-/, '');
      return (
        name !== 'sam_port_access' &&
        name !== 'vm_session' &&
        !name.startsWith('vm_session_') &&
        !name.startsWith('better-auth.')
      );
    })
    .map((part) => part.trim())
    .filter(Boolean);
  if (retained.length) headers.set('cookie', retained.join('; '));
  else headers.delete('cookie');
}
