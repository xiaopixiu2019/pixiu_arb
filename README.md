# PIXIU ARB

通过Gate CrossEx管理跨交易所行情、对冲执行和托管持仓的单人自托管终端。它不是Gate官方产品，也不提供收益保证。

**交付范围：1.0.3 源码与部署文档。** 当前不提供经过发行验收的预编译桌面安装包。

提供两种自托管使用方式：

- 本地电脑运行后台，通过本地浏览器操作。
- 自有云服务器运行后台，通过 SSH 隧道在本地浏览器操作。

功能包括跨所行情与资金费率比较、手动和配对执行、显式接管持仓、保证金风控，以及订单、费用和任务盈亏记录。

普通Maker–Taker任务提前准备两腿资金责任，按确认成交及时补腿。入场价差是触发条件，不是成交价差保证；仍有手续费、滑点、资金费和单腿暴露风险。

新建对冲任务草稿默认使用挂单–吃单；退出条件为价差-90 bps、净资金费率年化低于-150%、任一满足、持续3000秒。这是界面初始值，不是收益建议；既有任务和手动修改的值不会被覆盖。

启动和重启不会自动启用普通实盘交易。默认Stop保留仓位并停止自动保护，平仓需要明确选择。未知订单只查原单，不能重复提交。详见[安全说明](docs/safety.md)。

## 从源码运行

建议使用 Node.js 24 LTS、npm 和 Git。获取源码后执行：

```sh
git clone https://github.com/xiaopixiu2019/pixiu_arb.git
cd pixiu_arb
npm ci --no-audit --no-fund
npm run build
```

Windows运行 `.\run.ps1`，Linux运行 `./run`。访问启动器输出的回环地址，默认 http://127.0.0.1:17840 。凭据通过安全录入页面配置，不写入源码。

## Docker

```sh
docker compose up -d --build
```

默认仅发布主机回环端口并使用持久数据卷。云服务器通过SSH隧道访问，不直接开放终端端口。详见[部署、更新与恢复](docs/deployment.md)。

## 开发与验证

```sh
npx playwright install chromium
npm run verify
npm audit --registry=https://registry.npmjs.org --audit-level=high
```

测试使用隔离数据库和模拟网关，不需要真实凭据。[开发说明](docs/local-development.md) · [架构](docs/architecture.md) · [更新记录](CHANGELOG.md) · [安全报告](SECURITY.md)

项目来源、原作者版权及第三方声明见[来源及版权声明](SOURCE_NOTICES.md)和[第三方声明](THIRD_PARTY_NOTICES.md)，相关源码法律声明完整保留。

许可证：[AGPL-3.0-only](LICENSE)。保留[来源及版权声明](SOURCE_NOTICES.md)和[第三方声明](THIRD_PARTY_NOTICES.md)。不要在公开问题、截图或日志中提交凭据、账户标识、数据库或真实交易资料。

## 暂停期间持续保护

新托管任务启动确认时自动登记本组持续保护，涵盖接管与新增仓位，并在首笔下单前与任务及归属一起提交。暂停或重启后仍自动核对，只对已核实持仓按授权减仓，不补仓、不恢复普通交易。KEEP、明确只读和撤权优先；已有未覆盖组仍须明确授权。风险页区分当前组、已登记和已核实保护，缺口不再隐藏。

详见[托管持仓](docs/managed-positions.md)与[保证金保护](docs/margin-risk-management.md)。历史收益从持久阶段结果读取，当前价格仅更新浮动估值；缺失或过期的持仓、价格及费用证据保持不可用。
