/**
 * PROTOTYPE ONLY — /prototype/run-account (dev builds only). Never ship.
 * Three questions from 2026-11-13:
 *   1. Where should "via ChatGPT" sit on a chat-list row?
 *   2. How does a usage indicator say which window (5h, week) it is about?
 *   3. Should one run be able to use a different account than its profile's?
 */
import { paneClassName } from '@simple-agent-manager/ui';
import type { ReactNode } from 'react';

import { AccountPicking, Nudge } from './account-variants';
import { TodayRows, VariantRows } from './connector-rows';
import { OPUS_CHAT } from './mock-data';
import { Round2Column } from './usage-round2';
import { PickerList, ToControlVariant, TwinLegend } from './usage-variants';

function Card({
  id,
  label,
  title,
  why,
  recommended,
  children,
}: Readonly<{
  id: string;
  label: string;
  title: string;
  why: string;
  recommended?: boolean;
  children: ReactNode;
}>) {
  return (
    <article data-card={id} className="flex min-w-0 flex-col gap-2.5">
      <header className="px-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
            {label}
          </span>
          {recommended && (
            <span className="rounded-full bg-[var(--sam-status-success-bg)] px-2 py-px font-mono text-[10px] font-semibold text-[var(--sam-status-success-fg)] uppercase">
              Recommended
            </span>
          )}
        </div>
        <h3 className="m-0 mt-0.5 text-[15px] font-semibold text-fg-primary">{title}</h3>
        <p className="m-0 mt-1 text-xs leading-relaxed text-fg-muted">{why}</p>
      </header>
      <div className={`${paneClassName('pane')} min-w-0 p-1.5`}>{children}</div>
    </article>
  );
}

function Section({
  id,
  title,
  intro,
  columns = 'xl:grid-cols-4',
  children,
}: Readonly<{ id: string; title: string; intro: string; columns?: string; children: ReactNode }>) {
  return (
    <section data-section={id} className="mx-auto w-full max-w-[1240px] px-4 py-6">
      <h2 className="m-0 text-lg font-semibold text-fg-primary">{title}</h2>
      <p className="m-0 mt-1 max-w-[70ch] text-sm text-fg-muted">{intro}</p>
      <div className={`mt-4 grid gap-6 md:grid-cols-2 ${columns}`}>{children}</div>
    </section>
  );
}

function Stack({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="@container grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 p-2">{children}</div>
  );
}

export function RunAccountPrototype() {
  return (
    // The app scrolls inside its shell, not the body: the page brings its own scroller.
    <div className="sam-void relative h-dvh overflow-y-auto overflow-x-hidden">
      <header className="mx-auto w-full max-w-[1240px] px-4 pt-6">
        <div className="font-mono text-[11px] tracking-wide text-fg-muted uppercase">
          Prototype · mock data
        </div>
        <h1 className="m-0 mt-1 text-xl font-semibold text-fg-primary">
          Connector provenance, usage windows, and choosing an account per run
        </h1>
      </header>

      <Section
        id="usage-r2"
        columns="xl:grid-cols-5"
        title="2b · Usage, round 2: the 5h window comes first"
        intro="Same eight account states in every column; the mono line under each name is the truth (5h left · week left). Words under it are shared by the new variants: silent while both windows have more than half left, 5h first otherwise. Colours everywhere use your thresholds on what is left: green above 50%, amber 25–50%, red below 25%."
      >
        <Card
          id="r2-today"
          label="Today"
          title="One ring, tightest window"
          why="Shows whichever window is tightest, unlabelled. “5h fresh, week nearly gone” and “5h nearly gone” look identical."
        >
          <Round2Column variant="today" />
        </Card>
        <Card
          id="r2-raph"
          label="D · yours"
          recommended
          title="Arc = 5h, colour = week"
          why="One glyph, two answers: how much of this session is left (length) and whether the week can carry on (colour). An empty 5h still shows a dot. Weakness: colour alone carries the week, so the words must back it up for colour-blind readers."
        >
          <Round2Column variant="raph" />
        </Card>
        <Card
          id="r2-pip"
          label="E"
          title="Ring = 5h, pip = week"
          why="Like presence dots: the ring answers “now”, a corner dot answers “this week”. Each signal has its own place, so the arc can keep its own colour. Costs one more mark on a small avatar."
        >
          <Round2Column variant="pip" />
        </Card>
        <Card
          id="r2-hairline"
          label="F"
          title="Thick ring 5h, hairline week"
          why="Shows the week’s amount, not just its band. Weight sets the hierarchy (thick = now), which is easier to learn than equal twin rings, but the hairline is hard to read at 32px."
        >
          <Round2Column variant="hairline" />
        </Card>
        <Card
          id="r2-bar"
          label="G"
          title="Ring 5h, bar week"
          why="Borrowed from CodexBar and UsageBar (thick 5h over thin weekly) and Claude’s own usage page (session above weekly). Most explicit, but the bar adds height to every row and the composer chip."
        >
          <Round2Column variant="bar" />
        </Card>
      </Section>

      <Section
        id="connector"
        title="1 · Where “via ChatGPT” goes"
        intro="The chip sits in the right-hand badge cluster with max-width 40% of an auto-sized column, so it truncates itself and leaves a gap. The hierarchy button then floats left of where it sits on every other row. Every variant moves the provenance to the meta line and leaves the right edge to buttons."
      >
        <Card
          id="connector-today"
          label="Today"
          title="Chip on the title line"
          why="Rows with the chip push the parent/child button inward (rows 2, 3 and 5). The long connector name truncates to “via Clau…” and the title loses room."
        >
          <TodayRows />
        </Card>
        <Card
          id="connector-a"
          label="A"
          recommended
          title="“Chat via ChatGPT”"
          why="Your suggestion. Provenance reads as part of what the row is, in the meta line’s own muted text. Nothing new to learn, and the right edge stays aligned on every row."
        >
          <VariantRows placement="kind-text" />
        </Card>
        <Card
          id="connector-b"
          label="B"
          title="Kind chip with a plug icon"
          why="Easier to spot when scanning for connector work, but it adds a second chip style to a dense line. Worth it only if you scan for connector chats often."
        >
          <VariantRows placement="kind-chip" />
        </Card>
        <Card
          id="connector-c"
          label="C"
          title="“You via ChatGPT”"
          why="Ties the connector to who started it, which is what it really means. But the owner slot is width-capped, so long connector names lose out first and “Task” drifts away from it."
        >
          <VariantRows placement="owner-phrase" />
        </Card>
      </Section>

      <Section
        id="usage"
        title="2 · Which limit is the ring about?"
        intro="Each account reports every window (5h, week, Opus week). Today the ring collapses them into one unlabelled arc, so “28% left” could mean 28% of 5 hours or 28% of a week. Accounts: Personal Pro (week only, 6% left), Work Max (5h 28%, week 69%), Team seat (5h, week, Opus week), ChatGPT Pro (week only), ChatGPT Team (5h used up)."
      >
        <Card
          id="usage-today"
          label="Today"
          title="One unlabelled ring"
          why="Personal Pro and Work Max look alike at a glance, and “6% left · resets 2d 4h” is the only hint that one is weekly."
        >
          <Stack>
            <ToControlVariant profile={OPUS_CHAT} variant="today" />
          </Stack>
          <PickerList variant="today" />
        </Card>
        <Card
          id="usage-a"
          label="A"
          recommended
          title="Ring + window tag"
          why="Keeps the ring you approved and adds a tiny mono tag (5H / WK / OPUS) for the window the arc measures. The words name the window too: “Weekly limit · 6% left”. Fits the composer at 375px."
        >
          <Stack>
            <ToControlVariant profile={OPUS_CHAT} variant="tag" />
          </Stack>
          <PickerList variant="tag" />
        </Card>
        <Card
          id="usage-b"
          label="B"
          title="Twin rings"
          why="Shows both windows at once, but needs a legend, the glyph shrinks, a dashed ring for “no such limit” is subtle, and a third window (Opus week) has nowhere to go."
        >
          <Stack>
            <ToControlVariant profile={OPUS_CHAT} variant="twin" />
          </Stack>
          <TwinLegend />
          <PickerList variant="twin" />
        </Card>
        <Card
          id="usage-c"
          label="C"
          recommended
          title="Labelled meters (in the sheet)"
          why="Every window, labelled, with the account name, in the vocabulary the Profiles page already uses. Too wide for the composer, so pair it with A: tag on the ring there, full meters wherever there is a row of room."
        >
          <Stack>
            <ToControlVariant profile={OPUS_CHAT} variant="meters" />
          </Stack>
          <PickerList variant="meters" />
        </Card>
      </Section>

      <Section
        id="account"
        columns="xl:grid-cols-3"
        title="3 · The nudge, and picking an account for one run"
        intro="Today the only way to run Opus on another account is a second profile pinned to it, so you end up with Opus Chat, Opus Chat (Work) and so on. Splitting “how it runs” (the profile) from “who pays” (the account) removes the duplicates. Note: the API cannot do this yet; the start-chat and task requests accept only model and effort overrides."
      >
        <Card
          id="nudge-today"
          label="Today"
          title="Nudge offers another profile"
          why="“6% left” without saying weekly, and “Use Opus Chat (Work) · 28% left” is a 5h figure while that account still has 69% of its week. The two numbers aren’t comparable."
        >
          <Stack>
            <Nudge variant="today" />
          </Stack>
        </Card>
        <Card
          id="nudge-a"
          label="A"
          title="Same nudge, windows named"
          why="Fixes the ambiguity with no backend change: the headline names the limit, and the alternative shows every window. Still requires a profile per account."
        >
          <Stack>
            <Nudge variant="named" />
          </Stack>
        </Card>
        <Card
          id="nudge-b"
          label="B"
          recommended
          title="Nudge swaps the account"
          why="Offers the roomiest compatible account directly, keeping your profile (model, effort, mode). After the tap, one line says the chat runs on Work Max, with an undo. The second profile becomes unnecessary."
        >
          <Stack>
            <Nudge variant="swap" />
            <div className="px-1 text-[11px] text-fg-muted">After tapping:</div>
            <Nudge variant="swapped" />
          </Stack>
        </Card>
        <Card
          id="account-a"
          label="A"
          title="Account in Chat options"
          why="Lives with model and effort, the other per-run overrides, and counts toward the options badge. But it is hidden behind the sliders button, which is the wrong place for the thing you change most when you hit a limit."
        >
          <Stack>
            <AccountPicking variant="options" />
          </Stack>
        </Card>
        <Card
          id="account-b"
          label="B"
          recommended
          title="“on Work Max” beside To"
          why="The account is always visible next to the profile and opens a list with every window, limited to accounts that can run this agent. One control, which the nudge’s button also sets. Wraps to its own line on a phone."
        >
          <Stack>
            <AccountPicking variant="segment" />
          </Stack>
        </Card>
        <Card
          id="account-c"
          label="C"
          title="Account row inside the profile sheet"
          why="Profile and account picked together in one place. But it makes the sheet taller, hides the choice once the sheet closes, and the horizontal chips scroll on a phone."
        >
          <Stack>
            <AccountPicking variant="sheet" />
          </Stack>
        </Card>
      </Section>
      <div className="h-10" />
    </div>
  );
}
