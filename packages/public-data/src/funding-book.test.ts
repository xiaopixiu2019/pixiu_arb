import { expect, it } from 'vitest';
import { fundingBook } from './funding-book.js';

it('accepts an explicit uncrossed two-sided snapshot and retains its observation time', () => {
  expect(fundingBook('0.6889', '0.6994', 1_000_000)).toEqual({ bidPrice: '0.6889', askPrice: '0.6994', bookObservedAt: new Date(1_000_000).toISOString() });
});

it('rejects missing, malformed, crossed and stale books without inventing a price', () => {
  for (const bid of [undefined, null, '', 'NaN', 'Infinity', -1, 0, {}, true]) expect(fundingBook(bid, '1', 1_000_000)).toEqual({});
  expect(fundingBook('2', '1', 1_000_000)).toEqual({});
  expect(fundingBook('1', '2', 1_000_000, 969_999)).toEqual({});
  expect(fundingBook('1', '2', 1_000_000, 1_005_001)).toEqual({});
});
