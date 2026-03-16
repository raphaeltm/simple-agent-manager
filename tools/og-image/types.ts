export interface TemplateConfig {
  width: number;
  height: number;
}

export interface TemplateModule {
  config: TemplateConfig;
  render: (opts?: Record<string, string>) => unknown;
}

export interface GenerateOptions {
  template: string;
  output?: string;
  title?: string;
  subtitle?: string;
}
