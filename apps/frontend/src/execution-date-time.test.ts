import { describe, expect, it } from 'vitest';
import { formatExecutionDateTime } from './execution-date-time.js';

describe('formatExecutionDateTime', () => {
  it('includes the localized date and second-level time', () => {
    const instant = new Date(2026, 7, 12, 16, 2, 32).toISOString();

    expect(formatExecutionDateTime(instant, 'en')).toMatch(/12\/08\/2026,? 16:02:32/);
    expect(formatExecutionDateTime(instant, 'zh')).toMatch(/2026\/08\/12 16:02:32/);
  });

  it('handles an invalid persisted timestamp', () => {
    expect(formatExecutionDateTime('not-a-date', 'en')).toBe('—');
  });
});
