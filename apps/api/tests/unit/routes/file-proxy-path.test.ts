import { describe, expect, it } from 'vitest';
import { normalizeFileProxyPath } from '../../../src/routes/projects/_helpers';

describe('normalizeFileProxyPath', () => {
  it('allows absolute paths under /workspaces/', () => {
    expect(normalizeFileProxyPath('/workspaces/my-project/src/index.ts')).toBe(
      '/workspaces/my-project/src/index.ts'
    );
  });

  it('allows absolute paths under /etc/ (read-only is safe)', () => {
    expect(normalizeFileProxyPath('/etc/hosts')).toBe('/etc/hosts');
  });

  it('allows absolute paths under /usr/', () => {
    expect(normalizeFileProxyPath('/usr/local/bin/node')).toBe('/usr/local/bin/node');
  });

  it('allows absolute paths under /var/', () => {
    expect(normalizeFileProxyPath('/var/log/syslog')).toBe('/var/log/syslog');
  });

  it('allows /home/node/ paths', () => {
    expect(normalizeFileProxyPath('/home/node/.npmrc')).toBe('/home/node/.npmrc');
  });

  it('allows relative paths', () => {
    expect(normalizeFileProxyPath('src/index.ts')).toBe('src/index.ts');
  });

  it('allows tilde-prefixed paths', () => {
    expect(normalizeFileProxyPath('~/.bashrc')).toBe('~/.bashrc');
  });

  it('allows bare dot as root alias', () => {
    expect(normalizeFileProxyPath('.')).toBe('.');
  });

  it('rejects path traversal (..)', () => {
    expect(() => normalizeFileProxyPath('../etc/passwd')).toThrow(
      'path must not contain empty, dot, or dot-dot segments'
    );
  });

  it('rejects mid-path traversal', () => {
    expect(() => normalizeFileProxyPath('/workspaces/foo/../../../etc/shadow')).toThrow(
      'path must not contain empty, dot, or dot-dot segments'
    );
  });

  it('rejects dot segments', () => {
    expect(() => normalizeFileProxyPath('/workspaces/./foo')).toThrow(
      'path must not contain empty, dot, or dot-dot segments'
    );
  });

  it('rejects empty path', () => {
    expect(() => normalizeFileProxyPath('')).toThrow('path is required');
  });

  it('rejects whitespace-only path', () => {
    expect(() => normalizeFileProxyPath('   ')).toThrow('path is required');
  });

  it('normalizes backslashes to forward slashes', () => {
    expect(normalizeFileProxyPath('src\\index.ts')).toBe('src/index.ts');
  });

  it('rejects paths with colons', () => {
    expect(() => normalizeFileProxyPath('C:\\Users\\foo')).toThrow('path contains invalid characters');
  });

  it('rejects empty segments (double slashes)', () => {
    expect(() => normalizeFileProxyPath('/workspaces//foo')).toThrow(
      'path must not contain empty, dot, or dot-dot segments'
    );
  });

  it('rejects tilde traversal (~/..)', () => {
    expect(() => normalizeFileProxyPath('~/..')).toThrow(
      'path must not contain empty, dot, or dot-dot segments'
    );
  });

  it('rejects trailing slash (empty final segment)', () => {
    expect(() => normalizeFileProxyPath('/workspaces/foo/')).toThrow(
      'path must not contain empty, dot, or dot-dot segments'
    );
  });

  it('allows bare tilde', () => {
    expect(normalizeFileProxyPath('~')).toBe('~');
  });

  it('rejects backslash-encoded traversal', () => {
    expect(() => normalizeFileProxyPath('..\\..\\etc\\passwd')).toThrow(
      'path must not contain empty, dot, or dot-dot segments'
    );
  });

  it('allows ~/.ssh/authorized_keys (read-only proxy has no blocked paths)', () => {
    expect(normalizeFileProxyPath('~/.ssh/authorized_keys')).toBe('~/.ssh/authorized_keys');
  });
});
