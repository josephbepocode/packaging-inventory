import { adjustStock, createTransfer, mergePallets, receiveTransfer, shipOut, splitPallet } from '../src/model/ops';
import { binSkuQty, palletBalances, palletLocation, siteTotals, verifyState } from '../src/model/ledger';
import type { State } from '../src/model/types';
import { createRng } from '../src/model/rng';
import { ctx, err, ok, palletsOf, small } from './helpers';

const CAN = 'CAN-473-BRT';
const sumPallets = (s: State, site: string, sku: string) => {
  const bins = new Set(s.bins.filter((b) => b.siteId === site).map((b) => b.id));
  return [...palletBalances(s.ledger).values()].filter((b) => bins.has(b.location) && b.skuId === sku).reduce((a, b) => a + b.qty, 0);
};
const total = (s: State, sku: string) => [...palletBalances(s.ledger).values()].filter((b) => b.skuId === sku).reduce((a, b) => a + b.qty, 0);

describe('ledger basics', () => {
  it('derives on-hand only from entries and records pallet before/after', () => {
    const s = small();
    expect(binSkuQty(s.ledger, 'TOR-A-01', CAN)).toBe(17338);
    for (const e of s.ledger) { expect(e.before).toBe(0); expect(e.after).toBe(e.qty); }
    expect(verifyState(s)).toEqual([]);
  });

  it('entries are frozen and cannot be edited in place', () => {
    const s = ok(shipOut(small(), { binId: 'TOR-A-01', skuId: CAN, qty: 1, reference: 'run 1' }, ctx()));
    const e = s.ledger.at(-1)!;
    expect(Object.isFrozen(e)).toBe(true);
    expect(() => { (e as { qty: number }).qty = 5; }).toThrow();
    expect(Object.isFrozen(s.audit.at(-1)!)).toBe(true);
  });

  it('verifyState catches tampering: edited quantity, removed entry, edited audit, broken before/after', () => {
    const s = ok(shipOut(small(), { binId: 'TOR-A-01', skuId: CAN, qty: 10, reference: 'run 1' }, ctx()));
    const t1 = structuredClone(s); t1.ledger[2] = { ...t1.ledger[2], qty: 999 };
    expect(verifyState(t1).join(' ')).toMatch(/altered/);
    const t2 = structuredClone(s); t2.ledger.splice(1, 1);
    expect(verifyState(t2).length).toBeGreaterThan(0);
    const t3 = structuredClone(s); t3.audit[0] = { ...t3.audit[0], user: 'Someone else' };
    expect(verifyState(t3).join(' ')).toMatch(/Audit entry 1/);
    const t4 = structuredClone(s); t4.audit.pop();
    expect(verifyState(t4)).toEqual([]); // trailing removal can't be detected by a chain alone...
    expect(t4.audit.length).toBe(s.audit.length - 1); // ...so exports carry seq numbers and hashes for external comparison
  });
});

describe('outbound picks and partial pallets', () => {
  it('ships FIFO across pallets, breaking the last one, with exact totals', () => {
    const s = small();
    const [p1, p2, p3] = palletsOf(s, CAN);
    const r = ok(shipOut(s, { binId: 'TOR-A-01', skuId: CAN, qty: 9000, reference: 'Run LAK-1' }, ctx()));
    const bal = (p: string) => palletLocation(r.ledger, p)?.qty ?? 0;
    expect([bal(p1), bal(p2), bal(p3)]).toEqual([0, 8169 - 831, 1000]);
    expect(total(r, CAN)).toBe(17338 - 9000);
    const out = r.ledger.filter((e) => e.kind === 'ship');
    expect(out.map((e) => [e.palletId, e.before, e.qty, e.after])).toEqual([[p1, 8169, -8169, 0], [p2, 8169, -831, 7338]]);
    expect(r.audit.at(-1)!.detail).toContain(`${p2} ${CAN} @TOR-A-01: 8169→7338 (-831)`);
  });

  it('can pick a single piece from a named pallet', () => {
    const s = small();
    const p3 = palletsOf(s, CAN)[2];
    const r = ok(shipOut(s, { binId: 'TOR-A-01', skuId: CAN, qty: 1, reference: 'QA sample', palletId: p3 }, ctx()));
    expect(palletLocation(r.ledger, p3)!.qty).toBe(999);
  });

  it('refuses to go negative and leaves state untouched', () => {
    const s = small();
    const before = JSON.stringify(s);
    expect(err(shipOut(s, { binId: 'TOR-A-01', skuId: CAN, qty: 17339, reference: 'too much' }, ctx())).code).toBe('INSUFFICIENT_STOCK');
    expect(err(shipOut(s, { binId: 'TOR-A-01', skuId: CAN, qty: 1001, reference: 'x1', palletId: palletsOf(s, CAN)[2] }, ctx())).code).toBe('INSUFFICIENT_STOCK');
    expect(err(adjustStock(s, { binId: 'TOR-A-02', skuId: CAN, delta: '-1', reason: 'Damaged in handling' }, ctx())).code).toBe('INSUFFICIENT_STOCK');
    expect(JSON.stringify(s)).toBe(before);
  });

  it('validates ship input', () => {
    const s = small();
    expect(err(shipOut(s, { binId: 'TOR-A-01', skuId: CAN, qty: '2.5', reference: 'run' }, ctx())).code).toBe('INVALID');
    expect(err(shipOut(s, { binId: 'TOR-A-01', skuId: CAN, qty: 1, reference: '' }, ctx())).code).toBe('INVALID');
    expect(err(shipOut(s, { binId: 'TOR-A-01', skuId: CAN, qty: 1, reference: 'run', palletId: palletsOf(s, 'END-202-SOT')[0] }, ctx())).code).toBe('INVALID');
  });
});

describe('transfers are two-step and atomic', () => {
  it('whole pallets keep their LPN; partial picks get a new LPN; transit holds the stock in between', () => {
    const s = small();
    const [p1, p2] = palletsOf(s, CAN);
    const t = ok(createTransfer(s, { fromBin: 'TOR-A-01', toBin: 'LAK-S-01', skuId: CAN, qty: 8169 + 100 }, ctx()));
    const tr = t.transfers[0];
    expect(tr.status).toBe('in-transit');
    expect(tr.palletMoves[0]).toEqual({ from: p1, to: p1, qty: 8169 });
    expect(tr.palletMoves[1].from).toBe(p2);
    expect(tr.palletMoves[1].to).not.toBe(p2);
    expect(siteTotals(t).get('TRANSIT')!.get(CAN)).toBe(8269);
    expect(sumPallets(t, 'TOR', CAN)).toBe(17338 - 8269);
    expect(sumPallets(t, 'LAK', CAN)).toBe(0);
    expect(total(t, CAN)).toBe(17338);
    const r = ok(receiveTransfer(t, tr.id, ctx('Receiver')));
    expect(sumPallets(r, 'LAK', CAN)).toBe(8269);
    expect(siteTotals(r).get('TRANSIT')).toBeUndefined();
    expect(palletLocation(r.ledger, p1)).toEqual({ location: 'LAK-S-01', qty: 8169 });
    expect(total(r, CAN)).toBe(17338);
    expect(verifyState(r)).toEqual([]);
    expect(err(receiveTransfer(r, tr.id, ctx())).code).toBe('INVALID');
  });

  it('a failing transfer posts nothing (no half moves)', () => {
    const s = small();
    const r = createTransfer(s, { fromBin: 'TOR-A-01', toBin: 'LAK-S-01', skuId: CAN, qty: 17339 }, ctx());
    expect(err(r).code).toBe('INSUFFICIENT_STOCK');
    expect(s.ledger).toHaveLength(5);
    expect(err(createTransfer(s, { fromBin: 'TOR-A-01', toBin: 'TOR-A-01', skuId: CAN, qty: 1 }, ctx())).code).toBe('INVALID');
    expect(err(createTransfer(s, { fromBin: 'TOR-A-01', toBin: 'NOPE', skuId: CAN, qty: 1 }, ctx())).code).toBe('NOT_FOUND');
  });
});

describe('splits and merges keep piece totals exact', () => {
  it('split moves exactly N pieces to a new LPN in the same bin', () => {
    const s = small();
    const p1 = palletsOf(s, CAN)[0];
    const r = ok(splitPallet(s, p1, '389', ctx()));
    const np = r.pallets.at(-1)!.id;
    expect(palletLocation(r.ledger, p1)).toEqual({ location: 'TOR-A-01', qty: 7780 });
    expect(palletLocation(r.ledger, np)).toEqual({ location: 'TOR-A-01', qty: 389 });
    expect(binSkuQty(r.ledger, 'TOR-A-01', CAN)).toBe(17338);
    expect(err(splitPallet(s, p1, 8169, ctx())).error).toMatch(/at least one piece/);
    expect(err(splitPallet(s, p1, 0, ctx())).code).toBe('INVALID');
  });

  it('merge moves every piece and empties the source LPN', () => {
    const s = small();
    const [, p2, p3] = palletsOf(s, CAN);
    const r = ok(mergePallets(s, p3, p2, ctx()));
    expect(palletLocation(r.ledger, p3)).toBeNull();
    expect(palletLocation(r.ledger, p2)!.qty).toBe(9169);
    expect(binSkuQty(r.ledger, 'TOR-A-01', CAN)).toBe(17338);
    expect(err(mergePallets(s, p2, p2, ctx())).code).toBe('INVALID');
    expect(err(mergePallets(s, p2, palletsOf(s, 'CTN-4PK-473')[0], ctx())).error).toMatch(/Cannot merge/);
    expect(err(mergePallets(s, p2, palletsOf(s, 'END-202-SOT')[0], ctx())).error).toMatch(/Cannot merge/);
  });
});

describe('site totals always equal the sum of pallet piece counts (randomised operations)', () => {
  it('holds after 300 random valid and invalid operations', () => {
    const rng = createRng(42);
    let s = small();
    const start = total(s, CAN) + total(s, 'END-202-SOT') + total(s, 'CTN-4PK-473');
    let shipped = 0; let adjusted = 0;
    const bins = ['TOR-A-01', 'TOR-A-02', 'TOR-B-01', 'LAK-S-01', 'MIS-A-01'];
    for (let i = 0; i < 300; i++) {
      const sku = rng.pick([CAN, 'END-202-SOT', 'CTN-4PK-473']);
      const pallets = [...palletBalances(s.ledger).values()].filter((b) => b.skuId === sku && !b.location.startsWith('TRANSIT'));
      const op = rng.int(0, 5);
      const q = rng.int(1, 9000);
      let r;
      if (op === 0) r = shipOut(s, { binId: rng.pick(bins), skuId: sku, qty: q, reference: `run ${i}` }, ctx());
      else if (op === 1) r = createTransfer(s, { fromBin: rng.pick(bins), toBin: rng.pick(bins), skuId: sku, qty: q }, ctx());
      else if (op === 2 && s.transfers.some((t) => t.status === 'in-transit')) r = receiveTransfer(s, s.transfers.find((t) => t.status === 'in-transit')!.id, ctx());
      else if (op === 3 && pallets.length) r = splitPallet(s, rng.pick(pallets).palletId, rng.int(1, 500), ctx());
      else if (op === 4 && pallets.length > 1) r = mergePallets(s, pallets[0].palletId, pallets[1].palletId, ctx());
      else r = adjustStock(s, { binId: rng.pick(bins), skuId: sku, delta: rng.chance(0.5) ? `-${q}` : `${q}`, reason: 'Random test adjustment' }, ctx());
      if (r.ok) {
        const last = r.state.audit.at(-1)!;
        if (last.action === 'stock.ship') shipped += r.state.shipments.at(-1)!.qty;
        if (last.action === 'stock.adjust') adjusted += r.state.ledger.filter((e) => e.txn === r.state.ledger.at(-1)!.txn).reduce((a, e) => a + e.qty, 0);
        s = r.state;
      }
      const totals = siteTotals(s);
      for (const site of ['TOR', 'MIS', 'LAK', 'NIA']) for (const k of [CAN, 'END-202-SOT', 'CTN-4PK-473']) {
        expect(totals.get(site)?.get(k) ?? 0).toBe(sumPallets(s, site, k));
      }
    }
    expect(verifyState(s)).toEqual([]);
    const now = total(s, CAN) + total(s, 'END-202-SOT') + total(s, 'CTN-4PK-473');
    expect(now).toBe(start - shipped + adjusted);
    for (const b of palletBalances(s.ledger).values()) { expect(b.qty).toBeGreaterThan(0); expect(Number.isInteger(b.qty)).toBe(true); }
  });
});

describe('adjustments', () => {
  it('need a reason and integer pieces; positive creates or tops up an LPN', () => {
    const s = small();
    expect(err(adjustStock(s, { binId: 'TOR-A-01', skuId: CAN, delta: '-1', reason: '' }, ctx())).code).toBe('INVALID');
    expect(err(adjustStock(s, { binId: 'TOR-A-01', skuId: CAN, delta: '1.5', reason: 'Found stock' }, ctx())).code).toBe('INVALID');
    expect(err(adjustStock(s, { binId: 'TOR-A-01', skuId: CAN, delta: '0', reason: 'Found stock' }, ctx())).code).toBe('INVALID');
    const up = ok(adjustStock(s, { binId: 'TOR-B-01', skuId: CAN, delta: '+24', reason: 'Found behind racking' }, ctx()));
    expect(up.pallets).toHaveLength(s.pallets.length + 1);
    expect(binSkuQty(up.ledger, 'TOR-B-01', CAN)).toBe(24);
    const p1 = palletsOf(s, CAN)[0];
    expect(err(adjustStock(s, { binId: 'TOR-B-01', skuId: CAN, delta: '5', reason: 'Top up wrong bin', palletId: p1 }, ctx())).error).toMatch(/one place/);
  });
});
