import { describe, expect, it } from 'vitest';
import { translate } from './i18n.js';

describe('English and Chinese translations', () => {
  it.each([
    ['en', 'More', 'More'],
    ['zh', 'More', '更多'],
    ['zh', 'Best ask', '最优卖价'],
    ['zh', 'ADL indicator', 'ADL 指标'],
    ['zh', 'It indicates the position in ADL ranking. When all lights are lit, the position is at the top of the ADL preference hierarchy.', '它表示该持仓在 ADL 排名中的位置。所有指示条均亮起时，该持仓处于 ADL 事件优先级的最高位置。'],
    ['zh', 'Manage and switch accounts', '管理和切换账户'],
    ['zh', 'Current account', '当前账户'],
    ['zh', 'Edit account name', '编辑账户名称'],
    ['zh', 'Add a new account', '添加新账户'],
    ['zh', 'Delete account', '删除账户'],
    ['zh', 'Pause strategies and switch account?', '暂停策略并切换账户？'],
    ['zh', 'Resume', '恢复'],
    ['zh', 'Confirm strategy launch', '确认启动策略'],
    ['zh', 'Run strategy', '运行策略'],
    ['zh', 'Sign in with Gate API credentials', '使用 Gate API 密钥登录'],
    ['zh', 'Open secure credential setup', '打开 Gate API 密钥设置'],
    ['zh', 'Current total initial margin ratio', '当前总起始保证金率'],
    ['zh', 'Current total maintenance margin ratio', '当前总维持保证金率'],
    ['zh', 'Margin balance divided by total maintenance margin. At or below 100%, CrossEx force-liquidates positions.', '保证金余额除以总维持保证金。当比率等于或低于 100% 时，CrossEx 将强制平仓。'],
    ['zh', 'Execute a fixed two-venue position, then stop', '在两个交易所执行固定仓位后停止'],
    ['zh', 'Open hedge strategy', '打开配对策略'],
  ] as const)('translates %s %s', (language, key, expected) => {
    expect(translate(language, key)).toBe(expected);
  });
});
