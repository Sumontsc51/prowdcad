/**
 * Rule libraries (A7). A library owns its own size line; rules store incremental values keyed by
 * the library's size ids. Applying a rule materialises the increments into anchor.grade (mapped
 * to the piece's size line by size name) and records anchor.ruleId = rule.id.
 */
import type { Document } from '../model/doc';
import type { GradeInc, GradeRule, Id, RuleLibrary, SizeId, SizeLine, SizeTable } from '../model/types';
import { newId } from '../model/factory';
import { type GradeRec, findRef, refWorldAbs, incFromWorldAbs, deepClone, gi, piecesOfTable, gradedRefs } from './grading/util';
import { absoluteOffset } from '../model/contour';

const Z = (): GradeInc => ({ dx: 0, dy: 0 });

export function library(doc: Document, libraryId: Id): RuleLibrary {
  const l = doc.style.ruleLibraries.find(l => l.id === libraryId);
  if (!l) throw new Error('No rule library ' + libraryId);
  return l;
}

/** Create a rule library for a size line (copied; default = the active table's axis1). */
export function createLibrary(doc: Document, name: string, sizeLine?: SizeLine): Id {
  return doc.transact('New rule library', style => {
    const src = sizeLine ?? doc.sizeTable().axis1;
    const lib: RuleLibrary = { id: newId('rl'), name, sizeLine: deepClone(src), rules: [] };
    style.ruleLibraries.push(lib);
    return lib.id;
  });
}

function nextNumber(lib: RuleLibrary): number { return lib.rules.reduce((m, r) => Math.max(m, r.number), 0) + 1; }

/** Map an increment record between size lines by size id, else by size name (missing → 0). */
export function remapByName(rec: GradeRec, from: SizeLine, to: SizeLine): GradeRec {
  const out: GradeRec = {};
  for (const s of to.sizes) {
    const src = rec[s.id] ? s.id : from.sizes.find(f => f.name === s.name)?.id;
    out[s.id] = src && rec[src] ? { ...rec[src] } : Z();
  }
  if (to.sizes.length) out[to.sizes[0].id] = Z();
  return out;
}

/**
 * Create a rule from values. `values` keyed by library size id OR size name, incremental by default
 * (view:'absolute' converts from absolute offsets from the library base).
 */
export function createRuleFromValues(doc: Document, libraryId: Id, values: Record<string, GradeInc>, opt: { name?: string; number?: number; view?: 'incremental' | 'absolute'; description?: string } = {}): GradeRule {
  return doc.transact('New rule', () => {
    const lib = library(doc, libraryId);
    const line = lib.sizeLine;
    const keyed: GradeRec = {};
    for (const [k, v] of Object.entries(values)) {
      const id = line.sizes.find(s => s.id === k)?.id ?? line.sizes.find(s => s.name === k)?.id;
      if (!id) throw new Error('Rule value for unknown size ' + k);
      keyed[id] = { dx: v.dx, dy: v.dy };
    }
    let inc: GradeRec;
    if (opt.view === 'absolute') {
      const w: Record<SizeId, { x: number; y: number }> = {};
      for (const s of line.sizes) w[s.id] = { x: gi(keyed, s.id).dx, y: gi(keyed, s.id).dy };
      inc = incFromWorldAbs(w, line);
    } else { inc = {}; for (const s of line.sizes) inc[s.id] = { ...gi(keyed, s.id) }; inc[line.sizes[0].id] = Z(); }
    const number = opt.number ?? nextNumber(lib);
    if (lib.rules.some(r => r.number === number)) throw new Error('Rule number exists: ' + number);
    const rule: GradeRule = { id: newId('r'), number, name: opt.name ?? String(number), inc, sizeLineId: line.id, ...(opt.description ? { description: opt.description } : {}) };
    lib.rules.push(rule);
    return rule;
  });
}

/** Capture a live anchor's current (world-frame) increments as a new rule. */
export function createRuleFromPoint(doc: Document, libraryId: Id, pieceId: Id, anchorId: Id, opt: { name?: string; number?: number } = {}): GradeRule {
  return doc.transact('Rule from point', () => {
    const lib = library(doc, libraryId);
    const piece = doc.piece(pieceId); const line = doc.sizeLine(piece);
    const ref = findRef(piece, anchorId);
    const inc = incFromWorldAbs(refWorldAbs(ref, line), line);
    const values = remapByName(inc, line, lib.sizeLine);
    return createRuleFromValues(doc, libraryId, values, { ...opt, name: opt.name ?? ref.anchor?.name });
  });
}

/**
 * One rule per GRADE anchor of the sew contour, numbered consecutively from `startNumber`
 * (default next free) in contour order starting at the start point. Optionally links the anchors.
 */
export function createRuleSetFromContour(doc: Document, libraryId: Id, pieceId: Id, opt: { startNumber?: number; link?: boolean; prefix?: string } = {}): GradeRule[] {
  return doc.transact('Rule set from contour', () => {
    const lib = library(doc, libraryId);
    const piece = doc.piece(pieceId);
    const pts = piece.sew.points;
    let s0 = pts.findIndex(a => a.flags.startPoint); if (s0 < 0) s0 = 0;
    const order = pts.map((_, k) => pts[(s0 + k) % pts.length]).filter(a => a.kind === 'grade');
    let n = opt.startNumber ?? nextNumber(lib);
    const out: GradeRule[] = [];
    for (const a of order) {
      const r = createRuleFromPoint(doc, libraryId, pieceId, a.id, { number: n, name: opt.prefix ? `${opt.prefix}${n}` : String(n) });
      n++;
      out.push(r);
      if (opt.link) a.ruleId = r.id;
    }
    return out;
  });
}

/** Find a rule by number, name or id across one library or all libraries. */
export function findRule(doc: Document, ref: number | string, libraryId?: Id): { lib: RuleLibrary; rule: GradeRule } | undefined {
  const libs = libraryId ? [library(doc, libraryId)] : doc.style.ruleLibraries;
  for (const lib of libs) {
    const rule = lib.rules.find(r => (typeof ref === 'number' ? r.number === ref : r.id === ref || r.name === ref || String(r.number) === ref));
    if (rule) return { lib, rule };
  }
  return undefined;
}

/** Materialise a rule's increments into an anchor (mapped by size name), set ruleId. Local frame of the anchor. */
export function applyRule(doc: Document, pieceId: Id, anchorIds: Id | Id[], rule: number | string, opt: { libraryId?: Id } = {}): void {
  doc.transact('Apply rule', () => {
    const hit = findRule(doc, rule, opt.libraryId);
    if (!hit) throw new Error('No rule ' + rule);
    const piece = doc.piece(pieceId); const line = doc.sizeLine(piece);
    const inc = remapByName(hit.rule.inc, hit.lib.sizeLine, line);
    for (const id of Array.isArray(anchorIds) ? anchorIds : [anchorIds]) {
      const ref = findRef(piece, id);
      ref.set(deepClone(inc));
      if (ref.anchor) ref.anchor.ruleId = hit.rule.id;
    }
  });
}

/** Detach: keep the materialised values, drop the rule link. */
export function detachRule(doc: Document, pieceId: Id, anchorIds: Id | Id[]): void {
  doc.transact('Detach rule', () => {
    const piece = doc.piece(pieceId);
    for (const id of Array.isArray(anchorIds) ? anchorIds : [anchorIds]) { const r = findRef(piece, id); if (r.anchor) delete r.anchor.ruleId; }
  });
}

/** Re-materialise every anchor linked to a rule (after editing the rule's values). Returns count. */
export function refreshRuleLinks(doc: Document, ruleId: Id): number {
  return doc.transact('Refresh rule links', style => {
    const hit = findRule(doc, ruleId); if (!hit) throw new Error('No rule ' + ruleId);
    let n = 0;
    for (const piece of style.pieces) {
      const line = doc.sizeLine(piece);
      for (const ref of gradedRefs(piece, 1)) if (ref.anchor?.ruleId === ruleId) { ref.set(remapByName(hit.rule.inc, hit.lib.sizeLine, line)); n++; }
    }
    return n;
  });
}

/** Display label for an anchor's rule: "12 (SideSeam)" / "12" / "" ; '*' suffix when values diverged from the rule. */
export function ruleName(doc: Document, pieceId: Id, anchorId: Id): string {
  const piece = doc.piece(pieceId);
  const ref = findRef(piece, anchorId);
  const rid = ref.anchor?.ruleId; if (!rid) return '';
  const hit = findRule(doc, rid); if (!hit) return '?' + rid;
  const r = hit.rule;
  const label = r.name && r.name !== String(r.number) ? `${r.number} (${r.name})` : String(r.number);
  const line = doc.sizeLine(piece);
  const expect = remapByName(r.inc, hit.lib.sizeLine, line);
  const cur = ref.get() ?? {};
  const diverged = line.sizes.slice(1).some(s => {
    const a = gi(cur, s.id), b = gi(expect, s.id); return Math.abs(a.dx - b.dx) > 1e-9 || Math.abs(a.dy - b.dy) > 1e-9;
  });
  return diverged ? label + '*' : label;
}

/**
 * Load Sizes from Library: create a new size table whose axis1 is a copy of the library's size line
 * (fresh ids), re-point the given pieces (default: all pieces of the active table) to it and remap
 * every graded record by size NAME. Sizes absent from the source line get zero increments; the
 * absolute offsets of matched sizes are preserved where the base name exists in both lines.
 */
export function loadSizesFromLibrary(doc: Document, libraryId: Id, opt: { pieceIds?: Id[]; name?: string; activate?: boolean } = {}): Id {
  return doc.transact('Load sizes from library', style => {
    const lib = library(doc, libraryId);
    const srcTable = doc.sizeTable();
    const newLine: SizeLine = { ...deepClone(lib.sizeLine), id: newId('sl') };
    const idMap: Record<SizeId, SizeId> = {};
    for (const s of newLine.sizes) { const nid = newId('s'); idMap[s.id] = nid; s.id = nid; }
    newLine.baseSizeId = idMap[lib.sizeLine.baseSizeId];
    const table: SizeTable = { id: newId('st'), name: opt.name ?? lib.name, axis1: newLine };
    const pieces = opt.pieceIds ? opt.pieceIds.map(id => doc.piece(id)) : piecesOfTable(style, srcTable.id, false);
    for (const piece of pieces) {
      const old = doc.sizeLine(piece);
      const oldBaseName = old.sizes.find(s => s.id === old.baseSizeId)?.name;
      const newBaseName = newLine.sizes.find(s => s.id === newLine.baseSizeId)?.name;
      const sameBase = oldBaseName === newBaseName;
      for (const ref of gradedRefs(piece, 1)) {
        if (ref.implicit) continue;
        const rec = ref.get() ?? {};
        if (sameBase) {
          // preserve absolute offsets by name; unmatched sizes interpolate as zero increment
          const abs: Record<SizeId, { x: number; y: number }> = {};
          for (const s of newLine.sizes) {
            const o = old.sizes.find(x => x.name === s.name);
            abs[s.id] = o ? absoluteOffset(rec, old, o.id) : { x: NaN, y: NaN };
          }
          // fill unmatched with previous matched (toward base) to give zero increments
          const ids = newLine.sizes.map(s => s.id), bi = ids.indexOf(newLine.baseSizeId);
          for (let i = bi + 1; i < ids.length; i++) if (Number.isNaN(abs[ids[i]].x)) abs[ids[i]] = { ...abs[ids[i - 1]] };
          for (let i = bi - 1; i >= 0; i--) if (Number.isNaN(abs[ids[i]].x)) abs[ids[i]] = { ...abs[ids[i + 1]] };
          ref.set(incFromWorldAbs(abs, newLine));
        } else ref.set(remapByName(rec, old, newLine));
      }
      for (const n of piece.notches) {
        const p = n.placement;
        if (p.kind === 'fromPrev' || p.kind === 'fromNext') {
          const d: Record<SizeId, number> = {};
          for (const s of newLine.sizes) { const o = old.sizes.find(x => x.name === s.name); if (o && p.dist[o.id] !== undefined) d[s.id] = p.dist[o.id]; }
          p.dist = d;
        }
      }
      if (piece.sizes) {
        const names = new Set(piece.sizes.map(id => old.sizes.find(s => s.id === id)?.name));
        piece.sizes = newLine.sizes.filter(s => names.has(s.name)).map(s => s.id);
      }
      piece.sizeTableId = table.id;
    }
    style.sizeTables.push(table);
    if (opt.activate !== false) style.activeSizeTableId = table.id;
    return table.id;
  });
}

// ───────────────────────── Gerber-style rule tables (rows = sizes) ─────────────────────────
//
// Two plain-language views of one column of values (one axis of one point or rule), both keyed by
// size index along the size line (base index b):
//   total[i] — "Total from base size": absolute offset from the base size (total[b] = 0)
//   step[i]  — "Step into this size": total[i] − total[neighbour toward the base] (step[b] = 0).
// The step view is the AccuMark convention (smaller sizes carry their own, usually negative, step
// away from the base), so editing a step moves that size AND every size further from the base,
// never the sizes between it and the base. The kernel's storage convention (inc[i] = abs[i] −
// abs[i−1]) is converted with absoluteToIncremental / incrementalToAbsolute.

/** Outward steps from totals. */
export function outwardSteps(total: number[], baseIndex: number): number[] {
  return total.map((v, i) => (i === baseIndex ? 0 : i > baseIndex ? v - total[i - 1] : v - total[i + 1]));
}
/** Totals from outward steps (step at the base ignored). */
export function totalsFromSteps(step: number[], baseIndex: number): number[] {
  const t = step.map(() => 0);
  for (let i = baseIndex + 1; i < step.length; i++) t[i] = t[i - 1] + step[i];
  for (let i = baseIndex - 1; i >= 0; i--) t[i] = t[i + 1] + step[i];
  return t;
}
/** Indices of the sizes whose position changes when the cell of size `i` is edited in a view. */
export function affectedSizes(n: number, baseIndex: number, i: number, view: 'step' | 'total'): number[] {
  if (i === baseIndex || i < 0 || i >= n) return [];
  if (view === 'total') return [i];
  const out: number[] = [];
  if (i > baseIndex) for (let k = i; k < n; k++) out.push(k); else for (let k = i; k >= 0; k--) out.push(k);
  return out;
}

export type FillMethod = 'linear' | 'interpolate' | 'repeat' | 'breaks';
/** A typed cell: size index and value in the view the user typed it in. */
export interface FillAnchor { i: number; v: number }

/**
 * Smart fill of one column (UI: type a few size rows, press Fill). Works per side of the base; a side
 * without anchors keeps `current`. Returns totals (and steps).
 * - linear: equal steps. Step view: the mean of the typed steps; total view: least-squares slope
 *   through the base (one typed total at the last size = that total spread evenly).
 * - interpolate: total view: piecewise linear through the typed totals (ends continue the last
 *   step); step view: the step ramps linearly between typed steps, constant beyond the last one.
 * - repeat: each typed step repeats outward until the next typed one (sizes before the first typed
 *   one, toward the base, take the first). Total view: the step implied at each typed row repeats.
 * - breaks: AccuMark size breaks. The value at a break (typed, else current) is reached at that size
 *   and the change since the previous break (toward the base) is split evenly over the sizes in
 *   between; beyond the outermost break the last per-size step continues. Typed rows act as breaks
 *   too. Step view: a typed value at a break is the change over its range.
 */
export function smartFill(current: number[], baseIndex: number, anchors: FillAnchor[], view: 'step' | 'total', method: FillMethod, breaks: number[] = []): { totals: number[]; steps: number[] } {
  const n = current.length, b = baseIndex;
  const out = current.slice(); out[b] = 0;
  for (const side of [1, -1] as const) {
    const idx: number[] = []; for (let i = b + side; i >= 0 && i < n; i += side) idx.push(i); // outward order
    if (!idx.length) continue;
    const anc = new Map<number, number>();
    for (const a of anchors) if (idx.includes(a.i) && Number.isFinite(a.v)) anc.set(a.i, a.v);
    if (!anc.size) continue;
    const d = (i: number) => Math.abs(i - b);
    const setTotals = (tot: (i: number) => number) => { for (const i of idx) out[i] = tot(i); };
    const fromSteps = (st: Map<number, number>) => { let acc = 0; for (const i of idx) { acc += st.get(i) ?? 0; out[i] = acc; } };
    if (method === 'linear') {
      if (view === 'step') { const k = [...anc.values()].reduce((a, v) => a + v, 0) / anc.size; setTotals(i => k * d(i)); }
      else { let num = 0, den = 0; for (const [i, v] of anc) { num += d(i) * v; den += d(i) * d(i); } const k = den ? num / den : 0; setTotals(i => k * d(i)); }
    } else if (method === 'interpolate') {
      const keys = idx.filter(i => anc.has(i));
      if (view === 'total') {
        const px = [0, ...keys.map(d)], py = [0, ...keys.map(i => anc.get(i)!)];
        setTotals(i => {
          const x = d(i);
          let k = px.findIndex(v => v >= x); if (k < 0) k = px.length - 1; if (k === 0) k = 1;
          const x0 = px[k - 1], x1 = px[k], y0 = py[k - 1], y1 = py[k];
          return x1 === x0 ? y1 : y0 + (y1 - y0) * (x - x0) / (x1 - x0);
        });
      } else {
        const st = new Map<number, number>();
        for (const i of idx) {
          const x = d(i);
          const lo = [...keys].reverse().find(k => d(k) <= x), hi = keys.find(k => d(k) >= x);
          if (lo === undefined) st.set(i, anc.get(hi!)!);
          else if (hi === undefined) st.set(i, anc.get(lo)!);
          else st.set(i, d(hi) === d(lo) ? anc.get(lo)! : anc.get(lo)! + (anc.get(hi)! - anc.get(lo)!) * (x - d(lo)) / (d(hi) - d(lo)));
        }
        fromSteps(st);
      }
    } else if (method === 'repeat') {
      let typedSteps = new Map<number, number>();
      if (view === 'step') typedSteps = anc;
      else { // implied step at each typed total row (its neighbour toward the base taken from the current values / earlier anchors)
        const tmp = current.slice(); tmp[b] = 0; for (const [i, v] of anc) tmp[i] = v;
        for (const i of anc.keys()) typedSteps.set(i, tmp[i] - tmp[i - side]);
      }
      const first = idx.find(i => typedSteps.has(i))!;
      const st = new Map<number, number>(); let last = typedSteps.get(first)!;
      for (const i of idx) { if (typedSteps.has(i)) last = typedSteps.get(i)!; st.set(i, last); }
      fromSteps(st);
    } else { // breaks
      const brk = new Set<number>([...breaks.filter(i => idx.includes(i)), ...anc.keys()]);
      const order = idx.filter(i => brk.has(i));
      const val = new Map<number, number>(); // total at each break
      let prevTotal = 0;
      for (const i of order) {
        let v: number;
        if (anc.has(i)) v = view === 'total' ? anc.get(i)! : prevTotal + anc.get(i)!;
        else v = view === 'total' ? current[i] : prevTotal + (current[i] - (order.indexOf(i) > 0 ? current[order[order.indexOf(i) - 1]] : 0));
        val.set(i, v); prevTotal = v;
      }
      let px = 0, py = 0, lastStep = 0;
      for (const i of order) { const x = d(i), y = val.get(i)!; lastStep = x > px ? (y - py) / (x - px) : 0; for (const j of idx) if (d(j) > px && d(j) <= x) out[j] = py + (y - py) * (d(j) - px) / (x - px); px = x; py = y; }
      for (const j of idx) if (d(j) > px) out[j] = py + lastStep * (d(j) - px);
    }
  }
  return { totals: out, steps: outwardSteps(out, b) };
}

// ───────────────────────── size breaks (stored with the style) ─────────────────────────

type MetaWithBreaks = { sizeBreaks?: Record<Id, SizeId[]> };
/** Break sizes of a size line (AccuMark "Next Size Breaks" / Edit Size Breaks), in line order. Stored in style.meta.sizeBreaks. */
export function sizeBreaks(doc: Document, lineId: Id): SizeId[] {
  return ((doc.style.meta as MetaWithBreaks).sizeBreaks?.[lineId] ?? []).slice();
}
export function setSizeBreaks(doc: Document, lineId: Id, sizeIds: SizeId[]): void {
  doc.transact('Size breaks', style => {
    const m = style.meta as MetaWithBreaks;
    m.sizeBreaks ??= {};
    if (sizeIds.length) m.sizeBreaks[lineId] = [...new Set(sizeIds)]; else delete m.sizeBreaks[lineId];
  });
}

// ───────────────────────── rule editing (Create / Modify Rule, Copy Table Rule) ─────────────────────────

function ruleIn(doc: Document, libraryId: Id, ruleId: Id): { lib: RuleLibrary; rule: GradeRule } {
  const lib = library(doc, libraryId);
  const rule = lib.rules.find(r => r.id === ruleId);
  if (!rule) throw new Error('No rule ' + ruleId);
  return { lib, rule };
}

/**
 * Modify Rule / Edit Rule Delta: replace a rule's values (library size ids; incremental by default,
 * view:'absolute' = offsets from the library base) and re-apply it to every linked point.
 * Returns the number of linked points refreshed.
 */
export function setRuleValues(doc: Document, libraryId: Id, ruleId: Id, values: Record<SizeId, GradeInc>, opt: { view?: 'incremental' | 'absolute'; refresh?: boolean } = {}): number {
  return doc.transact('Modify rule', () => {
    const { lib, rule } = ruleIn(doc, libraryId, ruleId);
    const line = lib.sizeLine;
    let inc: GradeRec;
    if (opt.view === 'absolute') {
      const w: Record<SizeId, { x: number; y: number }> = {};
      for (const s of line.sizes) w[s.id] = { x: gi(values, s.id).dx, y: gi(values, s.id).dy };
      inc = incFromWorldAbs(w, line);
    } else { inc = {}; for (const s of line.sizes) inc[s.id] = { ...gi(values, s.id) }; inc[line.sizes[0].id] = Z(); }
    rule.inc = inc;
    return opt.refresh === false ? 0 : refreshRuleLinks(doc, rule.id);
  });
}

/** Copy Table Rule: duplicate a rule under a new number (optionally flipped in X / Y). */
export function copyRule(doc: Document, libraryId: Id, ruleId: Id, opt: { number?: number; name?: string; flipX?: boolean; flipY?: boolean } = {}): GradeRule {
  return doc.transact('Copy rule', () => {
    const { lib, rule } = ruleIn(doc, libraryId, ruleId);
    const number = opt.number ?? nextNumber(lib);
    if (lib.rules.some(r => r.number === number)) throw new Error('Rule number exists: ' + number);
    const inc: GradeRec = {};
    for (const [k, v] of Object.entries(rule.inc)) inc[k] = { dx: opt.flipX ? -v.dx : v.dx, dy: opt.flipY ? -v.dy : v.dy };
    const copy: GradeRule = { id: newId('r'), number, name: opt.name ?? String(number), inc, sizeLineId: rule.sizeLineId, ...(rule.description ? { description: rule.description } : {}) };
    lib.rules.push(copy);
    return copy;
  });
}

/** Rename / renumber a rule. */
export function renameRule(doc: Document, libraryId: Id, ruleId: Id, opt: { name?: string; number?: number }): void {
  doc.transact('Rename rule', () => {
    const { lib, rule } = ruleIn(doc, libraryId, ruleId);
    if (opt.number !== undefined && opt.number !== rule.number) {
      if (lib.rules.some(r => r.number === opt.number)) throw new Error('Rule number exists: ' + opt.number);
      rule.number = opt.number;
    }
    if (opt.name !== undefined) rule.name = opt.name;
  });
}

/** Delete a rule. Linked points keep their values; their link is removed. Returns the number of points detached. */
export function deleteRule(doc: Document, libraryId: Id, ruleId: Id): number {
  return doc.transact('Delete rule', style => {
    const { lib } = ruleIn(doc, libraryId, ruleId);
    lib.rules = lib.rules.filter(r => r.id !== ruleId);
    let n = 0;
    for (const p of style.pieces) for (const ref of gradedRefs(p, 1)) if (ref.anchor?.ruleId === ruleId) { delete ref.anchor.ruleId; n++; }
    return n;
  });
}

export type GradeStatus = 'rule' | 'edited' | 'graded' | 'ungraded';
/**
 * Grading status of a point for the rule badges: 'rule' = linked to a rule and equal to it,
 * 'edited' = linked but its values differ (locally edited), 'graded' = own non-zero grading, no rule,
 * 'ungraded' = no grading at all (every size on the base position).
 */
export function gradeStatus(doc: Document, pieceId: Id, anchorId: Id): GradeStatus {
  const piece = doc.piece(pieceId);
  const ref = findRef(piece, anchorId);
  if (ref.anchor?.ruleId) return ruleName(doc, pieceId, anchorId).endsWith('*') ? 'edited' : 'rule';
  const line = doc.sizeLine(piece);
  const w = refWorldAbs(ref, line);
  return line.sizes.some(s => Math.hypot(w[s.id].x, w[s.id].y) > 1e-9) ? 'graded' : 'ungraded';
}
