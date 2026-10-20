/**
 * The Events and Triggers URLs the Automation page replaced. They stay reachable because the
 * API still emits `/projects/:id/triggers/:triggerId` links (credential health, offboarding
 * previews) and people have bookmarks. See `legacyEventsTarget` / `legacyTriggersTarget`.
 */
import { Navigate, useParams, useSearchParams } from 'react-router';

import {
  automationPaths,
  legacyEventsTarget,
  legacyTriggersTarget,
} from '../../lib/automation-routes';
import { useProjectContext } from '../ProjectContext';

export function LegacyEventsRedirect() {
  const { projectId } = useProjectContext();
  const [params] = useSearchParams();
  return <Navigate to={legacyEventsTarget(projectId, params)} replace />;
}

export function LegacyTriggersRedirect() {
  const { projectId } = useProjectContext();
  const [params] = useSearchParams();
  return <Navigate to={legacyTriggersTarget(projectId, params)} replace />;
}

export function LegacyTriggerDetailRedirect() {
  const { projectId } = useProjectContext();
  const { triggerId } = useParams<{ triggerId: string }>();
  return (
    <Navigate
      to={
        triggerId
          ? automationPaths.detail(projectId, 'trigger', triggerId)
          : automationPaths.overview(projectId)
      }
      replace
    />
  );
}
