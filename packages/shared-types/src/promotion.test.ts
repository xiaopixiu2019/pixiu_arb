import { describe, expect, it } from 'vitest';
import { PUBLIC_PROMOTION } from './promotion.js';

describe('public promotion', () => {
  it('keeps order attribution separate from the exact signup link and user benefit', () => {
    expect(PUBLIC_PROMOTION).toEqual({
      channelId: 'xiaopixiu',
      referralUrl: 'https://www.gatesites.cc/zh/share/XIAOPXIU',
      repository: 'xiaopixiu2019/pixiu_arb',
    });
    expect(PUBLIC_PROMOTION.channelId).toMatch(/^[a-z0-9]{1,19}$/);
    expect(Object.isFrozen(PUBLIC_PROMOTION)).toBe(true);
  });
});
