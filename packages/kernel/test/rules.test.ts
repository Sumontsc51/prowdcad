import { describe, it, expect } from 'vitest';
import { Document } from '../src/model/doc';
import { makeStyle, makePiece, rectangleContour, makeSizeLine } from '../src/model/factory';
import { sizeIdByName } from '../src/ops/sizes';
import {
  createLibrary, createRuleFromValues, createRuleFromPoint, createRuleSetFromContour, applyRule, detachRule,
  ruleName, loadSizesFromLibrary, refreshRuleLinks, library, findRule,
} from '../src/ops/rules';
import { setGrade } from '../src/ops/grading';

function setup() {
  const doc = new Document(makeStyle('t', ['S', 'M', 'L', 'XL'], 'M'));
  const line = doc.sizeLine();
  const id = (n: string) => sizeIdByName(line, n)!;
  const c = rectangleContour(0, 0, 100, 50);
  const piece = makePiece('FRONT', c, doc.style.activeSizeTableId);
  doc.transact('add', s => s.pieces.push(piece));
  return { doc, piece, id, line, P: c.points };
}

describe('rule libraries', () => {
  it('createRuleFromValues (by size name; incremental + absolute) and applyRule materialises + links', () => {
    const { doc, piece, id, P } = setup();
    const lib = createLibrary(doc, 'Womens');
    const r1 = createRuleFromValues(doc, lib, { M: { dx: 8, dy: 0 }, L: { dx: 10, dy: 2 }, XL: { dx: 12, dy: 2 } }, { name: 'SideSeam' });
    expect(r1.number).toBe(1);
    const r2 = createRuleFromValues(doc, lib, { S: { dx: -5, dy: 0 }, L: { dx: 5, dy: 1 }, XL: { dx: 12, dy: 3 } }, { view: 'absolute' });
    expect(r2.number).toBe(2);
    const ll = library(doc, lib).sizeLine;
    expect(r2.inc[sizeIdByName(ll, 'XL')!]).toEqual({ dx: 7, dy: 2 });
    expect(r2.inc[sizeIdByName(ll, 'M')!]).toEqual({ dx: 5, dy: 0 });
    applyRule(doc, piece.id, P[1].id, 'SideSeam');
    const a = doc.piece(piece.id).sew.points[1];
    expect(a.ruleId).toBe(r1.id);
    expect(a.grade[id('L')]).toEqual({ dx: 10, dy: 2 });
    expect(doc.resolvePiece(piece.id, id('XL')).sew.anchorPos[1]).toEqual({ x: 122, y: 4 });
    expect(doc.resolvePiece(piece.id, id('S')).sew.anchorPos[1]).toEqual({ x: 92, y: 0 });
    applyRule(doc, piece.id, [P[2].id], 2);
    expect(doc.resolvePiece(piece.id, id('XL')).sew.anchorPos[2]).toEqual({ x: 112, y: 53 });
    expect(ruleName(doc, piece.id, P[1].id)).toBe('1 (SideSeam)');
    expect(ruleName(doc, piece.id, P[2].id)).toBe('2');
    expect(ruleName(doc, piece.id, P[0].id)).toBe('');
    detachRule(doc, piece.id, P[1].id);
    expect(doc.piece(piece.id).sew.points[1].ruleId).toBeUndefined();
    expect(doc.piece(piece.id).sew.points[1].grade[id('L')]).toEqual({ dx: 10, dy: 2 });
    expect(() => createRuleFromValues(doc, lib, {}, { number: 1 })).toThrow();
  });
  it('createRuleFromPoint captures live increments; editing the point unlinks; refreshRuleLinks', () => {
    const { doc, piece, id, P } = setup();
    setGrade(doc, piece.id, P[2].id, id('L'), { dx: 6, dy: 3 });
    setGrade(doc, piece.id, P[2].id, id('XL'), { dx: 7, dy: 4 });
    const lib = createLibrary(doc, 'L');
    const r = createRuleFromPoint(doc, lib, piece.id, P[2].id, { number: 10 });
    expect(r.inc[sizeIdByName(library(doc, lib).sizeLine, 'XL')!]).toEqual({ dx: 7, dy: 4 });
    applyRule(doc, piece.id, P[3].id, 10);
    expect(ruleName(doc, piece.id, P[3].id)).toBe('10');
    doc.transact('edit rule', () => { findRule(doc, 10)!.rule.inc[sizeIdByName(library(doc, lib).sizeLine, 'XL')!] = { dx: 1, dy: 1 }; });
    expect(ruleName(doc, piece.id, P[3].id)).toBe('10*');
    expect(refreshRuleLinks(doc, r.id)).toBe(1);
    expect(doc.piece(piece.id).sew.points[3].grade[id('XL')]).toEqual({ dx: 1, dy: 1 });
    setGrade(doc, piece.id, P[3].id, id('L'), { dx: 0, dy: 0 });
    expect(doc.piece(piece.id).sew.points[3].ruleId).toBeUndefined();
  });
  it('createRuleSetFromContour: one numbered rule per grade anchor from the start point', () => {
    const { doc, piece, id, P } = setup();
    setGrade(doc, piece.id, P[1].id, id('XL'), { dx: 10, dy: 0 });
    setGrade(doc, piece.id, P[2].id, id('XL'), { dx: 10, dy: 5 });
    const lib = createLibrary(doc, 'Set');
    const rules = createRuleSetFromContour(doc, lib, piece.id, { startNumber: 101, link: true });
    expect(rules.map(r => r.number)).toEqual([101, 102, 103, 104]);
    const xl = sizeIdByName(library(doc, lib).sizeLine, 'XL')!;
    expect(rules[1].inc[xl]).toEqual({ dx: 10, dy: 0 });
    expect(rules[2].inc[xl]).toEqual({ dx: 10, dy: 5 });
    expect(doc.piece(piece.id).sew.points[2].ruleId).toBe(rules[2].id);
  });
  it('loadSizesFromLibrary adopts the library size line and remaps increments by size name', () => {
    const { doc, piece, id, P } = setup();
    setGrade(doc, piece.id, P[2].id, id('L'), { dx: 10, dy: 5 });
    setGrade(doc, piece.id, P[2].id, id('XL'), { dx: 12, dy: 6 });
    setGrade(doc, piece.id, P[2].id, id('M'), { dx: 8, dy: 4 });
    const lib = createLibrary(doc, 'Ext', makeSizeLine(['XS', 'S', 'M', 'L', 'XL', 'XXL'], 'M'));
    const tid = loadSizesFromLibrary(doc, lib);
    expect(doc.style.activeSizeTableId).toBe(tid);
    const nl = doc.sizeLine(doc.piece(piece.id));
    expect(nl.sizes.map(s => s.name)).toEqual(['XS', 'S', 'M', 'L', 'XL', 'XXL']);
    expect(nl.sizes.every(s => !Object.values(library(doc, lib).sizeLine.sizes).some(o => o.id === s.id))).toBe(true);
    const n = (s: string) => sizeIdByName(nl, s)!;
    const at = (s: string) => doc.resolvePiece(piece.id, n(s)).sew.anchorPos[2];
    expect(at('S')).toEqual({ x: 92, y: 46 });
    expect(at('L')).toEqual({ x: 110, y: 55 });
    expect(at('XL')).toEqual({ x: 122, y: 61 });
    expect(at('XXL')).toEqual({ x: 122, y: 61 }); // new size: zero increment
    expect(at('XS')).toEqual({ x: 92, y: 46 });
  });
});
