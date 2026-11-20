import type { Ctx, Result, State } from '../src/model/types';
import { emptyState } from '../src/model/seed';
import { loadOpening } from '../src/model/ops';

export const TODAY = '2026-11-20'; // a Friday
export const ctx = (user = 'Tester', today = TODAY, at = `${today}T15:00:00.000Z`): Ctx => ({ user, today, at });

export function ok(r: Result): State {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.error}`);
  return r.state;
}

export function err(r: Result): { code: string; error: string } {
  if (r.ok) throw new Error('expected an error');
  return r;
}

/** Empty company with a little opening stock: TOR-A-01 has two full can pallets and one partial; TOR-A-02 has ends. */
export function small(): State {
  const s = emptyState(TODAY);
  return ok(loadOpening(s, [
    { binId: 'TOR-A-01', skuId: 'CAN-473-BRT', qty: 8169 },
    { binId: 'TOR-A-01', skuId: 'CAN-473-BRT', qty: 8169 },
    { binId: 'TOR-A-01', skuId: 'CAN-473-BRT', qty: 1000 },
    { binId: 'TOR-A-02', skuId: 'END-202-SOT', qty: 72000 },
    { binId: 'TOR-A-01', skuId: 'CTN-4PK-473', qty: 3000 },
  ], ctx('Loader', TODAY, `${TODAY}T08:00:00.000Z`)));
}

export const palletsOf = (s: State, sku: string) => s.pallets.filter((p) => p.skuId === sku).map((p) => p.id);
