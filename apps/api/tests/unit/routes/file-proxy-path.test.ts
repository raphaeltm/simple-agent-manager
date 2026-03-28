/**
 * Tests for normalizeFileProxyPath — the relaxed path validator for read-only
 * file proxy routes. Verifies that absolute paths are allowed (unlike the
 * write-API validator normalizeProjectFilePath) while still preventing
 * path traversal and invalid characters.
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeFileProxyPath,
  normalizeProjectFilePath,
} from '../../../src/routes/projects/_helpers';

describe('normalizeFileProxyPath', () => {
  describe('relative paths (same behavior as write validator)', () => {
    it('accepts simple filename', () => {
      expect(normalizeFileProxyPath('README.md')).toBe('README.md');
    });

    it('accepts nested relative path', () => {
      expect(normalizeFileProxyPath('src/components/App.tsx')).toBe('src/components/App.tsx');
    });

    it('accepts hidden files', () => {
      expect(normalizeFileProxyPath('.gitignore')).toBe('.gitignore');
    });

    it('accepts hidden directory paths', () => {
      expect(normalizeFileProxyPath('.github/workflows/ci.yml')).toBe('.github/workflows/ci.yml');
    });

    it('accepts bare "." as root alias', () => {
      expect(normalizeFileProxyPath('.')).toBe('.');
    });
  });

  describe('absolute paths (allowed for read-only proxy)', () => {
    it('accepts /workspaces/ paths', () => {
      expect(normalizeFileProxyPath('/workspaces/repo/src/index.ts'))
        .toBe('/workspaces/repo/src/index.ts');
    });

    it('accepts deep absolute paths', () => {
      expect(normalizeFileProxyPath('/workspaces/simple-agent-manager/apps/api/src/routes/projects/files.ts'))
        .toBe('/workspaces/simple-agent-manager/apps/api/src/routes/projects/files.ts');
    });

    it('accepts /etc paths (read-only is safe)', () => {
      expect(normalizeFileProxyPath('/etc/hostname')).toBe('/etc/hostname');
    });

    it('accepts /home paths', () => {
      expect(normalizeFileProxyPath('/home/node/.bashrc')).toBe('/home/node/.bashrc');
    });

    it('accepts /usr paths', () => {
      expect(normalizeFileProxyPath('/usr/local/bin/node')).toBe('/usr/local/bin/node');
    });

    it('accepts /var paths', () => {
      expect(normalizeFileProxyPath('/var/log/syslog')).toBe('/var/log/syslog');
    });

    it('allows tilde-prefixed paths', () => {
      expect(normalizeFileProxyPath('~/.bashrc')).toBe('~/.bashrc');
    });

    it('allows bare tilde', () => {
      expect(normalizeFileProxyPath('~')).toBe('~');
    });

    it('allows ~/.ssh/authorized_keys (read-only proxy has no blocked paths)', () => {
      expect(normalizeFileProxyPath('~/.ssh/authorized_keys')).toBe('~/.ssh/authorized_keys');
    });
  });

  describe('traversal prevention (still enforced)', () => {
    it('rejects basic path traversal', () => {
      expect(() => normalizeFileProxyPath('../etc/passwd')).toThrow();
    });

    it('rejects nested path traversal', () => {
      expect(() => normalizeFileProxyPath('src/../../etc/passwd')).toThrow();
    });

    it('rejects dot-dot segments even in absolute paths', () => {
      expect(() => normalizeFileProxyPath('/workspaces/repo/../../etc/passwd')).toThrow();
    });

    it('rejects dot segments in path', () => {
      expect(() => normalizeFileProxyPath('src/./foo.ts')).toThrow();
    });

    it('rejects mid-path traversal in absolute paths', () => {
      expect(() => normalizeFileProxyPath('/workspaces/foo/../../../etc/shadow')).toThrow();
    });

    it('rejects tilde traversal (~/..)', () => {
      expect(() => normalizeFileProxyPath('~/..')).toThrow();
    });

    it('rejects backslash-encoded traversal', () => {
      expect(() => normalizeFileProxyPath('..\\..\\etc\\passwd')).toThrow();
    });
  });

  describe('dangerous input prevention (still enforced)', () => {
    it('rejects empty path', () => {
      expect(() => normalizeFileProxyPath('')).toThrow();
    });

    it('rejects whitespace-only path', () => {
      expect(() => normalizeFileProxyPath('   ')).toThrow();
    });

    it('rejects invalid characters', () => {
      expect(() => normalizeFileProxyPath('file<script>.ts')).toThrow();
    });

    it('rejects backslash paths with traversal', () => {
      expect(() => normalizeFileProxyPath('..\\etc\\passwd')).toThrow();
    });

    it('normalizes backslashes to forward slashes', () => {
      expect(normalizeFileProxyPath('src\\index.ts')).toBe('src/index.ts');
    });

    it('rejects paths with colons', () => {
      expect(() => normalizeFileProxyPath('C:\\Users\\foo')).toThrow('path contains invalid characters');
    });

    it('rejects empty segments (double slashes)', () => {
      expect(() => normalizeFileProxyPath('/workspaces//foo')).toThrow();
    });

    it('rejects trailing slash (empty final segment)', () => {
      expect(() => normalizeFileProxyPath('/workspaces/foo/')).toThrow();
    });
  });

  describe('contrast with normalizeProjectFilePath (write validator)', () => {
    it('write validator rejects /workspaces/ paths', () => {
      expect(() => normalizeProjectFilePath('/workspaces/repo/src/index.ts'))
        .toThrow('Absolute paths are only allowed under /home/node/ or /home/user/');
    });

    it('proxy validator accepts /workspaces/ paths', () => {
      expect(normalizeFileProxyPath('/workspaces/repo/src/index.ts'))
        .toBe('/workspaces/repo/src/index.ts');
    });

    it('both reject traversal equally', () => {
      expect(() => normalizeProjectFilePath('../etc/passwd')).toThrow();
      expect(() => normalizeFileProxyPath('../etc/passwd')).toThrow();
    });
  });
});
