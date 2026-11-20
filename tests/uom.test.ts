import { SKUS } from '../src/model/seed';
import { breakdown, describe as text, piecesPerPallet, toPieces, checkSkuUom } from '../src/model/uom';
import { createRng } from '../src/model/rng';

describe('unit-of-measure conversion', () => {
  it('pallet -> case -> piece conversion is exact for every SKU', () => {
    for (const s of SKUS) {
      checkSkuUom(s);
      expect(toPieces(s, { pallets: 1 })).toBe(s.caseQty * s.casesPerPallet);
      expect(toPieces(s, { pallets: 2, cases: 3, pieces: 7 })).toBe(2 * piecesPerPallet(s) + 3 * s.caseQty + 7);
    }
  });

  it('never loses or rounds pieces on a round trip (random and boundary values)', () => {
    const rng = createRng(7);
    for (const s of SKUS) {
      const ppp = piecesPerPallet(s);
      const values = [0, 1, s.caseQty - 1, s.caseQty, s.caseQty + 1, ppp - 1, ppp, ppp + 1, 10 * ppp + s.caseQty - 1];
      for (let i = 0; i < 300; i++) values.push(rng.int(0, Math.min(9_999_999, 40 * ppp)));
      for (const v of values) {
        const b = breakdown(s, v);
        expect(toPieces(s, b)).toBe(v);
        expect(b.cases).toBeLessThan(s.casesPerPallet);
        expect(b.pieces).toBeLessThan(s.caseQty);
        expect(Number.isInteger(b.pallets) && Number.isInteger(b.cases) && Number.isInteger(b.pieces)).toBe(true);
      }
    }
  });

  it('accepts unnormalised entries (e.g. 25 layers) and still totals exactly', () => {
    const can = SKUS[0];
    expect(toPieces(can, { cases: 25 })).toBe(25 * 389);
    expect(breakdown(can, 25 * 389)).toEqual({ pallets: 1, cases: 4, pieces: 0 });
  });

  it('rejects fractional, negative and oversized parts', () => {
    const can = SKUS[0];
    expect(() => toPieces(can, { cases: 1.5 })).toThrow();
    expect(() => toPieces(can, { pieces: -1 })).toThrow();
    expect(() => toPieces(can, { pallets: 2000 })).toThrow(/more than/);
  });

  it('describes quantities in packs', () => {
    const can = SKUS[0];
    expect(text(can, 8169 + 389 + 3)).toBe('1 pallet + 1 layer + 3 cans');
    expect(text(can, 0)).toBe('0 cans');
    expect(text(can, -1)).toBe('−1 can');
  });

  it('rejects a broken pack structure', () => {
    expect(() => checkSkuUom({ ...SKUS[0], caseQty: 0 })).toThrow();
    expect(() => checkSkuUom({ ...SKUS[0], casesPerPallet: 2.5 })).toThrow();
  });
});
