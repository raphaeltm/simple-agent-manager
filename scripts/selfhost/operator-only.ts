/** L24 / policy 795e72a6: operator secrets must never enter a CI runner. */
export function assertOperatorExecution(): void {
  if (
    Object.keys(process.env).some(
      (name) => name === 'CI' || name === 'GITHUB_ACTIONS' || name.startsWith('RUNNER_')
    )
  ) {
    throw new Error('Operator secret commands are forbidden in CI');
  }
}
