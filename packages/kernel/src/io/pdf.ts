/**
 * Tiled 1:1 PDF export. Self-contained PDF 1.4 writer (no dependencies, uncompressed content streams,
 * standard Helvetica font), so output is deterministic and byte-inspectable.
 *
 * Scale: exactly 1:1 in PDF user units — every coordinate is written in points, 1 pt = 25.4/72 mm.
 * Layout: content (pieces, optional 100 mm reference square) is laid out in mm, then cut into tiles
 * of the printable area. Adjacent tiles overlap by `overlap` mm (the glue strip). Each page carries
 * registration crosses at the 4 corners of its printable area, a page grid label (column letter +
 * row number, e.g. A1, B2), neighbour labels on the glue strips and a dashed glue line.
 */
import type { Vec } from '../geom/vec';
import { bbox, add, sub, mul, norm, perp } from '../geom/vec';
import type { Document } from '../model/doc';
import type { Id, SizeId } from '../model/types';
import { type PieceDrawing, drawPiece, drawingBox, translateDrawing, shelfPack, hexToRgb, SIZE_PALETTE } from './common';

export const PT_PER_MM = 72 / 25.4;

export const PAGE_SIZES: Record<string, { w: number; h: number }> = {
  A4: { w: 210, h: 297 }, A3: { w: 297, h: 420 }, A2: { w: 420, h: 594 }, A1: { w: 594, h: 841 }, A0: { w: 841, h: 1189 },
  Letter: { w: 215.9, h: 279.4 }, Legal: { w: 215.9, h: 355.6 }, Tabloid: { w: 279.4, h: 431.8 },
};

export interface PDFExportOptions {
  pieceIds?: Id[];
  /** sizes to draw; > 1 with mode 'nested' overlays them per piece */
  sizes?: SizeId[];
  mode?: 'nested' | 'single';
  /** page key or custom size in mm */
  page?: keyof typeof PAGE_SIZES | { w: number; h: number };
  orientation?: 'portrait' | 'landscape';
  /** page margin in mm (default 10) */
  margin?: number;
  /** glue overlap strip in mm (default 10) */
  overlap?: number;
  /** add a 100 mm × 100 mm calibration square (default true) */
  referenceSquare?: boolean;
  /** max layout width before wrapping to a new row (mm; default: 3 printable widths) */
  layoutWidth?: number;
  gap?: number;
  title?: string;
  /** draw sew line (default true) */
  sew?: boolean;
}

export interface PDFExportResult {
  bytes: Uint8Array;
  pages: number;
  cols: number;
  rows: number;
  /** page labels in page order (A1, B1, …) */
  labels: string[];
  /** media box in points */
  mediaBox: [number, number];
  /** content extent in mm */
  contentMm: { w: number; h: number };
}

const n = (v: number) => { const s = (Math.round(v * 10000) / 10000).toFixed(4).replace(/\.?0+$/, ''); return s === '-0' ? '0' : s; };
const pdfStr = (s: string) => '(' + s.replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1') + ')';
export const colLabel = (c: number): string => { let s = ''; c++; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; };

interface Item { kind: 'piece'; drawings: PieceDrawing[]; colors: string[]; name: string }
interface Square { kind: 'square'; at: Vec; size: number }

export function exportPDF(doc: Document, opt: PDFExportOptions = {}): PDFExportResult {
  const pg0 = typeof opt.page === 'object' ? opt.page : PAGE_SIZES[opt.page ?? 'A4'];
  if (!pg0) throw new Error('unknown page size ' + String(opt.page));
  const pg = opt.orientation === 'landscape' ? { w: Math.max(pg0.w, pg0.h), h: Math.min(pg0.w, pg0.h) } : opt.orientation === 'portrait' ? { w: Math.min(pg0.w, pg0.h), h: Math.max(pg0.w, pg0.h) } : pg0;
  const margin = opt.margin ?? 10, overlap = opt.overlap ?? 10, gap = opt.gap ?? 20;
  const uw = pg.w - 2 * margin, uh = pg.h - 2 * margin;
  if (uw <= overlap || uh <= overlap) throw new Error('page too small for margin + overlap');
  const pieces = (opt.pieceIds ?? doc.style.pieces.map(p => p.id)).map(id => doc.piece(id));
  const mode = opt.mode ?? 'nested';

  // ── items
  const items: Item[] = [];
  for (const p of pieces) {
    const line = doc.sizeLine(p);
    const sizes = (opt.sizes ?? [doc.baseSize(p)]).filter(s => doc.sizesOf(p).includes(s));
    const colorOf = (sid: SizeId, i: number) => sizes.length > 1 ? (line.sizes.find(s => s.id === sid)?.color ?? SIZE_PALETTE[i % SIZE_PALETTE.length]) : '#000000';
    if (mode === 'nested' || sizes.length <= 1) items.push({ kind: 'piece', name: p.name, drawings: sizes.map(s => drawPiece(doc, p, s)), colors: sizes.map(colorOf) });
    else sizes.forEach(s => items.push({ kind: 'piece', name: p.name, drawings: [drawPiece(doc, p, s)], colors: ['#000000'] }));
  }
  const boxes = items.map(it => { const bs = it.drawings.map(drawingBox); return { minX: Math.min(...bs.map(b => b.minX)), minY: Math.min(...bs.map(b => b.minY)), maxX: Math.max(...bs.map(b => b.maxX)), maxY: Math.max(...bs.map(b => b.maxY)) }; });
  const sq: Square | null = (opt.referenceSquare ?? true) ? { kind: 'square', at: { x: 0, y: 0 }, size: 100 } : null;
  const allBoxes = sq ? [{ minX: 0, minY: -8, maxX: 100, maxY: 100 }, ...boxes] : boxes;
  const offs = shelfPack(allBoxes, opt.layoutWidth ?? Math.max(3 * uw, ...allBoxes.map(b => b.maxX - b.minX)), gap);
  if (sq) { sq.at = { x: offs[0].x, y: offs[0].y }; offs.shift(); }
  items.forEach((it, i) => { it.drawings = it.drawings.map(d => translateDrawing(d, offs[i])); });

  const allPts: Vec[] = items.flatMap(it => it.drawings.flatMap(d => [...d.cut, ...d.sew, d.grain.a, d.grain.b]));
  if (sq) allPts.push(sq.at, add(sq.at, { x: sq.size, y: sq.size }), add(sq.at, { x: 0, y: -8 }));
  const bb = allPts.length ? bbox(allPts) : { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  const cw = bb.maxX - bb.minX, ch = bb.maxY - bb.minY;
  const stepX = uw - overlap, stepY = uh - overlap;
  const cols = Math.max(1, Math.ceil((cw - overlap) / stepX - 1e-9)), rows = Math.max(1, Math.ceil((ch - overlap) / stepY - 1e-9));

  // ── content stream (world mm → page pt), per tile
  const mediaW = pg.w * PT_PER_MM, mediaH = pg.h * PT_PER_MM;
  const contents: string[] = []; const labels: string[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const label = colLabel(c) + (r + 1); labels.push(label);
    const wx0 = bb.minX + c * stepX, wyTop = bb.maxY - r * stepY;
    // world → page mm: px = margin + (x − wx0); py = margin + uh − (wyTop − y)
    const T = (p: Vec): [number, number] => [(margin + (p.x - wx0)) * PT_PER_MM, (margin + uh - (wyTop - p.y)) * PT_PER_MM];
    const S: string[] = [];
    const path = (pts: Vec[], closed: boolean) => { if (pts.length < 2) return; const [x0, y0] = T(pts[0]); S.push(`${n(x0)} ${n(y0)} m`); for (const q of pts.slice(1)) { const [x, y] = T(q); S.push(`${n(x)} ${n(y)} l`); } S.push(closed ? 'h S' : 'S'); };
    const rgb = (hex: string) => hexToRgb(hex).map(v => n(v)).join(' ');
    const text = (p: Vec, sizeMm: number, s: string, angleDeg = 0, center = false) => {
      const [x, y] = T(p); const fs = sizeMm * PT_PER_MM; const a = angleDeg * Math.PI / 180;
      const w = center ? s.length * fs * 0.5 : 0; // Helvetica average advance ≈ 0.5 em
      const cx = x - w / 2 * Math.cos(a), cy = y - w / 2 * Math.sin(a);
      S.push(`BT /F1 ${n(fs)} Tf ${n(Math.cos(a))} ${n(Math.sin(a))} ${n(-Math.sin(a))} ${n(Math.cos(a))} ${n(cx)} ${n(cy)} Tm ${pdfStr(s)} Tj ET`);
    };
    // clip to printable area
    S.push('q', `${n(margin * PT_PER_MM)} ${n(margin * PT_PER_MM)} ${n(uw * PT_PER_MM)} ${n(uh * PT_PER_MM)} re W n`);
    S.push('1 J 1 j');
    if (sq && tileHas(sq, wx0, wyTop, uw, uh)) {
      const [x, y] = T(sq.at);
      S.push('0 0 0 RG 0.5 w', `${n(x)} ${n(y)} ${n(sq.size * PT_PER_MM)} ${n(sq.size * PT_PER_MM)} re S`);
      S.push('0 0 0 rg'); text(add(sq.at, { x: 0, y: -6 }), 4, `${sq.size} mm x ${sq.size} mm calibration square - measure after printing`);
    }
    for (const it of items) {
      it.drawings.forEach((d, di) => {
        const col = it.colors[di] ?? '#000000';
        const isFirst = di === 0;
        S.push(`${rgb(col)} RG 0.6 w [] 0 d`); path(d.cut, true);
        if (!isFirst) return;
        if (d.hasSeam && (opt.sew ?? true)) { S.push('0.85 0.45 0 RG 0.4 w [3 2] 0 d'); path(d.sew, true); S.push('[] 0 d'); }
        S.push('0 0.25 0.75 RG 0.4 w');
        for (const ic of d.internals) { if (ic.type === 'mirror') S.push('[6 2 1 2] 0 d'); path(ic.pts, ic.closed); S.push('[] 0 d'); }
        S.push('0.75 0 0 RG 0.6 w'); for (const nt of d.notches) path([nt.a, nt.b], false);
        S.push('0 0.5 0 RG 0.5 w'); path([d.grain.a, d.grain.b], false);
        { const u = norm(sub(d.grain.b, d.grain.a)), w = perp(u), ah = 6; for (const [tip, dir] of [[d.grain.b, u], [d.grain.a, mul(u, -1)]] as [Vec, Vec][]) path([add(add(tip, mul(dir, -ah)), mul(w, ah / 2.5)), tip, add(add(tip, mul(dir, -ah)), mul(w, -ah / 2.5))], false); }
        S.push('0 0 0 RG 0.4 w');
        for (const dr of d.drills) { const rr = Math.max(dr.d / 2, 1); circle(S, T(dr.p), rr * PT_PER_MM); path([add(dr.p, { x: -rr, y: 0 }), add(dr.p, { x: rr, y: 0 })], false); path([add(dr.p, { x: 0, y: -rr }), add(dr.p, { x: 0, y: rr })], false); }
        S.push('0 0 0 rg');
        const b = bbox(d.sew);
        const sizes = it.drawings.length > 1 ? it.drawings.map(x => x.sizeName).join(' ') : d.sizeName;
        text({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, 6, `${it.name} - ${sizes}`, 0, true);
        for (const t of d.texts) text(t.p, t.size, t.text, t.angleDeg);
      });
    }
    S.push('Q');
    // tile furniture (unclipped, in the margins)
    const m = margin * PT_PER_MM, W = uw * PT_PER_MM, H = uh * PT_PER_MM, o = overlap * PT_PER_MM;
    S.push('0 0 0 RG 0.3 w [] 0 d');
    for (const [x, y] of [[m, m], [m + W, m], [m, m + H], [m + W, m + H]]) {
      const a = 4 * PT_PER_MM; S.push(`${n(x - a)} ${n(y)} m ${n(x + a)} ${n(y)} l S ${n(x)} ${n(y - a)} m ${n(x)} ${n(y + a)} l S`); circle(S, [x, y], 2 * PT_PER_MM);
    }
    // glue strips: right (if a right neighbour) and bottom (if a lower neighbour)
    S.push('0.5 0.5 0.5 RG [2 2] 0 d 0.3 w');
    if (c < cols - 1) S.push(`${n(m + W - o)} ${n(m)} m ${n(m + W - o)} ${n(m + H)} l S`);
    if (r < rows - 1) S.push(`${n(m)} ${n(m + o)} m ${n(m + W)} ${n(m + o)} l S`);
    S.push('[] 0 d 0.4 0.4 0.4 rg');
    const small = (x: number, y: number, s: string, size = 6) => S.push(`BT /F1 ${size} Tf 1 0 0 1 ${n(x)} ${n(y)} Tm ${pdfStr(s)} Tj ET`);
    if (c < cols - 1) small(m + W - o + 2, m + H / 2, `glue ${colLabel(c + 1)}${r + 1} here`);
    if (r < rows - 1) small(m + W / 2, m + 2, `glue ${colLabel(c)}${r + 2} here`);
    S.push('0 0 0 rg');
    small(m, m + H + 4 * PT_PER_MM / 2, `${opt.title ?? doc.style.name} - page ${label} (${labels.length}/${rows * cols}) - 1:1 scale, ${pg.w}x${pg.h} mm, overlap ${overlap} mm`, 7);
    S.push(`BT /F1 14 Tf 1 0 0 1 ${n(m + W - 30)} ${n(m + H + 2)} Tm ${pdfStr(label)} Tj ET`);
    contents.push(S.join('\n'));
  }

  // ── assemble PDF
  const objs: string[] = [];
  const pageCount = contents.length;
  const firstPage = 5;
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, i) => `${firstPage + 2 * i} 0 R`).join(' ')}] /Count ${pageCount} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[4] = `<< /Title ${pdfStr(opt.title ?? doc.style.name)} /Producer (ProwdCAD 2 kernel) /Creator (ProwdCAD) >>`;
  contents.forEach((c, i) => {
    objs[firstPage + 2 * i] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(mediaW)} ${n(mediaH)}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${firstPage + 2 * i + 1} 0 R >>`;
    objs[firstPage + 2 * i + 1] = `<< /Length ${c.length} >>\nstream\n${c}\nendstream`;
  });
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) { offsets[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n` + offsets.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return { bytes, pages: pageCount, cols, rows, labels, mediaBox: [Number(n(mediaW)), Number(n(mediaH))], contentMm: { w: cw, h: ch } };
}

function tileHas(sq: Square, wx0: number, wyTop: number, uw: number, uh: number): boolean {
  return sq.at.x < wx0 + uw && sq.at.x + sq.size > wx0 && sq.at.y - 8 < wyTop && sq.at.y + sq.size > wyTop - uh;
}

function circle(S: string[], c: [number, number], r: number) {
  const k = 0.5522847498 * r; const [x, y] = c;
  S.push(`${n(x + r)} ${n(y)} m ${n(x + r)} ${n(y + k)} ${n(x + k)} ${n(y + r)} ${n(x)} ${n(y + r)} c ${n(x - k)} ${n(y + r)} ${n(x - r)} ${n(y + k)} ${n(x - r)} ${n(y)} c ${n(x - r)} ${n(y - k)} ${n(x - k)} ${n(y - r)} ${n(x)} ${n(y - r)} c ${n(x + k)} ${n(y - r)} ${n(x + r)} ${n(y - k)} ${n(x + r)} ${n(y)} c S`);
}
