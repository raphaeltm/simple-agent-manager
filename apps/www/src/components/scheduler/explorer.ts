import { createLab, KINDS, LAB, record, SCENARIOS, sleepIdle, step, submit } from './model';
import type { Kind, Scenario } from './model';

class SchedulerExplorer extends HTMLElement {
  private lab = createLab();
  private timer: ReturnType<typeof setInterval> | undefined;
  private initialized = false;

  connectedCallback(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.querySelectorAll<HTMLElement>('.lab-controls').forEach((el) => {
      el.hidden = false;
    });
    this.addEventListener('click', this.onClick);
    this.addEventListener('change', this.onChange);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.render();
  }

  disconnectedCallback(): void {
    this.pause();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.removeEventListener('click', this.onClick);
    this.removeEventListener('change', this.onChange);
    this.initialized = false;
  }

  private element<T extends Element = HTMLElement>(selector: string): T {
    const element = this.querySelector<T>(selector);
    if (!element) throw new Error(`Scheduler lab element missing: ${selector}`);
    return element;
  }

  private onVisibility = (): void => {
    if (document.hidden) {
      this.pause();
      this.render();
    }
  };
  private onChange = (): void => {
    this.lab.providerAvailable = this.element<HTMLInputElement>('[data-provider]').checked;
    this.lab.maxNodes = Number(this.element<HTMLSelectElement>('[data-limit]').value);
    record(this.lab, 'Conditions updated. Step to recheck placement; existing nodes keep running.');
    this.render();
  };
  private onClick = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>('button');
    if (!button || button.disabled) return;
    const scenario = button.dataset.scenario;
    const kind = button.dataset.kind;
    if (scenario && Object.hasOwn(SCENARIOS, scenario)) {
      this.pause();
      this.lab = createLab(scenario as Scenario);
    } else if (kind && Object.hasOwn(KINDS, kind)) submit(this.lab, kind as Kind);
    else {
      switch (button.dataset.action) {
        case 'burst':
          for (const kind of Object.keys(KINDS) as Kind[]) submit(this.lab, kind);
          break;
        case 'step':
          this.pause();
          step(this.lab);
          break;
        case 'reset':
          this.pause();
          this.lab = createLab(this.lab.scenario);
          break;
        case 'sleep':
          sleepIdle(this.lab);
          break;
        case 'play':
          if (this.timer) this.pause();
          else
            this.timer = setInterval(() => {
              step(this.lab);
              if (
                !this.lab.tasks.some(
                  (t) => t.state === 'queued' || (t.state === 'running' && t.remaining > 0)
                )
              )
                this.pause();
              this.render();
            }, LAB.playMs);
          break;
      }
    }
    this.render();
  };
  private pause(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  private renderNodes(): void {
    const cards = this.element('[data-nodes]');
    cards.replaceChildren();
    for (const node of this.lab.nodes) {
      const occupied = this.lab.tasks.filter(
        (t) => t.state === 'running' && t.node === node.id
      ).length;
      const status =
        node.state === 'absent'
          ? 'not provisioned'
          : node.state === 'booting'
            ? `booting · ${node.boot} steps`
            : `${node.state} · ${occupied}/${LAB.slotsPerNode} slots`;
      const rack = this.element(`[data-rack='${node.id}']`);
      rack.setAttribute('data-state', node.state);
      this.element(`[data-rack='${node.id}'] [data-rack-status]`).textContent = status;
      const card = document.createElement('div');
      card.className = 'node-card';
      const title = document.createElement('strong');
      title.textContent = `VM 0${node.id} · ${node.size}`;
      const slots = document.createElement('div');
      slots.className = 'slots';
      slots.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < LAB.slotsPerNode; i++) {
        const slot = document.createElement('span');
        slot.className = `slot${i < occupied ? ' filled' : ''}`;
        slots.append(slot);
      }
      const caption = document.createElement('small');
      caption.textContent = status;
      card.append(title, slots, caption);
      cards.append(card);
    }
    const instant = document.createElement('div');
    instant.className = 'node-card instant-card';
    const title = document.createElement('strong');
    title.textContent = 'ϟ Cloudflare';
    const caption = document.createElement('small');
    caption.textContent = `${this.lab.tasks.filter((t) => t.kind === 'instant' && t.state === 'running').length} running · separate runtime`;
    instant.append(title, caption);
    cards.append(instant);
  }
  private renderTasks(): void {
    const list = this.element('[data-tasks]');
    const scrollTop = list.scrollTop;
    list.replaceChildren();
    if (!this.lab.tasks.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Your fleet is ready. Send some work.';
      list.append(empty);
    }
    for (const task of this.lab.tasks) {
      const row = document.createElement('div');
      row.className = 'task';
      row.dataset.status = task.state;
      const head = document.createElement('div');
      head.className = 'task-head';
      const name = document.createElement('span');
      name.textContent = `${KINDS[task.kind].glyph} ${KINDS[task.kind].label} #${task.id}`;
      const status = document.createElement('span');
      status.className = 'task-status';
      status.textContent = task.state === 'running' && task.remaining === 0 ? 'idle' : task.state;
      const detail = document.createElement('small');
      detail.textContent =
        task.reason +
        (task.state === 'queued' && task.waited
          ? ` · ${LAB.waitSteps - task.waited} wait steps left`
          : '');
      head.append(name, status);
      row.append(head, detail);
      list.append(row);
    }
    list.scrollTop = scrollTop;
  }
  private render(): void {
    const lab = this.lab;
    this.dataset.playing = String(Boolean(this.timer));
    this.element('[data-title]').textContent = SCENARIOS[lab.scenario].title;
    this.element('[data-hint]').textContent = SCENARIOS[lab.scenario].hint;
    this.element('[data-clock]').textContent = `STEP ${String(lab.tick).padStart(2, '0')}`;
    this.element<HTMLInputElement>('[data-provider]').checked = lab.providerAvailable;
    this.element<HTMLSelectElement>('[data-limit]').value = String(lab.maxNodes);
    this.querySelectorAll<HTMLButtonElement>('[data-scenario]').forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset.scenario === lab.scenario))
    );
    this.element('[data-action="play"]').textContent = this.timer ? 'Pause' : 'Play';
    this.element('[data-action="play"]').setAttribute('aria-pressed', String(Boolean(this.timer)));
    this.element<HTMLButtonElement>('[data-action="sleep"]').disabled = !lab.tasks.some(
      (t) => t.kind === 'chat' && t.state === 'running' && t.remaining === 0
    );
    this.querySelectorAll<HTMLButtonElement>('[data-kind], [data-action="burst"]').forEach(
      (button) => {
        button.disabled = lab.tasks.length >= LAB.maxTasks;
      }
    );
    this.element('[data-count]').textContent = `${lab.tasks.length}/${LAB.maxTasks} accepted`;
    this.element('[data-summary]').textContent = lab.events[0] ?? '';
    const events = this.element('[data-events]');
    events.replaceChildren();
    for (const message of lab.events.slice(1)) {
      const li = document.createElement('li');
      li.textContent = message;
      events.append(li);
    }
    this.renderNodes();
    this.renderTasks();
  }
}
if (!customElements.get('scheduler-explorer'))
  customElements.define('scheduler-explorer', SchedulerExplorer);
