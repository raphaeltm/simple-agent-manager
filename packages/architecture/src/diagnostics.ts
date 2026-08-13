export type DiagnosticSeverity = 'error' | 'warning';

export interface ArchitectureDiagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  file?: string;
  path?: string;
}

export function hasErrors(diagnostics: readonly ArchitectureDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}

export function formatDiagnostics(diagnostics: readonly ArchitectureDiagnostic[]): string {
  if (diagnostics.length === 0) return 'No architecture diagnostics.';
  return diagnostics
    .map((diagnostic) => {
      const location = [diagnostic.file, diagnostic.path].filter(Boolean).join(':');
      const prefix = location ? `${location}: ` : '';
      return `${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${prefix}${diagnostic.message}`;
    })
    .join('\n');
}
