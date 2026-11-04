/** Display-unit formatting/parsing on top of the kernel's unit helpers. Internal unit is always mm. */
import { formatLength, parseLengthAuto, parseNumber, type Unit } from '@prowdcad/kernel';
import { settings } from './settings';

export function unit(): Unit { return settings.unit; }
export function unitLabel(): string { return settings.unit === 'in' ? 'in' : settings.unit; }

/** Format mm in the current display unit (inch → fraction when a denominator is set). */
export function fmt(mm: number, decimals?: number): string {
  if (!Number.isFinite(mm)) return '';
  const u = settings.unit;
  const s = formatLength(mm, { unit: u, decimals, fractionDenominator: u === 'in' && settings.fracDen ? settings.fracDen : undefined });
  return s === '-0' ? '0' : s;
}
export function fmtU(mm: number, decimals?: number): string { return `${fmt(mm, decimals)} ${unitLabel()}`; }

/** Parse a typed length ("12.5", "1 1/8", "9/8", "2cm", '1"') in the current display unit → mm (NaN on failure). */
export function parseLen(text: string): number { return parseLengthAuto(text, settings.unit); }

/** Parse a unit-less number that may be a fraction. */
export function parseNum(text: string): number { return parseNumber(text); }

export function fmtDeg(d: number): string { return `${(Math.round(d * 100) / 100).toString()}°`; }
