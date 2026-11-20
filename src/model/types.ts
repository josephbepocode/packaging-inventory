/**
 * Data model. Rules that matter for a live warehouse:
 * - Stock is never stored as a number on a record. On-hand is derived from the ledger (immutable entries).
 * - Quantities are integer units. Prices are integer ten-thousandths of a dollar (price4) so there is no float drift.
 * - Nothing is deleted or edited in place: changes append ledger entries and audit entries.
 */

export type SiteKind = 'warehouse' | 'copacker';

export interface Site { id: string; name: string; kind: SiteKind; city: string }

export interface Bin {
  /** Code printed on the bin label and used as its QR payload, e.g. "TOR-A-01". Unique. */
  id: string;
  siteId: string;
  zone: string;
  receiving?: boolean;
}

export type PackagingKind = 'can' | 'end' | 'carton' | 'label' | 'tray' | 'handle' | 'film';

export interface Sku {
  id: string;
  name: string;
  kind: PackagingKind;
  /** Piece (each) unit name, e.g. "can", "end", "carton". All stock is held in pieces. */
  uom: string;
  /** Middle unit name, e.g. "case", "layer", "bundle", "roll". */
  caseUom: string;
  /** Pieces per case (or layer/bundle). */
  caseQty: number;
  /** Cases per full pallet. A full pallet is caseQty * casesPerPallet pieces. */
  casesPerPallet: number;
  /** Low-stock threshold per site, units. */
  minPerSite: number;
  /** Typical unit cost in price4 (1/10,000 dollar). */
  stdPrice4: number;
}

export interface Supplier { id: string; name: string; skuIds: string[] }

/** A licence plate (LPN). Its quantity and location are derived from ledger entries carrying its id. */
export interface Pallet { id: string; skuId: string; createdAt: string; createdBy: string; source: string }

export type LedgerKind =
  | 'opening'      // opening balance load
  | 'receipt'      // PO receipt
  | 'ship'         // outbound shipment / issue to production
  | 'transfer-out' // source bin -> in transit
  | 'transit-in'   // in transit location gains
  | 'transit-out'  // in transit location releases
  | 'transfer-in'  // arrives at destination bin
  | 'split-out' | 'split-in'  // partial pallet break into a new LPN
  | 'merge-out' | 'merge-in'  // consolidating one pallet onto another
  | 'adjust'       // manual adjustment (damage, scrap, found)
  | 'reconcile';   // count variance accepted while resolving a hold

export const TRANSIT_PREFIX = 'TRANSIT/';

/** Immutable stock movement. location is a bin id or TRANSIT/<transferId>. */
export interface LedgerEntry {
  seq: number;
  at: string;
  user: string;
  kind: LedgerKind;
  location: string;
  skuId: string;
  palletId: string;
  /** Signed integer pieces. */
  qty: number;
  /** Pieces on this pallet at this location before and after the entry. */
  before: number;
  after: number;
  /** PO / transfer / shipment / hold id this belongs to. */
  ref: string;
  /** All entries posted in one atomic commit share a txn id. */
  txn: string;
  reason?: string;
  prevHash: string;
  hash: string;
}

export type PoStatus = 'open' | 'partial' | 'received' | 'closed';

export interface Receipt {
  id: string;
  date: string;
  at: string;
  user: string;
  packingSlip: string;
  qty: number;
  unitPrice4: number;
  binId: string;
  palletIds: string[];
  final: boolean;
  overReason?: string;
}

export interface PoRevision { at: string; user: string; field: 'qty' | 'unitPrice4' | 'dueDate'; from: string | number; to: string | number; reason: string }

export interface PurchaseOrder {
  id: string;
  supplierId: string;
  supplierRef?: string;
  skuId: string;
  qty: number;
  unitPrice4: number;
  siteId: string;
  dueDate: string;
  createdOn: string;
  createdBy: string;
  status: PoStatus;
  receipts: Receipt[];
  revisions: PoRevision[];
  closedOn?: string;
  closeReason?: string;
}

export type MismatchType = 'quantity' | 'price';

export interface Mismatch {
  id: string;
  poId: string;
  receiptId: string;
  type: MismatchType;
  /** 'over' or 'short' for quantity, 'high' or 'low' for price. */
  direction: 'over' | 'short' | 'high' | 'low';
  expected: number;
  actual: number;
  createdAt: string;
  resolved: boolean;
  note?: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface Tolerance {
  /** Allowed quantity variance in basis points (100 = 1%). */
  qtyBp: number;
  /** Allowed unit-price variance in basis points. */
  priceBp: number;
}

export interface Transfer {
  id: string;
  skuId: string;
  fromBin: string;
  toBin: string;
  qty: number;
  status: 'in-transit' | 'received';
  shippedAt: string;
  shippedBy: string;
  receivedAt?: string;
  receivedBy?: string;
  /** Pallets moved whole keep their LPN; partial picks get a new LPN on arrival. */
  palletMoves: { from: string; to: string; qty: number }[];
}

export interface Shipment { id: string; at: string; user: string; skuId: string; binId: string; qty: number; reference: string }

/** One pallet's line in a submitted bin count, in pieces. palletId '' = unlabelled pieces found. */
export interface CountLine {
  palletId: string;
  skuId: string;
  /** Pieces the system had on this pallet in this bin when the count started (never shown to the counter). */
  systemQty: number;
  /** Pieces the system had at submit time. */
  currentQty: number;
  countedQty: number;
  /** This pallet moved in or out of the bin between count start and submit. */
  moved: boolean;
  scanned: boolean;
}

export interface CountRecord {
  id: string;
  binId: string;
  date: string;
  startedAt: string;
  startedSeq: number;
  submittedAt: string;
  user: string;
  lines: CountLine[];
  /** True when it counted a position that already had an open hold. */
  recount: boolean;
  scheduled: boolean;
  notes: string[];
}

export type HoldKind = 'variance' | 'moved';

/**
 * A count that disagreed with the system (or could not be trusted because stock moved mid-count)
 * puts SKU-in-bin on hold. While open, every decrement of that position is refused by the ledger.
 */
export interface Hold {
  id: string;
  binId: string;
  skuId: string;
  /** The pallet whose count disagreed ('' for unlabelled pieces found). The whole SKU-in-bin is blocked. */
  palletId: string;
  kind: HoldKind;
  systemQty: number;
  countedQty: number;
  createdAt: string;
  countIds: string[];
  resolved: boolean;
  reconciliationId?: string;
}

export interface Reconciliation {
  id: string;
  holdId: string;
  at: string;
  user: string;
  method: 'accept-count' | 'recount-matched';
  /** Units posted to the ledger (0 for a matching recount). */
  delta: number;
  reason: string;
  countId: string;
}

export interface CycleSettings { cycleDays: number; startDate: string }

export interface AuditEntry {
  seq: number;
  at: string;
  user: string;
  action: string;
  entity: string;
  entityId: string;
  detail: string;
  reason?: string;
  prevHash: string;
  hash: string;
}

export interface State {
  version: 1;
  company: string;
  sites: Site[];
  bins: Bin[];
  skus: Sku[];
  suppliers: Supplier[];
  pallets: Pallet[];
  ledger: LedgerEntry[];
  pos: PurchaseOrder[];
  mismatches: Mismatch[];
  transfers: Transfer[];
  shipments: Shipment[];
  counts: CountRecord[];
  holds: Hold[];
  reconciliations: Reconciliation[];
  audit: AuditEntry[];
  tolerance: Tolerance;
  cycle: CycleSettings;
  /** Next id number. */
  seq: number;
}

/** Who and when, passed to every operation. today is the local business date (YYYY-MM-DD). */
export interface Ctx { user: string; at: string; today: string }

export type ErrorCode =
  | 'ON_HOLD' | 'INSUFFICIENT_STOCK' | 'NOT_FOUND' | 'INVALID' | 'DUPLICATE'
  | 'OVER_RECEIPT' | 'PO_NOT_RECEIVABLE' | 'OPEN_MISMATCHES' | 'REASON_REQUIRED' | 'RECOUNT_REQUIRED';

export type Result<T = State> = { ok: true; state: T } | { ok: false; error: string; code: ErrorCode };
