/** Supervisor dashboard figures and CSV exports, all derived from state (stock from the ledger). */
import type { State } from './types';
import { TRANSIT_PREFIX } from './types';
import { palletBalances, siteTotals } from './ledger';
import { receivedQty } from './ops';
import { cycleStats, type CycleStats } from './schedule';
import { toCsv } from './csv';

export interface LowStock { siteId: string; skuId: string; qty: number; min: number }

export interface Dashboard {
  openPos: number;
  overdue: { poId: string; dueDate: string; daysLate: number; outstanding: number }[];
  openMismatches: number;
  holds: number;
  inTransit: number;
  cycle: CycleStats;
  lowStock: LowStock[];
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export function dashboard(state: State, today: string): Dashboard {
  const active = state.pos.filter((p) => p.status === 'open' || p.status === 'partial');
  const totals = siteTotals(state);
  const binSite = new Map(state.bins.map((b) => [b.id, b.siteId]));
  const stocked = new Set<string>();
  for (const e of state.ledger) { const s = binSite.get(e.location); if (s) stocked.add(`${s}|${e.skuId}`); }
  for (const p of state.pos) stocked.add(`${p.siteId}|${p.skuId}`);
  const lowStock: LowStock[] = [];
  for (const key of [...stocked].sort()) {
    const [siteId, skuId] = key.split('|');
    const sku = state.skus.find((s) => s.id === skuId);
    if (!sku) continue;
    const qty = totals.get(siteId)?.get(skuId) ?? 0;
    if (qty < sku.minPerSite) lowStock.push({ siteId, skuId, qty, min: sku.minPerSite });
  }
  return {
    openPos: active.length,
    overdue: active.filter((p) => p.dueDate < today).map((p) => ({ poId: p.id, dueDate: p.dueDate, daysLate: daysBetween(p.dueDate, today), outstanding: Math.max(0, p.qty - receivedQty(p)) })),
    openMismatches: state.mismatches.filter((m) => !m.resolved).length,
    holds: state.holds.filter((h) => !h.resolved).length,
    inTransit: state.transfers.filter((t) => t.status === 'in-transit').length,
    cycle: cycleStats(state, today),
    lowStock,
  };
}

export const exportAudit = (s: State) => toCsv(['seq', 'at', 'user', 'action', 'entity', 'entity_id', 'detail', 'reason', 'hash'],
  s.audit.map((a) => [a.seq, a.at, a.user, a.action, a.entity, a.entityId, a.detail, a.reason ?? '', a.hash]));

export const exportLedger = (s: State) => toCsv(['seq', 'at', 'user', 'txn', 'kind', 'location', 'sku', 'pallet', 'pieces_before', 'delta', 'pieces_after', 'ref', 'reason', 'hash'],
  s.ledger.map((e) => [e.seq, e.at, e.user, e.txn, e.kind, e.location, e.skuId, e.palletId, e.before, e.qty, e.after, e.ref, e.reason ?? '', e.hash]));

export function exportStock(s: State): string {
  const binSite = new Map(s.bins.map((b) => [b.id, b.siteId]));
  const rows = [...palletBalances(s.ledger).values()].sort((a, b) => a.location.localeCompare(b.location) || a.palletId.localeCompare(b.palletId))
    .map((b) => [b.location.startsWith(TRANSIT_PREFIX) ? 'TRANSIT' : binSite.get(b.location) ?? '', b.location, b.palletId, b.skuId, b.qty,
      s.holds.some((h) => !h.resolved && h.binId === b.location && h.skuId === b.skuId) ? 'HOLD' : '']);
  return toCsv(['site', 'location', 'pallet', 'sku', 'pieces', 'status'], rows);
}

export const exportPos = (s: State) => toCsv(['po', 'supplier', 'supplier_ref', 'sku', 'qty', 'unit_price', 'site', 'due', 'status', 'received', 'created_on', 'created_by'],
  s.pos.map((p) => [p.id, p.supplierId, p.supplierRef ?? '', p.skuId, p.qty, (p.unitPrice4 / 10_000).toFixed(4), p.siteId, p.dueDate, p.status, receivedQty(p), p.createdOn, p.createdBy]));
