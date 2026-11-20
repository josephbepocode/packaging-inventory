/** localStorage persistence. A saved state is only used if its shape is right and its ledger and audit chains verify. */
import type { State } from './model/types';
import { verifyState } from './model/ledger';

export const STORAGE_KEY = 'packaging-inventory.v1';
export const USER_KEY = 'packaging-inventory.user';

const ARRAYS: (keyof State)[] = ['sites', 'bins', 'skus', 'suppliers', 'pallets', 'ledger', 'pos', 'mismatches', 'transfers', 'shipments', 'counts', 'holds', 'reconciliations', 'audit'];

export type LoadResult = { kind: 'none' } | { kind: 'ok'; state: State } | { kind: 'corrupt'; problems: string[]; raw: string };

export function loadState(storage: Storage): LoadResult {
  let raw: string | null = null;
  try { raw = storage.getItem(STORAGE_KEY); } catch { return { kind: 'none' }; }
  if (!raw) return { kind: 'none' };
  try {
    const s = JSON.parse(raw) as State;
    const problems: string[] = [];
    if (!s || s.version !== 1) problems.push('Saved data is from an unknown version.');
    else {
      for (const k of ARRAYS) if (!Array.isArray(s[k])) problems.push(`Saved data is missing ${k}.`);
      if (!Number.isSafeInteger(s.seq)) problems.push('Saved data has a bad id counter.');
      if (!s.tolerance || !s.cycle) problems.push('Saved data is missing settings.');
      if (!problems.length) problems.push(...verifyState(s));
    }
    return problems.length ? { kind: 'corrupt', problems, raw } : { kind: 'ok', state: s };
  } catch {
    return { kind: 'corrupt', problems: ['Saved data is not valid JSON.'], raw };
  }
}

/** Returns false if the browser refused to save (quota, private mode). */
export function saveState(storage: Storage, state: State): boolean {
  try { storage.setItem(STORAGE_KEY, JSON.stringify(state)); return true; } catch { return false; }
}

export function clearState(storage: Storage): void {
  try { storage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}
