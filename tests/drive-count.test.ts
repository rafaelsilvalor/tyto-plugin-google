import { describe, expect, it } from 'vitest';

import { shapeOf, shapesText } from '../src/drive-count.js';

/** `shapeOf` and `shapesText` alone: the snap tolerance on both sides of each usual ratio. */
describe('shapeOf', () => {
  it('reads the usual ratios exactly', () => {
    expect(shapeOf(1080, 1080)).toBe('1:1');
    expect(shapeOf(1080, 1350)).toBe('4:5');
    expect(shapeOf(1080, 1920)).toBe('9:16');
    expect(shapeOf(1920, 1080)).toBe('16:9');
    expect(shapeOf(1500, 1000)).toBe('3:2');
    expect(shapeOf(1000, 1500)).toBe('2:3');
  });

  it('snaps within 2% of a usual ratio, above and below, and not past it', () => {
    // 4:5 is 0.8: 0.816 and 0.784 are its 2% edges.
    expect(shapeOf(1101, 1350)).toBe('4:5'); // 0.8156, +1.9%
    expect(shapeOf(1110, 1350)).toBe('37:45'); // 0.8222, +2.8%
    expect(shapeOf(1059, 1350)).toBe('4:5'); // 0.7844, -1.9%
    expect(shapeOf(1050, 1350)).toBe('7:9'); // 0.7778, -2.8%
    // 1:1, on the same two sides.
    expect(shapeOf(1019, 1000)).toBe('1:1');
    expect(shapeOf(1030, 1000)).toBe('103:100');
    expect(shapeOf(981, 1000)).toBe('1:1');
    expect(shapeOf(970, 1000)).toBe('97:100');
  });

  it('reads wider than 2:1 as wide, and 2:1 itself as its ratio', () => {
    expect(shapeOf(2001, 1000)).toBe('wide');
    expect(shapeOf(4000, 1000)).toBe('wide');
    expect(shapeOf(2000, 1000)).toBe('2:1');
  });

  it('reads an image with a missing dimension as ?', () => {
    expect(shapeOf(undefined, undefined)).toBe('?');
    expect(shapeOf(1080, undefined)).toBe('?');
    expect(shapeOf(undefined, 1350)).toBe('?');
  });
});

describe('shapesText', () => {
  it('sorts by count, most first, then by ratio', () => {
    const shapes = new Map([
      ['9:16', 1],
      ['?', 2],
      ['4:5', 3],
      ['1:1', 1],
    ]);
    expect(shapesText(shapes)).toBe('4:5:3,?:2,1:1:1,9:16:1');
    expect(shapesText(new Map())).toBe('');
  });
});
