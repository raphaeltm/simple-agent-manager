/**
 * jump-probe — paste-into-DevTools diagnostic for the project-chat scroll jump.
 *
 * HOW TO USE (desktop Chrome):
 *   1. Open the LIVE chat session that jumps (app.simple-agent-manager.org).
 *   2. Open DevTools → Console.
 *   3. Paste this whole file, hit Enter. You'll see "[jumpProbe] installed".
 *   4. Scroll around and/or just let it sit for ~30s while it's jumpy.
 *   5. Run:  __jumpProbe.report()
 *   6. When done:  __jumpProbe.stop()
 *
 * It is READ-ONLY (observers only) and correlates each visible jump with:
 *   - the DOM nodes that actually shifted (Layout Instability API + Δy)
 *   - whether rows were added/removed vs. re-laid-out (MutationObserver)
 *   - whether the jump happened while STATIONARY (a timer/re-render reflow) or
 *     while SCROLLING (virtualizer remeasure / followOutput)
 */
(() => {
  if (window.__jumpProbe) {
    console.warn('[jumpProbe] already installed — call __jumpProbe.stop() first');
    return;
  }

  // ---- locate the scroll container + rows ------------------------------------
  const scroller =
    document.querySelector('[data-virtuoso-scroller="true"]') ||
    document.querySelector('[data-testid="virtuoso-scroller"]') ||
    (() => {
      let el = document.querySelector('.sam-message-entry, [data-index]');
      el = el && el.parentElement;
      while (el && el.scrollHeight <= el.clientHeight + 1) el = el.parentElement;
      return el;
    })();

  if (!scroller) {
    console.warn('[jumpProbe] could not find the chat scroll container');
    return;
  }

  const ROW_SEL = scroller.querySelector('[data-index]') ? '[data-index]' : '.sam-message-entry';
  const keyOf = (el) =>
    el.getAttribute('data-item-index') ?? el.getAttribute('data-index') ?? null;

  const snapshot = () => {
    const m = new Map();
    scroller.querySelectorAll(ROW_SEL).forEach((el) => {
      const k = keyOf(el);
      if (k != null) m.set(k, el.getBoundingClientRect().top);
    });
    return m;
  };

  // ---- rolling context buffers ----------------------------------------------
  const recentMutations = []; // { t, kind: 'rows'|'style', count }
  const recentShifts = []; // { t, value, hadRecentInput, nodes:[{label, dy}] }
  const events = []; // significant jumps
  const prune = (arr, ms) => {
    const now = performance.now();
    while (arr.length && now - arr[0].t > ms) arr.shift();
  };

  // ---- Layout Instability: WHAT shifted and by how much ----------------------
  let po = null;
  try {
    po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const nodes = (e.sources || []).map((s) => {
          const n = s.node;
          let label = '(gone)';
          if (n && n.nodeType === 1) {
            const k = n.getAttribute?.('data-index') ?? n.getAttribute?.('data-item-index');
            const cls = (n.className || '').toString().split(' ')[0];
            label = n.nodeName.toLowerCase() + (k != null ? `#${k}` : cls ? `.${cls}` : '');
          }
          const dy =
            s.currentRect && s.previousRect
              ? Math.round(s.currentRect.top - s.previousRect.top)
              : null;
          return { label, dy };
        });
        recentShifts.push({ t: performance.now(), value: e.value, hadRecentInput: e.hadRecentInput, nodes });
      }
      prune(recentShifts, 4000);
    });
    po.observe({ type: 'layout-shift', buffered: false });
  } catch (err) {
    console.warn('[jumpProbe] layout-shift API unavailable', err);
  }

  // ---- Mutations: rows added/removed vs. re-layout (style bursts) -------------
  const mo = new MutationObserver((list) => {
    let rows = 0;
    let style = 0;
    for (const m of list) {
      if (m.type === 'childList') rows += m.addedNodes.length + m.removedNodes.length;
      else if (m.type === 'attributes') style += 1;
    }
    const t = performance.now();
    if (rows) recentMutations.push({ t, kind: 'rows', count: rows });
    if (style) recentMutations.push({ t, kind: 'style', count: style });
    prune(recentMutations, 4000);
  });
  mo.observe(scroller, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });

  // ---- per-frame detector: STATIONARY involuntary jumps ----------------------
  // If scrollTop did NOT change between frames but a visible row's viewport
  // position DID, that movement is 100% involuntary (no scroll caused it).
  // This is the cleanest signal for "it jumps on its own" and cannot be fooled
  // by scrollbar compensation (which only happens while scrollTop changes).
  let running = true;
  let lastTop = scroller.scrollTop;
  let lastRows = snapshot();
  const STATIONARY_JUMP_PX = 2;

  const tick = () => {
    if (!running) return;
    const st = scroller.scrollTop;
    const scrolled = Math.abs(st - lastTop) > 0.5;
    if (!scrolled) {
      const cur = snapshot();
      let maxJump = 0;
      let jumpKey = null;
      let matched = 0;
      for (const [k, top] of cur) {
        const prev = lastRows.get(k);
        if (prev === undefined) continue;
        const d = Math.abs(top - prev);
        matched += 1;
        if (d > maxJump) {
          maxJump = d;
          jumpKey = k;
        }
      }
      if (matched > 0 && maxJump >= STATIONARY_JUMP_PX) {
        const muts = recentMutations.filter((m) => performance.now() - m.t < 250);
        const shifts = recentShifts.filter((s) => performance.now() - s.t < 250);
        const ev = {
          t: new Date().toLocaleTimeString(),
          when: 'STATIONARY',
          jumpPx: +maxJump.toFixed(1),
          row: jumpKey,
          cause: muts.map((m) => `${m.kind}×${m.count}`).join(',') || '(no mutation?)',
          shiftNodes: shifts.flatMap((s) => s.nodes.map((n) => `${n.label} Δy=${n.dy}`)).slice(0, 4),
        };
        events.push(ev);
        console.log('%c[jump·stationary]', 'color:#e11;font-weight:bold', ev);
      }
      lastRows = cur;
    } else {
      lastRows = snapshot();
    }
    lastTop = st;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // ---- public API ------------------------------------------------------------
  window.__jumpProbe = {
    events,
    scroller,
    stop() {
      running = false;
      mo.disconnect();
      po && po.disconnect();
      console.log('[jumpProbe] stopped.', events.length, 'stationary jumps captured.');
    },
    report() {
      console.log('%c===== jumpProbe report =====', 'color:#09f;font-weight:bold');
      console.log('Row selector:', ROW_SEL, '· scroller:', this.scroller);
      console.log(`Stationary jumps captured: ${events.length}`);
      if (events.length) console.table(events.slice(-50));

      // Biggest layout shifts seen (works for scroll-driven jumps too).
      const shifts = recentShifts
        .slice()
        .sort((a, b) => b.value - a.value)
        .slice(0, 15)
        .map((s) => ({
          value: +s.value.toFixed(4),
          hadRecentInput: s.hadRecentInput,
          nodes: s.nodes.map((n) => `${n.label} Δy=${n.dy}`).slice(0, 4).join(' | '),
        }));
      console.log('%cBiggest recent layout shifts (what moved):', 'font-weight:bold');
      if (shifts.length) console.table(shifts);

      // Which cause dominates?
      const byCause = {};
      for (const ev of events) {
        const c = ev.cause.replace(/×\d+/g, '');
        byCause[c] = (byCause[c] || 0) + 1;
      }
      console.log('%cStationary jumps by correlated mutation:', 'font-weight:bold', byCause);
      console.log(
        'Tip: "rows" = messages added/removed · "style" = virtualizer re-layout/remeasure · ' +
          '"(no mutation?)" = reflow with no DOM change. A ~1s cadence of style bursts while ' +
          'stationary points at a timer re-render (e.g. the idle countdown).',
      );
      return { events, shifts, byCause };
    },
  };

  console.log(
    '%c[jumpProbe] installed. Scroll / let it sit until it jumps, then run __jumpProbe.report(). Stop with __jumpProbe.stop().',
    'color:#0a0;font-weight:bold',
  );
})();
