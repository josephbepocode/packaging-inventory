/** Scan handling for blind counts: label lookup, wrong-location checks and duplicate-scan debouncing. */
import type { State } from './types';
import { TRANSIT_PREFIX } from './types';
import { palletLocation, palletsInBin } from './ledger';

/** Ignores the same code read again within windowMs (camera frames, double trigger pulls). */
export class Debouncer {
  private last = new Map<string, number>();
  constructor(private windowMs = 1500) {}
  accept(code: string, nowMs: number): boolean {
    const t = this.last.get(code);
    this.last.set(code, nowMs);
    return t === undefined || nowMs - t >= this.windowMs;
  }
}

/** Upper-cases and strips whitespace/control characters that keyboard-wedge scanners add. */
export function normalizeScan(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().toUpperCase();
}

export interface CountSession {
  binId: string;
  siteId: string;
  startedSeq: number;
  startedAt: string;
  binConfirmed: boolean;
  /** Pallet -> counted pieces (null until the counter enters a quantity). */
  pallets: Record<string, number | null>;
  loose: Record<string, number>;
  notes: string[];
  scheduled: boolean;
}

export function startSession(state: State, binId: string, startedAt: string, scheduled: boolean): CountSession {
  const bin = state.bins.find((b) => b.id === binId);
  if (!bin) throw new Error(`Bin ${binId} does not exist.`);
  return { binId, siteId: bin.siteId, startedSeq: state.ledger.length, startedAt, binConfirmed: false, pallets: {}, loose: {}, notes: [], scheduled };
}

export type ScanOutcome =
  | { ok: true; kind: 'bin'; message: string }
  | { ok: true; kind: 'pallet'; palletId: string; skuId: string; message: string }
  | { ok: false; kind: 'ignored' | 'unknown' | 'wrong-site' | 'wrong-bin' | 'duplicate' | 'empty' | 'confirm-bin-first'; message: string };

/** Applies one scan to a session (mutates the session). Never reveals system quantities. */
export function applyScan(state: State, session: CountSession, raw: string): ScanOutcome {
  const code = normalizeScan(raw);
  if (!code) return { ok: false, kind: 'ignored', message: 'Empty scan ignored.' };
  const bin = state.bins.find((b) => b.id === code);
  if (bin) {
    if (bin.siteId !== session.siteId) { session.notes.push(`Scanned bin ${code} from another site.`); return { ok: false, kind: 'wrong-site', message: `${code} is at ${bin.siteId}, not ${session.siteId}. You are counting ${session.binId}.` }; }
    if (bin.id !== session.binId) return { ok: false, kind: 'wrong-bin', message: `That is bin ${code}. You are counting ${session.binId}.` };
    if (session.binConfirmed) return { ok: false, kind: 'duplicate', message: `Bin ${code} already confirmed.` };
    session.binConfirmed = true;
    return { ok: true, kind: 'bin', message: `Bin ${code} confirmed. Scan each pallet.` };
  }
  const pallet = state.pallets.find((p) => p.id === code);
  if (!pallet) return { ok: false, kind: 'unknown', message: `Label ${code} is not a known bin or pallet. Do not count it; set it aside and report it.` };
  if (!session.binConfirmed) return { ok: false, kind: 'confirm-bin-first', message: `Scan the bin label for ${session.binId} first.` };
  if (pallet.id in session.pallets) return { ok: false, kind: 'duplicate', message: `${pallet.id} is already in this count. Not added twice.` };
  const inBinAtStart = palletsInBin(state.ledger, session.binId, session.startedSeq).some((b) => b.palletId === pallet.id);
  const loc = palletLocation(state.ledger, pallet.id);
  if (!inBinAtStart && loc?.location !== session.binId) {
    if (!loc) { session.notes.push(`Found retired label ${pallet.id}.`); return { ok: false, kind: 'empty', message: `${pallet.id} was used up or merged and should have no stock. Count the pieces as unlabelled and relabel.` }; }
    if (loc.location.startsWith(TRANSIT_PREFIX)) { session.notes.push(`Found in-transit pallet ${pallet.id}.`); return { ok: false, kind: 'wrong-bin', message: `${pallet.id} is still in transit (${loc.location.slice(TRANSIT_PREFIX.length)}). Receive the transfer first.` }; }
    const other = state.bins.find((b) => b.id === loc.location);
    session.notes.push(`Found ${pallet.id} registered to ${loc.location}.`);
    if (other && other.siteId !== session.siteId) return { ok: false, kind: 'wrong-site', message: `${pallet.id} is registered at another site (${loc.location}). Report it; do not count it here.` };
    return { ok: false, kind: 'wrong-bin', message: `${pallet.id} is registered to ${loc.location}. Move it with a transfer, or count it there.` };
  }
  session.pallets[pallet.id] = null;
  return { ok: true, kind: 'pallet', palletId: pallet.id, skuId: pallet.skuId, message: `${pallet.id} (${pallet.skuId}) added. Enter its piece count.` };
}

/** Problems that stop a session being submitted. */
export function sessionProblems(session: CountSession): string[] {
  const out: string[] = [];
  if (!session.binConfirmed) out.push(`Scan or type the bin label ${session.binId} to confirm you are at the right location.`);
  for (const [p, q] of Object.entries(session.pallets)) if (q === null) out.push(`Enter a piece count for ${p}.`);
  return out;
}
