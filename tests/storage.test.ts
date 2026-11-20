import { loadState, saveState, STORAGE_KEY } from '../src/storage';
import { toCsv, csvCell } from '../src/model/csv';
import { exportLedger, exportStock } from '../src/model/dashboard';
import { seedState } from '../src/model/seed';
import { verifyState } from '../src/model/ledger';
import { small } from './helpers';

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; }, clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k),
  };
}

describe('storage', () => {
  it('round-trips and verifies', () => {
    const st = memory();
    const s = small();
    expect(saveState(st, s)).toBe(true);
    const r = loadState(st);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.state).toEqual(JSON.parse(JSON.stringify(s)));
  });

  it('refuses broken JSON, wrong versions, missing parts and tampered history', () => {
    const st = memory();
    expect(loadState(st).kind).toBe('none');
    st.setItem(STORAGE_KEY, '{oops');
    expect(loadState(st).kind).toBe('corrupt');
    st.setItem(STORAGE_KEY, JSON.stringify({ version: 2 }));
    expect(loadState(st).kind).toBe('corrupt');
    const s = JSON.parse(JSON.stringify(small()));
    delete s.ledger;
    st.setItem(STORAGE_KEY, JSON.stringify(s));
    expect(loadState(st).kind).toBe('corrupt');
    const t = JSON.parse(JSON.stringify(small()));
    t.ledger[0].qty += 1;
    st.setItem(STORAGE_KEY, JSON.stringify(t));
    const r = loadState(st);
    expect(r.kind).toBe('corrupt');
    if (r.kind === 'corrupt') expect(r.raw).toContain('ledger');
  });

  it('reports a full or blocked storage instead of throwing', () => {
    const st = memory();
    st.setItem = () => { throw new Error('QuotaExceededError'); };
    expect(saveState(st, small())).toBe(false);
  });
});

describe('CSV export', () => {
  it('quotes properly and neutralises spreadsheet formulas', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(undefined)).toBe('');
    expect(toCsv(['a', 'b'], [[1, 'x\ny']])).toBe('a,b\r\n1,"x\ny"\r\n');
  });

  it('ledger export has one row per entry with before, delta and after', () => {
    const s = small();
    const lines = exportLedger(s).trim().split('\r\n');
    expect(lines).toHaveLength(s.ledger.length + 1);
    expect(lines[0]).toBe('seq,at,user,txn,kind,location,sku,pallet,pieces_before,delta,pieces_after,ref,reason,hash');
    expect(exportStock(s).trim().split('\r\n')).toHaveLength(6);
  });
});

describe('seed data', () => {
  it.each(['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2027-01-04', '2026-12-31'])('is valid and consistent for %s', (d) => {
    const s = seedState(d);
    expect(verifyState(s)).toEqual([]);
    expect(s.holds.filter((h) => !h.resolved).length).toBeGreaterThanOrEqual(2);
    expect(s.mismatches.filter((m) => !m.resolved).length).toBe(2);
    expect(s.transfers.some((t) => t.status === 'in-transit')).toBe(true);
    expect(s.company).not.toMatch(/ace/i);
  });
  it('is deterministic', () => {
    expect(JSON.stringify(seedState('2026-11-20'))).toBe(JSON.stringify(seedState('2026-11-20')));
  });
});
