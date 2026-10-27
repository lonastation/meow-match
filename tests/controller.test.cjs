'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Board } = require('../engine.js');
const { Game, STATES } = require('../game.js');

const NEXT_ROW = Object.freeze([
  Object.freeze({ col: 0, length: 2, color: '#a8caa5' }),
  Object.freeze({ col: 6, length: 2, color: '#a6c8df' }),
]);

function add(board, row, col, length, color = '#f59ba7') {
  return board.addSpool({ row, col, length, color });
}

function captureGame(board) {
  const frames = [];
  const clears = [];
  const changes = [];
  const game = new Game({
    board,
    animate: async frame => { frames.push(frame); },
    onClear: event => { clears.push(event); },
    onChange: current => { changes.push({ state: current.state, score: current.score, moves: current.moves }); },
  });
  game.nextRow = NEXT_ROW;
  return { game, frames, clears, changes };
}

async function turn(game, id, col) {
  assert.equal(game.beginDrag(id), true);
  assert.equal(game.moveDrag(col), true);
  return game.releaseDrag();
}

// The middle full row clears first, then creates a full row beneath it, and
// finally frees two narrow bars to fill the gaps in the bottom row.
function threeChainFixture() {
  const board = new Board();
  add(board, 15, 0, 1);
  add(board, 15, 4, 1);
  add(board, 15, 8, 1);
  add(board, 14, 0, 4);
  add(board, 14, 4, 1);
  add(board, 13, 0, 4);
  add(board, 13, 4, 5);
  add(board, 12, 1, 3);
  add(board, 12, 5, 4);
  const selected = add(board, 11, 4, 3);
  return { board, selected };
}

function bothResolutionFixture() {
  const board = new Board();
  add(board, 15, 0, 4);
  const selected = add(board, 15, 8, 1);
  add(board, 14, 0, 5);
  add(board, 14, 5, 4);
  const nextRow = [{ col: 4, length: 3, color: '#a8caa5' }, { col: 8, length: 1, color: '#a6c8df' }];
  return { board, selected, nextRow };
}

test('a tap, a clamped drag, and a return to the starting column are no-op turns', async () => {
  for (const mode of ['tap', 'clamped', 'roundtrip']) {
    const board = new Board();
    const selected = add(board, 3, 0, 2);
    const { game, frames, clears } = captureGame(board);
    const before = board.snapshot();
    assert.equal(game.beginDrag(selected.id), true);
    if (mode === 'clamped') assert.equal(game.moveDrag(-20), false);
    if (mode === 'roundtrip') {
      assert.equal(game.moveDrag(5), true);
      assert.equal(game.moveDrag(0), true);
    }
    assert.equal(await game.releaseDrag(), false);
    assert.deepEqual(board.snapshot(), before, mode);
    assert.equal(game.state, STATES.IDLE);
    assert.equal(game.drag, null);
    assert.equal(game.moves, 0);
    assert.equal(game.score, 0);
    assert.equal(game.nextRow, NEXT_ROW);
    assert.deepEqual(frames, []);
    assert.deepEqual(clears, []);
    board.assertValid();
  }
});

test('cancelling a drag restores its original column and never advances the turn', async () => {
  const board = new Board();
  const selected = add(board, 2, 2, 3);
  const { game, frames } = captureGame(board);
  const before = board.snapshot();
  assert.equal(game.beginDrag(selected.id), true);
  assert.equal(game.moveDrag(6), true);
  assert.equal(board.getSpool(selected.id).col, 6);
  assert.equal(board.getSpool(selected.id).row, 2, 'dragging cannot start gravity');
  assert.equal(game.cancelDrag(), true);
  assert.deepEqual(board.snapshot(), before);
  assert.equal(game.state, STATES.IDLE);
  assert.equal(game.drag, null);
  assert.equal(await game.releaseDrag(), false);
  assert.equal(game.moves, 0);
  assert.equal(game.score, 0);
  assert.equal(game.nextRow, NEXT_ROW);
  assert.deepEqual(frames, []);
});

test('one valid drag resolves three chain steps at 100, 150, and 200, then inserts once', async () => {
  const { board, selected } = threeChainFixture();
  const { game, frames, clears, changes } = captureGame(board);
  assert.equal(await turn(game, selected.id, 5), true);
  assert.equal(game.score, 450);
  assert.equal(game.moves, 1);
  assert.equal(game.state, STATES.IDLE);
  assert.deepEqual(clears.map(({ rows, chain, points }) => ({ rows, chain, points })), [
    { rows: [13], chain: 1, points: 100 },
    { rows: [14], chain: 2, points: 150 },
    { rows: [15], chain: 3, points: 200 },
  ]);
  assert.equal(frames.filter(frame => frame.kind === 'insert').length, 1);
  const insertIndex = frames.findIndex(frame => frame.kind === 'insert');
  assert.equal(frames.slice(0, insertIndex).filter(frame => frame.kind === 'clear').length, 3);
  assert.equal(board.spools.size, NEXT_ROW.length);
  assert.ok(board.snapshot().every(spool => spool.row === 15));
  assert.deepEqual([...new Set(changes.map(change => change.score))], [0, 100, 250, 450]);
  board.assertValid();
});

test('a simultaneous clear awards the current step value for each cleared row', async () => {
  const board = new Board();
  for (const row of [14, 15]) {
    add(board, row, 0, 4);
    add(board, row, 4, 5);
  }
  const selected = add(board, 13, 0, 1);
  const { game, clears, frames } = captureGame(board);
  assert.equal(await turn(game, selected.id, 1), true);
  assert.deepEqual(clears, [{ rows: [14, 15], chain: 1, points: 200 }]);
  assert.equal(game.score, 200);
  assert.equal(game.moves, 1);
  assert.equal(frames.filter(frame => frame.kind === 'insert').length, 1);
  board.assertValid();
});

test('the post-insertion resolution starts a fresh chain at 100 points', async () => {
  const { board, selected, nextRow } = bothResolutionFixture();
  const { game, clears, frames } = captureGame(board);
  game.nextRow = nextRow;
  assert.equal(await turn(game, selected.id, 7), true);
  assert.deepEqual(clears, [
    { rows: [14], chain: 1, points: 100 },
    { rows: [15], chain: 1, points: 100 },
  ]);
  assert.equal(game.score, 200);
  assert.equal(game.moves, 1);
  assert.equal(game.state, STATES.IDLE);
  assert.equal(board.spools.size, 0);
  assert.deepEqual(frames.filter(frame => frame.kind !== 'fall').map(frame => frame.kind), ['clear', 'insert', 'clear']);
  board.assertValid();
});

test('a valid turn without clearing still inserts exactly one new row', async () => {
  const board = new Board();
  const selected = add(board, 15, 1, 2);
  const { game, clears, frames } = captureGame(board);
  assert.equal(await turn(game, selected.id, 3), true);
  assert.equal(game.score, 0);
  assert.equal(game.moves, 1);
  assert.equal(game.state, STATES.IDLE);
  assert.deepEqual(clears, []);
  assert.equal(frames.filter(frame => frame.kind === 'insert').length, 1);
  assert.equal(board.spools.size, 1 + NEXT_ROW.length);
  assert.equal(board.getSpool(selected.id).length, 2);
  board.assertValid();
});

test('all spools resume gravity after insertion, while release initially drops only the selected spool', async () => {
  const board = new Board();
  const selected = add(board, 15, 0, 1);
  const floating = add(board, 4, 7, 1);
  const { game, frames } = captureGame(board);
  game.nextRow = [{ col: 1, length: 1, color: '#a8caa5' }, { col: 5, length: 1, color: '#a6c8df' }];
  assert.equal(await turn(game, selected.id, 1), true);
  const insertion = frames.find(frame => frame.kind === 'insert');
  assert.equal(insertion.before.find(spool => spool.id === floating.id).row, 4);
  assert.equal(insertion.after.find(spool => spool.id === floating.id).row, 3);
  assert.equal(board.getSpool(floating.id).row, 15);
  assert.equal(board.getSpool(selected.id).row, 14);
  assert.ok(frames.slice(frames.indexOf(insertion) + 1).some(frame => frame.kind === 'fall'));
  board.assertValid();
});

test('every animation phase locks dragging, cancellation, reset, and duplicate release', async () => {
  const { board, selected, nextRow } = bothResolutionFixture();
  const queue = [];
  let listener = null;
  const game = new Game({
    board,
    animate: frame => new Promise(done => {
      const step = { frame, done };
      if (listener) { const deliver = listener; listener = null; deliver(step); }
      else queue.push(step);
    }),
  });
  game.nextRow = nextRow;
  const nextAnimation = () => queue.length > 0 ? Promise.resolve(queue.shift()) : new Promise(resolve => { listener = resolve; });
  assert.equal(game.beginDrag(selected.id), true);
  assert.equal(game.moveDrag(7), true);
  const finished = game.releaseDrag().then(result => ({ finished: true, result }));
  const kinds = new Set();
  let animationCount = 0;
  while (true) {
    const step = await Promise.race([nextAnimation(), finished]);
    if (step.finished) { assert.equal(step.result, true); break; }
    animationCount += 1;
    assert.ok(animationCount < 100, 'the turn must finish in finite animation steps');
    const { frame, done } = step;
    kinds.add(frame.kind);
    assert.equal(game.state, frame.kind === 'insert' ? STATES.INSERTING_ROW : STATES.RESOLVING);
    assert.ok(frame.duration >= 150 && frame.duration <= 300);
    const before = board.snapshot();
    const score = game.score;
    const moves = game.moves;
    assert.equal(game.beginDrag(board.snapshot()[0].id), false);
    assert.equal(game.moveDrag(0), false);
    assert.equal(game.cancelDrag(), false);
    assert.equal(game.reset(), false);
    assert.equal(await game.releaseDrag(), false);
    assert.deepEqual(board.snapshot(), before);
    assert.equal(game.score, score);
    assert.equal(game.moves, moves);
    board.assertValid();
    done();
  }
  assert.deepEqual([...kinds].sort(), ['clear', 'fall', 'insert']);
  assert.equal(game.state, STATES.IDLE);
  assert.equal(game.score, 200);
  assert.equal(game.moves, 1);
});

test('top overflow ends the turn before insertion or post-insertion gravity can hide it', async () => {
  const board = new Board();
  const top = add(board, 0, 0, 1);
  const selected = add(board, 15, 3, 1);
  const { game, frames, clears } = captureGame(board);
  assert.equal(await turn(game, selected.id, 4), true);
  assert.equal(game.state, STATES.GAME_OVER);
  assert.equal(game.moves, 1);
  assert.equal(game.score, 0);
  assert.equal(board.getSpool(top.id).row, 0);
  assert.equal(board.spools.size, 2);
  assert.equal(game.nextRow, NEXT_ROW);
  assert.deepEqual(frames, []);
  assert.deepEqual(clears, []);
  assert.equal(game.beginDrag(top.id), false);
  assert.equal(game.moveDrag(1), false);
  assert.equal(await game.releaseDrag(), false);
  board.assertValid();
  assert.equal(game.reset(), true);
  assert.equal(game.state, STATES.IDLE);
  assert.equal(game.moves, 0);
  assert.equal(game.score, 0);
  board.assertValid();
});

test('moving a top-row spool out of danger can fall before the overflow check', async () => {
  const board = new Board();
  const selected = add(board, 0, 0, 2);
  const { game, frames } = captureGame(board);
  assert.equal(await turn(game, selected.id, 3), true);
  assert.equal(game.state, STATES.IDLE);
  assert.equal(game.moves, 1);
  assert.equal(board.getSpool(selected.id).row, 15);
  assert.equal(frames.filter(frame => frame.kind === 'insert').length, 1);
  const insertIndex = frames.findIndex(frame => frame.kind === 'insert');
  assert.equal(frames.slice(0, insertIndex).filter(frame => frame.kind === 'fall').length, 15);
  board.assertValid();
});

test('drag acquisition and reset obey the idle and game-over boundaries', () => {
  const board = new Board();
  const selected = add(board, 10, 0, 2);
  const { game } = captureGame(board);
  assert.equal(game.beginDrag(99999), false);
  assert.equal(game.moveDrag(1), false);
  assert.equal(game.cancelDrag(), false);
  assert.equal(game.beginDrag(selected.id), true);
  assert.equal(game.beginDrag(selected.id), false);
  assert.equal(game.reset(), false);
  assert.equal(game.cancelDrag(), true);
  assert.equal(game.reset(), true);
  assert.equal(game.state, STATES.IDLE);
  board.assertValid();
});
