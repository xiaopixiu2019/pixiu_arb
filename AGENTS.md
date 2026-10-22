# Contributor contract

This repository contains the public PIXIU ARB product source. Keep changes scoped and preserve existing work.

- Preserve manual orders, paired execution, managed ownership, risk controls and data provenance.
- Startup is trading-unset. Stop keeps positions by default and ends automatic protection; closing requires explicit intent.
- Never replay an unknown order. Preserve unresolved orders, fills and capital responsibility across restart and maintenance.
- Prepare ordinary second legs before the maker; recheck authority and fresh local evidence at actual dispatch.
- Keep account pacing and 429 cooldown shared, reads bounded and trading writes serial.
- Never commit credentials, databases, account data or unredacted operational logs.
- Use isolated databases and synthetic gateways for faults. Run applicable tests and npm run verify.
- Review partial fills, duplicates, unknown responses, stale data and concurrent control changes.
- Retain AGPL-3.0-only, SOURCE_NOTICES.md, THIRD_PARTY_NOTICES.md and associated licenses.
- Build success, deployment success and live trading outcomes are separate evidence.
