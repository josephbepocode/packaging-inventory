# Packaging Inventory

Packaging purchase orders and inventory for a beverage company that fills at co-packers. It covers receiving against POs with quantity and price mismatch flags, a piece-level pallet ledger across warehouses and co-packer sites, rotating cycle counts with QR labels and scan-to-count, and a hard rule: any count that disagrees with the system puts that stock on hold until someone reconciles it.

It is built to warehouse rules rather than as a demo. Stock is never stored as an editable number. Every quantity change is an immutable ledger entry, every action is signed in an append-only audit log, and the rules are enforced in the logic layer, not the UI.

The company (Northbeam Beverage Co.), its sites, suppliers and stock are made up.

## What it does

- **Purchase orders**: you create a PO with supplier, SKU, quantity, unit price, delivery site and date. Its status goes open → partial → received → closed. You receive against the PO by packing slip, and changes are logged as revisions with a reason.
- **Mismatch flags**: price and quantity variances outside the tolerance (default ±2% quantity, ±1% price) are flagged on receipt. Over-receipt beyond tolerance is refused unless a reason is given. A final short receipt is flagged. A PO can't close until every flag is resolved with a note.
- **Piece-level stock**: pallets are licence plates (LPNs). Each SKU has a pallet → case/layer/bundle → piece conversion, and the ledger records every pick, split, merge, transfer, receipt and adjustment per pallet: pieces before, delta and pieces after.
- **Transfers** run in two steps (source → in transit → destination). Whole pallets keep their LPN. A partial pick gets a new LPN.
- **Cycle counting**: a schedule spreads every bin across N working days (default 20), mixing sites each day. There's a today's list, a behind-schedule list, cycle progress and first-count accuracy.
- **Blind counts with scanning**: you scan or type the bin label, then each pallet, and enter what you count. The camera uses BarcodeDetector, with ZXing loaded on demand as the fallback. Keyboard-wedge scanners and typing work too. Duplicate reads are debounced. Unknown, wrong-bin, wrong-site, retired and in-transit labels are refused. While you count, no system quantity is shown.
- **Count holds**: one piece off on one pallet puts that SKU-in-bin on hold. Shipments, transfers, splits, merges and write-downs are all refused by the ledger until the hold is released. A release always creates a reconciliation record, either by accepting the count with a reason or by a recount that matches. If stock moved mid-count, the hold can only be cleared by a recount.
- **Labels**: printable QR labels for every bin and pallet. Print runs are logged.
- **Supervisor dashboard**: open POs, overdue deliveries, unresolved mismatches, holds, in-transit stock, cycle progress and accuracy, and low stock by site.
- **Audit**: an append-only, hash-chained audit log and ledger with an integrity check. Audit, ledger, stock and PO data export to CSV, and exports are protected against formula injection.

## Stack

TypeScript, Vite and Vitest (with jsdom for UI tests). `qrcode` generates the labels, and `@zxing/browser` is the camera fallback. There's no framework, no backend and no API keys. Data lives in localStorage and is verified on load.

## Run locally

```bash
npm ci
npm run dev      # dev server
npm test         # unit + UI tests
npm run build    # type-check and build to dist/
npm run preview  # serve the production build
```

## Layout

```
src/model/types.ts     data model
src/model/validate.ts  input validation, integer prices, dates, working days
src/model/uom.ts       pallet / case / piece conversion
src/model/ledger.ts    derived balances, hash chain, integrity check
src/model/ops.ts       every write: POs, receipts, moves, counts, holds, reconciliation
src/model/schedule.ts  cycle-count schedule and stats
src/model/scan.ts      scan handling and blind count sessions
src/model/dashboard.ts dashboard figures and CSV exports
src/model/seed.ts      demo data, built by running the real operations
src/main.ts            the page
tests/                 Vitest tests
```

Built by Deji.
