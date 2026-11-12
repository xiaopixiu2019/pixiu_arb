# Changelog

## 1.0.5

- Give periodic margin-risk reads an independent bounded scheduler slot while preserving shared rate limits, so ordinary authenticated traffic cannot repeatedly starve account verification.
- Reject regressed remote account versions and recover only through bounded, strictly advancing evidence; identity, position, order and hard-risk conflicts remain fail-closed.
- Persist per-order router rejection evidence and bounded backoff; a fully verified zero-position route failure can pause only its task without stopping unrelated balanced groups.
- Retry transient SQLite writer conflicts only before any remote side effect, and persist real hard pauses across normal shutdown.
- Reconcile cancellation/fill races from exact order evidence; unknown writes are never replayed and confirmed fills cannot be overwritten by late failure responses.
- Calibrate risk-page freshness against bounded server time, retain a valid clock through one noisy probe and preserve the five-second expiry boundary.

## 1.0.4

- Keep displayed, confirmed and submitted leverage aligned with the selected account and contract; uncertain writes are reconciled by reads and never replayed automatically.
- Preserve the selected contract when venue catalogs refresh; unavailable contracts block launch instead of silently switching to AAVE or another first item.
- Keep leverage panels inside the visual viewport with bounded scrolling and keyboard navigation.
- Improve the risk-configuration workflow with explicit draft, preview and confirmation states while retaining server-side revision, account and authorization checks.
- Defer Hyperliquid Maker first legs while the exact hedge contract is at its official open-interest cap; a confirmed post-fill cap race pauses and repairs only the affected task unless protection becomes uncertain.
- Retry a confirmed-but-ineffective cancellation only after exact remote order facts still prove the same open order, with bounded persisted attempts; unknown cancellation results remain non-replayable.
- Avoid account-wide hard pauses when no margin incident exists, while preserving global protection for unknown orders, unexplained holdings and unresolved execution responsibility.
- Consolidate documentation around current behavior and retain unavailable financial/history evidence as unavailable rather than zero.

This release publishes reviewed source and deployment documentation. It does not claim profitability, production deployment, or signed/notarized desktop installers.
