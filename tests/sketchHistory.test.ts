import { describe, expect, it } from 'vitest';
import { createSketchHistoryAppender } from '../src/core/rig/sketchHistory';

describe('sketch drag history', () => {
  it('keeps the full draft at interaction start when the history updater runs later', () => {
    const start = { points: [{ x: 12, y: 34 }, null], options: { headR: 0.13, thickness: 1.2 } };
    const appendStart = createSketchHistoryAppender(start);
    start.points[0] = null;
    start.options.headR = 0.09;

    expect(appendStart([])).toEqual([{
      points: [{ x: 12, y: 34 }, null],
      options: { headR: 0.13, thickness: 1.2 },
    }]);
  });
});
