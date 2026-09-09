import type { ProviderCatalog, ProviderId } from './catalog';
import { DEFAULT_REGION_COUNT, formatPrice, PROVIDER_CATALOG } from './catalog';
import type { ExhaustionPolicy, Lab, LabNode, Strategy, WorkloadShape } from './model';
import {
  COMPARE_COLUMN_COUNT,
  createLab,
  DEFAULT_STRATEGY,
  cpuBudgetMillis,
  defaultSeedFleet,
  generateBatch,
  HOST_ORDERING,
  LAB,
  EVENT_DISPLAY_LIMIT,
  MAX_WORKSPACES_PER_NODE,
  setStockout,
  simulate,
  step,
  STRATEGIES,
  submit,
  usableMemoryMb,
  usageOf,
  WORKLOAD_DISPLAY_LIMIT,
  WORKLOAD_PRESETS,
} from './model';

const PLAY_MS = 1100;

function isStrategy(value: string): value is Strategy {
  return (STRATEGIES as readonly string[]).includes(value);
}

function isProviderId(value: string): value is ProviderId {
  return Object.prototype.hasOwnProperty.call(PROVIDER_CATALOG, value);
}

function isShape(value: string): value is WorkloadShape {
  return Object.prototype.hasOwnProperty.call(WORKLOAD_PRESETS, value);
}

class PlacementExplorer extends HTMLElement {
  private catalog: ProviderCatalog = PROVIDER_CATALOG.hetzner;
  private regions: string[] = [];
  private strategy: Strategy = DEFAULT_STRATEGY;
  private policy: ExhaustionPolicy = 'queue';
  private stockedOut = new Set<string>();
  private lab: Lab;
  private timer: ReturnType<typeof setInterval> | undefined;
  private initialized = false;

  constructor() {
    super();
    this.regions = this.catalog.regions.slice(0, DEFAULT_REGION_COUNT);
    this.lab = this.freshLab();
  }

  connectedCallback(): void {
    if (this.initialized) return;
    this.initialized = true;
    const body = this.querySelector<HTMLElement>('[data-lab-body]');
    if (body) body.hidden = false;
    this.addEventListener('click', this.onClick);
    this.addEventListener('change', this.onChange);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.renderRegions();
    this.render();
  }

  disconnectedCallback(): void {
    this.stopPlaying();
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  private freshLab(): Lab {
    return createLab(this.catalog, this.regions, {
      strategy: this.strategy,
      policy: this.policy,
      seedFleet: defaultSeedFleet(this.regions),
      stockedOut: [...this.stockedOut].filter((region) => this.regions.includes(region)),
    });
  }

  private reset(reason?: string): void {
    this.stopPlaying();
    this.lab = this.freshLab();
    // Changing the pool restarts the simulation. Say so: silently discarding a run the user had
    // stepped through several times, with no acknowledgement, reads as the widget breaking.
    if (reason) this.lab.events.unshift(`-- ${reason} — simulation restarted.`);
    this.render();
  }

  private onVisibility = (): void => {
    if (document.hidden) this.stopPlaying();
  };

  private stopPlaying(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
    const play = this.querySelector<HTMLButtonElement>('[data-action="play"]');
    if (play) play.textContent = 'Play ▸▸';
  }

  private togglePlaying(): void {
    if (this.timer !== undefined) {
      this.stopPlaying();
      return;
    }
    this.timer = setInterval(() => {
      step(this.lab);
      this.render();
      const busy = this.lab.workloads.some(
        (workload) => workload.state === 'queued' || workload.state === 'running'
      );
      const settling = this.lab.nodes.some((node) => node.state !== 'destroyed');
      if (!busy && !settling) this.stopPlaying();
    }, PLAY_MS);
    const play = this.querySelector<HTMLButtonElement>('[data-action="play"]');
    if (play) play.textContent = 'Pause ▮▮';
  }

  private onClick = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest('button');
    if (!button) return;

    const strategy = button.dataset.strategy;
    if (strategy !== undefined && isStrategy(strategy)) {
      this.strategy = strategy;
      this.lab.strategy = strategy;
      this.render();
      return;
    }

    const shape = button.dataset.shape;
    if (shape !== undefined && isShape(shape)) {
      submit(this.lab, shape);
      this.render();
      return;
    }

    const stockRegion = button.dataset.stockout;
    if (stockRegion !== undefined) {
      const nowOut = !this.stockedOut.has(stockRegion);
      if (nowOut) this.stockedOut.add(stockRegion);
      else this.stockedOut.delete(stockRegion);
      setStockout(this.lab, stockRegion, nowOut);
      this.renderRegions();
      this.render();
      return;
    }

    switch (button.dataset.action) {
      case 'batch':
        generateBatch(this.lab);
        this.render();
        break;
      case 'step':
        this.stopPlaying();
        step(this.lab);
        this.render();
        break;
      case 'play':
        this.togglePlaying();
        break;
      case 'reset':
        this.reset();
        break;
      default:
        break;
    }
  };

  private onChange = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    if (target.matches('[data-provider]')) {
      const value = (target as HTMLSelectElement).value;
      if (isProviderId(value)) {
        this.catalog = PROVIDER_CATALOG[value];
        this.regions = this.catalog.regions.slice(0, DEFAULT_REGION_COUNT);
        this.stockedOut.clear();
        this.renderRegions();
        this.reset(`Switched provider to ${this.catalog.label}`);
      }
      return;
    }

    if (target.matches('[data-policy]')) {
      this.policy = (target as HTMLSelectElement).value as ExhaustionPolicy;
      this.lab.policy = this.policy;
      this.render();
      return;
    }

    if (target.matches('[data-region]')) {
      const input = target as HTMLInputElement;
      const region = input.value;
      if (input.checked) {
        if (!this.regions.includes(region)) {
          // Keep catalog order so the region list is stable across toggles.
          this.regions = this.catalog.regions.filter(
            (candidate) => candidate === region || this.regions.includes(candidate)
          );
        }
      } else if (this.regions.length > 1) {
        this.regions = this.regions.filter((candidate) => candidate !== region);
      } else {
        // Never leave the pool with zero regions — there would be nothing to place onto.
        input.checked = true;
        return;
      }
      this.reset(`Pool regions changed to ${this.regions.join(', ')}`);
    }
  };

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private renderRegions(): void {
    const host = this.querySelector<HTMLElement>('[data-regions]');
    if (!host) return;
    const legend = host.querySelector('legend');
    const grid = document.createElement('div');
    grid.className = 'region-grid';

    for (const region of this.catalog.regions) {
      const chip = document.createElement('div');
      chip.className = 'region-chip';

      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = region;
      input.checked = this.regions.includes(region);
      input.setAttribute('data-region', '');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = region;
      label.append(input, name);

      const flame = document.createElement('button');
      flame.type = 'button';
      flame.dataset.stockout = region;
      const out = this.stockedOut.has(region);
      flame.setAttribute('aria-pressed', String(out));
      flame.setAttribute(
        'aria-label',
        `${region} is ${out ? 'out of stock' : 'in stock'} — toggle provider stockout`
      );
      // The dim lives on this span, not the button — see the focus-ring note in explorer.css.
      const glyph = document.createElement('span');
      glyph.className = 'flame-glyph';
      glyph.textContent = '🔥';
      flame.append(glyph);

      chip.append(label, flame);
      grid.append(chip);
    }

    host.replaceChildren(...(legend ? [legend, grid] : [grid]));
  }

  private render(): void {
    const lab = this.lab;

    for (const button of this.querySelectorAll<HTMLButtonElement>('[data-strategy]')) {
      button.setAttribute('aria-pressed', String(button.dataset.strategy === this.strategy));
    }
    const ordering = this.querySelector<HTMLElement>('[data-ordering]');
    if (ordering) ordering.textContent = HOST_ORDERING[this.strategy];

    const clock = this.querySelector<HTMLElement>('[data-clock]');
    if (clock) clock.textContent = `STEP ${String(lab.step).padStart(2, '0')}`;

    const catalogNote = this.querySelector<HTMLElement>('[data-catalog-note]');
    if (catalogNote) {
      const priced = this.catalog.offerings
        .map((item) => `${item.instanceType} ${formatPrice(this.catalog, item.monthlyCents)}`)
        .join(' · ');
      catalogNote.textContent = `${this.catalog.label}: ${priced} — the same price in every region, so region is a tie no strategy breaks.`;
    }

    this.renderFleet();
    this.renderWorkloads();
    this.renderEvents();
    this.renderCompare();
  }

  private renderFleet(): void {
    const host = this.querySelector<HTMLElement>('[data-fleet]');
    const summary = this.querySelector<HTMLElement>('[data-fleet-summary]');
    if (!host) return;
    const lab = this.lab;
    const live = lab.nodes.filter((node) => node.state !== 'destroyed');

    if (summary) {
      const cost = live.reduce((total, node) => total + node.offering.monthlyCents, 0);
      summary.textContent = live.length
        ? `${live.length} host${live.length === 1 ? '' : 's'} · ${formatPrice(this.catalog, cost)}`
        : 'no hosts';
    }

    if (lab.nodes.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'No hosts yet.';
      host.replaceChildren(empty);
      return;
    }

    host.replaceChildren(...lab.nodes.map((node) => this.nodeCard(node)));
  }

  private nodeCard(node: LabNode): HTMLLIElement {
    const usage = usageOf(this.lab, node.id);
    const li = document.createElement('li');

    const top = document.createElement('div');
    top.className = 'node-top';
    const sku = document.createElement('span');
    sku.className = 'sku';
    sku.textContent = `${node.offering.instanceType} · ${node.region}`;
    const state = document.createElement('span');
    state.className = 'state';
    state.dataset.state = node.state;
    state.textContent =
      node.state === 'booting'
        ? `booting ${node.bootRemaining}`
        : node.state === 'warm'
          ? `warm ${node.warmRemaining}`
          : node.state;
    top.append(sku, state);

    const meta = document.createElement('p');
    meta.className = 'meta';
    meta.textContent = `node ${node.id} · ${node.offering.vcpu} vCPU · ${(node.offering.memoryMb / 1024).toFixed(0)} GB · ${formatPrice(this.catalog, node.offering.monthlyCents)} · ${usage.coTenants}/${MAX_WORKSPACES_PER_NODE} workspaces`;

    li.append(top, meta);
    li.append(
      this.bar('CPU', usage.cpuMillis, cpuBudgetMillis(node)),
      this.bar('MEM', usage.memoryMb, usableMemoryMb(node))
    );
    return li;
  }

  private bar(label: string, used: number, capacity: number): HTMLDivElement {
    const safeCapacity = Math.max(1, capacity);
    const percent = Math.min(100, Math.round((used / safeCapacity) * 100));
    const row = document.createElement('div');
    row.className = 'bar';

    const name = document.createElement('span');
    name.textContent = label;

    const track = document.createElement('span');
    track.className = 'track';
    const fill = document.createElement('i');
    fill.className = 'fill';
    fill.style.width = `${percent}%`;
    fill.dataset.over = String(used > capacity);
    track.append(fill);

    const value = document.createElement('span');
    value.textContent = `${percent}%`;

    row.append(name, track, value);
    return row;
  }

  private renderWorkloads(): void {
    const host = this.querySelector<HTMLElement>('[data-workloads]');
    if (!host) return;
    const submitted = this.lab.workloads.filter((workload) => !workload.seeded);
    if (submitted.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'Submit some work, or generate a batch.';
      host.replaceChildren(empty);
      return;
    }
    host.replaceChildren(
      ...submitted.slice(-WORKLOAD_DISPLAY_LIMIT).map((workload) => {
        const li = document.createElement('li');
        li.dataset.state = workload.state;
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = workload.state;
        const label = document.createElement('span');
        label.textContent = `${WORKLOAD_PRESETS[workload.shape].label} #${workload.id} `;
        const why = document.createElement('span');
        why.className = 'why';
        why.textContent = workload.reason;
        li.append(tag, label, why);
        return li;
      })
    );
  }

  private renderEvents(): void {
    const host = this.querySelector<HTMLElement>('[data-events]');
    if (!host) return;
    host.replaceChildren(
      ...this.lab.events.slice(0, EVENT_DISPLAY_LIMIT).map((message) => {
        const li = document.createElement('li');
        li.textContent = message;
        return li;
      })
    );
  }

  private renderCompare(): void {
    const body = this.querySelector<HTMLTableSectionElement>('[data-compare] tbody');
    const note = this.querySelector<HTMLElement>('[data-compare-note]');
    if (!body) return;

    const shapes = this.lab.workloads
      .filter((workload) => !workload.seeded)
      .map((workload) => workload.shape);

    if (shapes.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = COMPARE_COLUMN_COUNT;
      cell.className = 'empty';
      cell.textContent = 'Submit some work to compare the strategies.';
      row.append(cell);
      body.replaceChildren(row);
      if (note) note.textContent = '';
      return;
    }

    const seedFleet = defaultSeedFleet(this.regions);
    const stockedOut = [...this.stockedOut].filter((region) => this.regions.includes(region));
    const outcomes = STRATEGIES.map((strategy) =>
      simulate(this.catalog, this.regions, strategy, shapes, {
        policy: this.policy,
        seedFleet,
        stockedOut,
      })
    );

    body.replaceChildren(
      ...outcomes.map((outcome) => {
        const row = document.createElement('tr');
        row.dataset.current = String(outcome.strategy === this.strategy);
        const cells = [
          outcome.strategy,
          HOST_ORDERING[outcome.strategy],
          `${outcome.provisioned}`,
          formatPrice(this.catalog, outcome.monthlyCents),
          outcome.distribution.join(' · ') || '—',
          outcome.regions.join(', ') || '—',
          `${outcome.rejected}`,
        ];
        for (const text of cells) {
          const cell = document.createElement('td');
          cell.textContent = text;
          row.append(cell);
        }
        return row;
      })
    );

    if (note) {
      const distinct = new Set(outcomes.map((outcome) => outcome.placement.join(' '))).size;
      note.textContent =
        distinct === 1
          ? 'Every strategy placed this work identically. That happens when the fleet is homogeneous or the workloads are small enough that any host will do — the strategy only matters when the choice is real.'
          : `${distinct} of ${outcomes.length} strategies produced a different placement for this work.`;
    }
  }
}

if (!customElements.get('placement-explorer')) {
  customElements.define('placement-explorer', PlacementExplorer);
}

export { PLAY_MS, LAB };
