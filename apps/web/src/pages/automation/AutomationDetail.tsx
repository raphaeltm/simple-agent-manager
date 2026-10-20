/** `automation/:kind/:automationId`: the page for one trigger, one-time automation or watch. */
import { Navigate, useLocation, useParams } from 'react-router';

import { automationPaths, isAutomationKind } from '../../lib/automation-routes';
import { useProjectContext } from '../ProjectContext';
import { ScheduleDetail } from './ScheduleDetail';
import { TriggerDetail } from './TriggerDetail';
import { WatchDetail } from './WatchDetail';

export function AutomationDetail() {
  const { projectId } = useProjectContext();
  // Not `id`: the project route above already owns that name.
  const { kind, automationId: id } = useParams<{ kind: string; automationId: string }>();
  const { hash } = useLocation();
  if (!id || !isAutomationKind(kind))
    return <Navigate to={automationPaths.overview(projectId)} replace />;
  // Keyed by id so moving between automations never shows one item's state on another.
  if (kind === 'trigger')
    return <TriggerDetail key={id} triggerId={id} scrollToRuns={hash === '#runs'} />;
  if (kind === 'schedule') return <ScheduleDetail key={id} scheduleId={id} />;
  return <WatchDetail key={id} watchId={id} />;
}
