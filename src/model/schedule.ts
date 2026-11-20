/** Cycle-count schedule: every bin is counted once per cycle of N working days, spread evenly and mixed across sites. */
import type { Bin, CycleSettings, State } from './types';
import { addWorkingDays, isWorkingDay, workingDaysBetween } from './validate';

/**
 * Returns, for each working day of the cycle, the bin ids to count. Bins are interleaved round-robin across
 * sites (each site in its own walking order), then cut into N contiguous, near-equal chunks: daily load differs by
 * at most one bin, every bin appears exactly once, and each day touches as many sites as its size allows.
 */
export function buildSchedule(bins: readonly Bin[], cycleDays: number): string[][] {
  if (!Number.isSafeInteger(cycleDays) || cycleDays < 1) throw new Error('cycleDays must be a positive whole number');
  const bySite = new Map<string, string[]>();
  for (const b of [...bins].sort((a, z) => a.id.localeCompare(z.id))) {
    const l = bySite.get(b.siteId) ?? [];
    l.push(b.id); bySite.set(b.siteId, l);
  }
  const queues = [...bySite.keys()].sort().map((s) => [...bySite.get(s)!]);
  const order: string[] = [];
  while (queues.some((q) => q.length)) for (const q of queues) if (q.length) order.push(q.shift()!);
  const days: string[][] = [];
  const base = Math.floor(order.length / cycleDays);
  const extra = order.length % cycleDays;
  let i = 0;
  for (let d = 0; d < cycleDays; d++) {
    const size = base + (d < extra ? 1 : 0);
    days.push(order.slice(i, i + size));
    i += size;
  }
  return days;
}

export interface CyclePosition {
  /** Which cycle we are in (0 = first) and which working day of it; null on weekends or before the start. */
  cycleNo: number;
  dayIndex: number;
  cycleStart: string;
  cycleEnd: string;
}

export function cyclePosition(cycle: CycleSettings, date: string): CyclePosition | null {
  if (date < cycle.startDate || !isWorkingDay(date) || !isWorkingDay(cycle.startDate)) return null;
  const wd = workingDaysBetween(cycle.startDate, date);
  const cycleNo = Math.floor(wd / cycle.cycleDays);
  const cycleStart = addWorkingDays(cycle.startDate, cycleNo * cycle.cycleDays);
  return { cycleNo, dayIndex: wd % cycle.cycleDays, cycleStart, cycleEnd: addWorkingDays(cycleStart, cycle.cycleDays - 1) };
}

export interface TodayList { position: CyclePosition | null; bins: { binId: string; siteId: string; countedToday: boolean; countedThisCycle: boolean }[]; overdue: string[] }

export function todaysCounts(state: State, today: string): TodayList {
  const pos = cyclePosition(state.cycle, today);
  if (!pos) return { position: null, bins: [], overdue: [] };
  const sched = buildSchedule(state.bins, state.cycle.cycleDays);
  const site = new Map(state.bins.map((b) => [b.id, b.siteId]));
  const inCycle = new Set(state.counts.filter((c) => c.date >= pos.cycleStart && c.date <= today).map((c) => c.binId));
  const today_ = new Set(state.counts.filter((c) => c.date === today).map((c) => c.binId));
  const overdue = sched.slice(0, pos.dayIndex).flat().filter((b) => !inCycle.has(b));
  return {
    position: pos,
    bins: sched[pos.dayIndex].map((binId) => ({ binId, siteId: site.get(binId)!, countedToday: today_.has(binId), countedThisCycle: inCycle.has(binId) })),
    overdue,
  };
}

export interface CycleStats { binsTotal: number; binsCounted: number; dueSoFar: number; overdue: number; linesCounted: number; linesMatched: number; accuracyPct: number | null }

/** Progress through the current cycle and first-count accuracy (pallet lines that matched / lines counted). */
export function cycleStats(state: State, today: string): CycleStats {
  const t = todaysCounts(state, today);
  const pos = t.position ?? cyclePosition(state.cycle, lastWorkingDayOnOrBefore(today, state.cycle.startDate));
  const from = pos?.cycleStart ?? state.cycle.startDate;
  const counts = state.counts.filter((c) => c.date >= from && c.date <= today);
  const counted = new Set(counts.map((c) => c.binId));
  const firsts = counts.filter((c) => !c.recount);
  const lines = firsts.flatMap((c) => c.lines);
  const matched = lines.filter((l) => l.countedQty === l.systemQty || (l.moved && l.countedQty === l.currentQty)).length;
  const sched = buildSchedule(state.bins, state.cycle.cycleDays);
  const dueSoFar = pos ? sched.slice(0, pos.dayIndex + 1).flat().length : 0;
  return {
    binsTotal: state.bins.length, binsCounted: state.bins.filter((b) => counted.has(b.id)).length, dueSoFar, overdue: t.overdue.length,
    linesCounted: lines.length, linesMatched: matched, accuracyPct: lines.length ? Math.round((matched / lines.length) * 1000) / 10 : null,
  };
}

function lastWorkingDayOnOrBefore(date: string, floor: string): string {
  let d = date;
  while (!isWorkingDay(d) && d > floor) d = prev(d);
  return d;
}
const prev = (d: string) => { const [y, m, day] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, day - 1)).toISOString().slice(0, 10); };
