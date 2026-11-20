import { buildSchedule, cyclePosition, cycleStats, todaysCounts } from '../src/model/schedule';
import { submitCount } from '../src/model/ops';
import { palletsInBin } from '../src/model/ledger';
import { emptyState } from '../src/model/seed';
import type { Bin } from '../src/model/types';
import { ctx, ok, small } from './helpers';

const mkBins = (perSite: Record<string, number>): Bin[] =>
  Object.entries(perSite).flatMap(([site, n]) => Array.from({ length: n }, (_, i) => ({ id: `${site}-A-${String(i + 1).padStart(2, '0')}`, siteId: site, zone: 'A' })));

describe('schedule generator', () => {
  it('covers every bin exactly once per cycle, for many bin counts and cycle lengths', () => {
    for (const sizes of <Record<string, number>[]>[{ A: 1 }, { A: 7 }, { A: 14, B: 6, C: 5, D: 4 }, { A: 40, B: 3 }, { A: 0, B: 2 }, { A: 100, B: 100, C: 100 }]) {
      const bins = mkBins(sizes);
      for (const days of [1, 2, 5, 19, 20, 33, 60, 250]) {
        const sched = buildSchedule(bins, days);
        expect(sched).toHaveLength(days);
        const flat = sched.flat();
        expect(flat).toHaveLength(bins.length);
        expect(new Set(flat).size).toBe(bins.length);
        expect(new Set(flat)).toEqual(new Set(bins.map((b) => b.id)));
        const loads = sched.map((d) => d.length);
        expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('spreads each day across sites instead of counting one site at a time', () => {
    const bins = mkBins({ A: 20, B: 20, C: 20 });
    const sched = buildSchedule(bins, 20);
    for (const day of sched) expect(new Set(day.map((id) => id[0]))).toEqual(new Set(['A', 'B', 'C']));
  });

  it('is deterministic and independent of input order', () => {
    const bins = mkBins({ A: 9, B: 4 });
    expect(buildSchedule([...bins].reverse(), 6)).toEqual(buildSchedule(bins, 6));
  });

  it('rejects invalid cycle lengths', () => {
    expect(() => buildSchedule(mkBins({ A: 3 }), 0)).toThrow();
    expect(() => buildSchedule(mkBins({ A: 3 }), 2.5)).toThrow();
  });

  it('the seeded layout (33 bins over 20 days) is 1 or 2 bins a day', () => {
    const s = emptyState('2026-11-20');
    const loads = buildSchedule(s.bins, 20).map((d) => d.length);
    expect(Math.min(...loads)).toBe(1);
    expect(Math.max(...loads)).toBe(2);
  });
});

describe('cycle position and today\'s list', () => {
  const cycle = { cycleDays: 20, startDate: '2026-11-02' }; // Monday
  it('maps working days to cycle days and rolls into the next cycle', () => {
    expect(cyclePosition(cycle, '2026-11-02')).toMatchObject({ cycleNo: 0, dayIndex: 0, cycleStart: '2026-11-02', cycleEnd: '2026-11-27' });
    expect(cyclePosition(cycle, '2026-11-20')!.dayIndex).toBe(14);
    expect(cyclePosition(cycle, '2026-11-30')).toMatchObject({ cycleNo: 1, dayIndex: 0, cycleStart: '2026-11-30' });
    expect(cyclePosition(cycle, '2026-11-21')).toBeNull(); // Saturday
    expect(cyclePosition(cycle, '2026-10-30')).toBeNull(); // before start
  });

  it('lists today\'s bins, marks what is counted and reports bins behind schedule', () => {
    const s = small();
    const t = todaysCounts(s, '2026-11-20');
    expect(t.position).not.toBeNull();
    const sched = buildSchedule(s.bins, s.cycle.cycleDays);
    expect(t.bins.map((b) => b.binId)).toEqual(sched[t.position!.dayIndex]);
    expect(t.overdue).toEqual(sched.slice(0, t.position!.dayIndex).flat());
    const bin = t.bins[0].binId;
    const pallets = Object.fromEntries(palletsInBin(s.ledger, bin).map((p) => [p.palletId, p.qty]));
    const c = ok(submitCount(s, { binId: bin, startedSeq: s.ledger.length, startedAt: 'x', pallets, loose: {}, scheduled: true }, ctx()));
    expect(todaysCounts(c, '2026-11-20').bins[0]).toMatchObject({ countedToday: true, countedThisCycle: true });
  });

  it('accuracy counts first counts only, by pallet line', () => {
    const s = small();
    const pallets = Object.fromEntries(palletsInBin(s.ledger, 'TOR-A-01').map((p) => [p.palletId, p.qty]));
    const first = Object.keys(pallets)[0];
    const c = ok(submitCount(s, { binId: 'TOR-A-01', startedSeq: s.ledger.length, startedAt: 'x', pallets: { ...pallets, [first]: pallets[first] - 1 }, loose: {}, scheduled: true }, ctx()));
    const st = cycleStats(c, '2026-11-20');
    expect(st).toMatchObject({ linesCounted: 4, linesMatched: 3, accuracyPct: 75, binsCounted: 1 });
    const re = ok(submitCount(c, { binId: 'TOR-A-01', startedSeq: c.ledger.length, startedAt: 'x', pallets, loose: {}, scheduled: false }, ctx()));
    expect(cycleStats(re, '2026-11-20').accuracyPct).toBe(75); // the recount doesn't inflate accuracy
  });
});
