/** Input validation and exact number handling. No floats are used for stored quantities or prices. */

export const MAX_QTY = 10_000_000;
/** $10,000.0000 per unit, in price4. */
export const MAX_PRICE4 = 100_000_000;
export const MIN_REASON = 5;

export class ValidationError extends Error {}

/** A positive whole number of units, 1..MAX_QTY. Accepts numbers or strings like "8,169". */
export function parseQty(v: unknown, label = 'Quantity', allowZero = false): number {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string') {
    const s = v.trim().replace(/,/g, '');
    if (!/^\d+$/.test(s)) throw new ValidationError(`${label} must be a whole number of units.`);
    n = Number(s);
  } else throw new ValidationError(`${label} is required.`);
  if (!Number.isSafeInteger(n)) throw new ValidationError(`${label} must be a whole number of units.`);
  if (n < 0 || (n === 0 && !allowZero)) throw new ValidationError(`${label} must be ${allowZero ? 'zero or more' : 'at least 1'}.`);
  if (n > MAX_QTY) throw new ValidationError(`${label} cannot exceed ${MAX_QTY.toLocaleString('en-CA')}.`);
  return n;
}

/** Dollar price string with up to 4 decimals ("0.0912", "1.2") to integer price4. Numbers must already be price4 integers. */
export function parsePrice4(v: unknown, label = 'Unit price'): number {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string') {
    const s = v.trim().replace(/^\$/, '');
    const m = /^(\d{1,5})(?:\.(\d{1,4}))?$/.exec(s);
    if (!m) throw new ValidationError(`${label} must be a dollar amount with at most 4 decimals, e.g. 0.0912.`);
    n = Number(m[1]) * 10_000 + Number((m[2] ?? '').padEnd(4, '0'));
  } else throw new ValidationError(`${label} is required.`);
  if (!Number.isSafeInteger(n) || n <= 0) throw new ValidationError(`${label} must be more than $0.`);
  if (n > MAX_PRICE4) throw new ValidationError(`${label} cannot exceed $10,000 per unit.`);
  return n;
}

export function formatPrice4(p: number): string {
  const whole = Math.floor(p / 10_000);
  const frac = String(p % 10_000).padStart(4, '0');
  return `$${whole.toLocaleString('en-CA')}.${frac}`;
}

/** Extended value in cents, rounded half-up, computed with integers only. */
export function extendedCents(qty: number, price4: number): number {
  const big = BigInt(qty) * BigInt(price4); // price4 * qty = 1/10,000 dollars
  return Number((big + 50n) / 100n);
}

export function formatCents(c: number): string {
  const sign = c < 0 ? '-' : '';
  const a = Math.abs(c);
  return `${sign}$${Math.floor(a / 100).toLocaleString('en-CA')}.${String(a % 100).padStart(2, '0')}`;
}

/** Strict YYYY-MM-DD calendar date (rejects 2026-02-30 etc). */
export function isDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (y < 2000 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function parseDate(v: unknown, label = 'Date'): string {
  const s = typeof v === 'string' ? v.trim() : v;
  if (!isDate(s)) throw new ValidationError(`${label} must be a real date (YYYY-MM-DD).`);
  return s;
}

export function requireText(v: unknown, label: string, min = 1, max = 500): string {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  if (s.length < min) throw new ValidationError(min <= 1 ? `${label} is required.` : `${label} needs at least ${min} characters.`);
  if (s.length > max) throw new ValidationError(`${label} is too long (max ${max} characters).`);
  return s;
}

/** Bin codes: SITE-ZONE-NN style, upper case letters, digits and dashes. */
export function isBinCode(s: string): boolean {
  return /^[A-Z0-9]{2,6}(-[A-Z0-9]{1,4}){1,3}$/.test(s);
}

/** |actual - expected| > tolerance (basis points of expected), with integers only. */
export function exceedsTolerance(expected: number, actual: number, bp: number): boolean {
  const diff = BigInt(Math.abs(actual - expected));
  return diff * 10_000n > BigInt(bp) * BigInt(expected);
}

/** Signed variance percent for display only. */
export function variancePct(expected: number, actual: number): number {
  if (expected === 0) return actual === 0 ? 0 : 100;
  return Math.round(((actual - expected) / expected) * 1000) / 10;
}

// ---- dates ----
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export function dayOfWeek(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const isWorkingDay = (date: string) => { const w = dayOfWeek(date); return w !== 0 && w !== 6; };

/** Working days from a to b (a counts as 0). Negative if b is before a. Weekend b is counted as the previous working day. */
export function workingDaysBetween(a: string, b: string): number {
  if (b < a) return -workingDaysBetween(b, a);
  let n = 0;
  let d = a;
  while (d < b) { d = addDays(d, 1); if (isWorkingDay(d)) n++; }
  return n;
}

export function nextWorkingDay(date: string): string {
  let d = date;
  while (!isWorkingDay(d)) d = addDays(d, 1);
  return d;
}

/** Local business date for a Date. */
export function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The date n working days after (or before, for negative n) a working day. */
export function addWorkingDays(date: string, n: number): string {
  let d = date;
  let left = Math.abs(n);
  const step = n < 0 ? -1 : 1;
  while (left > 0) { d = addDays(d, step); if (isWorkingDay(d)) left--; }
  return d;
}
