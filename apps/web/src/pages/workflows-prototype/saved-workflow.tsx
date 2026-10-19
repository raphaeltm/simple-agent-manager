/**
 * PROTOTYPE ONLY — Option B saved workflow page and Start sheet.
 * The steps render as a dashed "blueprint" (numbers, no status) so it reads as
 * the plan, not a run. Schedules reuse the REAL trigger SchedulePicker: a
 * schedule here would be an ordinary cron trigger whose action is "start this".
 */
import { Alert, Breadcrumb, Button, Dialog, DropdownMenu } from '@simple-agent-manager/ui';
import { CalendarClock, CornerDownRight, Hand, Pencil, Play, Plus, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { SchedulePicker } from '../../components/triggers/SchedulePicker';
import { useIsMobile } from '../../hooks/useIsMobile';
import { getSaved, runsOfWorkflow } from './mock-workflows';
import {
  afterLine,
  countSteps,
  frameAt,
  layerLabel,
  layerSteps,
  progressSentence,
  type SavedWorkflow,
} from './model';
import { useParam } from './proto-controls';
import { p, ProjectPage, ProtoShell } from './shell';
import { ProfileChip, RunStatusPill, SavedChip, StepProgressBar } from './status-ui';

function Card({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border-default p-4 flex flex-col gap-2.5 min-w-0 bg-[color-mix(in_srgb,var(--sam-color-bg-surface)_70%,transparent)]">
      <div className="flex items-center gap-2">
        <h2 className="m-0 text-[11px] font-semibold uppercase tracking-wider text-fg-muted flex-1">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Blueprint({ wf }: { wf: Pick<SavedWorkflow, 'steps'> }) {
  const layers = layerSteps(wf.steps);
  let n = 0;
  return (
    <ol className="list-none m-0 p-0 flex flex-col gap-3" aria-label="Steps">
      {layers.map((layer, li) => (
        <li key={layer.map((s) => s.key).join('-')}>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
            {layerLabel(li, layers.length, layer)}
          </div>
          <div className="flex flex-col gap-1.5">
            {layer.map((s) => {
              n += 1;
              const after = afterLine(s, layers[li - 1], wf.steps);
              return (
                <div
                  key={s.key}
                  className="flex items-start gap-2.5 rounded-md border border-dashed px-3 py-2"
                  style={{
                    borderColor:
                      s.kind === 'approval'
                        ? 'color-mix(in srgb, var(--sam-color-warning) 55%, transparent)'
                        : 'color-mix(in srgb, var(--sam-color-fg-muted) 40%, transparent)',
                  }}
                >
                  <span className="shrink-0 w-6 h-6 rounded-full border border-dashed border-[var(--sam-color-fg-muted)] text-[11px] text-fg-muted flex items-center justify-center tabular-nums">
                    {n}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm text-fg-primary break-words">{s.title}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-fg-muted">
                      {s.kind === 'approval' ? (
                        <span
                          className="inline-flex items-center gap-1"
                          style={{ color: 'var(--sam-color-warning-fg)' }}
                        >
                          <Hand size={11} aria-hidden /> Waits for your approval
                        </span>
                      ) : (
                        <ProfileChip profileId={s.profileId} />
                      )}
                      {s.mustOpenPr && <span>Must open a PR</span>}
                    </span>
                    {after && (
                      <span className="mt-1 flex items-center gap-1 text-[11px] text-fg-muted">
                        <CornerDownRight size={11} aria-hidden /> {after}
                      </span>
                    )}
                    <span className="mt-1 block text-xs text-fg-muted leading-relaxed line-clamp-2 break-words">
                      {s.kind === 'approval' ? s.question : s.instructions}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </li>
      ))}
    </ol>
  );
}

function ScheduleCard({ wf }: { wf: SavedWorkflow }) {
  const [adding, setAdding] = useState(false);
  const [cron, setCron] = useState('0 6 * * 1');
  const [tz, setTz] = useState('UTC');
  return (
    <Card
      title="Starts automatically"
      action={
        !wf.schedule && !adding ? (
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
            <Plus size={14} /> Add a schedule
          </Button>
        ) : null
      }
    >
      {wf.schedule ? (
        <div className="flex items-start gap-2.5">
          <CalendarClock
            size={16}
            className="shrink-0 mt-0.5"
            style={{ color: 'var(--sam-color-info)' }}
          />
          <div className="min-w-0 flex-1">
            <div className="text-sm text-fg-primary break-words">{wf.schedule.label}</div>
            <div className="text-[11px] text-fg-muted">
              {wf.schedule.nextIn} · runs as you · skipped if the last run is still going
            </div>
          </div>
          <Button size="sm" variant="secondary">
            Change
          </Button>
        </div>
      ) : adding ? (
        <div className="flex flex-col gap-3">
          <SchedulePicker value={cron} onChange={setCron} timezone={tz} onTimezoneChange={setTz} />
          <p className="m-0 text-[11px] text-fg-muted">
            Saved as a normal trigger (it appears on the Triggers page) whose action is “start{' '}
            {wf.name}”.
          </p>
          <div className="flex gap-2">
            <Button size="sm">Save schedule</Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p className="m-0 text-xs text-fg-muted">Only when you, or an agent you ask, start it.</p>
      )}
    </Card>
  );
}

export function SavedWorkflowPage() {
  const { workflowId } = useParams();
  const wf = getSaved(workflowId);
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [justSaved] = useParam('justSaved');
  const runs = runsOfWorkflow(wf.id);

  return (
    <ProtoShell option="B" active="workflows" label="Option B · Workflows area · saved workflow">
      <ProjectPage>
        <div className="flex flex-col gap-4 pb-12 min-w-0" data-testid="saved-workflow">
          <Breadcrumb
            segments={[
              { label: 'Workflows', path: p('b/workflows') },
              { label: 'Saved', path: p('b/workflows/saved') },
              { label: 'This workflow' },
            ]}
          />
          {justSaved && (
            <Alert variant="success">
              Saved from your one-off run. Start it any time — the original run is unchanged.
            </Alert>
          )}
          <div className="flex flex-col sm:flex-row sm:items-start gap-3">
            <div className="flex-1 min-w-0">
              <SavedChip version={wf.version} />
              <h1 className="sam-type-page-title m-0 mt-2 break-words">{wf.name}</h1>
              <p className="m-0 mt-1 text-sm text-fg-muted leading-relaxed break-words">
                {wf.description}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button size="sm" onClick={() => navigate(p(`b/workflows/saved/${wf.id}/start`))}>
                <Play size={14} /> Start run
              </Button>
              <Button size="sm" variant="secondary">
                <Pencil size={14} /> Edit
              </Button>
              <DropdownMenu
                items={[
                  { id: 'dup', label: 'Duplicate', onClick: () => undefined },
                  { id: 'archive', label: 'Archive', variant: 'danger', onClick: () => undefined },
                ]}
              />
            </div>
          </div>

          <div
            className={
              isMobile
                ? 'flex flex-col gap-4'
                : 'grid grid-cols-[minmax(0,1fr)_360px] gap-6 items-start'
            }
          >
            <Card title={`Steps (${wf.steps.length})`}>
              <Blueprint wf={wf} />
            </Card>
            <div className="flex flex-col gap-4 min-w-0">
              <Card title="Blanks you fill in each time">
                {wf.inputs.length === 0 ? (
                  <p className="m-0 text-xs text-fg-muted">
                    None — it runs the same way every time.
                  </p>
                ) : (
                  wf.inputs.map((i) => (
                    <div key={i.key} className="text-sm text-fg-primary">
                      {i.label}
                      {i.required && <span className="text-fg-muted text-[11px]"> · required</span>}
                      <div className="text-[11px] text-fg-muted">{i.placeholder}</div>
                    </div>
                  ))
                )}
              </Card>
              <ScheduleCard wf={wf} />
              <Card title={`Recent runs · ${wf.usedCount} total`}>
                {runs.length === 0 && <p className="m-0 text-xs text-fg-muted">No runs yet.</p>}
                <ul className="list-none m-0 p-0 flex flex-col gap-2">
                  {runs.map((r) => {
                    const f = frameAt(r, null);
                    return (
                      <li key={r.id}>
                        <Link
                          to={p(`b/workflows/runs/${r.id}`)}
                          className="block no-underline rounded-md px-2 py-1.5 hover:bg-surface-hover"
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-fg-muted tabular-nums shrink-0">
                              #{r.origin.kind === 'saved' ? r.origin.runNumber : ''}
                            </span>
                            <span className="text-sm text-fg-primary truncate flex-1">
                              {r.title}
                            </span>
                            <RunStatusPill status={f.status} />
                          </div>
                          <StepProgressBar
                            steps={r.steps}
                            frame={f}
                            height={4}
                            className="mt-1.5"
                          />
                          <div className="mt-1 text-[11px] text-fg-muted">
                            {progressSentence(countSteps(f, r.steps))} · {r.startedAgo}
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </Card>
              <Card title="Versions">
                <ul className="list-none m-0 p-0 flex flex-col gap-1.5">
                  {wf.versions.map((v) => (
                    <li key={v.v} className="flex gap-2 text-xs">
                      <span className="tabular-nums font-semibold text-fg-primary shrink-0">
                        v{v.v}
                      </span>
                      <span className="text-fg-muted break-words">
                        {v.note} · {v.ago}
                        {v.v === wf.version ? ' · current' : ''}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="m-0 text-[11px] text-fg-muted">
                  Each run keeps the version it started with.
                </p>
              </Card>
            </div>
          </div>
        </div>
      </ProjectPage>
    </ProtoShell>
  );
}

export function StartSheet() {
  const { workflowId } = useParams();
  const wf = getSaved(workflowId);
  const navigate = useNavigate();
  const [values, setValues] = useState<Record<string, string>>({
    change:
      'CSV export drops the last row when the file ends without a trailing newline. Starter-plan customers see missing refunds in exported statements.',
  });
  const close = () => navigate(p(`b/workflows/saved/${wf.id}`));
  const approvals = wf.steps.filter((s) => s.kind === 'approval');

  return (
    <>
      <SavedWorkflowPage />
      <Dialog isOpen onClose={close} maxWidth="lg" aria-labelledby="start-title">
        <div className="p-5 flex flex-col gap-4 overflow-y-auto" data-testid="start-sheet">
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <div className="text-[11px] text-fg-muted">Start a run of</div>
              <h2
                id="start-title"
                className="m-0 text-base font-semibold text-fg-primary break-words"
              >
                {wf.name}
              </h2>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="w-8 h-8 rounded-md flex items-center justify-center bg-transparent border border-border-default text-fg-muted cursor-pointer"
            >
              <X size={15} />
            </button>
          </div>
          {wf.inputs.map((i) => (
            <label key={i.key} className="flex flex-col gap-1 text-xs text-fg-muted">
              <span>
                {i.label}
                {i.required ? '' : ' (optional)'}
              </span>
              {i.multiline ? (
                <textarea
                  rows={3}
                  value={values[i.key] ?? ''}
                  placeholder={i.placeholder}
                  onChange={(e) => setValues((v) => ({ ...v, [i.key]: e.target.value }))}
                  className="w-full rounded-sm bg-[var(--sam-form-bg)] border border-[var(--sam-form-border)] px-3 py-2 text-sm text-fg-primary resize-y"
                />
              ) : (
                <input
                  value={values[i.key] ?? ''}
                  placeholder={i.placeholder}
                  onChange={(e) => setValues((v) => ({ ...v, [i.key]: e.target.value }))}
                  className="w-full min-h-11 rounded-sm bg-[var(--sam-form-bg)] border border-[var(--sam-form-border)] px-3 text-sm text-fg-primary"
                />
              )}
            </label>
          ))}
          <div className="rounded-md border border-border-default bg-inset px-3 py-2.5 text-xs text-fg-muted leading-relaxed">
            <div className="text-fg-primary font-medium text-sm mb-1">What happens next</div>
            {wf.steps.length} steps, up to 2 agents at once. SAM starts each step as soon as the
            steps before it finish — like dispatching tasks yourself, so nothing else needs
            approving to begin.
            {approvals.length > 0 && (
              <>
                {' '}
                It stops once to ask you:{' '}
                <span className="text-fg-primary">
                  “{approvals[0]?.title.replace('Your approval: ', '')}”
                </span>
                .
              </>
            )}{' '}
            Every step runs as you, on your credentials.
          </div>
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <Button variant="ghost" onClick={close}>
              Save as draft
            </Button>
            <Button onClick={() => navigate(p('b/workflows/runs/run-csv?t=csv-0'))}>
              <Play size={15} /> Start run
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
