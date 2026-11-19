import { aspectOf, aspectsText } from '@tyto/plugin-api';
import { describe, expect, it } from 'vitest';

import { shapeOf, shapesText } from '../src/drive-count.js';

/**
 * The plugin keeps its own copy of Tyto's shape snapping (Tyto ADR 0215): importing `aspectOf`
 * at runtime bundles the whole of core into `dist/index.js`. This holds the copy equal to
 * Tyto's, and every move onto a newer plugin API (Tyto ADR 0154) reruns it.
 */
describe("shapeOf against Tyto's aspectOf", () => {
  const edgeCases: readonly (readonly [number | undefined, number | undefined])[] = [
    [1080, 1080],
    [1080, 1350],
    [1080, 1920],
    [1920, 1080],
    [1500, 1000],
    [1000, 1500],
    [1101, 1350],
    [1110, 1350],
    [1059, 1350],
    [1050, 1350],
    [1019, 1000],
    [1030, 1000],
    [981, 1000],
    [970, 1000],
    [2001, 1000],
    [4000, 1000],
    [2000, 1000],
    [1000, 700],
    [undefined, undefined],
    [1080, undefined],
    [undefined, 1350],
  ];

  it('agrees on every edge case the plugin tests', () => {
    for (const [width, height] of edgeCases) {
      expect(shapeOf(width, height), `${String(width)}x${String(height)}`).toBe(
        aspectOf(width, height),
      );
    }
  });

  it('agrees across a sweep of widths and heights', () => {
    const heights = [100, 333, 720, 1000, 1080, 1350, 1500, 1920];
    let compared = 0;
    for (let width = 100; width <= 3000; width += 7) {
      for (const height of heights) {
        expect(shapeOf(width, height), `${String(width)}x${String(height)}`).toBe(
          aspectOf(width, height),
        );
        compared += 1;
      }
    }
    expect(compared).toBe(415 * heights.length);
  });
});

describe("shapesText against Tyto's aspectsText", () => {
  it('writes the same text, ties and empty included', () => {
    const shapes = new Map([
      ['9:16', 1],
      ['?', 2],
      ['4:5', 3],
      ['1:1', 1],
      ['wide', 2],
    ]);
    expect(shapesText(shapes)).toBe(aspectsText(shapes));
    expect(shapesText(new Map())).toBe(aspectsText(new Map()));
  });
});
