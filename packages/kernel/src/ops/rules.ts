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
