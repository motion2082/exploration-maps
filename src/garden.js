/* Garden: a companion panel for the 🌱 → 🌿 → 🌲 growth stages.
   Works out each note's stage from rules (words, headings, links), compares it with the note's stage tag,
   and lists what needs attention, with a one-click retag. Reads Obsidian's metadata cache, so it stays live as you write.
   Retagging is the only thing here that changes a note, and only when you click. */
import { ItemView, Modal, Notice, Setting, getAllTags } from "obsidian";
import { STAGES, STAGE_NAMES, checks, gardenSettings, replaceStage, status, suggest, taggedStages } from "./stage.js";
import { dateKeys, isDateNote, parseDay } from "./scan.js";
import { openBeside } from "./view.js";

export const GARDEN_VIEW = "ideaverse-garden";

const WORD = /[\p{L}\p{N}_]+/gu, FENCE = /```[\s\S]*?```/g;
const DAY = 864e5;
const RANGES = [["3m", 91], ["6m", 182], ["1y", 365], ["All", 0]];
const TABS = [
  ["grow", "Ready to grow", "The rules say these have outgrown their tag."],
  ["untagged", "Untagged", "No stage tag yet."],
  ["unlinked", "Unlinked", "No links in or out."],
  ["ahead", "Above the rules", "Tagged higher than the rules give. Often on purpose: retag only if it's a slip."],
];
const under = (p, dirs) => dirs.some(d => d && (p === d || p.startsWith(d + "/")));
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;

export class GardenView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf); this.plugin = plugin;
    this.notes = []; this.byPath = new Map(); this.words = new Map();   // words: path → [mtime, count], so only changed notes are read again
    this.tab = plugin.store.get("garden-tab") || "grow";
    this.range = plugin.store.get("garden-range") || "6m";
    this.sel = null; this.busy = false;
    this.tlOpen = plugin.store.get("garden-tl-open") !== false;   // the timeline can be folded away
    this.tlH = plugin.store.get("garden-tl-h") || 0;                 // its height, once you've dragged it (0: the default)
    this.only = null;                                                // a stage picked in the counts: the timeline shows just that band
  }
  getViewType() { return GARDEN_VIEW; }
  getDisplayText() { return "Garden"; }
  getIcon() { return "sprout"; }

  async onOpen() {
    this.contentEl.addClass("ivg");
    const soon = () => { window.clearTimeout(this.timer); this.timer = window.setTimeout(() => { void this.refresh(); }, 700); };
    this.registerEvent(this.app.metadataCache.on("resolved", soon));
    this.registerEvent(this.app.vault.on("delete", soon));
    this.registerEvent(this.app.vault.on("rename", soon));
    this.registerEvent(this.app.workspace.on("file-open", () => this.renderCurrent()));
    this.ro = new ResizeObserver(() => this.renderTimeline());
    await this.refresh();
  }
  async onClose() { window.clearTimeout(this.timer); if (this.ro) this.ro.disconnect(); }

  /** Measure every note in the Garden's folders. */
  async refresh() {
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    try {
      const app = this.app, mc = app.metadataCache, s = this.plugin.settings, G = this.G = gardenSettings(s);
      const files = app.vault.getMarkdownFiles().filter(f => under(f.path, G.folders) && !(f.parent && f.basename === f.parent.name));   // folder notes (named after their folder) aren't ideas
      const keys = new Set([...(s.upProps || ["up"]), ...(s.relatedProps || ["related"])].map(k => String(k).toLowerCase()));
      const dkeys = ["date-added", "created", ...dateKeys(s)].map(k => k.toLowerCase());
      // links in: every note in the vault that links here (any link Obsidian resolved)
      // (date notes don't count, in or out, unless Settings → Leave out date notes is off)
      const skipDates = s.skipDateNotes !== false, dated = path => skipDates && isDateNote(path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, ""));
      const inn = new Map();
      for (const [src, targets] of Object.entries(mc.resolvedLinks)) { if (dated(src)) continue; for (const t of Object.keys(targets)) if (t !== src) (inn.get(t) || inn.set(t, new Set()).get(t)).add(src); }
      const notes = [];
      for (const f of files) {
        const c = mc.getFileCache(f) || {};
        // links out: links in the text, plus the up and related properties (not date properties like Week or Year)
        const out = new Set();
        const add = l => { const d = mc.getFirstLinkpathDest(l.link.replace(/[#|].*$/, ""), f.path); if (d && d.path !== f.path && d.extension === "md" && !dated(d.path)) out.add(d.path); };
        for (const l of c.links || []) add(l);
        for (const l of c.frontmatterLinks || []) if (keys.has(String(l.key).split(".")[0].toLowerCase())) add(l);
        const m = { words: await this.wordCount(f, c), headings: (c.headings || []).filter(h => h.level >= 2).length, out: out.size, in: (inn.get(f.path) || new Set()).size };
        const tagged = taggedStages(getAllTags(c) || []), sug = suggest(m, G);
        let date = "";
        if (c.frontmatter) { const fm = {}; for (const k of Object.keys(c.frontmatter)) fm[k.toLowerCase()] = c.frontmatter[k]; for (const k of dkeys) { const v = fm[k]; date = parseDay(Array.isArray(v) ? v[0] : v); if (date) break; } }
        const t = date ? Date.parse(date) : f.stat.ctime;
        notes.push({ file: f, path: f.path, title: f.basename, m, tagged, cur: tagged.length ? Math.max(...tagged) : -1, sug, st: status(tagged, sug), t });
      }
      this.notes = notes; this.byPath = new Map(notes.map(n => [n.path, n]));
      for (const p of this.words.keys()) if (!this.byPath.has(p)) this.words.delete(p);
      this.render();
    } finally {
      this.busy = false;
      if (this.again) { this.again = false; void this.refresh(); }
    }
  }

  async wordCount(f, c) {
    const w = this.words.get(f.path); if (w && w[0] === f.stat.mtime) return w[1];
    let t = await this.app.vault.cachedRead(f);
    const end = c.frontmatterPosition ? c.frontmatterPosition.end.offset : 0; t = t.slice(end).replace(FENCE, "");
    const n = (t.match(WORD) || []).length; this.words.set(f.path, [f.stat.mtime, n]); return n;
  }

  openNote(path) { openBeside(this.app, this.leaf, null, path, true); }

  async retag(n, stage) {
    const f = n.file, txt = await this.app.vault.read(f);
    if (replaceStage(txt, STAGES[stage]) != null) await this.app.vault.process(f, t => replaceStage(t, STAGES[stage]) ?? t);
    else await this.app.fileManager.processFrontMatter(f, fm => {
      const k = Object.keys(fm).find(x => /^tags?$/i.test(x)) || "tags"; let v = fm[k];
      v = Array.isArray(v) ? v : v ? String(v).split(/[,\s]+/).filter(Boolean) : [];
      v.push(`#${STAGES[stage]}`); fm[k] = v; });
  }

  // ---------- drawing ----------
  render() {
    const el = this.contentEl, keep = el.scrollTop; el.empty(); this.ro.disconnect();
    window.requestAnimationFrame(() => { el.scrollTop = keep; });   // a refresh while you write doesn't jump the panel
    const N = this.notes, G = this.G;
    const head = el.createDiv({ cls: "ivg-head" });
    head.createDiv({ cls: "ivg-title", text: "Garden" });
    const rb = head.createEl("button", { cls: "clickable-icon ivg-icon", attr: { "aria-label": "Refresh" }, text: "↻" }); rb.onclick = () => { void this.refresh(); };
    el.createDiv({ cls: "ivg-sub", text: `${G.folders.join(", ") || "No folders set"} · ${plural(N.length, "note")}` });
    if (!N.length) { el.createDiv({ cls: "ivg-empty", text: "No notes in the Garden's folders. Pick them in Settings → Exploration Maps → Garden." }); return; }

    // the counts double as a filter: click one to see only that stage on the timeline, click it again to see them all
    const counts = el.createDiv({ cls: "ivg-counts" }), chips = [];
    const chip = (i, cls, text, name) => { const b = counts.createEl("button", { cls: `ivg-count ${cls}${this.only === i ? " is-on" : ""}`, text, attr: { "aria-label": `Show only ${name} on the timeline` } });
      chips.push([i, b]); b.onclick = () => { this.only = this.only === i ? null : i; for (const [j, c] of chips) c.toggleClass("is-on", j === this.only);
        if (!this.tlOpen) this.setTlOpen(true); else this.renderTimeline(); }; };
    STAGES.forEach((s, i) => chip(i, `ivg-s${i}`, `${s} ${N.filter(n => n.cur === i).length}`, STAGE_NAMES[i].toLowerCase() + "s"));
    chip(-1, "ivg-none", `untagged ${N.filter(n => n.cur < 0).length}`, "untagged notes");

    this.curEl = el.createDiv({ cls: "ivg-current" }); this.renderCurrent();

    const tl = el.createDiv({ cls: "ivg-section" });
    const th = tl.createDiv({ cls: "ivg-sh" });
    this.foldEl = th.createEl("a", { cls: "ivg-fold", attr: { "aria-label": "Show or hide the timeline" } }); this.foldEl.onclick = () => this.setTlOpen(!this.tlOpen);
    const rg = this.rgEl = th.createDiv({ cls: "ivg-seg" });
    for (const [k] of RANGES) { const b = rg.createEl("button", { text: k, cls: k === this.range ? "is-on" : "" }); b.onclick = () => { this.range = k; this.win = null; this.plugin.store.set("garden-range", k); rg.querySelectorAll("button").forEach(x => x.toggleClass("is-on", x === b)); this.renderTimeline(); }; }
    const body = this.tlBody = tl.createDiv({ cls: "ivg-tl-body" });
    this.tlEl = body.createDiv({ cls: "ivg-tl" }); this.zoomable(this.tlEl);
    this.growable(body.createDiv({ cls: "ivg-grip", attr: { "aria-label": "Drag to resize · double-click for the default height" } }));
    this.tipEl = body.createDiv({ cls: "ivg-tip" }); this.tipEl.hide();
    this.selEl = body.createDiv({ cls: "ivg-selected" });
    this.ro.observe(this.tlEl); this.setTlOpen(this.tlOpen); this.renderSelected();

    this.listEl = el.createDiv({ cls: "ivg-section" }); this.renderList();
  }

  /** Fold the timeline away or bring it back (remembered). */
  setTlOpen(open) {
    this.tlOpen = open; this.plugin.store.set("garden-tl-open", open);
    this.tlBody.toggle(open); this.rgEl.toggle(open); this.foldLabel();
    if (open) this.renderTimeline();
  }
  foldLabel() { if (this.foldEl) this.foldEl.setText(`${this.tlOpen ? "▾" : "▸"} Timeline${this.only == null ? "" : this.only < 0 ? " · untagged only" : ` · ${STAGES[this.only]} only`}`); }

  /** Drag the grip under the timeline to make it taller or shorter; double-click it for the default height. */
  growable(grip) {
    let drag = null;
    grip.addEventListener("pointerdown", e => { if (e.button !== 0) return; e.preventDefault(); grip.setPointerCapture(e.pointerId);
      drag = { y: e.clientY, h: this.tlH || this.tlDefault() }; grip.addClass("is-dragging"); });
    grip.addEventListener("pointermove", e => { if (!drag) return;
      this.tlH = Math.round(Math.min(1400, Math.max(120, drag.h + e.clientY - drag.y)));
      if (!this.raf) this.raf = window.requestAnimationFrame(() => { this.raf = 0; this.renderTimeline(); }); });
    const end = () => { if (!drag) return; drag = null; grip.removeClass("is-dragging"); this.plugin.store.set("garden-tl-h", this.tlH); };
    grip.addEventListener("pointerup", end); grip.addEventListener("pointercancel", end);
    grip.addEventListener("dblclick", () => { this.tlH = 0; this.plugin.store.set("garden-tl-h", 0); this.renderTimeline(); });
  }
  tlDefault() { return this.tlEl && this.tlEl.clientWidth > 700 ? 420 : 300; }

  /** The note you're on, if it's in the Garden. */
  renderCurrent() {
    if (!this.curEl) return; this.curEl.empty();
    const f = this.app.workspace.getActiveFile(), n = f && this.byPath.get(f.path);
    if (!n) return;
    this.curEl.createDiv({ cls: "ivg-sh", text: "This note" });
    this.card(this.curEl, n);
  }

  renderSelected() { if (!this.selEl) return; this.selEl.empty(); const n = this.sel && this.byPath.get(this.sel); if (n) this.card(this.selEl, n); }

  /** One note: its stage, what the rules say, the checks for the next stage, and a retag button when they differ. */
  card(parent, n) {
    const c = parent.createDiv({ cls: `ivg-card ivg-st-${n.st}` });
    const top = c.createDiv({ cls: "ivg-card-top" });
    const a = top.createEl("a", { cls: "ivg-name", text: n.title, attr: { "aria-label": "Open in a new tab" } }); a.onclick = () => this.openNote(n.path);
    top.createSpan({ cls: "ivg-tag", text: n.cur >= 0 ? STAGES[n.cur] : "–" });
    c.createDiv({ cls: "ivg-verdict", text: this.verdict(n) });
    const C = checks(n.m, this.G), next = Math.min(2, Math.max(n.sug, n.cur) + 1);
    const showStage = n.st === "ahead" ? n.cur : n.st === "ok" ? next : n.sug;   // ahead: what its tag asks for; ok: the next stage; otherwise: the stage the rules give
    if (showStage > 0 && !(n.st === "ok" && n.cur === 2)) {
      const ul = c.createDiv({ cls: "ivg-checks" });
      ul.createDiv({ cls: "ivg-checks-h", text: `${STAGES[showStage]} ${STAGE_NAMES[showStage]} needs` });
      for (const k of C[showStage]) ul.createDiv({ cls: k.ok ? "ivg-ok" : "ivg-no", text: `${k.ok ? "✓" : "✗"} ${k.have.toLocaleString()} / ${k.need.toLocaleString()} ${k.label}` });
    }
    if (n.st !== "ok") this.retagBtn(c, n, n.sug);
  }

  verdict(n) {
    const s = i => `${STAGES[i]} ${STAGE_NAMES[i].toLowerCase()}`;
    return n.st === "untagged" ? `No stage tag. The rules say ${s(n.sug)}.`
      : n.st === "mixed" ? `Tagged ${n.tagged.map(i => STAGES[i]).join(" and ")}. The rules say ${s(n.sug)}.`
      : n.st === "grow" ? `Ready to grow: tagged ${STAGES[n.cur]}, the rules say ${s(n.sug)}.`
      : n.st === "ahead" ? `Tagged ${STAGES[n.cur]}, the rules say ${s(n.sug)}.`
      : `${s(n.cur)}, as the rules say.`;
  }

  retagBtn(parent, n, stage) {
    const b = parent.createEl("button", { cls: "ivg-retag", text: `Retag ${STAGES[stage]}`, attr: { "aria-label": `Set this note's stage tag to ${STAGES[stage]} ${STAGE_NAMES[stage]}` } });
    b.onclick = async e => { e.stopPropagation(); b.disabled = true;
      try { await this.retag(n, stage); new Notice(`${n.title}: ${STAGES[stage]}`); }
      catch (err) { console.error("Garden: retag failed", err); new Notice(`Couldn't retag ${n.title}`); b.disabled = false; } };
  }

  /** The time window the range buttons give (3 months, 6 months, a year, or everything). */
  baseWindow() {
    const days = (RANGES.find(r => r[0] === this.range) || RANGES[1])[1], now = Date.now();
    return [days ? now - days * DAY : Math.min(...this.notes.map(n => n.t), now - DAY), now];
  }

  /** Scroll to zoom (around the pointer), drag to pan, double-click to go back to the range. Set up once per render. */
  zoomable(box) {
    const plot = () => this.plotLR || [26, Math.max(200, box.clientWidth) - 8];   // the plot's left and right edges, from the last renderTimeline
    const lim = () => [Math.min(...this.notes.map(n => n.t), Date.now()) - 30 * DAY, Date.now() + 7 * DAY];
    const set = (a, b) => { const [lo, hi] = lim(), span = Math.min(b - a, hi - lo);
      if (a < lo) { a = lo; b = a + span; } if (b > hi) { b = hi; a = b - span; } this.win = [a, b];
      if (!this.raf) this.raf = window.requestAnimationFrame(() => { this.raf = 0; this.renderTimeline(); }); };
    box.addEventListener("wheel", e => { e.preventDefault();
      const [t0, t1] = this.win || this.baseWindow(), [L, R] = plot(), f = Math.exp(e.deltaY * (e.ctrlKey ? .01 : .0015));
      const at = t0 + (t1 - t0) * Math.min(1, Math.max(0, (e.offsetX - L) / (R - L))), span = Math.max(2 * DAY, (t1 - t0) * f);
      set(at - (at - t0) * span / (t1 - t0), at + (t1 - at) * span / (t1 - t0)); }, { passive: false });
    let drag = null;
    box.addEventListener("pointerdown", e => { if (e.button === 0) drag = { x: e.clientX, w: this.win || this.baseWindow(), moved: false }; });
    box.addEventListener("pointermove", e => { if (!drag) return; const dx = e.clientX - drag.x; if (Math.abs(dx) > 3) drag.moved = true; if (!drag.moved) return;
      const [L, R] = plot(), dt = -dx * (drag.w[1] - drag.w[0]) / (R - L); set(drag.w[0] + dt, drag.w[1] + dt); box.addClass("is-panning"); });
    const end = () => { if (drag && drag.moved) this.justPanned = true; drag = null; box.removeClass("is-panning"); window.setTimeout(() => { this.justPanned = false; }, 0); };
    box.addEventListener("pointerup", end); box.addEventListener("pointerleave", end);
    box.addEventListener("dblclick", () => { this.win = null; this.renderTimeline(); });
  }

  renderTimeline() {
    const box = this.tlEl; if (!box || !box.isConnected || !this.tlOpen) return; box.empty(); this.foldLabel();
    // bands: 🌲 at the top, then 🌿, 🌱, and untagged at the bottom (or just the one picked in the counts)
    const rows = [[2, "🌲", "Evergreen"], [1, "🌿", "Plant"], [0, "🌱", "Seedling"], [-1, "?", "Untagged"]].filter(([s]) => this.only == null || s === this.only);
    const W = Math.max(200, box.clientWidth), PAD = 20, H = this.tlH || this.tlDefault(), BAND = (H - PAD) / rows.length;
    const [t0, t1] = this.win || this.baseWindow();
    const N = this.notes.filter(n => n.t >= t0 && n.t <= t1 && (this.only == null || n.cur === this.only));
    const wide = W > 700, LEFT = wide ? 100 : 26; this.plotLR = [LEFT, W - 8];
    const x = t => LEFT + (W - LEFT - 8) * (t - t0) / Math.max(1, t1 - t0);
    const svg = box.createSvg("svg", { attr: { width: W, height: H, viewBox: `0 0 ${W} ${H}` } });
    rows.forEach(([s, em, name], r) => {
      svg.createSvg("rect", { cls: ["ivg-band", `ivg-band${2 - s}`], attr: { x: 0, y: r * BAND, width: W, height: BAND } });
      svg.createSvg("text", { cls: "ivg-band-l", attr: { x: 6, y: r * BAND + BAND / 2 + 5 } }).textContent = wide ? `${em} ${name}` : em; });
    // ticks: years, quarters, months, weeks or days, by how far you're zoomed in
    const span = (t1 - t0) / DAY;
    const unit = span > 1100 ? "y" : span > 400 ? "q" : span > 75 ? "m" : span > 18 ? "w" : "d";
    const d = new Date(t0); d.setHours(0, 0, 0, 0);
    if (unit === "y") d.setMonth(0, 1); else if (unit === "q") d.setMonth(d.getMonth() - d.getMonth() % 3, 1); else if (unit === "m") d.setDate(1); else if (unit === "w") d.setDate(d.getDate() - (d.getDay() + 6) % 7);
    const next = () => { if (unit === "y") d.setFullYear(d.getFullYear() + 1); else if (unit === "q") d.setMonth(d.getMonth() + 3); else if (unit === "m") d.setMonth(d.getMonth() + 1); else d.setDate(d.getDate() + (unit === "w" ? 7 : 1)); };
    const label = () => unit === "y" ? String(d.getFullYear())
      : unit === "q" || unit === "m" ? d.toLocaleString(undefined, { month: "short" }) + (d.getMonth() === 0 ? ` ${d.getFullYear()}` : "")
      : d.toLocaleString(undefined, { day: "numeric", month: "short" });
    for (; d.getTime() <= t1; next()) { if (d.getTime() < t0) continue;
      const X = x(d.getTime()); svg.createSvg("line", { cls: "ivg-tick", attr: { x1: X, x2: X, y1: 0, y2: BAND * rows.length } });
      svg.createSvg("text", { cls: "ivg-tick-l", attr: { x: X + 2, y: H - 6 } }).textContent = label(); }
    // names wherever they fit without covering another: the selected note first, then the ones that need attention, then the rest
    const pos = new Map(), section = this.tlEl.parentElement;
    const tip = (e, n) => { const r = section.getBoundingClientRect(); this.tipEl.setText(`${n.title} · ${this.verdict(n)}`); this.tipEl.show();
      this.tipEl.setCssProps({ left: `${Math.min(e.clientX - r.left + 12, r.width - this.tipEl.offsetWidth - 4)}px`, top: `${e.clientY - r.top + 14}px` }); };
    for (const n of N) {
      const r = rows.findIndex(([s]) => s === n.cur), h = hash(n.path);
      const cy = r * BAND + 6 + (h % 1000) / 1000 * (BAND - 12), cx = Math.min(W - 4, x(n.t));
      const dot = svg.createSvg("circle", { cls: ["ivg-dot", `ivg-dot-${n.st}`, ...(n.path === this.sel ? ["is-sel"] : [])], attr: { cx, cy, r: n.st === "ok" ? 3.5 : 4.5 } });
      pos.set(n, [cx, cy]);
      dot.addEventListener("mousemove", e => tip(e, n));
      dot.addEventListener("mouseleave", () => this.tipEl.hide());
      dot.addEventListener("click", () => { if (this.justPanned) return; this.sel = n.path; this.renderTimeline(); this.renderSelected(); });
    }
    const PRI = { grow: 1, mixed: 1, untagged: 2, ahead: 3, ok: 4 }, taken = [];
    const order = [...N].sort((a, b) => (a.path === this.sel ? -1 : b.path === this.sel ? 1 : 0) || PRI[a.st] - PRI[b.st] || b.t - a.t);
    for (const n of order.slice(0, 400)) {
      const [cx, cy] = pos.get(n), t = n.title.length > 30 ? n.title.slice(0, 29) + "…" : n.title, w = t.length * 6.2, bx = [cx + 7, cy - 7, w, 14];
      if (bx[0] + w > W || taken.some(q => bx[0] < q[0] + q[2] && bx[0] + w > q[0] && bx[1] < q[1] + q[3] && bx[1] + 14 > q[1])) continue;
      taken.push(bx); svg.createSvg("text", { cls: ["ivg-dot-l", `ivg-dot-l-${n.st}`], attr: { x: cx + 7, y: cy + 4 } }).textContent = t;
    }
    const leg = box.createDiv({ cls: "ivg-legend" });
    for (const [st, t] of [["ok", "matches"], ["grow", "ready to grow"], ["untagged", "untagged"], ["ahead", "above the rules"]]) { const s_ = leg.createSpan(); s_.createSpan({ cls: `ivg-key ivg-dot-${st}` }); s_.appendText(t); }
    leg.createSpan({ cls: "ivg-hint", text: this.win ? "Double-click to reset" : "Scroll to zoom · drag to pan" });
  }

  renderList() {
    const el = this.listEl; el.empty();
    const groups = { grow: [], untagged: [], unlinked: [], ahead: [] };
    for (const n of this.notes) {
      if (n.st === "grow" || n.st === "mixed") groups.grow.push(n);
      if (n.st === "untagged") groups.untagged.push(n);
      if (n.st === "ahead") groups.ahead.push(n);
      if (!n.m.out && !n.m.in) groups.unlinked.push(n);
    }
    el.createDiv({ cls: "ivg-sh", text: "Needs attention" });
    const tabs = el.createDiv({ cls: "ivg-tabs" });
    for (const [k, name] of TABS) { const b = tabs.createEl("button", { cls: k === this.tab ? "is-on" : "", text: `${name} ${groups[k].length}` });
      b.onclick = () => { this.tab = k; this.plugin.store.set("garden-tab", k); this.renderList(); }; }
    const [, , desc] = TABS.find(t => t[0] === this.tab);
    el.createDiv({ cls: "ivg-desc", text: desc });
    const L = groups[this.tab].sort((a, b) => b.t - a.t);
    if (!L.length) { el.createDiv({ cls: "ivg-empty", text: "Nothing here. 🌿" }); return; }
    const R = L.filter(n => n.st !== "ok");   // on every tab: the notes here whose tag differs from the rules (Unlinked can hold notes that already match)
    if (R.length) {
      const all = el.createEl("button", { cls: "ivg-all", text: `Retag all ${R.length} to what the rules say` });
      all.onclick = () => new ConfirmModal(this.app, `Retag ${plural(R.length, "note")}?`,
        `Each note's stage tag is set to the stage its rules give (${STAGES.map((s, i) => `${R.filter(n => n.sug === i).length} ${s}`).join(", ")}). This edits the notes' tags and nothing else.`
          + (this.tab === "ahead" ? " These are tagged higher than the rules give, so this moves them down." : ""),
        async () => { let ok = 0; for (const n of R) { try { await this.retag(n, n.sug); ok++; } catch (e) { console.error("Garden: retag failed", n.path, e); } } new Notice(`Retagged ${plural(ok, "note")}`); }).open();
    }
    const list = el.createDiv({ cls: "ivg-list" });
    for (const n of L.slice(0, 200)) {
      const row = list.createDiv({ cls: "ivg-row" });
      const main = row.createDiv({ cls: "ivg-row-main" });
      const a = main.createEl("a", { cls: "ivg-name", text: n.title, attr: { "aria-label": "Open in a new tab" } }); a.onclick = () => this.openNote(n.path);
      main.createDiv({ cls: "ivg-meta", text: `${n.cur >= 0 ? n.tagged.map(i => STAGES[i]).join("") : "–"} → ${STAGES[n.sug]} · ${n.m.words.toLocaleString()} words · ${n.m.headings} headings · ${n.m.out} out · ${n.m.in} in` });
      if (n.st !== "ok") this.retagBtn(row, n, n.sug);
    }
    if (L.length > 200) list.createDiv({ cls: "ivg-desc", text: `And ${(L.length - 200).toLocaleString()} more.` });
  }
}

class ConfirmModal extends Modal {
  constructor(app, title, body, go) { super(app); this.t = title; this.b = body; this.go = go; }
  onOpen() {
    this.setTitle(this.t); this.contentEl.createEl("p", { text: this.b });
    new Setting(this.contentEl)
      .addButton(b => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton(b => b.setButtonText("Retag").setCta().onClick(() => { this.close(); void this.go(); }));
  }
}

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
