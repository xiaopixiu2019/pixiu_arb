# Changelog

## 1.0.3 — source candidate

- Atomically enroll newly launched managed groups for protection during pauses/restarts, including adoption and transfer under stable group identity.
- Preserve revocation, KEEP, explicit read-only, unknown-order reconciliation and exact confirmed fill responsibility; disclose enrolled, verified and uncovered groups.
- Continue independent authorized protection during ordinary risk pauses; complete only verified normal margin episodes automatically, without clearing legacy/manual locks or rebuilding exposure.
- Publish durable group performance stages outside ordinary page queries, retain historical evidence and use current prices only for floating valuation.
- Show exact per-leg entry/mark prices with settlement currencies; keep expired position snapshots visible with timestamps and disable stale-data actions.
- Preserve existing migration bytes and upgrade by adding continuous-protection and performance-projection tables.

This candidate contains source and deployment documentation, not precompiled desktop installers. Local acceptance is separate from publication and live trading.

## 1.0.2 — source release

- Patch Vite to 7.3.7 and Vitest to 4.1.12, including the affected development mocker components.
- Report the installed backend package version for direct Node/Docker startup, independently of launcher environment variables.
- Support deep Windows archive contents and cleanup while preserving download metadata, installation boundaries, and rollback.
- Stop Windows backup, restore, maintenance and update commands on native failures before reporting success or proceeding.

- Reuse one risk snapshot per synchronous admission check without reusing it across awaits or final-send guards.
- Preserve close receipts across route changes, late replies and account changes; unknown outcomes remain unconfirmed.
- Default new hedge drafts to Maker–Taker, -90 bps spread, -150% net funding APR, OR and 3000 seconds; keep existing and manual settings.
- Include confirmed REJECT in financial terminal states without accepting unknown or incomplete fill evidence.
- Expire account-risk presentation at the existing five-second boundary without extra network reads.

- Prepare both legs and persist capital responsibility before ordinary Maker–Taker entry.
- Dispatch confirmed outstanding hedge quantity without repeated synchronous admission queries.
- Avoid counting an approved task's margin twice when official pool attribution is proven; retain conservative checks for unverified responsibility.
- Hold new Maker writes during bounded position-before-fill progress without delaying a subsequently confirmed hedge.
- Pair ordinary exit reductions before final position settlement, with reconciliation before the next batch.
- Separate bounded reads from serial trading writes while retaining shared pacing, cooldown and dispatch guards.
- Persist unknown submission/cancellation responsibility and pause execution before queued writes proceed.
- Retain paired responsibility and execution evidence across restart and maintenance until released.
- Preserve managed adoption, keep/exit intent, account risk, funding and task performance.

This release delivers source and deployment documentation. It does not claim production latency percentiles, profitability or availability of tested precompiled desktop installers.
