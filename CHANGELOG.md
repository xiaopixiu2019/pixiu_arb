# Changelog

## 1.0.6

- **配对补腿**：按每笔 IOC 委托已确认的累计成交计算第二腿剩余量。已确认的部分成交继续补剩余差额，暂时复核时保留该任务的对冲责任。剩余量未核清前禁止发出下一笔首腿，结果未知的订单只查询原单。
- **任务隔离**：单个托管任务外部减仓时，在持仓、订单和权限均可验证的情况下隔离该任务，由持续保护按实际失衡只减仓。跨任务账实不符、身份变化或订单结果不明仍保留账户级保护。
- **只监控接管与退出**：经账户流水和真实持仓核验，旧组归零后可将同账户的反向平衡仓移交给零新增任务。停止并平仓时核对撤单期间的成交，仅减仓配平后退出。对已复核的持仓提供显式只减仓退出。
- **挂单与行情**：区分建仓价差边界与队列竞争价格，避免因新报价更差而撤回仍有效的 Maker 单。价差越界、必需行情失效和控制权限变化继续触发撤单或复核。
- **风控与收益显示**：建仓完成后先对账再进入监控，短暂保证金读取超时按有界复核处理。任务收益保留账单覆盖、资金费归属和历史汇率证据；证据待核对时不会把旧浮动金额当作最终结果。

本版提供源码、部署文档和源码归档校验值。

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
