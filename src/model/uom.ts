/** Unit-of-measure conversion: pallet -> case (or layer/bundle) -> piece. Integers only, nothing is rounded. */
import type { Sku } from './types';
import { MAX_QTY, ValidationError } from './validate';

export interface Breakdown { pallets: number; cases: number; pieces: number }

export const piecesPerPallet = (s: Sku) => s.caseQty * s.casesPerPallet;

/** Converts a pallet/case/piece entry to pieces. Each part must be a non-negative integer; total must fit MAX_QTY. */
export function toPieces(sku: Sku, b: Partial<Breakdown>): number {
  const parts = [b.pallets ?? 0, b.cases ?? 0, b.pieces ?? 0];
  for (const p of parts) {
    if (!Number.isSafeInteger(p) || p < 0) throw new ValidationError('Pallets, cases and pieces must be whole numbers, zero or more.');
  }
  const total = parts[0] * piecesPerPallet(sku) + parts[1] * sku.caseQty + parts[2];
  if (!Number.isSafeInteger(total) || total > MAX_QTY) throw new ValidationError(`That is more than ${MAX_QTY.toLocaleString('en-CA')} pieces.`);
  return total;
}

/** Splits a piece count into full pallets, full cases and loose pieces. toPieces(breakdown(n)) === n always. */
export function breakdown(sku: Sku, pieces: number): Breakdown {
  if (!Number.isSafeInteger(pieces)) throw new ValidationError('Piece count must be a whole number.');
  const sign = pieces < 0 ? -1 : 1;
  let n = Math.abs(pieces);
  const ppp = piecesPerPallet(sku);
  const pallets = Math.floor(n / ppp); n -= pallets * ppp;
  const cases = Math.floor(n / sku.caseQty); n -= cases * sku.caseQty;
  return { pallets: sign * pallets, cases: sign * cases, pieces: sign * n };
}

export function describe(sku: Sku, pieces: number): string {
  const b = breakdown(sku, Math.abs(pieces));
  const parts: string[] = [];
  if (b.pallets) parts.push(`${b.pallets} pallet${b.pallets === 1 ? '' : 's'}`);
  if (b.cases) parts.push(`${b.cases} ${sku.caseUom}${b.cases === 1 ? '' : 's'}`);
  if (b.pieces || !parts.length) parts.push(`${b.pieces} ${sku.uom}${b.pieces === 1 ? '' : 's'}`);
  return `${pieces < 0 ? '−' : ''}${parts.join(' + ')}`;
}

/** Validates a SKU's pack structure. */
export function checkSkuUom(sku: Sku): void {
  if (!Number.isSafeInteger(sku.caseQty) || sku.caseQty < 1) throw new ValidationError(`${sku.id}: pieces per ${sku.caseUom} must be a whole number of at least 1.`);
  if (!Number.isSafeInteger(sku.casesPerPallet) || sku.casesPerPallet < 1) throw new ValidationError(`${sku.id}: ${sku.caseUom}s per pallet must be a whole number of at least 1.`);
  if (piecesPerPallet(sku) > MAX_QTY) throw new ValidationError(`${sku.id}: pallet is too large.`);
}
