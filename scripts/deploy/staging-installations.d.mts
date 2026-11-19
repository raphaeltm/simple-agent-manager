export interface SecondaryInstallation {
  credentialEnvironment: string;
  baseDomain: string;
  resourcePrefix: string;
  stack: string;
}

export const SECONDARY_CREDENTIAL_ENVIRONMENTS: readonly string[];

export const SECONDARY_INSTALLATIONS: Readonly<Record<string, Readonly<SecondaryInstallation>>>;

export function resolveInstallation(input: {
  environment: string;
  installation?: string;
  primary: { baseDomain?: string; prefix: string; stack: string };
}): { installation: string; secondary: boolean; entry?: SecondaryInstallation };

export function credentialEnvironmentFor(installation: string | undefined): string;

export function workflowTargetFor(
  installation: string,
  primaryBaseDomain: string | undefined
): { credential_environment: string; installation: string; base_domain: string };
