/**
 * Units. Internal unit is ALWAYS millimetres (float64).
 * Display may be mm / cm / inch; inch input accepts decimals AND fractions:
 *   "1.125"  ≡ "1 1/8" ≡ "1.1/8" ≡ "1-1/8" ≡ "9/8"
 */
export type Unit = 'mm' | 'cm' | 'in';

export const MM_PER_UNIT: Record<Unit, number> = { mm: 1, cm: 10, in: 25.4 };

/** Parse a user-typed number in the given unit into mm. Returns NaN on failure. */
export function parseLength(text: string, unit: Unit): number {
  const v = parseNumber(text);
  return Number.isNaN(v) ? NaN : v * MM_PER_UNIT[unit];
}

/**
 * Parse a plain number allowing fraction forms. Unit-agnostic.
 *   "3"  "3.5"  "-0.25"  "1/2"  "1 1/2"  "1.1/2"  "1-1/2"  "-1 3/8"
 * Also accepts an explicit unit suffix (mm|cm|in|") which overrides nothing here —
 * use parseLengthAuto for that.
 */
export function parseNumber(raw: string): number {
  let s = raw.trim().replace(/,/g, '.');
  if (!s) return NaN;
  let sign = 1;
  if (s[0] === '-') { sign = -1; s = s.slice(1).trim(); }
  else if (s[0] === '+') { s = s.slice(1).trim(); }
  // whole + fraction:  "1 1/8", "1.1/8", "1-1/8"
  let m = /^(\d+)\s*[\s.\-]\s*(\d+)\s*\/\s*(\d+)$/.exec(s);
  if (m) {
    const d = Number(m[3]);
    if (d === 0) return NaN;
    return sign * (Number(m[1]) + Number(m[2]) / d);
  }
  // pure fraction "9/8"
  m = /^(\d+)\s*\/\s*(\d+)$/.exec(s);
  if (m) {
    const d = Number(m[2]);
    if (d === 0) return NaN;
    return sign * (Number(m[1]) / d);
  }
  // decimal
  if (/^\d*\.?\d+$|^\d+\.$/.test(s)) return sign * Number(s);
  return NaN;
}

/** Parse "12mm" / "1.5cm" / '2 1/4"' / "2in" / bare number (uses defaultUnit). Returns mm. */
export function parseLengthAuto(raw: string, defaultUnit: Unit): number {
  const s = raw.trim();
  const m = /^(.*?)\s*(mm|cm|in|inch|inches|"|”)$/i.exec(s);
  if (m) {
    const u = m[2].toLowerCase();
    const unit: Unit = u === 'mm' ? 'mm' : u === 'cm' ? 'cm' : 'in';
    return parseLength(m[1], unit);
  }
  return parseLength(s, defaultUnit);
}

export interface FormatOptions {
  unit: Unit;
  /** decimals for mm/cm/in-decimal display */
  decimals?: number;
  /** when unit is 'in', show as fraction with this denominator (8, 16, 32, 64) */
  fractionDenominator?: number;
}

/** Format mm for display. */
export function formatLength(mm: number, opt: FormatOptions): string {
  const v = mm / MM_PER_UNIT[opt.unit];
  if (opt.unit === 'in' && opt.fractionDenominator) {
    return formatFraction(v, opt.fractionDenominator);
  }
  const d = opt.decimals ?? (opt.unit === 'mm' ? 2 : opt.unit === 'cm' ? 3 : 4);
  return stripZeros(v.toFixed(d));
}

export function formatFraction(v: number, denom: number): string {
  const sign = v < 0 ? '-' : '';
  v = Math.abs(v);
  let whole = Math.floor(v);
  let num = Math.round((v - whole) * denom);
  if (num === denom) { whole += 1; num = 0; }
  if (num === 0) return `${sign}${whole}`;
  // reduce
  let g = gcd(num, denom);
  const n = num / g, d = denom / g;
  return whole === 0 ? `${sign}${n}/${d}` : `${sign}${whole} ${n}/${d}`;
}

function gcd(a: number, b: number): number { while (b) { [a, b] = [b, a % b]; } return a; }
function stripZeros(s: string): string { return s.includes('.') ? s.replace(/\.?0+$/, '') : s; }
