import './style.css';
import QRCode from 'qrcode';
import type { Result, Sku, State } from './model/types';
import { TRANSIT_PREFIX } from './model/types';
import { seedState } from './model/seed';
import {
  acceptHold, addBin, adjustStock, closePo, createPo, createTransfer, isBlocked, logLabelPrint, mergePallets, receivePo,
  receiveTransfer, receivedQty, resolveMismatch, revisePo, setCycle, setTolerance, shipOut, splitPallet, submitCount,
} from './model/ops';
import { palletBalances, siteTotals, verifyState } from './model/ledger';
import { buildSchedule, todaysCounts } from './model/schedule';
import { applyScan, Debouncer, sessionProblems, startSession, type CountSession } from './model/scan';
import { dashboard, exportAudit, exportLedger, exportPos, exportStock } from './model/dashboard';
import { describe as qtyText, piecesPerPallet, toPieces } from './model/uom';
import { formatCents, extendedCents, formatPrice4, localDate, ValidationError } from './model/validate';
import { clearState, loadState, saveState, USER_KEY } from './storage';
import { hasCamera, startCamera } from './scanner';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const n = (v: number) => v.toLocaleString('en-CA');

const today = localDate();
let state: State;
let session: CountSession | null = null;
let stopCam: (() => void) | null = null;
const debounce = new Debouncer(1500);
let selectedPo = '';

const loaded = loadState(localStorage);
if (loaded.kind === 'ok') state = loaded.state;
else {
  state = seedState(today);
  if (loaded.kind === 'corrupt') {
    const f = $('fatal');
    f.hidden = false;
    f.innerHTML = `<strong>Saved data failed its integrity check and was not loaded.</strong> ${loaded.problems.slice(0, 5).map(esc).join(' ')}
      <button type="button" data-action="download-raw">Download the saved data</button> <button type="button" data-action="reset">Discard it and load demo data</button>`;
    (window as unknown as { __raw: string }).__raw = loaded.raw;
  } else saveState(localStorage, state);
}
$<HTMLInputElement>('user').value = localStorage.getItem(USER_KEY) ?? '';
$('company').textContent = state.company;
$('today').textContent = today;

const ctx = () => ({ user: $<HTMLInputElement>('user').value, at: new Date().toISOString(), today });
const sku = (id: string) => state.skus.find((s) => s.id === id)!;
const siteName = (id: string) => state.sites.find((s) => s.id === id)?.name ?? id;
const binSite = () => new Map(state.bins.map((b) => [b.id, b.siteId]));

let msgTimer: number | undefined;
function say(text: string, bad = false): void {
  const m = $('msg');
  m.textContent = text;
  m.className = `msg${bad ? ' bad' : ''}`;
  window.clearTimeout(msgTimer);
  msgTimer = window.setTimeout(() => { m.textContent = ''; }, bad ? 15000 : 6000);
}

/** Applies an operation result: saves and re-renders on success, shows the error otherwise. */
function apply(r: Result, ok: string): boolean {
  if (!r.ok) { say(r.error, true); return false; }
  state = r.state;
  if (!saveState(localStorage, state)) say('Saved in memory only: this browser refused to store the data.', true);
  else say(ok);
  render();
  return true;
}

// ---------------------------------------------------------------- shared bits

const opt = (v: string, label: string, sel = '') => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(label)}</option>`;
const skuOptions = (sel = '') => state.skus.map((s) => opt(s.id, `${s.id} · ${s.name}`, sel)).join('');
const binOptions = (filter: (siteId: string) => boolean = () => true, sel = '') =>
  state.bins.filter((b) => filter(b.siteId)).map((b) => opt(b.id, `${b.id} (${siteName(b.siteId)})`, sel)).join('');
const field = (label: string, inner: string, hint = '') => `<label class="field"><span>${label}</span>${inner}${hint ? `<small>${hint}</small>` : ''}</label>`;

function qtyInputs(name: string, opts: { pallets?: boolean } = { pallets: true }): string {
  const inp = (suffix: string, label: string) =>
    `<label class="q"><span>${label}</span><input name="${name}_${suffix}" inputmode="numeric" pattern="[0-9]*" autocomplete="off" /></label>`;
  return `<fieldset class="qty"><legend>Quantity</legend>${opts.pallets === false ? '' : inp('pal', 'Full pallets')}${inp('cs', 'Cases / layers')}${inp('pc', 'Pieces')}</fieldset>`;
}

function readInt(fd: FormData, key: string): number {
  const raw = String(fd.get(key) ?? '').trim().replace(/,/g, '');
  if (raw === '') return 0;
  if (!/^\d+$/.test(raw)) throw new ValidationError('Pallets, cases and pieces must be whole numbers.');
  return Number(raw);
}

function readQty(fd: FormData, name: string, s: Sku): number {
  return toPieces(s, { pallets: readInt(fd, `${name}_pal`), cases: readInt(fd, `${name}_cs`), pieces: readInt(fd, `${name}_pc`) });
}

const statusTag = (s: string) => `<span class="tag s-${esc(s)}">${esc(s)}</span>`;

// ---------------------------------------------------------------- views

function viewDashboard(): string {
  const d = dashboard(state, today);
  const c = d.cycle;
  const stat = (k: string, v: string, cls = '', href = '') => `<a class="stat ${cls}" href="${href}"><span class="k">${k}</span><span class="v">${v}</span></a>`;
  const holds = state.holds.filter((h) => !h.resolved);
  const mm = state.mismatches.filter((m) => !m.resolved);
  return `<h2 id="h-dashboard">Supervisor dashboard</h2>
  <div class="stats">
    ${stat('Open POs', n(d.openPos), '', '#pos')}
    ${stat('Overdue deliveries', n(d.overdue.length), d.overdue.length ? 'bad' : 'good', '#pos')}
    ${stat('Receipt mismatches', n(d.openMismatches), d.openMismatches ? 'bad' : 'good', '#pos')}
    ${stat('Items on count hold', n(d.holds), d.holds ? 'bad' : 'good', '#counts')}
    ${stat('In transit', n(d.inTransit), '', '#stock')}
    ${stat('Cycle progress', `${c.binsCounted}/${c.binsTotal} bins`, c.overdue ? 'bad' : '', '#counts')}
    ${stat('Count accuracy', c.accuracyPct === null ? '—' : `${c.accuracyPct}%`, c.accuracyPct !== null && c.accuracyPct < 95 ? 'bad' : 'good', '#counts')}
    ${stat('Low stock lines', n(d.lowStock.length), d.lowStock.length ? 'bad' : 'good', '#dashboard')}
  </div>
  <p class="hint">Accuracy is pallet lines whose first count matched the system, this cycle (${c.linesMatched} of ${c.linesCounted}). ${c.dueSoFar} bins were due by today; ${c.overdue} scheduled bins are behind.</p>
  <div class="grid2">
    <div><h3>Overdue deliveries</h3>${d.overdue.length ? `<ul class="list">${d.overdue.map((o) => `<li><a href="#pos" data-po="${o.poId}">${o.poId}</a> due ${o.dueDate}, ${o.daysLate} days late, ${n(o.outstanding)} pieces outstanding</li>`).join('')}</ul>` : '<p class="ok">None.</p>'}</div>
    <div><h3>Unresolved receipt mismatches</h3>${mm.length ? `<ul class="list">${mm.map((m) => `<li><a href="#pos" data-po="${m.poId}">${m.poId}</a> ${m.type} ${m.direction}: expected ${m.type === 'price' ? formatPrice4(m.expected) : n(m.expected)}, got ${m.type === 'price' ? formatPrice4(m.actual) : n(m.actual)}</li>`).join('')}</ul>` : '<p class="ok">None.</p>'}</div>
    <div><h3>Items on count hold (outbound blocked)</h3>${holds.length ? `<ul class="list">${holds.map((h) => `<li>${h.binId} · ${h.skuId} · ${h.palletId || 'unlabelled pieces'}: system ${n(h.systemQty)}, counted ${n(h.countedQty)} (${h.countedQty - h.systemQty > 0 ? '+' : ''}${n(h.countedQty - h.systemQty)})${h.kind === 'moved' ? ' · moved during count, recount needed' : ''}</li>`).join('')}</ul>` : '<p class="ok">None.</p>'}</div>
    <div><h3>Low stock by site</h3>${d.lowStock.length ? `<table><thead><tr><th scope="col">Site</th><th scope="col">SKU</th><th scope="col" class="num">On hand</th><th scope="col" class="num">Minimum</th></tr></thead><tbody>${d.lowStock.map((l) => `<tr><td>${esc(siteName(l.siteId))}</td><td>${l.skuId}</td><td class="num">${n(l.qty)}</td><td class="num">${n(l.min)}</td></tr>`).join('')}</tbody></table>` : '<p class="ok">None.</p>'}</div>
  </div>`;
}

function viewPos(): string {
  const sup = state.suppliers.map((s) => opt(s.id, `${s.name} (${s.skuIds.join(', ')})`)).join('');
  const rows = [...state.pos].reverse().map((p) => {
    const rcv = receivedQty(p);
    const late = (p.status === 'open' || p.status === 'partial') && p.dueDate < today;
    const mm = state.mismatches.filter((m) => m.poId === p.id && !m.resolved).length;
    return `<tr${p.id === selectedPo ? ' class="sel"' : ''}>
      <td><button type="button" class="link" data-po="${p.id}" aria-expanded="${p.id === selectedPo}">${p.id}</button></td>
      <td>${esc(state.suppliers.find((s) => s.id === p.supplierId)?.name)}</td><td>${p.skuId}</td>
      <td class="num">${n(rcv)} / ${n(p.qty)}</td><td class="num">${formatPrice4(p.unitPrice4)}</td><td>${esc(siteName(p.siteId))}</td>
      <td>${p.dueDate}${late ? ' <span class="tag s-late">late</span>' : ''}</td><td>${statusTag(p.status)}${mm ? ` <span class="tag s-flag">${mm} flag${mm > 1 ? 's' : ''}</span>` : ''}</td></tr>`;
  }).join('');
  return `<h2 id="h-pos">Purchase orders</h2>
  <details class="panel"><summary>New purchase order</summary>
    <form data-form="po-create" class="form" novalidate>
      ${field('Supplier', `<select name="supplier" required>${sup}</select>`)}
      ${field('SKU', `<select name="sku" required>${skuOptions()}</select>`)}
      ${field('Quantity (pieces)', '<input name="qty" inputmode="numeric" required />', 'Whole pieces, e.g. 49014 cans')}
      ${field('Unit price ($)', '<input name="price" inputmode="decimal" required placeholder="0.0912" />', 'Up to 4 decimals')}
      ${field('Deliver to', `<select name="site">${state.sites.map((s) => opt(s.id, `${s.name} (${s.kind === 'copacker' ? 'co-packer' : 'warehouse'})`)).join('')}</select>`)}
      ${field('Delivery date', `<input type="date" name="due" min="${today}" required />`)}
      ${field('Supplier reference (optional)', '<input name="ref" maxlength="40" />', 'Must be unique per supplier')}
      ${field('Reason, if this duplicates an open PO', '<input name="dup" maxlength="200" />')}
      <button type="submit">Create PO</button>
    </form></details>
  <p class="hint">Tolerance: quantity ±${state.tolerance.qtyBp / 100}%, price ±${state.tolerance.priceBp / 100}%. Receipts outside it are flagged and the PO cannot be closed until each flag is resolved with a note.</p>
  <div class="table-wrap"><table><caption class="sr-only">Purchase orders, newest first</caption><thead><tr><th scope="col">PO</th><th scope="col">Supplier</th><th scope="col">SKU</th><th scope="col" class="num">Received / ordered</th><th scope="col" class="num">Unit price</th><th scope="col">Site</th><th scope="col">Due</th><th scope="col">Status</th></tr></thead><tbody>${rows}</tbody></table></div>
  ${selectedPo ? poDetail(selectedPo) : '<p class="hint">Choose a PO number to receive, revise, resolve flags or close it.</p>'}`;
}

function poDetail(id: string): string {
  const p = state.pos.find((x) => x.id === id);
  if (!p) return '';
  const s = sku(p.skuId);
  const mms = state.mismatches.filter((m) => m.poId === p.id);
  const receivable = p.status === 'open' || p.status === 'partial';
  const rcv = receivedQty(p);
  return `<article class="panel detail" aria-labelledby="po-h"><h3 id="po-h">${p.id} · ${esc(s.name)}</h3>
    <p>${statusTag(p.status)} Ordered ${n(p.qty)} ${s.uom}s (${qtyText(s, p.qty)}) at ${formatPrice4(p.unitPrice4)} = ${formatCents(extendedCents(p.qty, p.unitPrice4))}. Received ${n(rcv)}. Deliver to ${esc(siteName(p.siteId))} by ${p.dueDate}. Raised ${p.createdOn} by ${esc(p.createdBy)}${p.supplierRef ? `, supplier ref ${esc(p.supplierRef)}` : ''}.${p.closeReason ? ` Closed: ${esc(p.closeReason)}` : ''}</p>
    <p class="small">1 pallet = ${s.casesPerPallet} ${s.caseUom}s × ${s.caseQty} = ${n(piecesPerPallet(s))} ${s.uom}s.</p>
    ${receivable ? `<form data-form="po-receive" data-id="${p.id}" class="form" novalidate><h4>Receive against ${p.id}</h4>
      ${field('Receipt date', `<input type="date" name="date" value="${today}" max="${today}" required />`)}
      ${field('Packing slip no.', '<input name="slip" maxlength="40" required />', 'Each slip can only be received once')}
      ${qtyInputs('q')}
      ${field('Invoice unit price ($)', `<input name="price" inputmode="decimal" value="${(p.unitPrice4 / 10000).toFixed(4)}" required />`)}
      ${field('Put into bin', `<select name="bin">${binOptions((sid) => sid === p.siteId, `${p.siteId}-RCV-01`)}</select>`)}
      <label class="check"><input type="checkbox" name="final" /> Supplier says this is the last delivery on this PO</label>
      ${field('Over-receipt reason (only if over tolerance)', '<input name="over" maxlength="200" />')}
      <button type="submit">Post receipt</button></form>` : ''}
    <h4>Receipts</h4>${p.receipts.length ? `<ul class="list">${p.receipts.map((r) => `<li>${r.id} · ${r.date} · slip ${esc(r.packingSlip)} · ${n(r.qty)} @ ${formatPrice4(r.unitPrice4)} into ${r.binId} · pallets ${r.palletIds.join(', ')} · by ${esc(r.user)}${r.final ? ' · final' : ''}${r.overReason ? ` · over-receipt: ${esc(r.overReason)}` : ''}</li>`).join('')}</ul>` : '<p class="muted">None yet.</p>'}
    <h4>Mismatches</h4>${mms.length ? `<ul class="list">${mms.map((m) => `<li class="${m.resolved ? '' : 'flag'}">${m.id} · ${m.type} ${m.direction}: expected ${m.type === 'price' ? formatPrice4(m.expected) : n(m.expected)}, actual ${m.type === 'price' ? formatPrice4(m.actual) : n(m.actual)}
      ${m.resolved ? `· resolved by ${esc(m.resolvedBy)}: ${esc(m.note)}` : `<form data-form="mm-resolve" data-id="${m.id}" class="inline" novalidate><label><span class="sr-only">Resolution note for ${m.id}</span><input name="note" placeholder="Resolution note (required)" maxlength="300" /></label><button type="submit">Resolve</button></form>`}</li>`).join('')}</ul>` : '<p class="muted">None.</p>'}
    ${p.status !== 'closed' ? `<form data-form="po-revise" data-id="${p.id}" class="form" novalidate><h4>Revise</h4>
      ${field('New quantity', '<input name="qty" inputmode="numeric" />')}${field('New unit price ($)', '<input name="price" inputmode="decimal" />')}${field('New delivery date', '<input type="date" name="due" />')}
      ${field('Reason (required)', '<input name="reason" maxlength="200" />')}<button type="submit">Save revision</button></form>
      <form data-form="po-close" data-id="${p.id}" class="form" novalidate><h4>Close</h4>${field(p.status === 'received' ? 'Note (optional)' : 'Reason for closing short (required)', '<input name="reason" maxlength="200" />')}<button type="submit">Close ${p.id}</button></form>` : ''}
    <h4>Revision history</h4>${p.revisions.length ? `<ul class="list">${p.revisions.map((r) => `<li>${esc(r.at)} ${esc(r.user)}: ${r.field} ${esc(r.from)} → ${esc(r.to)} (${esc(r.reason)})</li>`).join('')}</ul>` : '<p class="muted">No changes.</p>'}
  </article>`;
}

function viewStock(): string {
  const bs = binSite();
  const bal = [...palletBalances(state.ledger).values()].sort((a, b) => a.location.localeCompare(b.location) || a.palletId.localeCompare(b.palletId));
  const totals = siteTotals(state);
  const sites = [...state.sites.map((s) => s.id), 'TRANSIT'];
  const transit = state.transfers.filter((t) => t.status === 'in-transit');
  return `<h2 id="h-stock">Stock and moves</h2>
  <p class="hint">Every figure here is summed from the ledger, pallet by pallet, in pieces. Stock on count hold cannot be shipped, transferred, split, merged or written down until the count is reconciled.</p>
  <h3>Site totals (pieces)</h3>
  <div class="table-wrap"><table><thead><tr><th scope="col">SKU</th>${sites.map((s) => `<th scope="col" class="num">${esc(s === 'TRANSIT' ? 'In transit' : siteName(s))}</th>`).join('')}</tr></thead><tbody>
  ${state.skus.map((s) => `<tr><th scope="row">${s.id}</th>${sites.map((x) => `<td class="num">${n(totals.get(x)?.get(s.id) ?? 0)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
  <div class="grid2">
    <form data-form="ship" class="form panel" novalidate><h3>Ship out / issue to production</h3>
      ${field('From bin', `<select name="bin">${binOptions()}</select>`)}${field('SKU', `<select name="sku">${skuOptions()}</select>`)}
      ${qtyInputs('q')}${field('Specific pallet (optional)', '<input name="pallet" placeholder="LPN-000123" />')}${field('Reference', '<input name="ref" maxlength="60" placeholder="Production run or BOL" />')}
      <button type="submit">Ship</button></form>
    <form data-form="transfer" class="form panel" novalidate><h3>Transfer between bins or sites</h3>
      ${field('From bin', `<select name="from">${binOptions()}</select>`)}${field('To bin', `<select name="to">${binOptions()}</select>`)}${field('SKU', `<select name="sku">${skuOptions()}</select>`)}
      ${qtyInputs('q')}${field('Specific pallet (optional)', '<input name="pallet" placeholder="LPN-000123" />')}
      <p class="small">Stock leaves the source now and sits in transit until the destination receives it. Partial pallets get a new LPN.</p>
      <button type="submit">Ship transfer</button></form>
    <form data-form="split" class="form panel" novalidate><h3>Break a pallet</h3>
      ${field('Pallet', '<input name="pallet" placeholder="LPN-000123" required />')}${field('Pieces to break off', '<input name="qty" inputmode="numeric" />')}<button type="submit">Split to new LPN</button></form>
    <form data-form="merge" class="form panel" novalidate><h3>Merge pallets</h3>
      ${field('Move everything from', '<input name="from" placeholder="LPN-000123" required />')}${field('Onto', '<input name="into" placeholder="LPN-000124" required />')}<button type="submit">Merge</button></form>
    <form data-form="adjust" class="form panel" novalidate><h3>Adjust (damage, scrap, found)</h3>
      ${field('Bin', `<select name="bin">${binOptions()}</select>`)}${field('SKU', `<select name="sku">${skuOptions()}</select>`)}
      ${field('Change in pieces', '<input name="delta" placeholder="-12 or +24" />')}${field('Pallet (needed to add to an existing LPN)', '<input name="pallet" />')}${field('Reason (required)', '<input name="reason" maxlength="200" />')}<button type="submit">Post adjustment</button></form>
  </div>
  <h3>In transit</h3>${transit.length ? `<ul class="list">${transit.map((t) => `<li>${t.id}: ${n(t.qty)} ${t.skuId} ${t.fromBin} → ${t.toBin}, shipped ${esc(t.shippedAt.slice(0, 10))} by ${esc(t.shippedBy)} (${t.palletMoves.map((m) => m.to).join(', ')}) <button type="button" data-receive-transfer="${t.id}">Receive at ${t.toBin}</button></li>`).join('')}</ul>` : '<p class="muted">Nothing in transit.</p>'}
  <h3>Pallets</h3>
  <div class="table-wrap"><table><thead><tr><th scope="col">Site</th><th scope="col">Location</th><th scope="col">Pallet</th><th scope="col">SKU</th><th scope="col" class="num">Pieces</th><th scope="col">As packs</th><th scope="col">Status</th></tr></thead><tbody>
  ${bal.map((b) => { const t = b.location.startsWith(TRANSIT_PREFIX); const held = !t && isBlocked(state, b.location, b.skuId); return `<tr${held ? ' class="held"' : ''}><td>${esc(t ? 'In transit' : siteName(bs.get(b.location) ?? ''))}</td><td>${esc(b.location)}</td><td>${b.palletId}</td><td>${b.skuId}</td><td class="num">${n(b.qty)}</td><td>${esc(qtyText(sku(b.skuId), b.qty))}</td><td>${held ? '<span class="tag s-flag">On hold</span>' : ''}</td></tr>`; }).join('')}
  </tbody></table></div>`;
}

function viewCounts(): string {
  return `<h2 id="h-counts">Cycle counts</h2>
  <p class="hint">Every bin is counted once every ${state.cycle.cycleDays} working days (cycle started ${state.cycle.startDate}). Counts are blind: the counter never sees the system quantity. Any pallet that disagrees by even one piece puts that SKU in that bin on hold, and nothing can leave it until the hold is reconciled.</p>
  ${session ? `${viewSession(session)}<p class="hint">System quantities, holds and count history are hidden until this count is submitted or cancelled.</p>` : viewCountLists()}`;
}

function viewCountLists(): string {
  const t = todaysCounts(state, today);
  const holds = state.holds.filter((h) => !h.resolved);
  const sched = buildSchedule(state.bins, state.cycle.cycleDays);
  return `<h3>Today's list${t.position ? ` (cycle day ${t.position.dayIndex + 1} of ${state.cycle.cycleDays})` : ''}</h3>
  ${t.position ? `<ul class="list">${t.bins.map((b) => `<li>${b.binId} · ${esc(siteName(b.siteId))} · ${b.countedToday ? '<span class="tag s-received">counted today</span>' : `<button type="button" data-count="${b.binId}" data-scheduled="1">Start count</button>`}</li>`).join('')}</ul>` : '<p class="muted">No counts scheduled today (weekend or before the cycle starts).</p>'}
  ${t.overdue.length ? `<p class="warn">Behind schedule this cycle: ${t.overdue.join(', ')}</p>` : ''}
  <form data-form="count-adhoc" class="inline" novalidate><label>Count another bin <select name="bin">${binOptions()}</select></label><button type="submit">Start count</button></form>
  <h3>Count holds</h3>
  ${holds.length ? `<div class="table-wrap"><table><thead><tr><th scope="col">Hold</th><th scope="col">Bin</th><th scope="col">SKU</th><th scope="col">Pallet</th><th scope="col" class="num">System</th><th scope="col" class="num">Counted</th><th scope="col">Reconcile</th></tr></thead><tbody>
  ${holds.map((h) => `<tr class="held"><td>${h.id}<span class="small block">${h.kind === 'moved' ? 'stock moved during count' : 'variance'}</span></td><td>${h.binId}</td><td>${h.skuId}</td><td>${h.palletId || 'unlabelled'}</td><td class="num">${n(h.systemQty)}</td><td class="num">${n(h.countedQty)} (${h.countedQty - h.systemQty > 0 ? '+' : ''}${n(h.countedQty - h.systemQty)})</td>
    <td><button type="button" data-count="${h.binId}">Recount bin</button>${h.kind === 'variance' ? `<form data-form="hold-accept" data-id="${h.id}" class="inline" novalidate><label><span class="sr-only">Reason to accept the count for ${h.id}</span><input name="reason" placeholder="Reason to accept count" maxlength="300" /></label><button type="submit">Accept count</button></form>` : ''}</td></tr>`).join('')}
  </tbody></table></div>` : '<p class="ok">No holds.</p>'}
  <h3>Recent counts</h3>
  <ul class="list">${[...state.counts].reverse().slice(0, 15).map((c) => `<li>${c.id} · ${c.date} · ${c.binId} · ${esc(c.user)}${c.recount ? ' · recount' : ''} · ${c.lines.length} pallet lines, ${c.lines.filter((l) => l.countedQty !== l.systemQty).length} off</li>`).join('')}</ul>
  <details><summary>Full ${state.cycle.cycleDays}-day schedule</summary><ol class="sched">${sched.map((d) => `<li>${d.join(', ') || '—'}</li>`).join('')}</ol></details>`;
}

function viewSession(s: CountSession): string {
  const problems = sessionProblems(s);
  const palletSku = new Map(state.pallets.map((p) => [p.id, p.skuId]));
  return `<article class="panel session" aria-labelledby="sess-h"><h3 id="sess-h">Counting ${s.binId} (${esc(siteName(s.siteId))})${s.scheduled ? '' : ' · ad hoc / recount'}</h3>
    <p>${s.binConfirmed ? '<span class="tag s-received">bin confirmed</span>' : '<strong>Step 1:</strong> scan or type the bin label.'} Then scan each pallet label and enter what you count on it. Unknown or wrong-location labels are refused.</p>
    <form data-form="scan" class="inline" novalidate autocomplete="off"><label for="scan-input">Scan or type a label</label><input id="scan-input" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" /><button type="submit">Enter</button>
      ${hasCamera() ? `<button type="button" data-action="camera">${stopCam ? 'Stop camera' : 'Use camera'}</button>` : '<span class="small">No camera available; type or use a USB/Bluetooth scanner.</span>'}</form>
    <p id="scan-msg" class="scanmsg" role="status" aria-live="assertive"></p>
    ${Object.keys(s.pallets).length ? `<table><thead><tr><th scope="col">Pallet</th><th scope="col">SKU</th><th scope="col">Counted</th></tr></thead><tbody>${Object.entries(s.pallets).map(([id, q]) => { const k = sku(palletSku.get(id)!); return `<tr><td>${id}</td><td>${k.id}</td><td><form data-form="pallet-qty" data-id="${id}" class="inline" novalidate><label><span>${k.caseUom}s</span><input name="cs" inputmode="numeric" size="5" /></label><label><span>+ ${k.uom}s</span><input name="pc" inputmode="numeric" size="7" /></label><button type="submit">Set</button></form> ${q === null ? '<span class="tag s-flag">not entered</span>' : `<strong>${n(q)}</strong> ${k.uom}s`}</td></tr>`; }).join('')}</tbody></table>` : '<p class="muted">No pallets scanned yet. If the bin is empty, confirm the bin and submit.</p>'}
    <form data-form="loose" class="inline" novalidate><label>Unlabelled pieces found <select name="sku">${skuOptions()}</select></label>${qtyInputs('q', { pallets: false })}<button type="submit">Add</button></form>
    ${Object.keys(s.loose).length ? `<p>Unlabelled: ${Object.entries(s.loose).map(([k, q]) => `${k} ${n(q)}`).join(', ')}</p>` : ''}
    ${problems.length ? `<ul class="warn">${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
    <button type="button" data-action="submit-count"${problems.length ? ' disabled' : ''}>Submit count</button> <button type="button" class="ghost" data-action="cancel-count">Cancel</button>
  </article>`;
}

function viewLabels(): string {
  return `<h2 id="h-labels">Labels</h2>
  <form data-form="labels" class="inline" novalidate>
    <label>Site <select name="site">${state.sites.map((s) => opt(s.id, s.name)).join('')}</select></label>
    <label>Type <select name="type">${opt('bins', 'Bin labels')}${opt('pallets', 'Pallet (LPN) labels')}</select></label>
    <button type="submit">Show labels</button> <button type="button" data-action="print">Print</button>
  </form>
  <p class="hint">QR codes hold the exact bin code or LPN. Printing is logged in the audit trail. Codes are unique, so a label can only ever match one bin or one pallet.</p>
  <div id="sheet" class="sheet" aria-live="polite"></div>`;
}

function viewAudit(): string {
  const problems = verifyState(state);
  return `<h2 id="h-audit">Audit log</h2>
  <p class="${problems.length ? 'warn' : 'ok'}">${problems.length ? `Integrity check failed: ${problems.slice(0, 3).map(esc).join(' ')}` : `Integrity check passed: ${n(state.ledger.length)} ledger entries and ${n(state.audit.length)} audit entries chain correctly, and no pallet is below zero or in two places.`}</p>
  <p class="inline"><button type="button" data-export="audit">Export audit CSV</button><button type="button" data-export="ledger">Export ledger CSV</button><button type="button" data-export="stock">Export stock CSV</button><button type="button" data-export="pos">Export POs CSV</button></p>
  <p class="hint">Append-only. Nothing is edited or deleted; corrections are new entries. Showing the latest 200, newest first.</p>
  <div class="table-wrap"><table><thead><tr><th scope="col" class="num">#</th><th scope="col">When (UTC)</th><th scope="col">Who</th><th scope="col">Action</th><th scope="col">Record</th><th scope="col">What</th><th scope="col">Why</th></tr></thead><tbody>
  ${[...state.audit].reverse().slice(0, 200).map((a) => `<tr><td class="num">${a.seq}</td><td>${esc(a.at.replace('T', ' ').slice(0, 16))}</td><td>${esc(a.user)}</td><td>${esc(a.action)}</td><td>${esc(a.entityId)}</td><td class="detail">${esc(a.detail)}</td><td>${esc(a.reason ?? '')}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function viewSettings(): string {
  return `<h2 id="h-settings">Settings</h2>
  <div class="grid2">
  <form data-form="tolerance" class="form panel" novalidate><h3>Receipt tolerance</h3>
    ${field('Quantity tolerance (%)', `<input name="qty" inputmode="decimal" value="${state.tolerance.qtyBp / 100}" />`)}
    ${field('Price tolerance (%)', `<input name="price" inputmode="decimal" value="${state.tolerance.priceBp / 100}" />`)}<button type="submit">Save</button></form>
  <form data-form="cycle" class="form panel" novalidate><h3>Cycle count</h3>
    ${field('Working days per cycle', `<input name="days" inputmode="numeric" value="${state.cycle.cycleDays}" />`)}
    ${field('Cycle start (a weekday)', `<input type="date" name="start" value="${state.cycle.startDate}" />`)}<button type="submit">Save</button></form>
  <form data-form="bin" class="form panel" novalidate><h3>Add a bin</h3>
    ${field('Site', `<select name="site">${state.sites.map((s) => opt(s.id, s.name)).join('')}</select>`)}
    ${field('Bin code', '<input name="code" placeholder="TOR-C-01" />', 'Letters, digits and dashes; must be unique')}${field('Zone', '<input name="zone" placeholder="C" />')}<button type="submit">Add bin</button></form>
  <div class="panel"><h3>Demo data</h3><p class="small">Replaces everything saved in this browser with freshly seeded data for today.</p><button type="button" data-action="reset">Reset to demo data</button></div>
  </div>`;
}

const VIEWS: Record<string, () => string> = { dashboard: viewDashboard, pos: viewPos, stock: viewStock, counts: viewCounts, labels: viewLabels, audit: viewAudit, settings: viewSettings };

function current(): string {
  const h = location.hash.slice(1);
  return h in VIEWS ? h : 'dashboard';
}

function render(): void {
  const v = current();
  document.querySelectorAll<HTMLElement>('[data-view]').forEach((el) => {
    const on = el.dataset.view === v;
    el.hidden = !on;
    if (on) el.innerHTML = VIEWS[v]();
    else el.innerHTML = '';
  });
  document.querySelectorAll<HTMLAnchorElement>('.tabs a').forEach((a) => a.setAttribute('aria-current', a.getAttribute('href') === `#${v}` ? 'page' : 'false'));
  if (v === 'counts' && session) $<HTMLInputElement>('scan-input')?.focus();
}

// ---------------------------------------------------------------- events

function download(name: string, text: string, type = 'text/csv'): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function renderLabels(site: string, type: string): Promise<void> {
  const sheet = $('sheet');
  const bs = binSite();
  const items = type === 'bins'
    ? state.bins.filter((b) => b.siteId === site).map((b) => ({ code: b.id, line1: `BIN ${b.id}`, line2: `${siteName(site)} · zone ${b.zone}` }))
    : [...palletBalances(state.ledger).values()].filter((b) => bs.get(b.location) === site).map((b) => ({ code: b.palletId, line1: b.palletId, line2: `${b.skuId} · ${sku(b.skuId).name}` }));
  const svgs = await Promise.all(items.map((i) => QRCode.toString(i.code, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 })));
  sheet.innerHTML = items.length ? items.map((i, k) => `<figure class="label"><div class="qr" role="img" aria-label="QR code for ${esc(i.code)}">${svgs[k]}</div><figcaption><strong>${esc(i.line1)}</strong><span>${esc(i.line2)}</span></figcaption></figure>`).join('') : '<p class="muted">Nothing to label.</p>';
  sheet.dataset.codes = items.map((i) => i.code).join(',');
}

function scanMsg(text: string, ok: boolean): void {
  const m = $('scan-msg');
  if (m) { m.textContent = text; m.className = `scanmsg ${ok ? 'good' : 'bad'}`; }
}

function handleScan(code: string): void {
  if (!session) return;
  if (!debounce.accept(code.trim().toUpperCase(), Date.now())) return;
  const r = applyScan(state, session, code);
  render();
  scanMsg(r.message, r.ok);
}

const forms: Record<string, (fd: FormData, el: HTMLFormElement) => void> = {
  'po-create': (fd) => apply(createPo(state, { supplierId: String(fd.get('supplier')), skuId: String(fd.get('sku')), qty: String(fd.get('qty')), unitPrice: String(fd.get('price')), siteId: String(fd.get('site')), dueDate: String(fd.get('due')), supplierRef: String(fd.get('ref') ?? ''), allowDuplicateReason: String(fd.get('dup') ?? '') || undefined }, ctx()), 'Purchase order created.') && (selectedPo = state.pos[state.pos.length - 1].id, render()),
  'po-receive': (fd, el) => {
    const p = state.pos.find((x) => x.id === el.dataset.id)!;
    apply(receivePo(state, p.id, { date: String(fd.get('date')), packingSlip: String(fd.get('slip')), qty: readQty(fd, 'q', sku(p.skuId)), unitPrice: String(fd.get('price')), binId: String(fd.get('bin')), final: fd.get('final') === 'on', overReason: String(fd.get('over') ?? '') || undefined }, ctx()), 'Receipt posted.');
  },
  'mm-resolve': (fd, el) => apply(resolveMismatch(state, el.dataset.id!, String(fd.get('note')), ctx()), 'Mismatch resolved.'),
  'po-revise': (fd, el) => apply(revisePo(state, el.dataset.id!, { qty: String(fd.get('qty') ?? ''), unitPrice: String(fd.get('price') ?? ''), dueDate: String(fd.get('due') ?? '') }, String(fd.get('reason')), ctx()), 'PO revised.'),
  'po-close': (fd, el) => apply(closePo(state, el.dataset.id!, String(fd.get('reason') ?? ''), ctx()), 'PO closed.'),
  ship: (fd) => { const s = sku(String(fd.get('sku'))); apply(shipOut(state, { binId: String(fd.get('bin')), skuId: s.id, qty: readQty(fd, 'q', s), reference: String(fd.get('ref')), palletId: String(fd.get('pallet') ?? '').trim().toUpperCase() || undefined }, ctx()), 'Shipment posted.'); },
  transfer: (fd) => { const s = sku(String(fd.get('sku'))); apply(createTransfer(state, { fromBin: String(fd.get('from')), toBin: String(fd.get('to')), skuId: s.id, qty: readQty(fd, 'q', s), palletId: String(fd.get('pallet') ?? '').trim().toUpperCase() || undefined }, ctx()), 'Transfer shipped; it is now in transit.'); },
  split: (fd) => apply(splitPallet(state, String(fd.get('pallet')).trim().toUpperCase(), String(fd.get('qty')), ctx()), 'Pallet split.'),
  merge: (fd) => apply(mergePallets(state, String(fd.get('from')).trim().toUpperCase(), String(fd.get('into')).trim().toUpperCase(), ctx()), 'Pallets merged.'),
  adjust: (fd) => apply(adjustStock(state, { binId: String(fd.get('bin')), skuId: String(fd.get('sku')), delta: String(fd.get('delta')), reason: String(fd.get('reason')), palletId: String(fd.get('pallet') ?? '').trim().toUpperCase() || undefined }, ctx()), 'Adjustment posted.'),
  'count-adhoc': (fd) => begin(String(fd.get('bin')), false),
  scan: (fd, el) => { handleScan(String(fd.get('code') ?? '')); el.reset(); $<HTMLInputElement>('scan-input')?.focus(); },
  'pallet-qty': (fd, el) => {
    if (!session) return;
    const id = el.dataset.id!;
    const k = sku(state.pallets.find((p) => p.id === id)!.skuId);
    session.pallets[id] = toPieces(k, { cases: readInt(fd, 'cs'), pieces: readInt(fd, 'pc') });
    render();
  },
  loose: (fd) => {
    if (!session) return;
    const k = sku(String(fd.get('sku')));
    const q = readQty(fd, 'q', k);
    if (q <= 0) throw new ValidationError('Enter how many unlabelled pieces you found.');
    session.loose[k.id] = (session.loose[k.id] ?? 0) + q;
    render();
  },
  'hold-accept': (fd, el) => apply(acceptHold(state, el.dataset.id!, String(fd.get('reason')), ctx()), 'Count accepted and hold released.'),
  labels: (fd) => { void renderLabels(String(fd.get('site')), String(fd.get('type'))); },
  tolerance: (fd) => apply(setTolerance(state, String(fd.get('qty')), String(fd.get('price')), ctx()), 'Tolerance saved.'),
  cycle: (fd) => apply(setCycle(state, String(fd.get('days')), String(fd.get('start')), ctx()), 'Cycle settings saved.'),
  bin: (fd) => apply(addBin(state, { code: String(fd.get('code')), siteId: String(fd.get('site')), zone: String(fd.get('zone')) }, ctx()), 'Bin added. Print its label from Labels.'),
};

function begin(binId: string, scheduled: boolean): void {
  if (!$<HTMLInputElement>('user').value.trim()) { say('Enter your name at the top first; every count is signed.', true); return; }
  stopCam?.(); stopCam = null;
  session = startSession(state, binId, new Date().toISOString(), scheduled);
  if (location.hash !== '#counts') location.hash = '#counts'; else render();
  say(`Count started for ${binId}. Scan the bin label.`);
}

document.addEventListener('submit', (e) => {
  const el = e.target as HTMLFormElement;
  const name = el.dataset.form;
  if (!name || !forms[name]) return;
  e.preventDefault();
  try { forms[name](new FormData(el), el); } catch (err) {
    if (err instanceof ValidationError) say(err.message, true); else { console.error(err); say('Something went wrong; nothing was saved.', true); }
  }
});

document.addEventListener('click', async (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('button, a');
  if (!t) return;
  if (t.dataset.po) { selectedPo = selectedPo === t.dataset.po && t.tagName === 'BUTTON' ? '' : t.dataset.po; if (location.hash !== '#pos') location.hash = '#pos'; else render(); return; }
  if (t.dataset.count) { begin(t.dataset.count, t.dataset.scheduled === '1'); return; }
  if (t.dataset.receiveTransfer) { apply(receiveTransfer(state, t.dataset.receiveTransfer, ctx()), 'Transfer received.'); return; }
  if (t.dataset.export) {
    const map: Record<string, (s: State) => string> = { audit: exportAudit, ledger: exportLedger, stock: exportStock, pos: exportPos };
    download(`${t.dataset.export}-${today}.csv`, map[t.dataset.export](state));
    return;
  }
  switch (t.dataset.action) {
    case 'submit-count': {
      if (!session) return;
      const s = session;
      const pallets = Object.fromEntries(Object.entries(s.pallets).filter(([, q]) => q !== null)) as Record<string, number>;
      const before = state.holds.filter((h) => !h.resolved).length;
      if (apply(submitCount(state, { binId: s.binId, startedSeq: s.startedSeq, startedAt: s.startedAt, pallets, loose: s.loose, scheduled: s.scheduled, notes: s.notes }, ctx()), 'Count submitted.')) {
        stopCam?.(); stopCam = null; session = null; render();
        const after = state.holds.filter((h) => !h.resolved).length;
        say(after > before ? `Count submitted. ${after - before} item(s) did not match and are now on hold.` : 'Count submitted.' + (after < before ? ' Recount matched; hold released.' : ''));
      }
      return;
    }
    case 'cancel-count': stopCam?.(); stopCam = null; session = null; render(); say('Count cancelled; nothing was saved.'); return;
    case 'camera': {
      if (stopCam) { stopCam(); stopCam = null; render(); return; }
      try {
        const video = $<HTMLVideoElement>('cam');
        $('camwrap').hidden = false;
        const stop = await startCamera(video, handleScan);
        stopCam = () => { stop(); $('camwrap').hidden = true; };
        t.textContent = 'Stop camera';
      } catch { stopCam = null; $('camwrap').hidden = true; say('Camera unavailable or permission denied. Type or use a handheld scanner instead.', true); render(); }
      return;
    }
    case 'print': {
      const codes = ($('sheet')?.dataset.codes ?? '').split(',').filter(Boolean);
      if (!codes.length) { say('Show some labels first.', true); return; }
      if (apply(logLabelPrint(state, codes, ctx()), `Printing ${codes.length} labels (logged).`)) {
        const f = document.querySelector<HTMLFormElement>('[data-form="labels"]');
        if (f) await renderLabels(String(new FormData(f).get('site')), String(new FormData(f).get('type')));
        window.print();
      }
      return;
    }
    case 'reset':
      if (!window.confirm('Replace all data saved in this browser with fresh demo data?')) return;
      clearState(localStorage); state = seedState(today); saveState(localStorage, state); session = null; selectedPo = '';
      $('fatal').hidden = true; render(); say('Demo data loaded.');
      return;
    case 'download-raw': download(`packaging-inventory-backup-${today}.json`, (window as unknown as { __raw: string }).__raw, 'application/json'); return;
  }
});

$<HTMLInputElement>('user').addEventListener('change', (e) => { try { localStorage.setItem(USER_KEY, (e.target as HTMLInputElement).value.trim()); } catch { /* ignore */ } });
window.addEventListener('hashchange', () => { render(); $('main').focus({ preventScroll: true }); });
render();
