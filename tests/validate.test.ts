import { addWorkingDays, exceedsTolerance, extendedCents, formatPrice4, isDate, parseDate, parsePrice4, parseQty, requireText, workingDaysBetween } from '../src/model/validate';

describe('quantity parsing', () => {
  it('accepts whole numbers and thousands separators', () => {
    expect(parseQty('8,169')).toBe(8169);
    expect(parseQty(' 12 ')).toBe(12);
    expect(parseQty(5)).toBe(5);
    expect(parseQty('0', 'Q', true)).toBe(0);
  });
  it.each(['', '1.5', '-3', '1e3', 'abc', '0x10', ' ', '١٢'])('rejects %j', (v) => expect(() => parseQty(v)).toThrow());
  it.each([0, -1, 1.5, NaN, Infinity, 10_000_001, Number.MAX_SAFE_INTEGER + 2])('rejects number %s', (v) => expect(() => parseQty(v)).toThrow());
  it('rejects missing values', () => { expect(() => parseQty(undefined)).toThrow(/required/); expect(() => parseQty(null)).toThrow(); });
});

describe('price parsing is exact (no floats)', () => {
  it('converts to ten-thousandths of a dollar', () => {
    expect(parsePrice4('0.0912')).toBe(912);
    expect(parsePrice4('$1.2')).toBe(12000);
    expect(parsePrice4('32.5')).toBe(325000);
    expect(parsePrice4('0.1')).toBe(1000);
    expect(parsePrice4('0.0001')).toBe(1);
  });
  it.each(['0', '0.0000', '0.00001', '-1', '1,000', 'abc', '', '100000'])('rejects %j', (v) => expect(() => parsePrice4(v)).toThrow());
  it('formats without drift', () => {
    expect(formatPrice4(912)).toBe('$0.0912');
    expect(formatPrice4(1)).toBe('$0.0001');
  });
  it('extends qty x price in integer cents, half-up', () => {
    expect(extendedCents(49014, 912)).toBe(447008); // 49014 * 0.0912 = 4470.0768
    expect(extendedCents(3, 1)).toBe(0);
    expect(extendedCents(50, 1)).toBe(1); // 0.005 rounds up
    expect(extendedCents(10_000_000, 100_000_000)).toBe(10_000_000 * 1_000_000); // $1e10, exact
    // the float version drifts: 0.1 + 0.2 style. Integer maths stays exact.
    expect(extendedCents(3, 1000) + extendedCents(7, 1000)).toBe(extendedCents(10, 1000));
  });
});

describe('dates', () => {
  it('only accepts real calendar dates', () => {
    expect(isDate('2026-11-20')).toBe(true);
    expect(isDate('2028-02-29')).toBe(true);
    for (const bad of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-11-31', '26-11-20', '2026/11/20', '', '1999-01-01', '2026-11-20T00:00']) expect(isDate(bad)).toBe(false);
    expect(() => parseDate('2026-04-31')).toThrow(/real date/);
  });
  it('counts working days, skipping weekends', () => {
    expect(workingDaysBetween('2026-11-20', '2026-11-23')).toBe(1); // Fri -> Mon
    expect(addWorkingDays('2026-11-20', 1)).toBe('2026-11-23');
    expect(addWorkingDays('2026-11-23', -1)).toBe('2026-11-20');
    expect(addWorkingDays('2026-11-02', 20)).toBe('2026-11-30');
  });
});

describe('tolerance', () => {
  it('flags only strictly outside the tolerance, in integers', () => {
    expect(exceedsTolerance(10000, 10200, 200)).toBe(false); // exactly 2%
    expect(exceedsTolerance(10000, 10201, 200)).toBe(true);
    expect(exceedsTolerance(10000, 9800, 200)).toBe(false);
    expect(exceedsTolerance(10000, 9799, 200)).toBe(true);
    expect(exceedsTolerance(912, 912, 0)).toBe(false);
    expect(exceedsTolerance(912, 913, 0)).toBe(true);
  });
});

describe('required text', () => {
  it('trims, collapses spaces and enforces length', () => {
    expect(requireText('  a   b ', 'X')).toBe('a b');
    expect(() => requireText('   ', 'Reason', 5)).toThrow(/at least 5/);
    expect(() => requireText(undefined, 'Reason')).toThrow(/required/);
    expect(() => requireText('x'.repeat(501), 'Reason')).toThrow(/too long/);
  });
});
