import { applyScan, Debouncer, normalizeScan, sessionProblems, startSession } from '../src/model/scan';
import { createTransfer, shipOut, submitCount } from '../src/model/ops';
import { ctx, ok, palletsOf, small } from './helpers';

const CAN = 'CAN-473-BRT';

describe('scan input handling', () => {
  it('debounces the same code inside the window but not different codes', () => {
    const d = new Debouncer(1500);
    expect(d.accept('LPN-1', 0)).toBe(true);
    expect(d.accept('LPN-1', 400)).toBe(false);
    expect(d.accept('LPN-2', 500)).toBe(true);
    expect(d.accept('LPN-1', 2000)).toBe(true);
  });

  it('normalises keyboard-wedge input (CR/LF, tabs, case, spaces)', () => {
    expect(normalizeScan(' lpn-000001\r\n')).toBe('LPN-000001');
    expect(normalizeScan('\u0002TOR-A-01\u0003')).toBe('TOR-A-01');
    expect(normalizeScan('   ')).toBe('');
  });
});

describe('blind count session', () => {
  it('requires the bin label first, then accepts pallets once, never revealing system quantities', () => {
    const s = small();
    const [p1] = palletsOf(s, CAN);
    const sess = startSession(s, 'TOR-A-01', 'now', true);
    expect(applyScan(s, sess, p1)).toMatchObject({ ok: false, kind: 'confirm-bin-first' });
    expect(applyScan(s, sess, 'tor-a-01')).toMatchObject({ ok: true, kind: 'bin' });
    const r = applyScan(s, sess, p1.toLowerCase());
    expect(r).toMatchObject({ ok: true, kind: 'pallet', palletId: p1, skuId: CAN });
    expect(r.message).not.toMatch(/8,?169/);
    expect(applyScan(s, sess, p1)).toMatchObject({ ok: false, kind: 'duplicate' });
    expect(Object.keys(sess.pallets)).toEqual([p1]);
    expect(sess.pallets[p1]).toBeNull();
    expect(sessionProblems(sess)).toEqual([`Enter a piece count for ${p1}.`]);
    sess.pallets[p1] = 8169;
    expect(sessionProblems(sess)).toEqual([]);
  });

  it('refuses unknown labels, wrong bins, other sites, retired and in-transit pallets', () => {
    let s = small();
    const [p1, , p3] = palletsOf(s, CAN);
    const end = palletsOf(s, 'END-202-SOT')[0];
    s = ok(shipOut(s, { binId: 'TOR-A-01', skuId: CAN, qty: 1000, reference: 'run', palletId: p3 }, ctx())); // p3 used up
    s = ok(createTransfer(s, { fromBin: 'TOR-A-01', toBin: 'LAK-S-01', skuId: CAN, qty: 8169, palletId: p1 }, ctx()));
    const sess = startSession(s, 'TOR-A-01', 'now', true);
    expect(applyScan(s, sess, 'NOT-A-LABEL').kind).toBe('unknown');
    expect(applyScan(s, sess, 'TOR-A-02').kind).toBe('wrong-bin');
    expect(applyScan(s, sess, 'LAK-S-01').kind).toBe('wrong-site');
    applyScan(s, sess, 'TOR-A-01');
    expect(applyScan(s, sess, end)).toMatchObject({ ok: false, kind: 'wrong-bin' });
    expect(applyScan(s, sess, p3).kind).toBe('empty');
    expect(applyScan(s, sess, p1).message).toMatch(/in transit/);
    expect(applyScan(s, sess, '').kind).toBe('ignored');
    expect(Object.keys(sess.pallets)).toEqual([]);
    expect(sess.notes.length).toBeGreaterThanOrEqual(3);
  });

  it('accepts a pallet that was in the bin when the count started even if it moved since', () => {
    const s0 = small();
    const p1 = palletsOf(s0, CAN)[0];
    const sess = startSession(s0, 'TOR-A-01', 'now', true);
    const s = ok(createTransfer(s0, { fromBin: 'TOR-A-01', toBin: 'TOR-B-01', skuId: CAN, qty: 8169, palletId: p1 }, ctx()));
    applyScan(s, sess, 'TOR-A-01');
    expect(applyScan(s, sess, p1).ok).toBe(true);
  });

  it('a whole session submits, and a one-piece short pallet lands on hold', () => {
    const s = small();
    const sess = startSession(s, 'TOR-A-01', 'now', true);
    applyScan(s, sess, 'TOR-A-01');
    for (const p of [...palletsOf(s, CAN), ...palletsOf(s, 'CTN-4PK-473')]) applyScan(s, sess, p);
    const [p1, p2, p3] = palletsOf(s, CAN);
    Object.assign(sess.pallets, { [p1]: 8169, [p2]: 8168, [p3]: 1000, [palletsOf(s, 'CTN-4PK-473')[0]]: 3000 });
    const r = ok(submitCount(s, { binId: sess.binId, startedSeq: sess.startedSeq, startedAt: sess.startedAt, pallets: sess.pallets as Record<string, number>, loose: sess.loose, scheduled: true, notes: sess.notes }, ctx()));
    expect(r.holds).toMatchObject([{ palletId: p2, systemQty: 8169, countedQty: 8168 }]);
  });
});
