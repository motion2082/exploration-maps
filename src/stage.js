/* Garden: a note's growth stage (🌱 seedling, 🌿 plant, 🌲 evergreen), worked out from rules you can measure,
   and compared with the stage tag the note actually has. Pure functions, so they run the same in tests. */

export const STAGES = ["🌱", "🌿", "🌲"];
export const STAGE_NAMES = ["Seedling", "Plant", "Evergreen"];

export const GARDEN_DEFAULTS = {
  folders: ["02 Cards"],   // the notes that get a stage
  plantWords: 200, plantHeadings: 1, plantLinks: 1,
  evergreenWords: 500, evergreenHeadings: 2, evergreenOut: 3, evergreenIn: 1,
};
export const gardenSettings = s => Object.assign({}, GARDEN_DEFAULTS, (s && s.garden) || {});

/** What each stage asks of a note. m: {words, headings (H2 and below), out, in}. */
export function checks(m, G) {
  return [
    [],
    [
      { label: "words", have: m.words, need: G.plantWords },
      { label: "headings", have: m.headings, need: G.plantHeadings },
      { label: "links", have: m.out + m.in, need: G.plantLinks },
    ],
    [
      { label: "words", have: m.words, need: G.evergreenWords },
      { label: "headings", have: m.headings, need: G.evergreenHeadings },
      { label: "links out", have: m.out, need: G.evergreenOut },
      { label: "links in", have: m.in, need: G.evergreenIn },
    ],
  ].map(l => l.map(c => ({ ...c, ok: c.have >= c.need })));
}

/** The stage the rules give: the highest whose checks all pass (and every stage below it). */
export function suggest(m, G) {
  const C = checks(m, G); let s = 0;
  for (let i = 1; i < C.length; i++) { if (C[i].every(c => c.ok)) s = i; else break; }
  return s;
}

/** The stages a note is tagged with, from its tags (#🌱, 🌿, "#🌲️"…). Returns indexes into STAGES. */
export function taggedStages(tags) {
  const out = new Set();
  for (const t of tags || []) { const v = String(t).replace(/^#/, "").replace(/️/g, "").trim(); const i = STAGES.indexOf(v); if (i >= 0) out.add(i); }
  return [...out].sort();
}

/** How a note's tag compares with its rules: untagged, mixed (two stage tags), grow (ready for the next), ahead (tagged above the rules) or ok. */
export function status(tagged, sug) {
  if (!tagged.length) return "untagged";
  if (tagged.length > 1) return "mixed";
  return sug > tagged[0] ? "grow" : sug < tagged[0] ? "ahead" : "ok";
}

const STAGE_TOKEN = "(?:🌱|🌿|🌲)\\uFE0F?";
/** Swap a note's stage tag for another, in its text. Frontmatter list items (- "#🌱", - 🌿), inline tag lists, and #🌱 in the body.
    Keeps the way each tag was written (quotes, #). Returns null when the note has no stage tag to swap (add one with addStageTag). */
export function replaceStage(text, stage) {
  let fmEnd = -1;
  if (text.startsWith("---")) { const e = text.indexOf("\n---", 3); if (e > 0) fmEnd = e; }
  let found = false;
  let fm = fmEnd > 0 ? text.slice(0, fmEnd) : "", body = fmEnd > 0 ? text.slice(fmEnd) : text;
  if (fm) {
    // list items: the first becomes the new stage, any others go (a note had two stage tags)
    let kept = false;
    fm = fm.replace(new RegExp(`^(\\s*-\\s*["']?)(#?)${STAGE_TOKEN}(["']?[ \\t]*)$\\n?`, "gmu"), (all, a, h, b) => {
      found = true; if (kept) return ""; kept = true; return `${a}${h}${stage}${b}${all.endsWith("\n") ? "\n" : ""}`; });
    // inline: tags: [a, "#🌱"] or tags: a, #🌱
    fm = fm.replace(/^(tags?\s*:[ \t]*)(\S.*)$/gimu, (all, k, v) => {
      const nv = v.replace(new RegExp(`(^|[\\s,\\["'])(#?)${STAGE_TOKEN}(?=$|[\\s,\\]"'])`, "gu"), (m, p, h) => { found = true; return `${p}${h}${stage}`; });
      return k + nv; });
  }
  body = body.replace(new RegExp(`(^|[\\s(,])#${STAGE_TOKEN}(?=$|[\\s,).#])`, "gmu"), (m, p) => { found = true; return `${p}#${stage}`; });
  return found ? fm + body : null;
}
