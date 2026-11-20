/**
 * Demo data for a made-up beverage company (Northbeam Beverage Co.). Built by running the real operations day by
 * day, so the seeded ledger, audit log, holds and mismatches obey every rule the app enforces.
 */
import type { Bin, Ctx, Site, Sku, State, Supplier } from './types';
import { createRng } from './rng';
import { acceptHold, closePo, createPo, createTransfer, loadOpening, receivePo, receiveTransfer, resolveMismatch, shipOut, submitCount } from './ops';
import { palletsInBin } from './ledger';
import { buildSchedule, cyclePosition } from './schedule';
import { addDays, addWorkingDays, isWorkingDay } from './validate';
import type { Result } from './types';

export const SEED = 20261120;
/** Bins the seeded transfers and shipments use; seeded count variances avoid them so the demo history stays valid. */
const BUSY = new Set(['TOR-A-01', 'TOR-A-04', 'LAK-S-01', 'NIA-S-01', 'NIA-S-04']);

const SITES: Site[] = [
  { id: 'TOR', name: 'Toronto DC', kind: 'warehouse', city: 'Toronto, ON' },
  { id: 'MIS', name: 'Mississauga overflow', kind: 'warehouse', city: 'Mississauga, ON' },
  { id: 'LAK', name: 'Lakeshore Co-Pack', kind: 'copacker', city: 'Hamilton, ON' },
  { id: 'NIA', name: 'Niagara Canning Partners', kind: 'copacker', city: 'St. Catharines, ON' },
];

export const SKUS: Sku[] = [
  { id: 'CAN-473-BRT', name: '473 mL aluminum can, bright (unprinted)', kind: 'can', uom: 'can', caseUom: 'layer', caseQty: 389, casesPerPallet: 21, minPerSite: 16000, stdPrice4: 912 },
  { id: 'CAN-473-LAG', name: '473 mL can, printed, Lakeside Lager', kind: 'can', uom: 'can', caseUom: 'layer', caseQty: 389, casesPerPallet: 21, minPerSite: 8000, stdPrice4: 1185 },
  { id: 'CAN-355-SLK', name: '355 mL sleek can, bright', kind: 'can', uom: 'can', caseUom: 'layer', caseQty: 409, casesPerPallet: 22, minPerSite: 12000, stdPrice4: 846 },
  { id: 'END-202-SOT', name: '202 can end, stay-on tab, silver', kind: 'end', uom: 'end', caseUom: 'sleeve', caseQty: 600, casesPerPallet: 120, minPerSite: 60000, stdPrice4: 310 },
  { id: 'CTN-4PK-473', name: '4-pack carton, 473 mL, Lakeside Lager', kind: 'carton', uom: 'carton', caseUom: 'bundle', caseQty: 50, casesPerPallet: 60, minPerSite: 4000, stdPrice4: 2100 },
  { id: 'CTN-12PK-355', name: '12-pack fridge-pack carton, 355 mL', kind: 'carton', uom: 'carton', caseUom: 'bundle', caseQty: 25, casesPerPallet: 48, minPerSite: 1500, stdPrice4: 4800 },
  { id: 'LBL-SLV-473', name: '473 mL shrink sleeve, Citrus Seltzer', kind: 'label', uom: 'sleeve', caseUom: 'roll', caseQty: 2500, casesPerPallet: 16, minPerSite: 30000, stdPrice4: 350 },
  { id: 'TRY-24-473', name: '24-count corrugated tray, 473 mL', kind: 'tray', uom: 'tray', caseUom: 'bundle', caseQty: 25, casesPerPallet: 40, minPerSite: 1200, stdPrice4: 3800 },
  { id: 'HND-4PK', name: '4-pack carry handle, HDPE', kind: 'handle', uom: 'handle', caseUom: 'case', caseQty: 1250, casesPerPallet: 24, minPerSite: 20000, stdPrice4: 280 },
  { id: 'FLM-STR-80', name: 'Stretch wrap, 80 gauge, 18 in roll', kind: 'film', uom: 'roll', caseUom: 'case', caseQty: 4, casesPerPallet: 50, minPerSite: 60, stdPrice4: 325000 },
];

const SUPPLIERS: Supplier[] = [
  { id: 'GLC', name: 'Great Lakes Can Co.', skuIds: ['CAN-473-BRT', 'CAN-473-LAG', 'CAN-355-SLK'] },
  { id: 'SEC', name: 'Summit Ends & Closures', skuIds: ['END-202-SOT'] },
  { id: 'MFC', name: 'Maple Folding Carton', skuIds: ['CTN-4PK-473', 'CTN-12PK-355'] },
  { id: 'PPL', name: 'PrintPoint Labels', skuIds: ['LBL-SLV-473'] },
  { id: 'CVC', name: 'Credit Valley Corrugated', skuIds: ['TRY-24-473'] },
  { id: 'RPS', name: 'Ridgeway Packaging Supply', skuIds: ['HND-4PK', 'FLM-STR-80'] },
];

function bins(): Bin[] {
  const out: Bin[] = [];
  const add = (site: string, zone: string, n: number) => { for (let i = 1; i <= n; i++) out.push({ id: `${site}-${zone}-${String(i).padStart(2, '0')}`, siteId: site, zone }); };
  add('TOR', 'A', 8); add('TOR', 'B', 6); add('MIS', 'A', 6); add('LAK', 'S', 5); add('NIA', 'S', 4);
  for (const s of SITES) out.push({ id: `${s.id}-RCV-01`, siteId: s.id, zone: 'RCV', receiving: true });
  return out;
}

export function emptyState(today: string): State {
  const lastWorking = isWorkingDay(today) ? today : addWorkingDays(today, -1);
  return {
    version: 1, company: 'Northbeam Beverage Co.', sites: SITES.map((s) => ({ ...s })), bins: bins(), skus: SKUS.map((s) => ({ ...s })),
    suppliers: SUPPLIERS.map((s) => ({ ...s, skuIds: [...s.skuIds] })), pallets: [], ledger: [], pos: [], mismatches: [], transfers: [],
    shipments: [], counts: [], holds: [], reconciliations: [], audit: [], tolerance: { qtyBp: 200, priceBp: 100 },
    cycle: { cycleDays: 20, startDate: addWorkingDays(lastWorking, -11) }, seq: 1,
  };
}

function must(r: Result, what: string): State {
  if (!r.ok) throw new Error(`Seed step failed (${what}): ${r.error}`);
  return r.state;
}

/** Builds the seeded demo for a business date. Deterministic for a given date. */
export function seedState(today: string): State {
  const rng = createRng(SEED);
  let s = emptyState(today);
  const ctx = (date: string, user = 'Seed: J. Bepo', hour = 13): Ctx => ({ user, today: date, at: `${date}T${String(hour).padStart(2, '0')}:00:00.000Z` });
  const d = (n: number) => addDays(today, n);
  const sku = (id: string) => SKUS.find((x) => x.id === id)!;
  const ppp = (id: string) => sku(id).caseQty * sku(id).casesPerPallet;

  // Opening balances, 35 days ago.
  const plan: [string, string[]][] = [
    ['TOR', ['CAN-473-BRT', 'CAN-473-LAG', 'CAN-355-SLK', 'END-202-SOT', 'CTN-4PK-473', 'CTN-12PK-355', 'LBL-SLV-473', 'TRY-24-473', 'HND-4PK', 'FLM-STR-80']],
    ['MIS', ['CAN-473-BRT', 'END-202-SOT', 'LBL-SLV-473', 'CTN-12PK-355']],
    ['LAK', ['CAN-473-BRT', 'END-202-SOT', 'CTN-4PK-473', 'HND-4PK', 'LBL-SLV-473']],
    ['NIA', ['CAN-355-SLK', 'END-202-SOT', 'TRY-24-473', 'CTN-12PK-355']],
  ];
  const rows: { binId: string; skuId: string; qty: number }[] = [];
  for (const [site, skus] of plan) {
    const siteBins = s.bins.filter((b) => b.siteId === site && !b.receiving);
    skus.forEach((id, i) => {
      const bin = siteBins[i % siteBins.length].id;
      const pallets = rng.int(1, 4);
      for (let p = 0; p < pallets; p++) {
        const full = ppp(id);
        // Most pallets full; some partially picked so partial-pallet maths is exercised.
        rows.push({ binId: bin, skuId: id, qty: rng.chance(0.7) ? full : rng.int(Math.ceil(full / 5), full - 1) });
      }
    });
  }
  s = must(loadOpening(s, rows, ctx(d(-35)), 'Opening balance at go-live'), 'opening');

  // Day-by-day events.
  const events = new Map<string, ((st: State) => State)[]>();
  const on = (date: string, f: (st: State) => State) => { const l = events.get(date) ?? []; l.push(f); events.set(date, l); };
  const lastPo = (st: State) => st.pos[st.pos.length - 1].id;
  const ids: Record<string, string> = {};
  const po = (key: string, date: string, supplierId: string, skuId: string, qty: number, price: string, siteId: string, due: string) =>
    on(date, (st) => { const n = must(createPo(st, { supplierId, skuId, qty, unitPrice: price, siteId, dueDate: due, supplierRef: `${supplierId}-${key}` }, ctx(date, 'Seed: J. Bepo', 14)), `po ${key}`); ids[key] = lastPo(n); return n; });

  po('A', d(-22), 'GLC', 'CAN-473-BRT', 8169 * 6, '0.0912', 'LAK', d(5));
  po('B', d(-21), 'SEC', 'END-202-SOT', 216000, '0.0310', 'TOR', d(-3));
  po('C', d(-20), 'MFC', 'CTN-4PK-473', 12000, '0.2100', 'TOR', d(-6));
  po('D', d(-18), 'PPL', 'LBL-SLV-473', 80000, '0.0350', 'MIS', d(-4));
  po('E', d(-17), 'CVC', 'TRY-24-473', 4000, '0.3800', 'NIA', d(-8));
  po('F', d(-16), 'RPS', 'HND-4PK', 60000, '0.0280', 'TOR', d(-10));
  po('G', d(-15), 'RPS', 'FLM-STR-80', 200, '32.5000', 'TOR', d(-9));
  po('H', d(-6), 'MFC', 'CTN-12PK-355', 4800, '0.4800', 'LAK', d(10));
  po('I', d(-5), 'GLC', 'CAN-473-LAG', 8169 * 4, '0.1185', 'NIA', d(2));

  const rcv = (key: string, date: string, slip: string, qty: number, price: string, binId: string, final = false) =>
    on(date, (st) => must(receivePo(st, ids[key], { date, packingSlip: slip, qty, unitPrice: price, binId, final }, ctx(date, 'Seed: M. Okafor', 15)), `receive ${key}`));
  rcv('C', d(-6), 'MFC-55120', 6000, '0.2100', 'TOR-RCV-01');                // partial, overdue
  rcv('D', d(-4), 'PPL-88031', 80000, '0.0372', 'MIS-RCV-01');               // price 6.3% high -> flagged
  rcv('E', d(-8), 'CVC-20417', 3700, '0.3800', 'NIA-RCV-01', true);         // final, 7.5% short -> flagged
  rcv('F', d(-10), 'RPS-1102', 60000, '0.0280', 'TOR-RCV-01');              // clean
  rcv('G', d(-9), 'RPS-1109', 203, '32.5000', 'TOR-RCV-01');                // 1.5% over, within tolerance
  on(d(-9), (st) => must(closePo(st, ids.F, '', ctx(d(-9), 'Seed: J. Bepo', 16)), 'close F'));
  on(d(-9), (st) => must(receivePo(st, ids.A, { date: d(-9), packingSlip: 'GLC-77310', qty: 8169, unitPrice: '0.0935', binId: 'LAK-RCV-01' }, ctx(d(-9), 'Seed: R. Singh', 10)), 'receive A'));
  on(d(-8), (st) => {
    const m = st.mismatches.find((x) => x.poId === ids.A && !x.resolved)!;
    return must(resolveMismatch(st, m.id, 'Supplier confirmed aluminum surcharge for November; approved by procurement manager.', ctx(d(-8), 'Seed: J. Bepo', 11)), 'resolve A');
  });

  // Transfers and shipments.
  on(d(-5), (st) => {
    const n = must(createTransfer(st, { fromBin: 'TOR-A-01', toBin: 'LAK-S-01', skuId: 'CAN-473-BRT', qty: 8169 }, ctx(d(-5), 'Seed: M. Okafor', 9)), 'transfer 1');
    return must(receiveTransfer(n, n.transfers[n.transfers.length - 1].id, ctx(d(-4), 'Seed: R. Singh', 11)), 'transfer 1 receive');
  });
  on(d(-1), (st) => must(createTransfer(st, { fromBin: 'TOR-A-04', toBin: 'NIA-S-04', skuId: 'END-202-SOT', qty: 30000 }, ctx(d(-1), 'Seed: M. Okafor', 9)), 'transfer 2'));
  on(d(-3), (st) => must(shipOut(st, { binId: 'LAK-S-01', skuId: 'CAN-473-BRT', qty: 5000, reference: 'Production run LAK-2611 (Lakeside Lager)' }, ctx(d(-3), 'Seed: R. Singh', 16)), 'ship 1'));
  on(d(-2), (st) => must(shipOut(st, { binId: 'NIA-S-01', skuId: 'CAN-355-SLK', qty: 4500, reference: 'Production run NIA-2614 (Seltzer)' }, ctx(d(-2), 'Seed: R. Singh', 16)), 'ship 2'));

  // Cycle counts on each working day of the current cycle before today.
  const sched = buildSchedule(s.bins, s.cycle.cycleDays);
  let special = 0;
  for (let day = s.cycle.startDate; day < today; day = addDays(day, 1)) {
    const pos = cyclePosition(s.cycle, day);
    if (!pos) continue;
    on(day, (st) => {
      let cur = st;
      for (const binId of sched[pos.dayIndex]) {
        const pals = palletsInBin(cur.ledger, binId);
        const pallets: Record<string, number> = Object.fromEntries(pals.map((p) => [p.palletId, p.qty]));
        const loose: Record<string, number> = {};
        if (pals.length && special < 3 && !BUSY.has(binId)) {
          // One-piece short on one pallet, a found bundle of loose cartons, and one short count later accepted.
          const p = pals[0];
          if (special === 0) pallets[p.palletId] = p.qty - 1;
          if (special === 1) loose[p.skuId] = 25;
          if (special === 2) pallets[p.palletId] = p.qty - 389;
          special++;
        }
        cur = must(submitCount(cur, { binId, startedSeq: cur.ledger.length, startedAt: ctx(day, 'Seed: A. Haddad', 7).at, pallets, loose, scheduled: true }, ctx(day, 'Seed: A. Haddad', 8)), `count ${binId}`);
        if (special === 3 && cur.holds.length === 3 && !cur.holds[2].resolved) {
          cur = must(acceptHold(cur, cur.holds[2].id, 'Layer found crushed in bin, scrapped by night shift without a write-off. Accepting count.', ctx(day, 'Seed: J. Bepo', 12)), 'accept hold');
        }
      }
      return cur;
    });
  }

  for (const date of [...events.keys()].sort()) for (const f of events.get(date)!) s = f(s);
  return s;
}
