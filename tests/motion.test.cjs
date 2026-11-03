'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Board, COLS, ROWS } = require('../engine.js');
const { Game, TIMING, sampleFallRow, sampleClearOffset } = require('../game.js');

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test('a complete gravity phase aggregates long and short rigid drops into one bounded animation', async () => {
  const board = new Board();
  for (const [row, col, length] of [[0, 0, 5], [2, 0, 1], [4, 2, 3], [8, 4, 1], [11, 2, 1]]) {
    board.addSpool({ row, col, length, color: '#a8caa5' });
  }
  const before = board.snapshot();
  const frames = [];
  const game = new Game({ board, animate: async frame => frames.push(frame) });
  await game.fall();
  assert.equal(frames.length, 1);
  const frame = frames[0];
  assert.equal(frame.kind, 'fall');
  assert.deepEqual(frame.before, before);
  assert.deepEqual(frame.after, board.snapshot());
  assert.equal(new Set(frame.moved.map(move => move.id)).size, frame.moved.length);
  assert.ok(frame.moved.some(move => move.toRow - move.fromRow > 1));
  assert.ok(new Set(frame.moved.map(move => move.toRow - move.fromRow)).size > 1);
  assert.equal(frame.maxDrop, Math.max(...frame.moved.map(move => move.toRow - move.fromRow)));
  assert.ok(frame.duration >= 250 && frame.duration <= 550);
  for (const move of frame.moved) {
    assert.equal(before.find(spool => spool.id === move.id).row, move.fromRow);
    assert.equal(board.getSpool(move.id).row, move.toRow);
  }
  board.assertValid();
  await game.fall();
  assert.equal(frames.length, 1, 'an already-settled board does not animate again');

  const shortBoard = new Board();
  shortBoard.addSpool({ row: ROWS - 2, col: 0, length: 1, color: '#a8caa5' });
  let shortFall;
  await new Game({ board: shortBoard, animate: async value => { shortFall = value; } }).fall();
  assert.equal(shortFall.duration, 250, 'a single-cell fall follows the reference pace');
  assert.ok(frame.duration > shortFall.duration, 'longer drops receive more viewing time');
});

test('fall durations retain fractional precision and cap drops of five or more cells at 550 ms', async () => {
  for (const [distance, expected] of [[1, 250], [2, 250 * Math.SQRT2], [3, 250 * Math.sqrt(3)], [4, 500], [5, 550], [6, 550], [ROWS - 1, 550]]) {
    const board = new Board();
    board.addSpool({ row: ROWS - 1 - distance, col: 3, length: 2, color: '#a8caa5' });
    const frames = [];
    await new Game({ board, animate: async frame => frames.push(frame) }).fall();
    assert.equal(frames.length, 1);
    assert.equal(frames[0].duration, expected, `distance ${distance} must use its unrounded duration`);
    assert.equal(frames[0].maxDrop, distance);
  }
});

test('the same drop has the same elapsed-time motion regardless of unrelated longer drops', async () => {
  async function captureFall(shortDrop, otherDrop = null) {
    const board = new Board();
    const selected = board.addSpool({ row: ROWS - 1 - shortDrop, col: 0, length: 1, color: '#a8caa5' });
    if (otherDrop !== null) board.addSpool({ row: ROWS - 1 - otherDrop, col: 4, length: 2, color: '#a8caa5' });
    let frame;
    await new Game({ board, animate: async value => { frame = value; } }).fall();
    const from = frame.before.find(spool => spool.id === selected.id).row;
    const to = frame.after.find(spool => spool.id === selected.id).row;
    return { frame, from, to };
  }

  for (const shortDrop of [1, 2, 4, 5]) {
    const alone = await captureFall(shortDrop);
    for (let longerDrop = shortDrop + 1; longerDrop < ROWS; longerDrop += 1) {
      const mixed = await captureFall(shortDrop, longerDrop);
      for (const elapsed of [0, 25, 125, 249, 250, 350, 500, 549, 550, 600]) {
        const baseline = sampleFallRow(alone.from, alone.to, alone.frame.maxDrop, elapsed / alone.frame.duration);
        const actual = sampleFallRow(mixed.from, mixed.to, mixed.frame.maxDrop, elapsed / mixed.frame.duration);
        assert.ok(Math.abs(actual - baseline) < 1e-10,
          `drop ${shortDrop}, companion ${longerDrop}, elapsed ${elapsed}`);
      }
    }
  }
});

test('short pieces land early while longer linear falls continue without moving landed pieces', () => {
  const phase = 550;
  assert.equal(sampleFallRow(0, 1, 11, 125 / phase), 0.5, 'motion begins at constant speed, not with quadratic hesitation');
  assert.equal(sampleFallRow(0, 1, 11, 250 / phase), 1);
  assert.equal(sampleFallRow(0, 1, 11, 500 / phase), 1);
  assert.equal(sampleFallRow(0, 4, 11, 250 / phase), 2);
  assert.equal(sampleFallRow(0, 4, 11, 500 / phase), 4);
  assert.equal(sampleFallRow(0, 11, 11, 250 / phase), 5);
  assert.equal(sampleFallRow(0, 11, 11, 500 / phase), 10);
  assert.equal(sampleFallRow(0, 11, 11, 1), 11);
});

test('landing times and the duration-cap boundary preserve monotone contraction between different drops', () => {
  const boundary = (550 / 250) ** 2;
  const distances = [0, 1, 2, 3, 4, boundary - 1e-6, boundary, boundary + 1e-6, 5, 6, 11];
  for (const elapsed of [0, 125, 249.999, 250, 250 * Math.SQRT2, 499.999, 500, 549.999, 550, 600]) {
    let previousDistance = 0;
    let previousTravel = 0;
    for (const distance of distances) {
      const travel = sampleFallRow(0, distance, 11, elapsed / 550);
      const difference = travel - previousTravel;
      assert.ok(difference >= -1e-10, 'greater drops must not travel less at the same time');
      assert.ok(difference <= distance - previousDistance + 1e-10,
        'relative travel cannot exceed the valid difference between landing distances');
      previousDistance = distance;
      previousTravel = travel;
    }
  }
});

test('sampled continuous paths preserve shape, order, bounds, and non-overlap through unequal drops', async () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    const random = seededRandom(seed);
    const board = new Board({ random });
    // Deliberately include floating bars, stacks, and partial supports. Their
    // independent lengths and landing distances exercise different stop times.
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const row = Math.floor(random() * ROWS);
      const length = 1 + Math.floor(random() * 5);
      const col = Math.floor(random() * (COLS - length + 1));
      if (board.grid[row].slice(col, col + length).some(id => id !== null)) continue;
      board.addSpool({ row, col, length, color: '#a8caa5' });
    }
    const before = board.snapshot();
    board.settle();
    const after = board.snapshot();
    const starts = new Map(before.map(spool => [spool.id, spool]));
    const maxDrop = Math.max(0, ...after.map(spool => spool.row - starts.get(spool.id).row));
    const previous = new Map(before.map(spool => [spool.id, spool.row]));
    for (let sample = 0; sample <= 100; sample += 1) {
      const positions = after.map(spool => {
        const start = starts.get(spool.id);
        assert.equal(spool.length, start.length);
        assert.equal(spool.col, start.col);
        const row = sampleFallRow(start.row, spool.row, maxDrop, sample / 100);
        assert.ok(Number.isFinite(row) && row >= start.row && row <= spool.row);
        assert.ok(row >= previous.get(spool.id), 'a falling spool cannot bounce upward');
        if (sample === 0) assert.equal(row, start.row);
        if (sample === 100) assert.equal(row, spool.row);
        previous.set(spool.id, row);
        return { ...spool, row };
      });
      for (let i = 0; i < positions.length; i += 1) {
        for (let j = i + 1; j < positions.length; j += 1) {
          const a = positions[i], b = positions[j];
          if (a.col >= b.col + b.length || b.col >= a.col + a.length) continue;
          assert.ok(Math.abs(a.row - b.row) >= 1 - 1e-10, `overlap in seed ${seed}, progress ${sample / 100}`);
        }
      }
    }
    board.assertValid();
  }
});

test('long falling motion remains continuous across cell boundaries and clamps elapsed progress', () => {
  const distance = ROWS - 1;
  assert.equal(sampleFallRow(0, distance, distance, -0.5), 0);
  assert.equal(sampleFallRow(0, distance, distance, 1.5), distance);
  assert.equal(sampleFallRow(5, 5, distance, 0.7), 5);
  assert.equal(sampleFallRow(5, 5, 0, 0.7), 5, 'zero-distance phases cannot divide by zero');
  for (let row = 1; row < distance; row += 1) {
    const crossing = row / distance;
    const epsilon = 1e-6;
    const before = sampleFallRow(0, distance, distance, crossing - epsilon);
    const at = sampleFallRow(0, distance, distance, crossing);
    const after = sampleFallRow(0, distance, distance, crossing + epsilon);
    assert.ok(before < row && after > row);
    assert.ok(Math.abs(at - row) < 1e-10);
    assert.ok(Math.abs((at - before) - (after - at)) < 1e-9, 'speed does not restart at a cell boundary');
  }
});

test('clear sway makes three diminishing left-and-back sweeps and remains zero outside the hold', () => {
  const hold = 1250;
  assert.equal(TIMING.clearHold, hold);
  assert.equal(TIMING.clearFade, 150, 'cosmetic sway cannot extend the clear timing');
  assert.equal(TIMING.clearSwayCells, 0.24);
  for (const elapsed of [-500, -1, 0, hold, hold + 1, hold + 75, hold + 150, hold + 500]) {
    assert.equal(sampleClearOffset(elapsed), 0, `elapsed ${elapsed} must stay centered`);
  }
  for (let elapsed = 0; elapsed <= hold; elapsed += 1) {
    const offset = sampleClearOffset(elapsed);
    assert.ok(Number.isFinite(offset));
    assert.ok(offset >= -0.24 && offset <= 0, 'the visual motion stays within its leftward cell envelope');
  }
  const peaks = [[0.2, -0.24], [0.56, -0.12], [0.86, -0.06]];
  for (const [fraction, expected] of peaks) {
    assert.ok(Math.abs(sampleClearOffset(hold * fraction) - expected) < 1e-12,
      'each successive left peak is half the preceding amplitude');
  }
  for (const fraction of [0, 0.4, 0.72, 1]) {
    assert.ok(Math.abs(sampleClearOffset(hold * fraction)) < 1e-12, 'each sweep returns to the original cell position');
  }
  for (const [start, peak, end] of [[0, 0.2, 0.4], [0.4, 0.56, 0.72], [0.72, 0.86, 1]]) {
    let previous = sampleClearOffset(hold * start);
    for (let step = 1; step <= 20; step += 1) {
      const value = sampleClearOffset(hold * (start + (peak - start) * step / 20));
      assert.ok(value <= previous + 1e-12, 'each outward sweep moves continuously left');
      previous = value;
    }
    for (let step = 1; step <= 20; step += 1) {
      const value = sampleClearOffset(hold * (peak + (end - peak) * step / 20));
      assert.ok(value >= previous - 1e-12, 'each return sweep moves continuously toward its cell');
      previous = value;
    }
  }
});

test('clear sway starts and finishes smoothly and leaves the entire fade centered', () => {
  const hold = TIMING.clearHold;
  const epsilon = 0.01;
  assert.ok(Math.abs(sampleClearOffset(epsilon)) < 1e-8);
  assert.ok(Math.abs(sampleClearOffset(hold - epsilon)) < 1e-8);
  assert.ok(Math.abs(sampleClearOffset(epsilon) / epsilon) < 1e-6, 'initial velocity approaches zero');
  assert.ok(Math.abs(sampleClearOffset(hold - epsilon) / epsilon) < 1e-6, 'final velocity approaches zero');
  for (const fraction of [0.2, 0.4, 0.56, 0.72, 0.86]) {
    const at = sampleClearOffset(hold * fraction);
    const left = sampleClearOffset(hold * fraction - epsilon);
    const right = sampleClearOffset(hold * fraction + epsilon);
    assert.ok(Math.abs((at - left) / epsilon) < 1e-6, 'each keyframe eases down to zero velocity');
    assert.ok(Math.abs((right - at) / epsilon) < 1e-6, 'each following segment eases away from zero velocity');
  }
  let previous = sampleClearOffset(0);
  for (let elapsed = 1; elapsed <= hold + TIMING.clearFade; elapsed += 1) {
    const offset = sampleClearOffset(elapsed);
    assert.ok(Math.abs(offset - previous) < 0.003, `no discontinuity at ${elapsed} ms`);
    if (elapsed >= hold) assert.equal(offset, 0, 'fading never shifts a spool away from its cell');
    previous = offset;
  }
  for (const duration of [250, 777.5, 2000]) {
    for (const progress of [0, 0.1, 0.2, 0.4, 0.56, 0.72, 0.86, 1, 1.1]) {
      assert.ok(Math.abs(sampleClearOffset(duration * progress, duration) - sampleClearOffset(hold * progress)) < 1e-12,
        'a different hold length changes the clock, not the normalized motion');
    }
  }
  assert.equal(sampleClearOffset(0, 0), 0);
  assert.equal(sampleClearOffset(10, 0), 0);
});

test('clear sway depends on elapsed time rather than frame cadence or previous samples', () => {
  const checkpoints = [0, 125, 250, 312.5, 500, 700, 900, 1075, 1250, 1325, 1400];
  const expected = checkpoints.map(elapsed => sampleClearOffset(elapsed));
  for (const cadence of [1000 / 30, 1000 / 60, 1000 / 120, 237]) {
    let nextFrame = 0;
    for (let index = 0; index < checkpoints.length; index += 1) {
      const elapsed = checkpoints[index];
      while (nextFrame < elapsed) {
        sampleClearOffset(nextFrame);
        nextFrame += cadence;
      }
      assert.equal(sampleClearOffset(elapsed), expected[index], `cadence ${cadence}, elapsed ${elapsed}`);
    }
  }
  for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
    assert.equal(sampleClearOffset(checkpoints[index]), expected[index], 're-reading an earlier time cannot change its position');
  }
});
