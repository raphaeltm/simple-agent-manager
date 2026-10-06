import type { AgentCredentialInfo, AgentType, CredentialKind } from '@simple-agent-manager/shared';

export function removeAgentCredentialKind(
  credentials: AgentCredentialInfo[],
  agentType: AgentType,
  credentialKind: CredentialKind
): AgentCredentialInfo[] {
  const deletedCredential = credentials.find(
    (credential) =>
      credential.agentType === agentType && credential.credentialKind === credentialKind
  );
  const remainingCredentials = credentials.filter(
    (credential) =>
      !(credential.agentType === agentType && credential.credentialKind === credentialKind)
  );

  if (!deletedCredential?.isActive) {
    return remainingCredentials;
  }

  const agentCredentials = remainingCredentials.filter(
    (credential) => credential.agentType === agentType
  );
  const hasActiveCredential = agentCredentials.some((credential) => credential.isActive);
  const fallbackCredential = agentCredentials[0];

  if (hasActiveCredential || !fallbackCredential) {
    return remainingCredentials;
  }

  return remainingCredentials.map((credential) =>
    credential === fallbackCredential ? { ...credential, isActive: true } : credential
  );
}

export function hasAgentCredentials(
  credentials: AgentCredentialInfo[],
  agentType: AgentType
): boolean {
  return credentials.some((credential) => credential.agentType === agentType);
}
