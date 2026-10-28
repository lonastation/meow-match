'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Board, COLS, ROWS } = require('../engine.js');
const { Game, sampleFallRow } = require('../game.js');

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
  assert.ok(frame.duration >= 150 && frame.duration <= 300);
  for (const move of frame.moved) {
    assert.equal(before.find(spool => spool.id === move.id).row, move.fromRow);
    assert.equal(board.getSpool(move.id).row, move.toRow);
  }
  board.assertValid();
  await game.fall();
  assert.equal(frames.length, 1, 'an already-settled board does not animate again');
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
  for (let row = 1; row < distance; row += 1) {
    const crossing = Math.sqrt(row / distance);
    const epsilon = 1e-6;
    const before = sampleFallRow(0, distance, distance, crossing - epsilon);
    const at = sampleFallRow(0, distance, distance, crossing);
    const after = sampleFallRow(0, distance, distance, crossing + epsilon);
    assert.ok(before < row && after > row);
    assert.ok(Math.abs(at - row) < 1e-10);
    assert.ok(Math.abs((at - before) - (after - at)) < 1e-9, 'speed does not restart at a cell boundary');
  }
});
