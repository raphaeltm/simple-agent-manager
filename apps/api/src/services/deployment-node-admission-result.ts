export type DeploymentNodeAdmissionRejection =
  'unavailable' | 'pool-ineligible' | 'capacity' | 'authority-changed';
export function deploymentNodeAdmissionFailureMessage(
  reason: DeploymentNodeAdmissionRejection
): string {
  switch (reason) {
    case 'pool-ineligible':
      return 'Existing exclusive deployment node is no longer eligible under the effective compute pool';
    case 'capacity':
      return 'Existing exclusive deployment node cannot admit the declared resource reservation';
    case 'authority-changed':
      return 'Existing exclusive deployment node admission changed during reservation; retry the release';
    case 'unavailable':
      return 'Existing exclusive deployment node is unavailable for admission';
  }
}
