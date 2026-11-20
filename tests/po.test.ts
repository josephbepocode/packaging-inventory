import { closePo, createPo, receivePo, resolveMismatch, revisePo, receivedQty } from '../src/model/ops';
import { palletBalances, verifyState } from '../src/model/ledger';
import type { State } from '../src/model/types';
import { ctx, err, ok, small, TODAY } from './helpers';

const base = { supplierId: 'GLC', skuId: 'CAN-473-BRT', qty: 10000, unitPrice: '0.0912', siteId: 'TOR', dueDate: '2026-11-27' };
const withPo = (over: Partial<typeof base> = {}): [State, string] => { const s = ok(createPo(small(), { ...base, ...over }, ctx())); return [s, s.pos[s.pos.length - 1].id]; };
let slip = 0;
const rc = (qty: number, extra: Record<string, unknown> = {}) => ({ date: TODAY, packingSlip: `PS-${++slip}`, qty, unitPrice: '0.0912', binId: 'TOR-RCV-01', ...extra });

describe('creating a PO', () => {
  it('creates an open PO with audit entry and integer price', () => {
    const [s, id] = withPo();
    const po = s.pos.find((p) => p.id === id)!;
    expect(po).toMatchObject({ status: 'open', qty: 10000, unitPrice4: 912, createdBy: 'Tester' });
    expect(s.audit.at(-1)).toMatchObject({ action: 'po.create', entityId: id, user: 'Tester' });
  });

  it.each([
    [{ supplierId: 'NOPE' }, 'NOT_FOUND'],
    [{ supplierId: 'SEC' }, 'INVALID'], // Summit doesn't make cans
    [{ skuId: 'XXX' }, 'NOT_FOUND'],
    [{ siteId: 'ZZZ' }, 'NOT_FOUND'],
    [{ qty: 0 }, 'INVALID'],
    [{ qty: 12.5 }, 'INVALID'],
    [{ qty: -5 }, 'INVALID'],
    [{ unitPrice: '0' }, 'INVALID'],
    [{ unitPrice: '0.00001' }, 'INVALID'],
    [{ dueDate: '2026-11-19' }, 'INVALID'], // in the past
    [{ dueDate: '2026-02-30' }, 'INVALID'],
    [{ dueDate: '' }, 'INVALID'],
  ])('rejects %j', (over, code) => {
    const s = small();
    const r = createPo(s, { ...base, ...(over as object) }, ctx());
    expect(err(r).code).toBe(code);
  });

  it('requires a signed-in user and a valid clock', () => {
    expect(err(createPo(small(), base, ctx(''))).code).toBe('INVALID');
    expect(err(createPo(small(), base, { user: 'Tester', today: TODAY, at: 'yesterday' })).code).toBe('INVALID');
  });

  it('blocks an accidental duplicate PO unless a reason is given', () => {
    const [s] = withPo();
    const e = err(createPo(s, base, ctx()));
    expect(e.code).toBe('DUPLICATE');
    expect(err(createPo(s, { ...base, allowDuplicateReason: 'no' }, ctx())).code).toBe('INVALID');
    const s2 = ok(createPo(s, { ...base, allowDuplicateReason: 'Second line for the Hamilton run' }, ctx()));
    expect(s2.pos).toHaveLength(2);
    expect(s2.audit.at(-1)!.reason).toBe('Second line for the Hamilton run');
  });

  it('rejects a supplier reference already used (case-insensitive)', () => {
    const s = ok(createPo(small(), { ...base, supplierRef: 'Q-100' }, ctx()));
    expect(err(createPo(s, { ...base, qty: 5, supplierRef: 'q-100' }, ctx())).code).toBe('DUPLICATE');
  });
});

describe('receiving and mismatch detection', () => {
  it('a clean full receipt raises no flags and splits into full pallets plus a partial', () => {
    const [s, id] = withPo();
    const r = ok(receivePo(s, id, rc(10000), ctx()));
    const po = r.pos.find((p) => p.id === id)!;
    expect(po.status).toBe('received');
    expect(r.mismatches).toHaveLength(0);
    const qtys = po.receipts[0].palletIds.map((p) => [...palletBalances(r.ledger).values()].find((b) => b.palletId === p)!.qty);
    expect(qtys).toEqual([8169, 1831]);
    expect(qtys.reduce((a, b) => a + b)).toBe(10000);
    expect(verifyState(r)).toEqual([]);
  });

  it('a partial receipt makes the PO partial with no quantity flag', () => {
    const [s, id] = withPo();
    const r = ok(receivePo(s, id, rc(4000), ctx()));
    expect(r.pos.find((p) => p.id === id)!.status).toBe('partial');
    expect(r.mismatches).toHaveLength(0);
  });

  it('price variance inside tolerance is not flagged; outside it is (high and low)', () => {
    const [s, id] = withPo(); // tolerance 1% on 0.0912 = 0.000912
    expect(ok(receivePo(s, id, rc(10000, { unitPrice: '0.0921' }), ctx())).mismatches).toHaveLength(0); // +0.99%
    const hi = ok(receivePo(s, id, rc(10000, { unitPrice: '0.0922' }), ctx()));
    expect(hi.mismatches).toMatchObject([{ type: 'price', direction: 'high', expected: 912, actual: 922, resolved: false }]);
    const lo = ok(receivePo(s, id, rc(10000, { unitPrice: '0.0900' }), ctx()));
    expect(lo.mismatches[0]).toMatchObject({ type: 'price', direction: 'low' });
  });

  it('over-receipt within tolerance is accepted without a flag', () => {
    const [s, id] = withPo();
    const r = ok(receivePo(s, id, rc(10200), ctx()));
    expect(r.mismatches).toHaveLength(0);
    expect(r.pos.find((p) => p.id === id)!.status).toBe('received');
  });

  it('over-receipt beyond tolerance is refused, leaving everything untouched', () => {
    const [s, id] = withPo();
    const r = receivePo(s, id, rc(10201), ctx());
    expect(err(r).code).toBe('OVER_RECEIPT');
    expect(s.ledger).toHaveLength(5);
    expect(receivedQty(s.pos.find((p) => p.id === id)!)).toBe(0);
  });

  it('over-receipt beyond tolerance with a reason is posted and flagged', () => {
    const [s, id] = withPo();
    const r = ok(receivePo(s, id, rc(10500, { overReason: 'Supplier shipped full pallet, buyer accepted' }), ctx()));
    expect(r.mismatches).toMatchObject([{ type: 'quantity', direction: 'over', expected: 10000, actual: 10500 }]);
    expect(r.audit.at(-1)!.reason).toMatch(/full pallet/);
  });

  it('cumulative receipts are checked: a second receipt pushing over tolerance is refused', () => {
    const [s, id] = withPo();
    const a = ok(receivePo(s, id, rc(6000), ctx()));
    expect(err(receivePo(a, id, rc(4300), ctx())).code).toBe('OVER_RECEIPT');
    expect(ok(receivePo(a, id, rc(4100), ctx())).mismatches).toHaveLength(0);
  });

  it('a final short receipt beyond tolerance is flagged short; within tolerance it is not', () => {
    const [s, id] = withPo();
    const short = ok(receivePo(s, id, rc(9000, { final: true }), ctx()));
    expect(short.mismatches).toMatchObject([{ type: 'quantity', direction: 'short', expected: 10000, actual: 9000 }]);
    expect(short.pos.find((p) => p.id === id)!.status).toBe('received');
    expect(ok(receivePo(s, id, rc(9850, { final: true }), ctx())).mismatches).toHaveLength(0);
  });

  it('flags quantity and price on the same receipt independently', () => {
    const [s, id] = withPo();
    const r = ok(receivePo(s, id, rc(8000, { final: true, unitPrice: '0.1000' }), ctx()));
    expect(r.mismatches.map((m) => m.type).sort()).toEqual(['price', 'quantity']);
  });

  it('rejects a packing slip already received from that supplier (double receipt)', () => {
    const [s, id] = withPo();
    const a = ok(receivePo(s, id, rc(1000, { packingSlip: 'GLC-1' }), ctx()));
    expect(err(receivePo(a, id, rc(1000, { packingSlip: 'glc-1' }), ctx())).code).toBe('DUPLICATE');
  });

  it.each([
    [{ date: '2026-11-21' }, /future/],
    [{ date: '2026-10-01' }, /before the PO/],
    [{ date: '2026-11-31' }, /real date/],
    [{ binId: 'MIS-A-01' }, /delivery site/],
    [{ binId: 'NOPE' }, /does not exist/],
    [{ packingSlip: '  ' }, /required/],
    [{ qty: 0 }, /at least 1/],
    [{ qty: '1.5' }, /whole number/],
    [{ unitPrice: 'free' }, /dollar amount/],
  ])('rejects receipt %j', (extra, msg) => {
    const [s, id] = withPo();
    expect(err(receivePo(s, id, rc(100, extra), ctx())).error).toMatch(msg);
  });

  it('refuses receipts against received or closed POs', () => {
    const [s, id] = withPo();
    const r = ok(receivePo(s, id, rc(10000), ctx()));
    expect(err(receivePo(r, id, rc(1), ctx())).code).toBe('PO_NOT_RECEIVABLE');
    const c = ok(closePo(r, id, '', ctx()));
    expect(err(receivePo(c, id, rc(1), ctx())).code).toBe('PO_NOT_RECEIVABLE');
  });
});

describe('resolving flags and closing', () => {
  it('cannot close with an open mismatch; resolving needs a real note; then it closes', () => {
    const [s, id] = withPo();
    const r = ok(receivePo(s, id, rc(10000, { unitPrice: '0.1' }), ctx()));
    expect(err(closePo(r, id, '', ctx())).code).toBe('OPEN_MISMATCHES');
    const mm = r.mismatches[0].id;
    expect(err(resolveMismatch(r, mm, '  ok ', ctx())).code).toBe('INVALID');
    const res = ok(resolveMismatch(r, mm, 'Credit note CN-44 requested from supplier', ctx('Buyer')));
    expect(res.mismatches[0]).toMatchObject({ resolved: true, resolvedBy: 'Buyer' });
    expect(err(resolveMismatch(res, mm, 'Credit note again', ctx())).code).toBe('INVALID');
    const closed = ok(closePo(res, id, '', ctx()));
    expect(closed.pos.find((p) => p.id === id)).toMatchObject({ status: 'closed', closedOn: TODAY });
    expect(err(closePo(closed, id, 'again', ctx())).code).toBe('INVALID');
  });

  it('closing short (open or partial) requires a reason', () => {
    const [s, id] = withPo();
    const p = ok(receivePo(s, id, rc(3000), ctx()));
    expect(err(closePo(p, id, '', ctx())).code).toBe('INVALID');
    const c = ok(closePo(p, id, 'Supplier cannot fill the balance this quarter', ctx()));
    expect(c.pos.find((x) => x.id === id)!.closeReason).toMatch(/cannot fill/);
  });

  it('revisions are recorded with before/after and reason, never silently', () => {
    const [s, id] = withPo();
    const p = ok(receivePo(s, id, rc(3000), ctx()));
    expect(err(revisePo(p, id, { qty: 2999 }, 'Cut back the order', ctx())).error).toMatch(/below/);
    expect(err(revisePo(p, id, { qty: 5000 }, '', ctx())).code).toBe('INVALID');
    expect(err(revisePo(p, id, { qty: 10000 }, 'No change here', ctx())).error).toMatch(/Nothing changed/);
    const r = ok(revisePo(p, id, { qty: 3000, unitPrice: '0.0950' }, 'Cut back to what arrived', ctx()));
    const po = r.pos.find((x) => x.id === id)!;
    expect(po.status).toBe('received');
    expect(po.revisions).toMatchObject([{ field: 'qty', from: 10000, to: 3000 }, { field: 'unitPrice4', from: 912, to: 950 }]);
    expect(r.audit.at(-1)).toMatchObject({ action: 'po.revise', reason: 'Cut back to what arrived' });
  });

  it('never mutates the input state, even on success', () => {
    const [s, id] = withPo();
    const snapshot = JSON.stringify(s);
    ok(receivePo(s, id, rc(10000, { unitPrice: '0.2' }), ctx()));
    err(receivePo(s, id, rc(99999), ctx()));
    expect(JSON.stringify(s)).toBe(snapshot);
  });
});
