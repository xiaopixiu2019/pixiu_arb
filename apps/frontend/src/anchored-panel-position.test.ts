import { describe, expect, it } from 'vitest';
import { anchoredPanelPosition } from './anchored-panel-position.js';

describe('interactive panel viewport placement', () => {
  it('repairs the measured left-edge and bottom overflow without hiding controls', () => {
    const p = anchoredPanelPosition({ left: 47, top: 326.6875, bottom: 365.6875 }, 326.5,
      { left: 0, top: 0, width: 1424, height: 691 });
    expect(p.left).toBe(47);
    expect(p.top).toBeGreaterThanOrEqual(12);
    expect(p.top + 326.5).toBeLessThanOrEqual(679);
  });
  it.each([320, 375, 768, 1280, 1920])('bounds both edges at viewport width %s', width => {
    for (const left of [-20, 10, width - 30]) {
      const viewport = { left: 7, top: 21, width, height: 220 };
      const p = anchoredPanelPosition({ left, top: 210, bottom: 248 }, 600, viewport);
      expect(p.left).toBeGreaterThanOrEqual(19);
      expect(p.left + p.width).toBeLessThanOrEqual(7 + width - 12);
      expect(p.top).toBeGreaterThanOrEqual(33);
      expect(p.top + p.maxHeight).toBeLessThanOrEqual(21 + 220 - 12);
    }
  });
});
