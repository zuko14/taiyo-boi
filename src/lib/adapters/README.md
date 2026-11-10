# Integration adapters

Every external integration sits behind an interface here. None is claimed to work until it has
credentials, documentation and a passing end-to-end test.

| Integration | Status | Boundary |
|---|---|---|
| OTP / SMS / WhatsApp | **Not integrated.** `none` (refuses) and `console` (dev log only, blocked in production). | `sms.ts` |
| Payment gateway / UPI webhook | **Not integrated.** Payments are verified manually by an authorised cashier (`verify_payment` RPC) using provider/settlement evidence. A gateway adapter must verify webhook signatures and call the same idempotent verification path. | `verify_payment` in SQL |
| LIS / lab report import | **Not integrated.** Manual upload works. `report_import_jobs` table is the review queue for a future importer that must match on registration/order/accession IDs, never names. | `reports` + `report_import_jobs` |
| Label printer | Browser printing of an HTML label (`@page` sized). Hardware compatibility is **untested** until the real printer, stock and scanner are used. | `/e/[eventId]/participants/[id]/tag` |
