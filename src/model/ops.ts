/**
 * Every write goes through run(): it copies the state, applies one operation, and either returns the whole new
 * state or an error with the original untouched. Stock only changes through post(), which enforces
 * no-negative balances, one-location-per-pallet and the count-hold block, and appends a chained, frozen
 * ledger entry with the pallet's before/after piece count. Each operation also appends an audit entry.
 */
import type {
  Bin, Ctx, ErrorCode, Hold, LedgerEntry, LedgerKind, Mismatch, Pallet, PurchaseOrder, Receipt, Result, State,
} from './types';
import { TRANSIT_PREFIX } from './types';
import { auditHash, ledgerHash } from './ledger';
import { piecesPerPallet, describe as describeQty } from './uom';
import {
  exceedsTolerance, isBinCode, isDate, MIN_REASON, parseDate, parsePrice4, parseQty, requireText, ValidationError,
} from './validate';

export class OpError extends Error {
  constructor(public code: ErrorCode, message: string) { super(message); }
}

interface Move { palletId: string; skuId: string; location: string; before: number; after: number; qty: number }

interface Draft {
  s: State;
  ctx: Ctx;
  txn: string;
  /** location\0pallet -> pieces */
  bal: Map<string, number>;
  /** pallet -> location -> pieces (positive only) */
  where: Map<string, Map<string, number>>;
  /** Holds being released in this same transaction (only acceptHold sets this). */
  resolving: Set<string>;
  moves: Move[];
}

const k = (loc: string, p: string) => `${loc}\u0000${p}`;

function checkCtx(ctx: Ctx): void {
  requireText(ctx?.user, 'User name', 2, 60);
  if (typeof ctx.at !== 'string' || Number.isNaN(Date.parse(ctx.at))) throw new ValidationError('Timestamp is missing or invalid.');
  if (!isDate(ctx.today)) throw new ValidationError('Business date is missing or invalid.');
}

/** Applies one operation atomically. */
export function run(state: State, ctx: Ctx, fn: (d: Draft) => void): Result {
  try {
    checkCtx(ctx);
    const s = structuredClone(state) as State;
    const bal = new Map<string, number>();
    const where = new Map<string, Map<string, number>>();
    for (const e of s.ledger) bal.set(k(e.location, e.palletId), (bal.get(k(e.location, e.palletId)) ?? 0) + e.qty);
    for (const [key, q] of bal) {
      if (q <= 0) continue;
      const [loc, p] = key.split('\u0000');
      const m = where.get(p) ?? new Map<string, number>();
      m.set(loc, q); where.set(p, m);
    }
    const d: Draft = { s, ctx: { ...ctx, user: ctx.user.trim() }, txn: `T${s.seq}`, bal, where, resolving: new Set(), moves: [] };
    fn(d);
    s.ledger.forEach((e) => Object.freeze(e));
    s.audit.forEach((e) => Object.freeze(e));
    return { ok: true, state: s };
  } catch (e) {
    if (e instanceof OpError) return { ok: false, code: e.code, error: e.message };
    if (e instanceof ValidationError) return { ok: false, code: 'INVALID', error: e.message };
    throw e;
  }
}

function nextId(d: Draft, prefix: string): string {
  return `${prefix}-${String(d.s.seq++).padStart(6, '0')}`;
}

const fail = (code: ErrorCode, msg: string): never => { throw new OpError(code, msg); };

function getBin(d: Draft, id: string): Bin {
  return d.s.bins.find((b) => b.id === id) ?? fail('NOT_FOUND', `Bin ${id || '(blank)'} does not exist.`);
}
function getSku(d: Draft, id: string) {
  return d.s.skus.find((x) => x.id === id) ?? fail('NOT_FOUND', `SKU ${id || '(blank)'} does not exist.`);
}
function getPallet(d: Draft, id: string): Pallet {
  return d.s.pallets.find((p) => p.id === id) ?? fail('NOT_FOUND', `Pallet ${id || '(blank)'} does not exist.`);
}
function getPo(d: Draft, id: string): PurchaseOrder {
  return d.s.pos.find((p) => p.id === id) ?? fail('NOT_FOUND', `PO ${id || '(blank)'} does not exist.`);
}

/** Open holds that block decrements of this SKU in this bin. */
export function blockingHolds(state: State, binId: string, skuId: string): Hold[] {
  return state.holds.filter((h) => h.binId === binId && h.skuId === skuId && !isReleased(state, h));
}

/** A hold only counts as released if a reconciliation record for it exists. Flipping hold.resolved alone does nothing. */
export function isReleased(state: State, h: Hold): boolean {
  return h.resolved && !!h.reconciliationId && state.reconciliations.some((r) => r.id === h.reconciliationId && r.holdId === h.id);
}

export function isBlocked(state: State, binId: string, skuId: string): boolean {
  return blockingHolds(state, binId, skuId).length > 0;
}

function newPallet(d: Draft, skuId: string, source: string): Pallet {
  const p: Pallet = { id: nextId(d, 'LPN'), skuId, createdAt: d.ctx.at, createdBy: d.ctx.user, source };
  d.s.pallets.push(p);
  return p;
}

/** The only function that changes stock. */
function post(d: Draft, e: { kind: LedgerKind; location: string; palletId: string; qty: number; ref: string; reason?: string }): LedgerEntry {
  if (!Number.isSafeInteger(e.qty) || e.qty === 0) fail('INVALID', 'Ledger quantity must be a non-zero whole number of pieces.');
  const pallet = getPallet(d, e.palletId);
  const isTransit = e.location.startsWith(TRANSIT_PREFIX);
  if (!isTransit) getBin(d, e.location);
  if (e.qty < 0 && !isTransit) {
    const holds = blockingHolds(d.s, e.location, pallet.skuId);
    const allowed = e.kind === 'reconcile' && d.resolving.has(e.ref);
    if (holds.length && !allowed) {
      fail('ON_HOLD', `${pallet.skuId} in ${e.location} is on count hold (${holds.map((h) => h.id).join(', ')}). Reconcile the count before moving or using it.`);
    }
  }
  const key = k(e.location, e.palletId);
  const before = d.bal.get(key) ?? 0;
  const after = before + e.qty;
  if (after < 0) fail('INSUFFICIENT_STOCK', `Pallet ${e.palletId} has ${before} pieces in ${e.location}; cannot take ${-e.qty}.`);
  const places = d.where.get(e.palletId) ?? new Map<string, number>();
  if (e.qty > 0 && [...places.keys()].some((loc) => loc !== e.location)) {
    fail('INVALID', `Pallet ${e.palletId} still has pieces in ${[...places.keys()].join(', ')}; a pallet can only be in one place.`);
  }
  d.bal.set(key, after);
  if (after > 0) places.set(e.location, after); else places.delete(e.location);
  d.where.set(e.palletId, places);
  const last = d.s.ledger[d.s.ledger.length - 1];
  const entry: Omit<LedgerEntry, 'hash'> = {
    seq: d.s.ledger.length + 1, at: d.ctx.at, user: d.ctx.user, kind: e.kind, location: e.location, skuId: pallet.skuId,
    palletId: e.palletId, qty: e.qty, before, after, ref: e.ref, txn: d.txn, prevHash: last?.hash ?? '',
    ...(e.reason ? { reason: e.reason } : {}),
  };
  const full = { ...entry, hash: ledgerHash(entry) } as LedgerEntry;
  d.s.ledger.push(full);
  d.moves.push({ palletId: e.palletId, skuId: pallet.skuId, location: e.location, before, after, qty: e.qty });
  return full;
}

function audit(d: Draft, action: string, entity: string, entityId: string, detail: string, reason?: string): void {
  const moves = d.moves.splice(0).map((m) => `${m.palletId} ${m.skuId} @${m.location}: ${m.before}→${m.after} (${m.qty > 0 ? '+' : ''}${m.qty})`);
  const last = d.s.audit[d.s.audit.length - 1];
  const a = {
    seq: d.s.audit.length + 1, at: d.ctx.at, user: d.ctx.user, action, entity, entityId,
    detail: moves.length ? `${detail} | ${moves.join('; ')}` : detail, prevHash: last?.hash ?? '',
    ...(reason ? { reason } : {}),
  };
  d.s.audit.push({ ...a, hash: auditHash(a) });
}

function piecesInBin(d: Draft, binId: string, skuId: string): { palletId: string; qty: number }[] {
  const out: { palletId: string; qty: number }[] = [];
  for (const p of d.s.pallets) {
    if (p.skuId !== skuId) continue;
    const q = d.bal.get(k(binId, p.id)) ?? 0;
    if (q > 0) out.push({ palletId: p.id, qty: q });
  }
  return out; // pallets array is in creation order, so this is FIFO
}

/** Chooses pallets to take qty from: a named pallet, or oldest first (partial pallets are naturally finished first). */
function pick(d: Draft, binId: string, skuId: string, qty: number, palletId?: string): { palletId: string; take: number; had: number }[] {
  if (isBlocked(d.s, binId, skuId)) fail('ON_HOLD', `${skuId} in ${binId} is on count hold. Reconcile the count before moving or using it.`);
  let avail = piecesInBin(d, binId, skuId);
  if (palletId) {
    const p = getPallet(d, palletId);
    if (p.skuId !== skuId) fail('INVALID', `Pallet ${palletId} holds ${p.skuId}, not ${skuId}.`);
    avail = avail.filter((a) => a.palletId === palletId);
    if (!avail.length) fail('INSUFFICIENT_STOCK', `Pallet ${palletId} is not in ${binId}.`);
  }
  const total = avail.reduce((s, a) => s + a.qty, 0);
  if (total < qty) fail('INSUFFICIENT_STOCK', `Only ${total} pieces of ${skuId} in ${binId}${palletId ? ` on ${palletId}` : ''}; ${qty} needed.`);
  const out: { palletId: string; take: number; had: number }[] = [];
  let left = qty;
  for (const a of avail) {
    if (!left) break;
    const take = Math.min(left, a.qty);
    out.push({ palletId: a.palletId, take, had: a.qty });
    left -= take;
  }
  return out;
}

// ---------------------------------------------------------------- master data

export function addBin(state: State, input: { code: string; siteId: string; zone: string; receiving?: boolean }, ctx: Ctx): Result {
  return run(state, ctx, (d) => {
    const code = requireText(input.code, 'Bin code').toUpperCase();
    if (!isBinCode(code)) fail('INVALID', 'Bin code must look like TOR-A-01 (letters, digits, dashes).');
    if (code.startsWith('LPN-') || code.startsWith(TRANSIT_PREFIX)) fail('INVALID', 'Bin codes cannot start with LPN- or TRANSIT/.');
    if (d.s.bins.some((b) => b.id === code)) fail('DUPLICATE', `Bin ${code} already exists; label codes must be unique.`);
    if (!d.s.sites.some((s) => s.id === input.siteId)) fail('NOT_FOUND', 'Site does not exist.');
    const zone = requireText(input.zone, 'Zone', 1, 20);
    d.s.bins.push({ id: code, siteId: input.siteId, zone, ...(input.receiving ? { receiving: true } : {}) });
    audit(d, 'bin.create', 'bin', code, `site ${input.siteId}, zone ${zone}`);
  });
}

/** Loads opening stock as new pallets (go-live migration or demo seed). */
export function loadOpening(state: State, rows: { binId: string; skuId: string; qty: number }[], ctx: Ctx, reason = 'Opening balance'): Result {
  return run(state, ctx, (d) => {
    const why = requireText(reason, 'Reason', MIN_REASON);
    for (const r of rows) {
      getBin(d, r.binId); getSku(d, r.skuId);
      const qty = parseQty(r.qty, 'Opening quantity');
      const p = newPallet(d, r.skuId, 'opening');
      post(d, { kind: 'opening', location: r.binId, palletId: p.id, qty, ref: 'OPENING', reason: why });
      audit(d, 'stock.opening', 'pallet', p.id, `${r.skuId} ${qty} pieces into ${r.binId}`, why);
    }
  });
}

// ---------------------------------------------------------------- purchase orders

export interface PoInput {
  supplierId: string; skuId: string; qty: number | string; unitPrice: number | string; siteId: string; dueDate: string;
  supplierRef?: string; allowDuplicateReason?: string;
}

export function createPo(state: State, input: PoInput, ctx: Ctx): Result {
  return run(state, ctx, (d) => {
    const sup = d.s.suppliers.find((x) => x.id === input.supplierId) ?? fail('NOT_FOUND', 'Choose a supplier.');
    const sku = getSku(d, input.skuId);
    if (!sup.skuIds.includes(sku.id)) fail('INVALID', `${sup.name} is not set up to supply ${sku.id}.`);
    const site = d.s.sites.find((x) => x.id === input.siteId) ?? fail('NOT_FOUND', 'Choose a delivery site.');
    if (!d.s.bins.some((b) => b.siteId === site.id)) fail('INVALID', `${site.name} has no bins to receive into.`);
    const qty = parseQty(input.qty, 'Order quantity');
    const unitPrice4 = parsePrice4(input.unitPrice);
    const dueDate = parseDate(input.dueDate, 'Delivery date');
    if (dueDate < d.ctx.today) fail('INVALID', 'Delivery date cannot be in the past.');
    const ref = input.supplierRef?.trim() ? requireText(input.supplierRef, 'Supplier reference', 1, 40) : undefined;
    if (ref && d.s.pos.some((p) => p.supplierId === sup.id && p.supplierRef?.toUpperCase() === ref.toUpperCase())) {
      fail('DUPLICATE', `${sup.name} reference ${ref} is already on another PO.`);
    }
    const twin = d.s.pos.find((p) => p.status !== 'closed' && p.supplierId === sup.id && p.skuId === sku.id && p.siteId === site.id && p.qty === qty && p.dueDate === dueDate);
    let dupReason: string | undefined;
    if (twin) {
      if (!input.allowDuplicateReason) fail('DUPLICATE', `${twin.id} already orders the same SKU, quantity, site and date from this supplier. Give a reason to place a second one.`);
      dupReason = requireText(input.allowDuplicateReason, 'Duplicate reason', MIN_REASON);
    }
    const po: PurchaseOrder = {
      id: nextId(d, 'PO'), supplierId: sup.id, skuId: sku.id, qty, unitPrice4, siteId: site.id, dueDate,
      createdOn: d.ctx.today, createdBy: d.ctx.user, status: 'open', receipts: [], revisions: [], ...(ref ? { supplierRef: ref } : {}),
    };
    d.s.pos.push(po);
    audit(d, 'po.create', 'po', po.id, `${sup.id} ${sku.id} qty ${qty} @ ${unitPrice4}/10000 to ${site.id} due ${dueDate}${ref ? ` ref ${ref}` : ''}${twin ? ` (duplicate of ${twin.id})` : ''}`, dupReason);
  });
}

export const receivedQty = (po: PurchaseOrder) => po.receipts.reduce((s, r) => s + r.qty, 0);
export const overLimit = (po: PurchaseOrder, qtyBp: number) => po.qty + Math.floor((po.qty * qtyBp) / 10_000);

export function revisePo(state: State, poId: string, changes: { qty?: number | string; unitPrice?: number | string; dueDate?: string }, reason: string, ctx: Ctx): Result {
  return run(state, ctx, (d) => {
    const po = getPo(d, poId);
    if (po.status === 'closed') fail('INVALID', `${po.id} is closed and cannot be changed.`);
    const why = requireText(reason, 'Reason for the change', MIN_REASON);
    const startLen = po.revisions.length;
    const rec = (field: 'qty' | 'unitPrice4' | 'dueDate', from: string | number, to: string | number) => {
      if (from !== to) po.revisions.push({ at: d.ctx.at, user: d.ctx.user, field, from, to, reason: why });
    };
    if (changes.qty !== undefined && changes.qty !== '') {
      const q = parseQty(changes.qty, 'Order quantity');
      if (q < receivedQty(po)) fail('INVALID', `Already received ${receivedQty(po)}; quantity cannot go below that.`);
      rec('qty', po.qty, q); po.qty = q;
    }
    if (changes.unitPrice !== undefined && changes.unitPrice !== '') { const p = parsePrice4(changes.unitPrice); rec('unitPrice4', po.unitPrice4, p); po.unitPrice4 = p; }
    if (changes.dueDate) { const dd = parseDate(changes.dueDate, 'Delivery date'); if (dd < po.createdOn) fail('INVALID', 'Delivery date cannot be before the PO date.'); rec('dueDate', po.dueDate, dd); po.dueDate = dd; }
    const fresh = po.revisions.slice(startLen);
    if (!fresh.length) fail('INVALID', 'Nothing changed.');
    const rcv = receivedQty(po);
    if (po.status !== 'open') po.status = rcv >= po.qty || po.receipts.some((r) => r.final) ? 'received' : 'partial';
    audit(d, 'po.revise', 'po', po.id, fresh.map((r) => `${r.field} ${r.from} → ${r.to}`).join(', '), why);
  });
}

export interface ReceiptInput {
  date: string; packingSlip: string; qty: number | string; unitPrice: number | string; binId: string; final?: boolean; overReason?: string;
}

export function receivePo(state: State, poId: string, input: ReceiptInput, ctx: Ctx): Result {
  return run(state, ctx, (d) => {
    const po = getPo(d, poId);
    if (po.status === 'closed' || po.status === 'received') fail('PO_NOT_RECEIVABLE', `${po.id} is ${po.status}; it cannot be received against. Raise a new PO for extra stock.`);
    const date = parseDate(input.date, 'Receipt date');
    if (date > d.ctx.today) fail('INVALID', 'Receipt date cannot be in the future.');
    if (date < po.createdOn) fail('INVALID', 'Receipt date cannot be before the PO was raised.');
    const slip = requireText(input.packingSlip, 'Packing slip number', 1, 40).toUpperCase();
    const seen = d.s.pos.some((p) => p.supplierId === po.supplierId && p.receipts.some((r) => r.packingSlip === slip));
    if (seen) fail('DUPLICATE', `Packing slip ${slip} from this supplier was already received. This looks like a double receipt.`);
    const qty = parseQty(input.qty, 'Received quantity');
    const unitPrice4 = parsePrice4(input.unitPrice, 'Invoice unit price');
    const bin = getBin(d, input.binId);
    if (bin.siteId !== po.siteId) fail('INVALID', `${bin.id} is not at the PO's delivery site (${po.siteId}).`);
    const before = receivedQty(po);
    const total = before + qty;
    const tol = d.s.tolerance;
    let overReason: string | undefined;
    if (total > overLimit(po, tol.qtyBp)) {
      if (!input.overReason) fail('OVER_RECEIPT', `This brings ${po.id} to ${total} of ${po.qty} ordered, over the ${tol.qtyBp / 100}% tolerance. Refuse the excess, or give an over-receipt reason.`);
      overReason = requireText(input.overReason, 'Over-receipt reason', MIN_REASON);
    }
    const sku = getSku(d, po.skuId);
    const receipt: Receipt = {
      id: nextId(d, 'RC'), date, at: d.ctx.at, user: d.ctx.user, packingSlip: slip, qty, unitPrice4, binId: bin.id, palletIds: [],
      final: !!input.final, ...(overReason ? { overReason } : {}),
    };
    let left = qty;
    while (left > 0) {
      const q = Math.min(left, piecesPerPallet(sku));
      const p = newPallet(d, sku.id, receipt.id);
      post(d, { kind: 'receipt', location: bin.id, palletId: p.id, qty: q, ref: po.id });
      receipt.palletIds.push(p.id);
      left -= q;
    }
    po.receipts.push(receipt);
    const flags: Mismatch[] = [];
    const flag = (type: Mismatch['type'], direction: Mismatch['direction'], expected: number, actual: number) => flags.push({
      id: nextId(d, 'MM'), poId: po.id, receiptId: receipt.id, type, direction, expected, actual, createdAt: d.ctx.at, resolved: false,
    });
    if (exceedsTolerance(po.unitPrice4, unitPrice4, tol.priceBp)) flag('price', unitPrice4 > po.unitPrice4 ? 'high' : 'low', po.unitPrice4, unitPrice4);
    if (total > po.qty && exceedsTolerance(po.qty, total, tol.qtyBp)) flag('quantity', 'over', po.qty, total);
    else if (receipt.final && total < po.qty && exceedsTolerance(po.qty, total, tol.qtyBp)) flag('quantity', 'short', po.qty, total);
    d.s.mismatches.push(...flags);
    po.status = total >= po.qty || receipt.final ? 'received' : 'partial';
    audit(d, 'po.receive', 'po', po.id,
      `receipt ${receipt.id} slip ${slip} qty ${qty} (${describeQty(sku, qty)}) @ ${unitPrice4}/10000 into ${bin.id}; total ${total}/${po.qty}; status ${po.status}${receipt.final ? '; final' : ''}${flags.length ? `; flagged ${flags.map((f) => `${f.type}-${f.direction}`).join(', ')}` : ''}`,
      overReason);
  });
}

export function resolveMismatch(state: State, id: string, note: string, ctx: Ctx): Result {
  return run(state, ctx, (d) => {
    const m = d.s.mismatches.find((x) => x.id === id) ?? fail('NOT_FOUND', 'Mismatch not found.');
    if (m.resolved) fail('INVALID', `${m.id} is already resolved.`);
    const n = requireText(note, 'Resolution note', MIN_REASON);
    m.resolved = true; m.note = n; m.resolvedAt = d.ctx.at; m.resolvedBy = d.ctx.user;
    audit(d, 'mismatch.resolve', 'mismatch', m.id, `${m.poId} ${m.type} ${m.direction} expected ${m.expected} actual ${m.actual}`, n);
  });
}

export function closePo(state: State, poId: string, reason: string, ctx: Ctx): Result {
  return run(state, ctx, (d) => {
    const po = getPo(d, poId);
    if (po.status === 'closed') fail('INVALID', `${po.id} is already closed.`);
    const open = d.s.mismatches.filter((m) => m.poId === po.id && !m.resolved);
    if (open.length) fail('OPEN_MISMATCHES', `Resolve ${open.length} receipt mismatch${open.length > 1 ? 'es' : ''} on ${po.id} before closing it.`);
    let why: string | undefined;
    if (po.status !== 'received') why = requireText(reason, `Reason for closing ${po.id} short`, MIN_REASON);
    else if (reason?.trim()) why = requireText(reason, 'Reason', 1);
    const was = po.status;
    po.status = 'closed'; po.closedOn = d.ctx.today; if (why) po.closeReason = why;
    audit(d, 'po.close', 'po', po.id, `closed from ${was}; received ${receivedQty(po)} of ${po.qty}`, why);
  });
}

// ---------------------------------------------------------------- outbound and movement

export function shipOut(state: State, input: { binId: string; skuId: string; qty: number | string; reference: string; palletId?: string }, ctx: Ctx): Result {
  return run(state, ctx, (d) => {
    getBin(d, input.binId); getSku(d, input.skuId);
    const qty = parseQty(input.qty, 'Ship quantity');
    const reference = requireText(input.reference, 'Shipment reference', 2, 60);
    const id = nextId(d, 'SH');
    for (const p of pick(d, input.binId, input.skuId, qty, input.palletId || undefined)) {
      post(d, { kind: 'ship', location: input.binId, palletId: p.palletId, qty: -p.take, ref: id });
    }
    d.s.shipments.push({ id, at: d.ctx.at, user: d.ctx.user, skuId: input.skuId, binId: input.binId, qty, reference });
    audit(d, 'stock.ship', 'shipment', id, `${input.skuId} ${qty} pieces from ${input.binId}, ref ${reference}`);
  });
}

/** Step 1 of a transfer: stock leaves the source bin and sits in transit. Whole pallets keep their LPN; a partial pick gets a new LPN. */
export function createTransfer(state: State, input: { fromBin: string; toBin: string; skuId: string; qty: number | string; palletId?: string }, ctx: Ctx): Result {
  return run(state, ctx, (d) => {
    getBin(d, input.fromBin); getBin(d, input.toBin); getSku(d, input.skuId);
    if (input.fromBin === input.toBin) fail('INVALID', 'Source and destination bins must be different.');
    const qty = parseQty(input.qty, 'Transfer quantity');
    const id = nextId(d, 'TR');
    const transit = TRANSIT_PREFIX + id;
    const moves: { from: string; to: string; qty: number }[] = [];
    for (const p of pick(d, input.fromBin, input.skuId, qty, input.palletId || undefined)) {
      post(d, { kind: 'transfer-out', location: input.fromBin, palletId: p.palletId, qty: -p.take, ref: id });
      const to = p.take === p.had ? p.palletId : newPallet(d, input.skuId, `${id} from ${p.palletId}`).id;
      post(d, { kind: 'transit-in', location: transit, palletId: to, qty: p.take, ref: id });
      moves.push({ from: p.palletId, to, qty: p.take });
    }
    d.s.transfers.push({ id, skuId: input.skuId, fromBin: input.fromBin, toBin: input.toBin, qty, status: 'in-transit', shippedAt: d.ctx.at, shippedBy: d.ctx.user, palletMoves: moves });
    audit(d, 'transfer.ship', 'transfer', id, `${input.skuId} ${qty} pieces ${input.fromBin} → ${input.toBin} (in transit)`);
  });
}

/** Step 2: the destination receives everything in transit for this transfer, pallet by pallet. */
export function receiveTransfer(state: State, transferId: string, ctx: Ctx): Result {
  return run(state, ctx, (d) => {
    const t = d.s.transfers.find((x) => x.id === transferId) ?? fail('NOT_FOUND', 'Transfer not found.');
    if (t.status !== 'in-transit') fail('INVALID', `${t.id} was already received.`);
    getBin(d, t.toBin);
    for (const m of t.palletMoves) {
      post(d, { kind: 'transit-out', location: TRANSIT_PREFIX + t.id, palletId: m.to, qty: -m.qty, ref: t.id });
      post(d, { kind: 'transfer-in', location: t.toBin, palletId: m.to, qty: m.qty, ref: t.id });
    }
    t.status = 'received'; t.receivedAt = d.ctx.at; t.receivedBy = d.ctx.user;
    audit(d, 'transfer.receive', 'transfer', t.id, `${t.skuId} ${t.qty} pieces received into ${t.toBin}`);
  });
}

function locateInBin(d: Draft, palletId: string): string {
  const places = [...(d.where.get(palletId)?.keys() ?? [])];
  const loc = places.find((l) => !l.startsWith(TRANSIT_PREFIX));
  if (!loc) fail('INSUFFICIENT_STOCK', `Pallet ${palletId} is empty or in transit.`);
  return loc!;
}

/** Breaks qty pieces off a pallet onto a new LPN in the same bin. */
export function splitPallet(state: State, palletId: string, qty: number | string, ctx: Ctx): Result {
  return run(state, ctx, (d) => {
    const src = getPallet(d, palletId);
    const bin = locateInBin(d, palletId);
    const q = parseQty(qty, 'Split quantity');
    const have = d.bal.get(k(bin, palletId)) ?? 0;
    if (q >= have) fail('INVALID', `Pallet ${palletId} has ${have} pieces; a split must leave at least one piece behind.`);
    const p = newPallet(d, src.skuId, `split from ${palletId}`);
    post(d, { kind: 'split-out', location: bin, palletId, qty: -q, ref: p.id });
    post(d, { kind: 'split-in', location: bin, palletId: p.id, qty: q, ref: palletId });
    audit(d, 'pallet.split', 'pallet', palletId, `${q} pieces to new ${p.id} in ${bin}`);
  });
}

/** Moves every piece from one pallet onto another of the same SKU in the same bin. */
export function mergePallets(state: State, fromId: string, intoId: string, ctx: Ctx): Result {
  return run(state, ctx, (d) => {
    if (fromId === intoId) fail('INVALID', 'Choose two different pallets.');
    const a = getPallet(d, fromId); const b = getPallet(d, intoId);
    if (a.skuId !== b.skuId) fail('INVALID', `Cannot merge ${a.skuId} onto ${b.skuId}.`);
    const binA = locateInBin(d, fromId); const binB = locateInBin(d, intoId);
    if (binA !== binB) fail('INVALID', `Pallets are in different bins (${binA}, ${binB}). Transfer first.`);
    const q = d.bal.get(k(binA, fromId)) ?? 0;
    post(d, { kind: 'merge-out', location: binA, palletId: fromId, qty: -q, ref: intoId });
    post(d, { kind: 'merge-in', location: binA, palletId: intoId, qty: q, ref: fromId });
    audit(d, 'pallet.merge', 'pallet', intoId, `${q} pieces from ${fromId} in ${binA}`);
  });
}

/** Manual adjustment (damage, scrap, found stock). Needs a reason; decrements are blocked by holds like any other. */
export function adjustStock(state: State, input: { binId: string; skuId: string; delta: number | string; reason: string; palletId?: string }, ctx: Ctx): Result {
  return run(state, ctx, (d) => {
    getBin(d, input.binId); getSku(d, input.skuId);
    const raw = typeof input.delta === 'string' ? input.delta.trim() : input.delta;
    const neg = typeof raw === 'string' ? raw.startsWith('-') : raw < 0;
    const mag = parseQty(typeof raw === 'string' ? raw.replace(/^[-+]/, '') : Math.abs(raw), 'Adjustment');
    const why = requireText(input.reason, 'Adjustment reason', MIN_REASON);
    const id = nextId(d, 'ADJ');
    if (neg) {
      for (const p of pick(d, input.binId, input.skuId, mag, input.palletId || undefined)) post(d, { kind: 'adjust', location: input.binId, palletId: p.palletId, qty: -p.take, ref: id, reason: why });
    } else {
      let pid = input.palletId;
      if (pid) { const p = getPallet(d, pid); if (p.skuId !== input.skuId) fail('INVALID', `Pallet ${pid} holds ${p.skuId}.`); }
      else pid = newPallet(d, input.skuId, id).id;
      post(d, { kind: 'adjust', location: input.binId, palletId: pid, qty: mag, ref: id, reason: why });
    }
    audit(d, 'stock.adjust', 'adjustment', id, `${input.skuId} ${neg ? '-' : '+'}${mag} in ${input.binId}`, why);
  });
}

// ---------------------------------------------------------------- counting, holds, reconciliation

export interface CountSubmission {
  binId: string;
  /** Ledger length when the counter started (they never see system quantities). */
  startedSeq: number;
  startedAt: string;
  /** Pieces counted per scanned pallet. */
  pallets: Record<string, number>;
  /** Unlabelled pieces found, per SKU. */
  loose: Record<string, number>;
  scheduled: boolean;
  notes?: string[];
}

export function submitCount(state: State, sub: CountSubmission, ctx: Ctx): Result {
  return run(state, ctx, (d) => {
    const bin = getBin(d, sub.binId);
    if (!Number.isSafeInteger(sub.startedSeq) || sub.startedSeq < 0 || sub.startedSeq > d.s.ledger.length) fail('INVALID', 'Count start point is invalid.');
    const notes = [...(sub.notes ?? [])];
    const snap = new Map<string, number>();
    for (const e of d.s.ledger) { if (e.seq > sub.startedSeq) break; if (e.location === bin.id) snap.set(e.palletId, (snap.get(e.palletId) ?? 0) + e.qty); }
    const movedSince = new Set(d.s.ledger.filter((e) => e.seq > sub.startedSeq && e.location === bin.id).map((e) => e.palletId));
    const ids = new Set<string>();
    for (const [p, q] of snap) if (q > 0) ids.add(p);
    for (const p of d.s.pallets) if ((d.bal.get(k(bin.id, p.id)) ?? 0) > 0) ids.add(p.id);
    for (const p of Object.keys(sub.pallets)) {
      const pal = getPallet(d, p);
      const loc = [...(d.where.get(p)?.keys() ?? [])];
      if (!ids.has(p) && !(snap.get(p))) {
        fail('INVALID', `Pallet ${pal.id} is registered ${loc.length ? `to ${loc.join(', ')}` : 'as empty'}, not ${bin.id}. Count it where it belongs or transfer it first.`);
      }
    }
    const count = { id: nextId(d, 'CC'), binId: bin.id, date: d.ctx.today, startedAt: sub.startedAt, startedSeq: sub.startedSeq, submittedAt: d.ctx.at, user: d.ctx.user, lines: [] as State['counts'][number]['lines'], recount: false, scheduled: !!sub.scheduled, notes };
    const pal = (id: string) => getPallet(d, id);
    for (const p of [...ids].sort()) {
      const systemQty = Math.max(0, snap.get(p) ?? 0);
      const currentQty = d.bal.get(k(bin.id, p)) ?? 0;
      const scanned = Object.prototype.hasOwnProperty.call(sub.pallets, p);
      if (!scanned && systemQty === 0) { notes.push(`${p} arrived after the count started and was not counted.`); continue; }
      const countedQty = scanned ? parseQty(sub.pallets[p], `Count for ${p}`, true) : 0;
      count.lines.push({ palletId: p, skuId: pal(p).skuId, systemQty, currentQty, countedQty, moved: movedSince.has(p), scanned });
    }
    for (const [skuId, q] of Object.entries(sub.loose)) {
      getSku(d, skuId);
      const n = parseQty(q, `Unlabelled ${skuId}`, true);
      if (n > 0) count.lines.push({ palletId: '', skuId, systemQty: 0, currentQty: 0, countedQty: n, moved: false, scanned: false });
    }
    let held = 0; let released = 0;
    for (const line of count.lines) {
      const existing = d.s.holds.find((h) => !isReleased(d.s, h) && h.binId === bin.id && h.skuId === line.skuId && h.palletId === line.palletId);
      if (existing) count.recount = true;
      const okVsStart = !line.moved && line.countedQty === line.systemQty;
      const okVsNow = line.moved && (line.countedQty === line.currentQty || line.countedQty === line.systemQty);
      if (okVsStart || okVsNow) {
        if (existing) {
          existing.resolved = true;
          const rec = { id: nextId(d, 'RCN'), holdId: existing.id, at: d.ctx.at, user: d.ctx.user, method: 'recount-matched' as const, delta: 0, reason: 'Recount matched the system quantity', countId: count.id };
          existing.reconciliationId = rec.id;
          d.s.reconciliations.push(rec);
          audit(d, 'hold.release', 'hold', existing.id, `recount ${count.id} matched: ${line.palletId} ${line.skuId} counted ${line.countedQty}`, rec.reason);
          released++;
        }
        continue;
      }
      const kind = line.moved ? 'moved' : 'variance';
      if (existing) {
        existing.kind = kind; existing.systemQty = line.systemQty; existing.countedQty = line.countedQty; existing.countIds.push(count.id);
        audit(d, 'hold.update', 'hold', existing.id, `recount ${count.id} still disagrees: ${line.palletId || 'unlabelled'} ${line.skuId} system ${line.systemQty} counted ${line.countedQty} (${line.countedQty - line.systemQty > 0 ? '+' : ''}${line.countedQty - line.systemQty})`);
      } else {
        const h: Hold = { id: nextId(d, 'HOLD'), binId: bin.id, skuId: line.skuId, palletId: line.palletId, kind, systemQty: line.systemQty, countedQty: line.countedQty, createdAt: d.ctx.at, countIds: [count.id], resolved: false };
        d.s.holds.push(h);
        audit(d, 'hold.place', 'hold', h.id, `${kind === 'moved' ? 'stock moved during count' : 'count variance'}: ${line.palletId || 'unlabelled'} ${line.skuId} in ${bin.id} system ${line.systemQty} counted ${line.countedQty} (${line.countedQty - line.systemQty > 0 ? '+' : ''}${line.countedQty - line.systemQty}); outbound blocked`);
      }
      held++;
    }
    d.s.counts.push(count);
    audit(d, 'count.submit', 'count', count.id,
      `${bin.id} ${count.scheduled ? 'scheduled' : 'ad hoc'}${count.recount ? ' recount' : ''}: ${count.lines.map((l) => `${l.palletId || 'unlabelled'} ${l.skuId} sys ${l.systemQty} cnt ${l.countedQty}${l.moved ? ' moved' : ''}`).join('; ') || 'empty bin, nothing found'}; ${held} on hold, ${released} released${notes.length ? `; notes: ${notes.join(' ')}` : ''}`);
  });
}

/** Releases a variance hold by accepting the count: posts the difference to the ledger as a reconcile entry. */
export function acceptHold(state: State, holdId: string, reason: string, ctx: Ctx): Result {
  return run(state, ctx, (d) => {
    const h = d.s.holds.find((x) => x.id === holdId) ?? fail('NOT_FOUND', 'Hold not found.');
    if (isReleased(d.s, h)) fail('INVALID', `${h.id} is already reconciled.`);
    if (h.kind === 'moved') fail('RECOUNT_REQUIRED', `Stock moved while ${h.id} was being counted, so the count cannot be trusted. Recount the bin.`);
    const why = requireText(reason, 'Reason for accepting the count', MIN_REASON);
    const delta = h.countedQty - h.systemQty;
    const id = nextId(d, 'RCN');
    d.resolving.add(h.id);
    let palletId = h.palletId;
    if (delta !== 0) {
      if (!palletId) palletId = newPallet(d, h.skuId, `found in count ${h.countIds[h.countIds.length - 1]}`).id;
      post(d, { kind: 'reconcile', location: h.binId, palletId, qty: delta, ref: h.id, reason: why });
    }
    h.resolved = true; h.reconciliationId = id;
    d.s.reconciliations.push({ id, holdId: h.id, at: d.ctx.at, user: d.ctx.user, method: 'accept-count', delta, reason: why, countId: h.countIds[h.countIds.length - 1] });
    audit(d, 'hold.reconcile', 'hold', h.id, `accepted count: ${palletId || 'unlabelled'} ${h.skuId} in ${h.binId} ${h.systemQty} → ${h.countedQty} (${delta > 0 ? '+' : ''}${delta}), reconciliation ${id}`, why);
  });
}

// ---------------------------------------------------------------- settings

export function setTolerance(state: State, qtyPct: string | number, pricePct: string | number, ctx: Ctx): Result {
  return run(state, ctx, (d) => {
    const bp = (v: string | number, label: string) => {
      const s = String(v).trim();
      if (!/^\d{1,2}(\.\d{1,2})?$/.test(s)) fail('INVALID', `${label} must be a percentage from 0 to 99.99 with at most 2 decimals.`);
      const [w, f = ''] = s.split('.');
      return Number(w) * 100 + Number(f.padEnd(2, '0'));
    };
    const q = bp(qtyPct, 'Quantity tolerance'); const p = bp(pricePct, 'Price tolerance');
    const was = d.s.tolerance;
    d.s.tolerance = { qtyBp: q, priceBp: p };
    audit(d, 'settings.tolerance', 'settings', 'tolerance', `qty ${was.qtyBp}bp → ${q}bp, price ${was.priceBp}bp → ${p}bp`);
  });
}

export function setCycle(state: State, cycleDays: number | string, startDate: string, ctx: Ctx): Result {
  return run(state, ctx, (d) => {
    const n = parseQty(cycleDays, 'Cycle length');
    if (n > 260) fail('INVALID', 'Cycle length must be 260 working days or fewer.');
    const sd = parseDate(startDate, 'Cycle start');
    const was = d.s.cycle;
    d.s.cycle = { cycleDays: n, startDate: sd };
    audit(d, 'settings.cycle', 'settings', 'cycle', `${was.cycleDays} days from ${was.startDate} → ${n} days from ${sd}`);
  });
}

export function logLabelPrint(state: State, codes: string[], ctx: Ctx): Result {
  return run(state, ctx, (d) => {
    if (!codes.length) fail('INVALID', 'No labels selected.');
    const dup = codes.find((c, i) => codes.indexOf(c) !== i);
    if (dup) fail('DUPLICATE', `Label ${dup} is in the print run twice.`);
    audit(d, 'labels.print', 'labels', `${codes.length}`, codes.join(', '));
  });
}
