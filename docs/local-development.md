# 开发与验证

建议Node.js 24，支持版本以根package.json为准。

```sh
npm ci --no-audit --no-fund
npx playwright install chromium
npm run verify
npm audit --registry=https://registry.npmjs.org --audit-level=high
```

Linux浏览器测试可能还需要 npx playwright install --with-deps chromium。公开验证包含lint、类型检查、工作区测试、构建、启动/安装器、CI守卫和浏览器回归。平台限定跳过须如实记录，不代表预编译安装包已验收。
测试使用临时数据库、模拟网关和假凭据，不读取真实账户或执行交易。关键回归覆盖部分成交、重复/乱序、未知写入、过期证据、排队期间停止和重启责任。
开发使用 npm run dev；构建使用 npm run build；启动用Windows的run.ps1或Linux的./run。数据、凭据、日志和构建产物不提交。
当前验证覆盖 Windows x64 源码运行和 Linux x64 容器部署，其他平台不能只凭矩阵或脚本宣称安装验收。源代码变更后重新验证实际候选，保留许可证和第三方声明。

Windows archive regression tests cover deep extracted paths, original download-zone metadata, rejected special ZIP entries, failed extraction, safe cleanup and preserved installations. The health response reads the installed backend package version rather than a launcher environment variable.
