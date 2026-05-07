type CoverageThresholds = {
  statements: number;
  branches: number;
  functions: number;
  lines: number;
};

export function coverageConfig(include: string[], thresholds: CoverageThresholds) {
  return {
    provider: 'v8' as const,
    reporter: ['text', 'json', 'html'] as const,
    include,
    exclude: ['src/**/*.d.ts'],
    thresholds,
  };
}
