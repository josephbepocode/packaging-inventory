import {
  acceptHold, adjustStock, blockingHolds, createTransfer, isBlocked, mergePallets, receiveTransfer, shipOut, splitPallet, submitCount,
  type CountSubmission,
} from '../src/model/ops';
import { binSkuQty, palletLocation, palletsInBin, verifyState } from '../src/model/ledger';
import type { State } from '../src/model/types';
import { exportAudit } from '../src/model/dashboard';
import { ctx, err, ok, palletsOf, small } from './helpers';

const CAN = 'CAN-473-BRT';
const BIN = 'TOR-A-01';

/** Blind count submission where every pallet matches, with optional overrides. */
function count(s: State, binId: string, over: Record<string, number> = {}, loose: Record<string, number> = {}, startedSeq = s.ledger.length): CountSubmission {
  const pallets = Object.fromEntries(palletsInBin(s.ledger, binId, startedSeq).map((p) => [p.palletId, p.qty]));
  return { binId, startedSeq, startedAt: '2026-11-20T14:00:00.000Z', pallets: { ...pallets, ...over }, loose, scheduled: true };
}

function oneShort(): { s: State; p1: string; holdId: string } {
  const s0 = small();
  const p1 = palletsOf(s0, CAN)[0];
  const s = ok(submitCount(s0, count(s0, BIN, { [p1]: 8168 }), ctx('Counter')));
  return { s, p1, holdId: s.holds[0].id };
}

describe('count variance puts the item on hold', () => {
  it('a matching count places no hold', () => {
    const s = small();
    const r = ok(submitCount(s, count(s, BIN), ctx()));
    expect(r.holds).toHaveLength(0);
    expect(r.counts[0].lines).toHaveLength(4);
    expect(r.counts[0].lines.every((l) => l.countedQty === l.systemQty)).toBe(true);
  });

  it('one piece short on one pallet places a hold and is visible in the audit log and CSV', () => {
    const { s, p1 } = oneShort();
    expect(s.holds).toMatchObject([{ binId: BIN, skuId: CAN, palletId: p1, kind: 'variance', systemQty: 8169, countedQty: 8168, resolved: false }]);
    expect(isBlocked(s, BIN, CAN)).toBe(true);
    const placed = s.audit.find((a) => a.action === 'hold.place')!;
    expect(placed.detail).toContain(`${p1} ${CAN} in ${BIN} system 8169 counted 8168 (-1)`);
    expect(placed.user).toBe('Counter');
    expect(s.audit.find((a) => a.action === 'count.submit')!.detail).toContain(`${p1} ${CAN} sys 8169 cnt 8168`);
    expect(exportAudit(s)).toContain('hold.place');
    expect(s.ledger).toHaveLength(5); // a count never changes stock by itself
  });

  it('one piece over also holds', () => {
    const s0 = small();
    const p3 = palletsOf(s0, CAN)[2];
    const s = ok(submitCount(s0, count(s0, BIN, { [p3]: 1001 }), ctx()));
    expect(s.holds[0]).toMatchObject({ palletId: p3, systemQty: 1000, countedQty: 1001 });
  });

  it('a pallet the system has but the counter did not find counts as zero and holds', () => {
    const s0 = small();
    const sub = count(s0, BIN);
    const p2 = palletsOf(s0, CAN)[1];
    delete sub.pallets[p2];
    const s = ok(submitCount(s0, sub, ctx()));
    expect(s.holds[0]).toMatchObject({ palletId: p2, systemQty: 8169, countedQty: 0 });
  });

  it('unlabelled pieces found place a hold with no pallet; accepting creates a new LPN', () => {
    const s0 = small();
    const s = ok(submitCount(s0, count(s0, 'TOR-B-01', {}, { 'CTN-4PK-473': 50 }), ctx()));
    expect(s.holds[0]).toMatchObject({ binId: 'TOR-B-01', palletId: '', systemQty: 0, countedQty: 50 });
    const r = ok(acceptHold(s, s.holds[0].id, 'Bundle found on floor, relabelled', ctx('Supervisor')));
    const np = r.pallets.at(-1)!;
    expect(np.skuId).toBe('CTN-4PK-473');
    expect(palletLocation(r.ledger, np.id)).toEqual({ location: 'TOR-B-01', qty: 50 });
  });

  it('other SKUs in the bin and the same SKU in other bins are not blocked', () => {
    const { s } = oneShort();
    expect(ok(shipOut(s, { binId: BIN, skuId: 'CTN-4PK-473', qty: 10, reference: 'run 9' }, ctx())).shipments).toHaveLength(1);
    const elsewhere = ok(adjustStock(s, { binId: 'TOR-B-01', skuId: CAN, delta: 100, reason: 'Found stock' }, ctx()));
    expect(ok(shipOut(elsewhere, { binId: 'TOR-B-01', skuId: CAN, qty: 10, reference: 'run 9' }, ctx())).shipments).toHaveLength(1);
  });
});

describe('a hold blocks every outbound path in the logic layer', () => {
  const { s, p1 } = oneShort();
  const [, p2, p3] = palletsOf(s, CAN);
  const attempts: [string, () => ReturnType<typeof shipOut>][] = [
    ['shipment', () => shipOut(s, { binId: BIN, skuId: CAN, qty: 1, reference: 'run 1' }, ctx())],
    ['shipment from a different, matching pallet', () => shipOut(s, { binId: BIN, skuId: CAN, qty: 1, reference: 'run 1', palletId: p3 }, ctx())],
    ['transfer', () => createTransfer(s, { fromBin: BIN, toBin: 'LAK-S-01', skuId: CAN, qty: 1 }, ctx())],
    ['whole-pallet transfer', () => createTransfer(s, { fromBin: BIN, toBin: 'LAK-S-01', skuId: CAN, qty: 8169, palletId: p2 }, ctx())],
    ['split', () => splitPallet(s, p1, 1, ctx())],
    ['merge out of the held pallet', () => mergePallets(s, p1, p2, ctx())],
    ['merge between other pallets of the held SKU', () => mergePallets(s, p3, p2, ctx())],
    ['negative adjustment', () => adjustStock(s, { binId: BIN, skuId: CAN, delta: -1, reason: 'Damaged can' }, ctx())],
  ];
  it.each(attempts)('refuses %s with ON_HOLD and changes nothing', (_, attempt) => {
    const before = JSON.stringify(s);
    const r = attempt();
    expect(err(r).code).toBe('ON_HOLD');
    expect(JSON.stringify(s)).toBe(before);
  });

  it('still allows stock in (receipts, positive adjustments) without lifting the hold', () => {
    const r = ok(adjustStock(s, { binId: BIN, skuId: CAN, delta: 389, reason: 'Layer returned from line' }, ctx()));
    expect(isBlocked(r, BIN, CAN)).toBe(true);
  });

  it('cannot be bypassed by flipping the resolved flag on the hold', () => {
    const forged = structuredClone(s);
    forged.holds[0].resolved = true;
    expect(blockingHolds(forged, BIN, CAN)).toHaveLength(1);
    expect(err(shipOut(forged, { binId: BIN, skuId: CAN, qty: 1, reference: 'run 1' }, ctx())).code).toBe('ON_HOLD');
    expect(verifyState(forged).join(' ')).toMatch(/without a reconciliation/);
    const fake = structuredClone(forged);
    fake.holds[0].reconciliationId = 'RCN-FAKE';
    expect(err(shipOut(fake, { binId: BIN, skuId: CAN, qty: 1, reference: 'run 1' }, ctx())).code).toBe('ON_HOLD');
  });
});

describe('reconciliation releases a hold', () => {
  it('accepting the count needs a reason, posts the exact piece difference, and unblocks', () => {
    const { s, p1, holdId } = oneShort();
    expect(err(acceptHold(s, holdId, '', ctx())).code).toBe('INVALID');
    expect(err(acceptHold(s, holdId, 'ok', ctx())).code).toBe('INVALID');
    const r = ok(acceptHold(s, holdId, 'Short can confirmed by second counter', ctx('Supervisor')));
    const e = r.ledger.at(-1)!;
    expect(e).toMatchObject({ kind: 'reconcile', palletId: p1, qty: -1, before: 8169, after: 8168, ref: holdId, user: 'Supervisor' });
    expect(r.reconciliations).toMatchObject([{ holdId, method: 'accept-count', delta: -1, user: 'Supervisor' }]);
    expect(r.holds[0]).toMatchObject({ resolved: true, reconciliationId: r.reconciliations[0].id });
    expect(r.audit.at(-1)).toMatchObject({ action: 'hold.reconcile', reason: 'Short can confirmed by second counter' });
    expect(r.audit.at(-1)!.detail).toContain(`${p1} ${CAN} @${BIN}: 8169→8168 (-1)`);
    expect(binSkuQty(r.ledger, BIN, CAN)).toBe(17337);
    expect(isBlocked(r, BIN, CAN)).toBe(false);
    expect(ok(shipOut(r, { binId: BIN, skuId: CAN, qty: 1, reference: 'run 1' }, ctx())).shipments).toHaveLength(1);
    expect(err(acceptHold(r, holdId, 'Accept it again please', ctx())).code).toBe('INVALID');
    expect(verifyState(r)).toEqual([]);
  });

  it('accepting uses the variance, so stock received after the count is not lost', () => {
    const { s, holdId } = oneShort();
    const topped = ok(adjustStock(s, { binId: BIN, skuId: CAN, delta: 100, reason: 'Returned from line' }, ctx()));
    const r = ok(acceptHold(topped, holdId, 'Accepting the short count', ctx()));
    expect(binSkuQty(r.ledger, BIN, CAN)).toBe(17338 + 100 - 1);
  });

  it('a recount that matches releases the hold with a recount record and no stock change', () => {
    const { s, holdId } = oneShort();
    const r = ok(submitCount(s, count(s, BIN), ctx('Second counter')));
    expect(r.holds[0]).toMatchObject({ id: holdId, resolved: true });
    expect(r.reconciliations[0]).toMatchObject({ method: 'recount-matched', delta: 0, holdId });
    expect(r.counts.at(-1)!.recount).toBe(true);
    expect(r.ledger).toHaveLength(s.ledger.length);
    expect(isBlocked(r, BIN, CAN)).toBe(false);
    expect(r.audit.some((a) => a.action === 'hold.release')).toBe(true);
  });

  it('a recount that still disagrees keeps the hold and records the new count', () => {
    const { s, p1, holdId } = oneShort();
    const r = ok(submitCount(s, count(s, BIN, { [p1]: 8167 }), ctx()));
    expect(r.holds).toHaveLength(1);
    expect(r.holds[0]).toMatchObject({ id: holdId, countedQty: 8167, resolved: false });
    expect(r.holds[0].countIds).toHaveLength(2);
    const a = ok(acceptHold(r, holdId, 'Two cans crushed, accepted', ctx()));
    expect(a.ledger.at(-1)!.qty).toBe(-2);
  });
});

describe('counts taken while stock moved', () => {
  it('a pallet that moved mid-count and does not match either figure gets a recount-only hold', () => {
    const s0 = small();
    const p3 = palletsOf(s0, CAN)[2];
    const startedSeq = s0.ledger.length;
    const moved = ok(shipOut(s0, { binId: BIN, skuId: CAN, qty: 100, reference: 'run 5', palletId: p3 }, ctx()));
    const r = ok(submitCount(moved, count(s0, BIN, { [p3]: 950 }, {}, startedSeq), ctx()));
    expect(r.holds[0]).toMatchObject({ palletId: p3, kind: 'moved' });
    expect(err(acceptHold(r, r.holds[0].id, 'Accept it anyway', ctx())).code).toBe('RECOUNT_REQUIRED');
    const re = ok(submitCount(r, count(r, BIN, { [p3]: 900 }), ctx()));
    expect(re.holds[0].resolved).toBe(true);
  });

  it('accepts a mid-count move when the counted figure matches before or after the move', () => {
    const s0 = small();
    const p3 = palletsOf(s0, CAN)[2];
    const startedSeq = s0.ledger.length;
    const moved = ok(shipOut(s0, { binId: BIN, skuId: CAN, qty: 100, reference: 'run 5', palletId: p3 }, ctx()));
    expect(ok(submitCount(moved, count(s0, BIN, { [p3]: 900 }, {}, startedSeq), ctx())).holds).toHaveLength(0);
    expect(ok(submitCount(moved, count(s0, BIN, { [p3]: 1000 }, {}, startedSeq), ctx())).holds).toHaveLength(0);
  });

  it('a pallet that arrived after the count started and was not scanned is noted, not held', () => {
    const s0 = small();
    const startedSeq = s0.ledger.length;
    const arrived = ok(adjustStock(s0, { binId: BIN, skuId: CAN, delta: 50, reason: 'Late put-away' }, ctx()));
    const r = ok(submitCount(arrived, count(s0, BIN, {}, {}, startedSeq), ctx()));
    expect(r.holds).toHaveLength(0);
    expect(r.counts[0].notes.join(' ')).toMatch(/arrived after the count started/);
  });

  it('a pallet that left whole during the count and was not scanned is fine', () => {
    const s0 = small();
    const p1 = palletsOf(s0, CAN)[0];
    const startedSeq = s0.ledger.length;
    const t = ok(createTransfer(s0, { fromBin: BIN, toBin: 'LAK-S-01', skuId: CAN, qty: 8169, palletId: p1 }, ctx()));
    const sub = count(s0, BIN, {}, {}, startedSeq);
    delete sub.pallets[p1];
    expect(ok(submitCount(ok(receiveTransfer(t, t.transfers[0].id, ctx())), sub, ctx())).holds).toHaveLength(0);
  });

  it('rejects counting a pallet registered to another bin, and bad start points', () => {
    const s0 = small();
    const end = palletsOf(s0, 'END-202-SOT')[0];
    expect(err(submitCount(s0, count(s0, BIN, { [end]: 72000 }), ctx())).error).toMatch(/registered to TOR-A-02/);
    expect(err(submitCount(s0, { ...count(s0, BIN), startedSeq: 999 }, ctx())).code).toBe('INVALID');
    expect(err(submitCount(s0, count(s0, BIN, { [palletsOf(s0, CAN)[0]]: 1.5 as number }), ctx())).code).toBe('INVALID');
  });
});
