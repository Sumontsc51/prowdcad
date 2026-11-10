/**
 * Native file format: the `Style` document root serialised as JSON (schema 'prowdcad/2').
 * See docs/FILE-FORMATS.md. `loadNative` validates structure, runs registered migrations for older
 * schemas (including the legacy single-HTML app's `.wptn`), and fills optional collections.
 */
import type { Vec } from '../geom/vec';
import { resolveContour, absoluteOffset } from '../model/contour';
import { makeStyle, makeSizeLine, makeSizeTable, makePiece, makeContour, gradePoint, curvePoint, newId, now, DEFAULT_NOTCH_SETUP } from '../model/factory';
import { Document } from '../model/doc';
import type { Anchor, Contour, GradeInc, Id, Notch, Piece, SizeId, SizeLine, Style } from '../model/types';
import { resolveNotch } from './common';

export const NATIVE_SCHEMA = 'prowdcad/2' as const;
export const NATIVE_EXTENSION = '.prowd';
export const NATIVE_MIME = 'application/vnd.prowdcad+json';

export class NativeFormatError extends Error {
  constructor(public problems: string[]) { super('Invalid ProwdCAD file: ' + problems.slice(0, 5).join('; ') + (problems.length > 5 ? ` (+${problems.length - 5} more)` : '')); }
}

// ───────────────────────── migrations ─────────────────────────

/** A migration upgrades a parsed JSON object whose schema matches `from` towards `to`. */
export interface Migration { from: string; to: string; migrate: (o: any) => any }
const migrations: Migration[] = [];

/** Register a migration hook (e.g. 'prowdcad/2' → 'prowdcad/3' when the schema evolves). */
export function registerMigration(m: Migration): void {
  const i = migrations.findIndex(x => x.from === m.from);
  if (i >= 0) migrations[i] = m; else migrations.push(m);
}
export function listMigrations(): readonly Migration[] { return migrations; }

/** Detect a schema tag for any supported input. */
export function detectSchema(o: any): string {
  if (o && typeof o.schema === 'string') return o.schema;
  if (o && (o.type === 'wptn' || (Array.isArray(o.pieces) && Array.isArray(o.measurements)))) return 'wptn/2';
  return 'unknown';
}

// built-in: legacy single-HTML ProwdCAD .wptn (version 2) → prowdcad/2
registerMigration({ from: 'wptn/2', to: NATIVE_SCHEMA, migrate: migrateWptn });

/**
 * Legacy `.wptn`: { name, size, pieces:[{name, points:[{x,y,curve,hIn,hOut (ABSOLUTE, y-down)}], seam, qty,
 * grain:{x1,y1,x2,y2}, notches:[{seg,t}], internals:[{x1,y1,x2,y2,kind?}], annotations:[string]}] }.
 * The legacy frame is SVG y-down ⇒ y is negated. Grading in .wptn is measurement-driven
 * (movement programs) and is not carried over.
 */
function migrateWptn(o: any): Style {
  const style = makeStyle(String(o.name ?? 'Imported'), [String(o.size ?? 'M')], String(o.size ?? 'M'));
  const tid = style.activeSizeTableId;
  const Y = (v: any): Vec => ({ x: Number(v?.x) || 0, y: -(Number(v?.y) || 0) });
  for (const lp of o.pieces ?? []) {
    const pts: Anchor[] = (lp.points ?? []).map((q: any) => {
      const p = Y(q);
      const a = q.curve ? curvePoint(p.x, p.y) : gradePoint(p.x, p.y);
      if (q.hIn) { const h = Y(q.hIn); a.hIn = { x: h.x - p.x, y: h.y - p.y }; a.smooth = true; }
      if (q.hOut) { const h = Y(q.hOut); a.hOut = { x: h.x - p.x, y: h.y - p.y }; a.smooth = true; }
      if (q.name) a.name = String(q.name);
      return a;
    });
    if (pts.length < 3) continue;
    if (!pts.some(a => a.kind === 'grade')) pts[0].kind = 'grade';
    pts[0].flags.startPoint = true;
    const sew = makeContour(pts);
    const seam = Number(lp.seam) || 0;
    const piece = makePiece(String(lp.name ?? 'Piece'), sew, tid, { seamDefault: seam, noSeam: seam <= 0 });
    piece.order.qtyPerBundle = Number(lp.qty) || 1;
    if (lp.grain) piece.grain = { a: Y({ x: lp.grain.x1, y: lp.grain.y1 }), b: Y({ x: lp.grain.x2, y: lp.grain.y2 }), gradeA: {}, gradeB: {}, centered: false };
    for (const il of lp.internals ?? []) {
      if (il.kind === 'drill') { const p = Y({ x: il.x1, y: il.y1 }); piece.drills.push({ id: newId('d'), x: p.x, y: p.y, grade: {}, diameter: 4, kind: 'drill', mode: 'draw' }); continue; }
      const a = Y({ x: il.x1, y: il.y1 }), b = Y({ x: il.x2, y: il.y2 });
      piece.internals.push(makeContour([gradePoint(a.x, a.y), gradePoint(b.x, b.y)], { type: 'internal', closed: false }));
    }
    // legacy notches {seg, t}: seg = span index between consecutive points, t ∈ [0,1] on that span
    const line = style.sizeTables[0].axis1;
    const r = resolveContour(sew, line, line.baseSizeId);
    for (const nt of lp.notches ?? []) {
      const seg = Math.max(0, Math.min(pts.length - 1, Number(nt.seg) || 0)), t = Number(nt.t) || 0;
      const s0 = r.cum[r.anchorIndex[seg]], s1 = seg + 1 < pts.length ? r.cum[r.anchorIndex[seg + 1]] : r.cum[r.cum.length - 1];
      const target = s0 + (s1 - s0) * t;
      let ai = 0; for (let k = 0; k < pts.length; k++) if (pts[k].kind === 'grade' && r.cum[r.anchorIndex[k]] <= target + 1e-9) ai = k;
      const d = target - r.cum[r.anchorIndex[ai]];
      piece.notches.push({ id: newId('n'), contourId: sew.id, type: 'slit', depth: 5, width: 0, angleDeg: 0, mode: 'cut', source: 'manual',
        placement: d < 1e-6 ? { kind: 'anchor', anchorId: pts[ai].id } : { kind: 'fromPrev', anchorId: pts[ai].id, dist: { [line.baseSizeId]: d } } });
    }
    let ty = 0;
    for (const txt of lp.annotations ?? []) {
      const b = r.pts.reduce((acc, p) => ({ x: acc.x + p.x / r.pts.length, y: acc.y + p.y / r.pts.length }), { x: 0, y: 0 });
      piece.texts.push({ id: newId('t'), x: b.x, y: b.y - (ty++) * 8, grade: {}, text: String(txt), size: 5, angleDeg: 0 });
    }
    style.pieces.push(piece);
  }
  return style;
}

// ───────────────────────── validation ─────────────────────────

const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown) => typeof v === 'string';
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Structural validation of a prowdcad/2 Style. Returns a list of problems (empty = valid). */
export function validateStyle(s: any): string[] {
  const P: string[] = [];
  const need = (cond: boolean, msg: string) => { if (!cond) P.push(msg); };
  if (!isObj(s)) return ['root is not an object'];
  need(s.schema === NATIVE_SCHEMA, `schema must be "${NATIVE_SCHEMA}"`);
  need(isStr(s.id), 'id missing'); need(isStr(s.name), 'name missing');
  need(['mm', 'cm', 'in'].includes(s.units), 'units must be mm|cm|in');
  need(Array.isArray(s.pieces), 'pieces[] missing');
  need(Array.isArray(s.sizeTables) && s.sizeTables.length > 0, 'sizeTables[] missing');
  if (P.length) return P;
  const sizeIds = new Map<string, Set<string>>();
  for (const [ti, t] of s.sizeTables.entries()) {
    const ax = t?.axis1;
    if (!isStr(t?.id) || !isObj(ax) || !Array.isArray(ax.sizes) || !ax.sizes.length) { P.push(`sizeTables[${ti}] malformed`); continue; }
    const ids = new Set<string>(ax.sizes.map((z: any) => z?.id));
    if (!ids.has(ax.baseSizeId)) P.push(`sizeTables[${ti}].axis1.baseSizeId not in sizes`);
    sizeIds.set(t.id, ids);
  }
  need(sizeIds.has(s.activeSizeTableId), 'activeSizeTableId does not reference a size table');
  const checkContour = (c: any, where: string, anchorIds: Set<string>) => {
    if (!isObj(c) || !isStr(c.id) || !Array.isArray(c.points) || typeof c.closed !== 'boolean') { P.push(`${where}: malformed contour`); return; }
    c.points.forEach((a: any, i: number) => {
      if (!isObj(a) || !isStr(a.id) || !isNum(a.x) || !isNum(a.y) || (a.kind !== 'grade' && a.kind !== 'curve') || typeof a.smooth !== 'boolean' || !isObj(a.grade)) P.push(`${where}.points[${i}] malformed`);
      else { if (anchorIds.has(a.id)) P.push(`${where}.points[${i}] duplicate anchor id ${a.id}`); anchorIds.add(a.id); }
    });
  };
  const pieceIds = new Set<string>();
  s.pieces.forEach((p: any, pi: number) => {
    const w = `pieces[${pi}]`;
    if (!isObj(p) || !isStr(p.id)) { P.push(`${w} malformed`); return; }
    if (pieceIds.has(p.id)) P.push(`${w} duplicate piece id`); pieceIds.add(p.id);
    if (!sizeIds.has(p.sizeTableId)) P.push(`${w}.sizeTableId unknown`);
    const ids = new Set<string>();
    checkContour(p.sew, `${w}.sew`, ids);
    if (p.sew?.points?.length < 3) P.push(`${w}.sew has < 3 points`);
    if (p.manualCut) checkContour(p.manualCut, `${w}.manualCut`, ids);
    if (p.cutMode === 'manual' && !p.manualCut) P.push(`${w}: cutMode manual without manualCut`);
    for (const k of ['internals', 'darts', 'pleats', 'notches', 'drills', 'texts', 'artwork', 'connections']) if (!Array.isArray(p[k])) P.push(`${w}.${k}[] missing`);
    (p.internals ?? []).forEach((c: any, ci: number) => checkContour(c, `${w}.internals[${ci}]`, ids));
    const contourIds = new Set([p.sew?.id, p.manualCut?.id, ...(p.internals ?? []).map((c: any) => c?.id)]);
    (p.notches ?? []).forEach((n: any, ni: number) => {
      if (!contourIds.has(n?.contourId)) P.push(`${w}.notches[${ni}].contourId unknown`);
      if (!ids.has(n?.placement?.anchorId)) P.push(`${w}.notches[${ni}].placement.anchorId unknown`);
    });
    (p.darts ?? []).forEach((d: any, di: number) => { if (!ids.has(d?.legA) || !ids.has(d?.legB)) P.push(`${w}.darts[${di}] legs reference unknown anchors`); });
    if (!isObj(p.grain) || !isObj(p.grain.a) || !isObj(p.grain.b)) P.push(`${w}.grain malformed`);
    if (!isNum(p.seamDefault)) P.push(`${w}.seamDefault not a number`);
  });
  return P;
}

/** Fill optional collections that older prowdcad/2 writers may have omitted. */
function normalize(s: Style): Style {
  const d = makeStyle();
  s.ruleLibraries ??= []; s.movementPrograms ??= []; s.measurementSets ??= []; s.pieceArchive ??= []; s.layouts ??= {};
  s.meta ??= {}; s.settings ??= d.settings; s.settings.notchSetup ??= { ...DEFAULT_NOTCH_SETUP };
  s.createdAt ??= now(); s.updatedAt ??= s.createdAt;
  for (const p of s.pieces) {
    for (const k of ['internals', 'darts', 'pleats', 'notches', 'drills', 'texts', 'artwork', 'connections'] as const) (p as any)[k] ??= [];
    for (const c of [p.sew, ...p.internals, ...(p.manualCut ? [p.manualCut] : [])]) for (const a of c.points) { a.grade ??= {}; a.flags ??= {}; }
  }
  return s;
}

// ───────────────────────── API ─────────────────────────

export interface SaveOptions { pretty?: boolean }

/** Serialise a Document (or Style) to native JSON. */
export function saveNative(doc: Document | Style, opt: SaveOptions = {}): string {
  const s = doc instanceof Document ? doc.style : doc;
  return JSON.stringify(s, null, opt.pretty ? 1 : undefined);
}

export interface LoadResult { style: Style; migratedFrom?: string; warnings: string[] }

/** Parse, migrate and validate native JSON (string or already-parsed object). Throws NativeFormatError. */
export function loadNative(json: string | object): LoadResult {
  let o: any;
  if (typeof json === 'string') { try { o = JSON.parse(json); } catch (e) { throw new NativeFormatError(['not valid JSON: ' + (e as Error).message]); } }
  else o = JSON.parse(JSON.stringify(json));
  const warnings: string[] = [];
  const first = detectSchema(o);
  let schema = first; let guard = 0;
  while (schema !== NATIVE_SCHEMA && guard++ < 20) {
    const m = migrations.find(x => x.from === schema);
    if (!m) throw new NativeFormatError([`unsupported schema "${schema}"`]);
    o = m.migrate(o);
    if (detectSchema(o) === schema && m.to !== schema) o.schema = m.to;
    schema = detectSchema(o);
    warnings.push(`migrated ${m.from} → ${m.to}`);
  }
  if (isObj(o)) normalize(o as Style);
  const problems = validateStyle(o);
  if (problems.length) throw new NativeFormatError(problems);
  return { style: o as Style, migratedFrom: first !== NATIVE_SCHEMA ? first : undefined, warnings };
}

/** Convenience: load straight into a Document. */
export function openNative(json: string | object): Document { return new Document(loadNative(json).style); }

// ───────────────────────── export one size as a standalone pattern ─────────────────────────

/**
 * New Style whose single size (named after `sizeId`) is that size of the piece, as base geometry.
 * Every anchor/handle/live object is re-expressed at that size; grading is stripped; ids are fresh.
 * Notches keep their anchor and their distance for that size; darts/pleats/drills/texts/grain/half
 * follow; manual cut and internals are resolved for that size.
 */
export function exportSizeAsStandalone(doc: Document, pieceId: Id, sizeId: SizeId): Style {
  const src = doc.piece(pieceId);
  const line = doc.sizeLine(src);
  const sizeName = line.sizes.find(s => s.id === sizeId)?.name;
  if (!sizeName) throw new Error('size not in piece size line: ' + sizeId);
  const nl = makeSizeLine([sizeName], sizeName, { name: line.name });
  const table = makeSizeTable(nl, doc.sizeTable(src.sizeTableId).name);
  const style = makeStyle(`${doc.style.name} ${src.name} ${sizeName}`, [sizeName], sizeName);
  style.sizeTables = [table]; style.activeSizeTableId = table.id;
  style.units = doc.style.units; style.fractionDenominator = doc.style.fractionDenominator;
  style.settings = JSON.parse(JSON.stringify(doc.style.settings)); style.meta = { ...doc.style.meta };
  const sid = nl.sizes[0].id;
  const off = (g: Record<SizeId, GradeInc> | undefined) => absoluteOffset(g, line, sizeId);
  const idMap = new Map<Id, Id>();
  const p: Piece = JSON.parse(JSON.stringify(src));
  p.id = newId('pc'); p.sizeTableId = table.id; p.sizes = undefined; p.version = 0; p.reference = undefined;
  p.createdAt = p.updatedAt = now();
  const rebase = (c: Contour, orig: Contour): void => {
    const pos = resolveContour(orig, line, sizeId).anchorPos;
    // explicit handles are relative offsets; with no grading on handles they stay as authored
    c.id = (() => { const n = newId('c'); idMap.set(orig.id, n); return n; })();
    c.points.forEach((a, i) => {
      const nid = newId('p'); idMap.set(a.id, nid); a.id = nid;
      a.x = pos[i].x; a.y = pos[i].y; a.grade = {}; delete a.ruleId; delete a.gradeAxisDeg;
      if (a.corner?.lockedPerSize) { const lk = a.corner.lockedPerSize[sizeId]; if (lk) a.corner.manualPoints = lk; delete a.corner.lockedPerSize; }
    });
  };
  rebase(p.sew, src.sew);
  if (p.manualCut && src.manualCut) rebase(p.manualCut, src.manualCut);
  p.internals.forEach((c, i) => rebase(c, src.internals[i]));
  const at = (v: { x: number; y: number; grade?: Record<SizeId, GradeInc> }) => { const o = off(v.grade); return { x: v.x + o.x, y: v.y + o.y }; };
  p.darts.forEach(d => { const q = at(d.apex); d.id = newId('dt'); d.legA = idMap.get(d.legA) ?? d.legA; d.legB = idMap.get(d.legB) ?? d.legB; d.apex = { x: q.x, y: q.y, grade: {} }; });
  p.pleats.forEach(pl => { const a = at(pl.axisStart), b = at(pl.axisEnd); pl.id = newId('pl'); pl.axisStart = { ...a, grade: {} }; pl.axisEnd = { ...b, grade: {} }; });
  p.notches = p.notches.map((n): Notch => {
    const pl = n.placement;
    const np: Notch['placement'] =
      pl.kind === 'fromPrev' || pl.kind === 'fromNext'
        ? { kind: pl.kind, anchorId: idMap.get(pl.anchorId) ?? pl.anchorId, dist: { [sid]: pl.dist[sizeId] ?? pl.dist[line.baseSizeId] ?? Object.values(pl.dist)[0] ?? 0 } }
        : { ...pl, anchorId: idMap.get(pl.anchorId) ?? pl.anchorId };
    return { ...n, id: newId('n'), contourId: idMap.get(n.contourId) ?? n.contourId, placement: np };
  });
  p.drills.forEach(d => { const q = at(d); d.id = newId('d'); d.x = q.x; d.y = q.y; d.grade = {}; });
  p.texts.forEach(t => { const q = at(t); t.id = newId('t'); t.x = q.x; t.y = q.y; t.grade = {}; });
  p.artwork.forEach(a => { const q = at(a); a.id = newId('aw'); a.x = q.x; a.y = q.y; a.grade = {}; });
  { const ga = off(src.grain.gradeA), gb = off(src.grain.gradeB); p.grain = { ...p.grain, a: { x: src.grain.a.x + ga.x, y: src.grain.a.y + ga.y }, b: { x: src.grain.b.x + gb.x, y: src.grain.b.y + gb.y }, gradeA: {}, gradeB: {} }; }
  p.connections = p.connections.map(c => ({ internalContourId: idMap.get(c.internalContourId) ?? c.internalContourId, internalAnchorId: idMap.get(c.internalAnchorId) ?? c.internalAnchorId, externalAnchorId: idMap.get(c.externalAnchorId) ?? c.externalAnchorId }));
  p.lockGrading = false;
  style.pieces = [p];
  return style;
}

/** Notch positions of a piece for a size (helper used by tests & UI to compare standalone vs graded). */
export function notchPositions(piece: Piece, line: SizeLine, sizeId: SizeId): Vec[] {
  return piece.notches.map(n => resolveNotch(piece, n, line, sizeId)?.p ?? { x: NaN, y: NaN });
}
