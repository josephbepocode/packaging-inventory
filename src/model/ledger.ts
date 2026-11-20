/** Read side of the ledger: every on-hand figure is derived from immutable entries here. */
import type { LedgerEntry, State } from './types';
import { TRANSIT_PREFIX } from './types';

/** FNV-1a 32-bit, used to chain ledger and audit entries so edits to history are detectable. Not a security control. */
export function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

export function ledgerHash(e: Omit<LedgerEntry, 'hash'>): string {
  return fnv([e.prevHash, e.seq, e.at, e.user, e.kind, e.location, e.skuId, e.palletId, e.qty, e.before, e.after, e.ref, e.txn, e.reason ?? ''].join('|'));
}

export interface PalletBalance { palletId: string; skuId: string; location: string; qty: number }

const key = (loc: string, pallet: string) => `${loc}\u0000${pallet}`;

/** Pieces per pallet per location, from entries with seq <= uptoSeq (default all). Zero rows are dropped. */
export function palletBalances(ledger: readonly LedgerEntry[], uptoSeq = Infinity): Map<string, PalletBalance> {
  const m = new Map<string, PalletBalance>();
  for (const e of ledger) {
    if (e.seq > uptoSeq) break;
    const k = key(e.location, e.palletId);
    const b = m.get(k);
    if (b) b.qty += e.qty; else m.set(k, { palletId: e.palletId, skuId: e.skuId, location: e.location, qty: e.qty });
  }
  for (const [k, b] of m) if (b.qty === 0) m.delete(k);
  return m;
}

export function palletQtyAt(ledger: readonly LedgerEntry[], location: string, palletId: string, uptoSeq = Infinity): number {
  let q = 0;
  for (const e of ledger) { if (e.seq > uptoSeq) break; if (e.location === location && e.palletId === palletId) q += e.qty; }
  return q;
}

/** Where a pallet is now (the one location with pieces) and how many pieces it holds. */
export function palletLocation(ledger: readonly LedgerEntry[], palletId: string): { location: string; qty: number } | null {
  const per = new Map<string, number>();
  for (const e of ledger) if (e.palletId === palletId) per.set(e.location, (per.get(e.location) ?? 0) + e.qty);
  for (const [location, qty] of per) if (qty > 0) return { location, qty };
  return null;
}

/** Pallets with pieces in one bin, optionally as of a ledger sequence. */
export function palletsInBin(ledger: readonly LedgerEntry[], binId: string, uptoSeq = Infinity): PalletBalance[] {
  return [...palletBalances(ledger, uptoSeq).values()].filter((b) => b.location === binId).sort((a, b) => a.palletId.localeCompare(b.palletId));
}

/** Pieces of a SKU in a bin (sum of its pallets). */
export function binSkuQty(ledger: readonly LedgerEntry[], binId: string, skuId: string): number {
  let q = 0;
  for (const e of ledger) if (e.location === binId && e.skuId === skuId) q += e.qty;
  return q;
}

/** Site x SKU totals, summed from pallet balances. Transit is reported under the TRANSIT site id. */
export function siteTotals(state: State): Map<string, Map<string, number>> {
  const binSite = new Map(state.bins.map((b) => [b.id, b.siteId]));
  const out = new Map<string, Map<string, number>>();
  for (const b of palletBalances(state.ledger).values()) {
    const site = b.location.startsWith(TRANSIT_PREFIX) ? 'TRANSIT' : binSite.get(b.location) ?? '?';
    const m = out.get(site) ?? new Map<string, number>();
    m.set(b.skuId, (m.get(b.skuId) ?? 0) + b.qty);
    out.set(site, m);
  }
  return out;
}

/** Integrity check run on load and in tests. Returns human-readable problems; empty means healthy. */
export function verifyState(state: State): string[] {
  const problems: string[] = [];
  let prev = '';
  const running = new Map<string, number>();
  const palletSku = new Map(state.pallets.map((p) => [p.id, p.skuId]));
  state.ledger.forEach((e, i) => {
    if (e.seq !== i + 1) problems.push(`Ledger entry ${i + 1} has sequence ${e.seq}.`);
    if (e.prevHash !== prev) problems.push(`Ledger entry ${e.seq} does not chain to the previous entry.`);
    if (ledgerHash(e) !== e.hash) problems.push(`Ledger entry ${e.seq} was altered after posting.`);
    prev = e.hash;
    if (!Number.isSafeInteger(e.qty) || e.qty === 0) problems.push(`Ledger entry ${e.seq} has a bad quantity.`);
    if (palletSku.get(e.palletId) !== e.skuId) problems.push(`Ledger entry ${e.seq} names pallet ${e.palletId} with the wrong SKU.`);
    const k = key(e.location, e.palletId);
    const before = running.get(k) ?? 0;
    if (before !== e.before || before + e.qty !== e.after) problems.push(`Ledger entry ${e.seq} before/after does not match the running balance.`);
    if (before + e.qty < 0) problems.push(`Ledger entry ${e.seq} takes pallet ${e.palletId} below zero at ${e.location}.`);
    running.set(k, before + e.qty);
  });
  const placesPerPallet = new Map<string, number>();
  for (const [k, q] of running) {
    if (q > 0) { const p = k.split('\u0000')[1]; placesPerPallet.set(p, (placesPerPallet.get(p) ?? 0) + 1); }
  }
  for (const [p, n] of placesPerPallet) if (n > 1) problems.push(`Pallet ${p} has pieces in ${n} places at once.`);
  for (const t of state.transfers) {
    if (t.status === 'received') {
      const left = state.ledger.filter((e) => e.location === TRANSIT_PREFIX + t.id).reduce((s, e) => s + e.qty, 0);
      if (left !== 0) problems.push(`Transfer ${t.id} is received but ${left} pieces are still in transit.`);
    }
  }
  for (const h of state.holds) {
    if (h.resolved && !state.reconciliations.some((r) => r.id === h.reconciliationId && r.holdId === h.id)) problems.push(`Hold ${h.id} is marked resolved without a reconciliation record.`);
  }
  prev = '';
  state.audit.forEach((a, i) => {
    if (a.seq !== i + 1) problems.push(`Audit entry ${i + 1} has sequence ${a.seq}.`);
    if (a.prevHash !== prev || auditHash(a) !== a.hash) problems.push(`Audit entry ${a.seq} was altered or removed.`);
    prev = a.hash;
  });
  return problems;
}

export function auditHash(a: { prevHash: string; seq: number; at: string; user: string; action: string; entity: string; entityId: string; detail: string; reason?: string }): string {
  return fnv([a.prevHash, a.seq, a.at, a.user, a.action, a.entity, a.entityId, a.detail, a.reason ?? ''].join('|'));
}
