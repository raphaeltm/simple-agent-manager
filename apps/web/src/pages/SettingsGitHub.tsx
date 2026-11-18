import { ConnectedAccountsSection } from '../components/ConnectedAccountsSection';
import { GitHubAppSection } from '../components/GitHubAppSection';

export function SettingsGitHub() {
  return (
    <div className="flex flex-col gap-4">
      <ConnectedAccountsSection />
      <GitHubAppSection />
    </div>
  );
}
