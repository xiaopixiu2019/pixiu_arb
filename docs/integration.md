# Gate CrossEx integration

## Continuous protection authority

`GET /api/risk/protection` returns current account identity, an optional persistent enrollment (revision, enabled, exact group IDs), protection status and a one-use CSRF token. `PUT /api/risk/protection` requires `x-gct-risk-intent: configure-protection` and the strict JSON fields `{accountId, revision, enabled, groupIds, acknowledge: true, csrfToken}`. Enabling rechecks credentials/account context, fresh margin evidence, selected claims/holdings and absence of unresolved orders. Revocation does not wait for the authenticated queue and invalidates queued capabilities. Scope and revision changes fail closed.

Trading-mode responses can include `protect_only`: ordinary trading remains disabled, while individually verified backend protection capabilities can reduce existing exposure. The public mode-write route still accepts only readonly/live; explicit readonly revokes continuous authority. Enrolled protection may reconcile and enter protect_only after restart; old deployments without enrollment remain unset. Manual order bodies cannot supply capabilities or spoof task ownership. Margin snapshots optionally expose `continuousProtection`; older/missing data never proves protection active.

账户收益统计通过只读 `/api/crossex/performance` 提供，接口、账户隔离和完整性契约见[资产管理与账户收益统计](account-performance.md)。手续费接口见[费用统计](transaction-fees.md)。资产完整页与弹层同源；界面呈现不改变交易接口或权限。

This document records the external API boundary needed to review the adapters. Gate's official references remain authoritative:

- `https://www.gate.com/docs/developers/crossex/en/`
- `https://www.gate.com/docs/developers/crossex/ws/en/`
- `https://www.gate.com/docs/developers/apiv4/en/`

## REST boundary

CrossEx REST is served below `https://api.gateio.ws/api/v4/crossex/*`. The adapter exposes a fixed allowlist rather than a generic authenticated proxy:

- account, positions, position margin-mode, margin positions, open orders, fills, fees, transfers, and account-ledger reads;
- instrument and risk-limit discovery;
- order creation, order cancellation, leverage updates, and Spot/CrossEx transfers.

Private requests use Gate APIv4 `KEY`, `Timestamp`, and HMAC-SHA512 `SIGN` authentication. Order-placement requests also include the disclosed `X-Gate-Channel-Id: xiaopixiu`; other authenticated requests do not. Public signup uses `https://www.gatesites.cc/zh/share/XIAOPXIU`; users can receive trading-fee rebates settled by Gate. This metadata does not alter fees, permissions, order payloads or financial evidence.

The portfolio futures-position DTO retains optional nullable `marginMode`, `isolatedMargin`, `liquidationPrice` and `liquidationPriceCheckedAt` as raw exchange evidence. Malformed optional fields do not reject an otherwise valid position update. The former `/api/crossex/liquidation-estimates` route and estimation UI are removed. The current mode, policy and recovery interfaces are specified in [account margin APIs](#账户保证金风控接口).

`GET /crossex/rule/symbols` is the runtime source of truth for venue/product availability and trading limits. The application does not infer that an instrument exists from a static venue list. Gate documents no CrossEx testnet, so execution is production-only.

## WebSocket boundary

- Public endpoint: `wss://api.gateio.ws/ws/crossex/public`
- Private endpoint: `wss://api.gateio.ws/ws/crossex`

The market hub validates public `ticker`, `funding_rate`, `open_interest`, `order_book_update`, `trade`, kline and supported full-book recovery channels. Detailed subscriptions are demand-driven by browser watchers or backend quote consumers, bounded and removed after demand expires. Full-book recovery is separate from the UI's incremental order-book projection.

After authenticated login, the private stream subscribes account-wide to `order`, `usertrades`, `position`, `margin_position`, and `asset`. REST snapshots bootstrap and periodically reconcile the in-memory projection so disconnects or missed pushes do not silently become authoritative.

The application routes writes through the reviewed REST adapter rather than CrossEx WebSocket API write channels.

### Executable quote provenance

Recovery subscribes to the exact requested CrossEx symbol. BINANCE, GATE, OKX, HYPERLIQUID and DERIBIT use `order_book_5`; BYBIT uses `order_book_1`. The channel selector also recognizes LIGHTER, but this does not add LIGHTER to the terminal's supported execution venues. KRAKEN retains ticker recovery only; no unverified incremental-book fallback is substituted.

Recovery retains at most two additional sockets. A requested symbol that still lacks a qualified quote is re-probed on retained sockets after the probe interval, without unsubscribing healthy symbols. Connection attempts and subscription re-probes share the existing eight-per-minute recovery budget and minimum retry spacing; `quoteRecovery.attemptsInWindow` counts these recovery probes. Subscription acknowledgement alone never restores readiness.

The shared `LiveMarket` contract carries:

| Field | Meaning |
| --- | --- |
| `source` | `gate_crossex_websocket`, verified independent `native_venue`, or non-executable `demo_seed`; it does not authenticate unrelated statistical fields |
| `nativeSymbol` / `nativeValidUntil` | Exact native contract and metadata validity deadline, required for native executable BBO |
| `quoteHealth` | Main-connection evidence, CrossEx and native source times/unavailability reasons |
| `quoteChannel` (optional) | `ticker`, `order_book_1` or `order_book_5` that supplied the current bid/ask |
| `updatedAt` / `receivedAt` | Executable quote's upstream source time / backend receipt time; a disconnected owner can invalidate `receivedAt` with an empty string |
| `tickerUpdatedAt` (optional) | Source timestamp of the last accepted ticker statistics; book updates never advance it |
| `fundingUpdatedAt` / `openInterestUpdatedAt` (optional) | Receipt evidence for each independent channel, not an executable-price timestamp |

Independent source mapping, per-source invalidation, failback and funding boundaries are defined in [data recovery](data-recovery.md). Native candidates do not reuse the reference-quote cache or its observation timestamps. Consumers must validate prices and timestamps, not just `source` or connection health. Managed quotes allow source age at most 15 seconds, delivery lag at most 3 seconds and future-clock tolerance 2 seconds. ACKs, empty/crossed/invalid books, expired or delayed snapshots do not restore readiness. Old/seed last-price values in a book-only quote cannot auto-fill the manual order ticket; missing funding evidence displays unavailable. These fields are additive; absence in an older response is not proof that a statistic is current.

## Public venue data

CrossEx REST does not provide every candle, current-funding, funding-history, or bulk open-interest view required by the UI. Unauthenticated adapters query official public APIs for Gate, Binance, OKX, Bybit, Kraken, Hyperliquid, and Deribit. Every response is schema-validated and mapped back to a validated CrossEx instrument; public reference data never authorizes trading.

Historical funding totals require coverage of the requested window and a successful tail within the existing 15-minute freshness limit. Missing, expired or incomplete histories return pending/unavailable and null rates, never a successful zero. A complete empty interval can legitimately total zero. Overlapping intervals retain incremental replacement; a fully fetched forward-disconnected window may atomically replace active coverage while preserving older settlement rows and auditing the previous coverage. The intervening gap is not covered. Failed, aborted, truncated or superseded reads must not replace successful coverage. Ranking reads do not warm the market universe or reorder the user's applied ranking.

## Execution controls

Hyperliquid FUTURE limit prices follow the [targeted price contract](hyperliquid-limit-price.md): automatic entry and managed limit exits quantize the final price conservatively, and the shared submission boundary validates tick/significant-digit rules before creating a submission. Other venues and market-order behavior retain their existing paths. The risk workspace independently discloses paused tasks and disabled execution without changing the margin verdict or any resume authority.

Every backend start is locked. Writes require the appropriate API permission, an explicit live-mode acknowledgement, local Host/Origin and intent checks, schema validation, and audit logging. Strategy execution uses acknowledged remote order state, refuses stale or seed prices, reconciles ambiguous outcomes, and pauses when exposure cannot be repaired safely.

## Scoped public market reads (local loading optimization)

Funding-table values refresh independently of its applied ranking. The initial load, an explicit column/metric/filter change, or **Update ranking** commits one global ordering before pagination. Background quotes, funding updates and OI threshold crossings do not move existing rows or silently change page membership. Changed filter eligibility is disclosed until the next explicit ranking; removed assets remain unavailable placeholders until that refresh. Price ranking retains the previous order while collecting quotes, then commits once when the collection finishes or after a 15-second wait, using only currently valid quotes and disclosing incomplete coverage. Later batches cannot silently commit another ranking. Stale/missing quotes still display unavailable immediately. Sorting and filtering never authorize trading.

`GET /api/markets/funding-overview?symbols=BYBIT_FUTURE_BTC_USDT,GATE_FUTURE_BTC_USDT` refreshes and projects the managed funding cache for the requested contracts, independently of the full-page display cache. Its response uses the actual selected-venue freshness window of 60 seconds; it must not return the older page cache after a successful managed refresh. The optional comma-separated list is syntax-validated and limited to 100 entries; absent `symbols` retains the full market response and display refresh. Unknown/delisted contracts remain absent/unavailable, never zero or evidence of a complete portfolio. Financial normalization and trading authorization remain unchanged; refresh/deadline/cycle rules are in [data recovery](data-recovery.md#实时费率).

`GET /api/markets/reference-quotes?symbols=GATE_FUTURE_BTC_USDT,HYPERLIQUID_FUTURE_BTC_USDC` returns exact-contract best bid/ask references for 1–100 validated catalog symbols. The independent 15-second result cache coalesces pending reads, uses at most four upstream jobs, expires queued work after 10 seconds, and returns per-contract unavailable/timeout results within 12 seconds once the instrument catalog is available. Unknown contracts do not trigger upstream reads. Frontend batches use 20 symbols and retain complete active-page/global-sort results independently of the bounded cross-page cache. Full-market price sorting collects quotes progressively and reports loading; unavailable/expired quotes sort last. Its displayed page has an independent priority refresh, so a slow background collection does not delay visible quotes. No instantaneous full-market book is promised when upstream capacity/latency exceeds the freshness window. Targeted native books are capped at 300 reads per venue per minute; quote HTTP limits use a separate bucket and client cooldown, preserving account/risk/trade request quotas. Stale/missing Binance bulk BBO can use its public 5-level depth snapshot, with fresh exchange event time and positive level sizes required; marks never substitute for a book. Public quote failures cannot change managed WS subscriptions, funding-cache timestamps or trade authorization.

Both funding and paired-execution previews use `(short best bid - long best ask) / long best ask * 10000`, with explicit double-sided books, exact contract identity, canonical asset units, quote age at most 45 seconds and sampling skew at most 30 seconds. Reverse direction reads the opposite bid/ask sides. USD/USDT/USDC are compared nominally without FX conversion; this is a reference before fees, depth and slippage. No last, mark, impact or missing-price zero fallback is allowed. Fresh valid exact CrossEx WS books take precedence in the execution preview even during a feed reconnect; this retains timestamp/lag validation but does not light the ready indicator or relax the healthy-feed trading guard; The reference-quote REST cache remains display-only. Separately verified native execution adapters follow the stricter source-age/lag/identity/authority contract above; their availability is independent of the CrossEx socket state. Hyperliquid uses resolved native/HIP-3 coins and the public [`l2Book` info read](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#l2-book-snapshot); its funding contexts have no executable BBO.

Funding overview, market catalog and instrument catalog public GET responses can negotiate gzip for larger JSON bodies; account/credential/write routes are excluded. `Vary: Accept-Encoding` prevents representation confusion. The financial payload is byte-identical after decompression.

## Terminal managed-task API

These are the terminal's local HTTP routes, not exchange endpoints. Browser clients retain the application's Host/Origin, authentication-state and intent checks. The examples describe request contracts only; sending a launch or close request in live mode can trade real funds. Quantities below are illustrative and still require current instrument and margin checks.

| Route | Intent header value (`x-gct-trading-intent`) | Semantics |
| --- | --- | --- |
| `POST /api/strategies` | `start-strategy` | Create additional entry with optional management/adoption |
| `POST /api/strategies/:id/stop` | `stop-strategy` | Persist KEEP by default, or EXIT when explicitly selected |
| `POST /api/strategies/:id/resume` | `resume-strategy` | Explicitly reconcile and restore monitoring, persisted exit, or a verified remaining entry target; never replay an old order |
| `GET /api/strategies` | None | Read task configuration, progress and managed state |

### Launch and adopt

The following JSON is a complete paired-task request body; the current live session selects the credential account:

```json
{
  "kind": "position",
  "asset": "BTC",
  "leftVenue": "BYBIT",
  "rightVenue": "GATE",
  "leftSide": "SELL",
  "rightSide": "BUY",
  "entryBps": "0",
  "totalAmount": "0.02",
  "perOrderQuantity": "0.01",
  "executionMethod": "TAKER_TAKER",
  "management": {
    "adoptExisting": true,
    "perOrderQuantity": "0.01"
  }
}
```

`totalAmount` is the additional target, not old holdings plus additions. `management.adoptExisting=true` authorizes admission of balanced holdings on the selected actual legs and reconciliation/cancellation of attributable old orders in scope. Unknown or conflicting orders prevent admission. With the flag absent/false, pre-existing holdings block a managed launch. With `management` absent, the historical non-managed execution contract remains.

Launching a new managed task also authorizes its stable group for account IMR/MMR reduction. The grant commits with task creation and ownership; a stale account, changed mode/credentials/policy or failed grant rejects the launch. It preserves current thresholds and existing incident scope. Execution still requires the original holdings, cross-margin, order and planning checks; ordinary launches without management grant no such scope. Later manual removal is not reversed by polling, restart or resume. Existing tasks require their existing explicit risk-settings action.

### Stop and resume

Keep holdings (also the behavior of an empty/omitted body):

```json
{"closePositions": false}
```

Exit all holdings managed by the group, including adopted and newly filled quantities:

```json
{"closePositions": true}
```

The position-table shortcut first reads `GET /api/strategies/close-targets`. Each target contains the existing strategy record and `scope: { accountProfileId, legs: [{ symbol, side }, { symbol, side }] }`; `side` is the original position direction (BUY long / SELL short). Only actual current-account claims are returned. The shortcut sends that scope as `expectedCloseScope` alongside `closePositions: true` to the same Stop route. The server rechecks the scope inside its authenticated-write boundary before calling the existing engine. This is an ownership check, not a new close executor or permission override. Ordinary Stop callers remain compatible without the optional scope.


The stop body is strict: unknown properties, string booleans, numbers and null values are rejected. KEEP stops automatic monitoring/protection/exits, proves task-order termination, refreshes remaining positions and retains claims. Zero positions with zero unresolved/remote orders complete the task. EXIT requires valid trading permission and does not bypass a risk pause. `POST /api/strategies/:id/resume` has no new quantity parameter; it rechecks account, actual holdings, orders and current ownership, including after awaited reads. It cannot restore a transferred or released controller.

Resume requires explicit live restoration authority. KEEP restores monitoring; an existing exit continues reduction. Interrupted entry must pass the [exact holdings and terminal-history checks](managed-positions.md#超时重启和权限边界), retaining its original target and fills; a completed target monitors. `verified=false` never generates an exit. `management.resumeAction` describes OPENING/MONITORING/EXITING, and an optional strict JSON body `{"expectedAction":"OPENING"}` binds the displayed direction; it does not bypass eligibility. If account events, ownership, risk or intent change during the read, the request is rejected without clearing the lock or submitting an order. The user must initiate another resume after reviewing fresh facts; unlike background account rechecks, this request does not automatically retry.

The returned `StrategyRecord.management` includes `phase`, actual `leftQuantity`/`rightQuantity`, `checkedAt`, signal observations and pending order IDs. Additive fields include `groupId`, `adoptedLeft`, `adoptedRight`, `adoptedAt`, `stopIntent` (`KEEP`/`EXIT`/null) and `transferredTo`; historical records may omit them. State meanings and defaults are in the [managed-position contract](managed-positions.md).

### Relevant rejection codes

| Code | Meaning / next action |
| --- | --- |
| `invalid_stop_options` (400) | Send boolean `closePositions`; optional `expectedCloseScope` is valid only with `true` |
| `managed_close_target_changed` (409) | Account, exact pair or actual claims changed; no Stop was started by this request |
| `invalid_resume_intent` (400) | Send only optional `expectedAction`: OPENING, MONITORING or EXITING |
| `managed_resume_action_changed` (409) | The requested direction differs from the current intent; refresh and review before another resume |
| `managed_entry_resume_unverified` (409) | Interrupted entry holdings/history do not reconcile; retain pause and resolve the evidence mismatch |
| `managed_existing_position` | Explicit adoption is required for these holdings |
| `managed_adoption_unbalanced` | Actual legs are not a balanced pair; reconcile before attempting entry |
| `managed_position_owned` / `managed_group_direction_conflict` | Another owner/reservation or incompatible actual direction prevents takeover |
| `managed_adoption_unknown_order` / `managed_adoption_unresolved_orders` | Order ownership or terminal outcome is unproven; do not replay |
| `managed_adoption_changed` / `managed_adoption_interrupted` | Admission facts changed or original protection/stop took priority |
| `managed_stop_in_progress` / `managed_stop_reconcile_failed` | Stop is pending or needs review; saved intent is not a success claim |
| `managed_group_transferred` / `managed_group_released` | Use the current controller; the old task cannot reacquire holdings |
| `managed_review_changed` (409) | Account-read revision, task configuration/state/intent or risk changed; the request did not resume the task. Refresh and explicitly retry only after reconciling new facts |
| `managed_account_rechecking` / `managed_global_risk_paused` | Writes are blocked by temporary reconciliation or a hard risk pause |
| `managed_account_read_failed` / `managed_account_timeout` | Account facts unavailable; recoverable background reads use the fixed 25-second window, without a three-failure shortcut |
| `managed_account_authorization_failed` | Explicit credential/permission or account-identity failure; not a transient 500 retry |
| `managed_account_recovery_expired` | Original recovery budget expired; requires review, and live activation cannot reset it |
| `managed_market_data_unavailable` | A managed reduction lacks usable quote evidence; do not enlarge/retry it to bypass the missing price |

`management.reason=managed_exit_quote_unavailable:<symbol>` is a persisted waiting reason, not a successful exit or an HTTP rejection code. An exit waits for both quotes before its first order. Recovery of market data alone never invokes task resume or clears a hard risk lock.

Conflict/review rejections normally use HTTP 409; live permission failures use 403 and unavailable account evidence can use 503. Financial or exchange data absence is never converted to a successful stop, zero balance or permission to add risk.

## 账户保证金风控接口

这些是终端本地接口，读取当前活动账户。`accountId`是风险账户键，`profileId`是活动凭据profile，二者不能互换。Host/Origin保护、live和托管控制权继续生效；外部模式读取为 `GET /crossex/positions/margin_mode`，没有新增自动切换模式的写入接口。

| 本地接口 | 请求及用途 |
| --- | --- |
| `GET /api/risk/margin` | 指标、保存/有效策略、组资格与授权、可选组 `readiness`、`valuation`、`protection`、`costAccounting`；WebSocket `risk.margin`同口径 |
| `GET /api/risk/margin/modes?symbols=...` | 一个或两个完整合约标识，逗号分隔；获取严格三态能力和实际模式，适用于无仓首单前核查 |
| `GET /api/risk/margin/policy` | 当前policy、accountId及一次性csrfToken |
| `PUT /api/risk/margin/policy` | JSON含policy/accountId/csrfToken；`x-gct-risk-intent: configure-margin`；校验当前身份和policy.revision |
| `POST /api/risk/margin/resume-entry` | JSON含accountId/csrfToken；`x-gct-risk-intent: resume-entry`；显式复核新增锁，不能清除托管硬锁或重启建仓 |
| `GET /api/risk/margin/history` | accountId、hours=1/24/168/720，可选已核实unit；按账户隔离的真实采样/缺测 |
| `GET /api/risk/margin/events` | accountId，可选before/hours；分页或最多2000个图表事件，保留截断标识 |

事件 `kind=entry_auto_recovered` 表示后端已核清本次正常保证金事件并原子解除其新增冻结；原存续任务继续监控实际剩余量，不需要调用恢复接口，也不会补回减仓。普通 `kind=recovered` 仅表示事件达到恢复条件，不能视为已有人工锁或增仓锁已解除。客户端同时读取当前 `fresh`、`entryBlocked`、`incidentId`、交易模式和任务状态；不能仅凭历史事件、健康比例或HTTP成功推断恢复权限。

自动资格仅属于本进程中新发生且授权有效的正常事件，完整条件见[执行结算与恢复](margin-risk-management.md#执行结算与恢复)。已有托管硬暂停仍通过[官方恢复接口](#stop-and-resume)处理；`resume-entry`不等同任务resume、切换实盘或新的开仓请求。

组 `readiness` 为可选附加字段：`status=ready|blocked|unknown`，另含reason、maxBatchQuantity（字符串或null）、checkedAt。它描述当前模型证据，不能替代eligible、authorized、live或当前事件预算；`maxBatchQuantity`是当前可核实的单批容量，不是建议下单量；`protection.targetQuantity`为估算恢复目标，`protection.plannedQuantity`为本批实际计划，仍须通过当批执行检查；旧响应缺字段按未知处理。`readiness.approximate=true`表示默认近似规划；不授予执行权限。可选`costAccounting={pendingBatches,reserved}`表示当前账户待对账批次及费用预约。默认规划不要求手工借币参数文件，没有新的HTTP参数写入口。

以下为合成响应片段，不是完整账户响应，也不是配置请求。`reserved`是USDT计价的风险预约，不是累计真实手续费；金额可以已降至0而明细仍待对账。

```json
{
  "groups":[{
    "id":"synthetic-group","strategyId":"synthetic-task","asset":"TEST","phase":"MONITORING",
    "eligible":true,"authorized":true,"reason":null,
    "readiness":{"status":"ready","reason":null,"maxBatchQuantity":"1","approximate":true,"checkedAt":1700000000000}
  }],
  "costAccounting":{"pendingBatches":1,"reserved":"0.04"}
}
```

模式查询的symbols字符串最长240字符，数组1–2项，每项符合 `VENUE_FUTURE_BASE_QUOTE` 的大写字母/数字格式。示例只读请求：

```bash
curl --fail --silent 'http://127.0.0.1:17840/api/risk/margin/modes?symbols=GATE_FUTURE_BTC_USDT%2CBYBIT_FUTURE_BTC_USDT'
curl --fail --silent 'http://127.0.0.1:17840/api/risk/margin/policy'
```

示意模式响应，不代表当前账户状态：

```json
{"profileId":"synthetic-profile","items":[{"symbol":"GATE_FUTURE_BTC_USDT","supportCross":true,"mode":"CROSS","checkedAt":1700000000000,"reason":null}]}
```

`supportCross`为true/false/null；`mode`为CROSS/ISOLATED/null。接口只读不能授予开仓权限，后台在实际提交边界重新核实。能力缺失和查询失败保持未知；不能把它们描述成“仅支持逐仓”。

配置请求的结构如下。ID/token/revision/勾选组必须从当前读取结果和用户选择取得；六项阈值仅为Schema示例，不是调用者应覆盖的默认操作：

```json
{
  "accountId":"CURRENT_ACCOUNT_ID",
  "csrfToken":"TOKEN_RETURNED_BY_POLICY_GET",
  "policy":{
    "revision":7,
    "initial":{"warn":110,"reduce":105,"recover":115},
    "maintenance":{"warn":200,"reduce":150,"recover":220},
    "protectedGroupIds":["SELECTED_GROUP_ID"],
    "notificationsEnabled":true,
    "reminderMinutes":10
  }
}
```

每次配置/恢复要取新的CSRF token；token一次性消费。保存阈值保留活动事件的有效数值版本，取消组授权阻止下一批首腿，已成交配对责任按原上限处理。服务live、组授权和托管硬锁是不同边界。

`valuation`可为null，否则含十进制rates、checkedAt与profileId；非USDT缺汇率不可用。`protection`可为null，否则含cause、stage、confirmations、batchId/strategyId、plannedQuantity/targetQuantity、apr、fallback、reason。目标量null不等于0；状态与完成判据见[保证金规格](margin-risk-management.md#执行结算与恢复)。

| 代码/持久原因 | 含义与处理 |
| --- | --- |
| `cross_margin_unsupported` / `cross_margin_capability_unknown` | 明确不支持/能力未知；阻止新增，不能自行补true |
| `cross_margin_mode_isolated` / `cross_margin_mode_unknown` | 实际逐仓/模式未核实；不能自动切换模式 |
| `invalid_margin_symbols` (400) / `margin_modes_unavailable` (409) | 查询参数不合法/无法取得当前模式证据 |
| `invalid_risk_configuration_intent` (403) | intent、请求结构或一次性CSRF失败 |
| `margin_account_changed` / `margin_policy_conflict` / `margin_group_not_eligible` | 身份、版本或组资格不一致；重读当前状态，不盲重试写入 |
| `margin_no_authorized_groups` / `margin_no_executable_plan` | 保护范围/合法规划不足；事件保持可见，不代表已减仓 |
| `margin_account_settlement_unverified` | 首次批次的真实订单/持仓/账户结算超过核对期限；保留责任并人工复核，不等同费用明细迟到 |
| `margin_execution_cost_exceeded` | 已核实费用或滑点超预算；触发全局暂停，对账完成也不自动清风险锁 |
| `margin_fx_depeg_unverified` | 已观察到明显汇率偏离，当前有效估值缺失；停止使用普通1:1近似 |
| `margin_no_legal_quantity` / `margin_projection_no_safe_improvement` | 本阶段预算不足合法数量或不能证明安全改善；不向上取整扩大批次 |
| `margin_partial_untradeable` / `margin_batch_quantity_exceeded` | 差额不可精确交易/预算异常；保留批次并人工复核 |
| `margin_legacy_batch_requires_review` / `margin_batch_holdings_unexplained` | 旧归属字段不足/数量变化不能由成交解释；不重放 |
| `managed_positions_settlement_pending` / `margin_positions_settlement_pending` | 已归属成交尚待仓位反映；有界等待，不是平衡完成 |
| `managed_external_reduction` / `margin_recovery_not_confirmed` | 外部事故/恢复证据不足；沿各自人工锁和复核流程 |

持久风控原因出现在快照或 `management.reason` 中，不必然是同名HTTP拒绝码。旧强平价接口返回404，客户端不能继续轮询它；可选原始交易所字段保留不意味着界面估算能力仍存在。
