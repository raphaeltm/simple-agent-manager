export interface DeploymentEnvironmentConfigVarResponse {
  key: string;
  value: string | null;
  isSecret: boolean;
  hasValue: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertDeploymentEnvironmentConfigVarRequest {
  key: string;
  value: string;
  isSecret?: boolean;
}

export interface DeploymentEnvironmentConfigResponse {
  envVars: DeploymentEnvironmentConfigVarResponse[];
  updatedAt: string | null;
  variableCount: number;
  secretCount: number;
}
