'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Board, ROWS } = require('../engine.js');
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

function gatedGame(board) {
  const frames = [];
  const clears = [];
  const scores = [];
  const queue = [];
  let waiting = null;
  let pending = null;
  const game = new Game({
    board,
    onClear: event => clears.push(event),
    onChange: current => scores.push(current.score),
    animate: frame => new Promise(resolve => {
      assert.equal(pending, null, 'animations must not overlap');
      pending = frame;
      frames.push(frame);
      const step = {
        frame,
        finish() {
          assert.equal(pending, frame);
          pending = null;
          resolve();
        },
      };
      if (waiting) { const deliver = waiting; waiting = null; deliver(step); }
      else queue.push(step);
    }),
  });
  game.nextRow = NEXT_ROW;
  return {
    game, frames, clears, scores,
    get pending() { return pending; },
    nextFrame() {
      return queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => { waiting = resolve; });
    },
  };
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
  add(board, ROWS - 1, 0, 1);
  add(board, ROWS - 1, 4, 1);
  add(board, ROWS - 1, 8, 1);
  add(board, ROWS - 2, 0, 4);
  add(board, ROWS - 2, 4, 1);
  add(board, ROWS - 3, 0, 4);
  add(board, ROWS - 3, 4, 5);
  add(board, ROWS - 4, 1, 3);
  add(board, ROWS - 4, 5, 4);
  const selected = add(board, ROWS - 5, 4, 3);
  return { board, selected };
}

function bothResolutionFixture() {
  const board = new Board();
  add(board, ROWS - 1, 0, 4);
  const selected = add(board, ROWS - 1, 8, 1);
  add(board, ROWS - 2, 0, 5);
  add(board, ROWS - 2, 5, 4);
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
    { rows: [ROWS - 3], chain: 1, points: 100 },
    { rows: [ROWS - 2], chain: 2, points: 150 },
    { rows: [ROWS - 1], chain: 3, points: 200 },
  ]);
  assert.equal(frames.filter(frame => frame.kind === 'insert').length, 1);
  const insertIndex = frames.findIndex(frame => frame.kind === 'insert');
  assert.equal(frames.slice(0, insertIndex).filter(frame => frame.kind === 'clear').length, 3);
  assert.equal(board.spools.size, NEXT_ROW.length);
  assert.ok(board.snapshot().every(spool => spool.row === ROWS - 1));
  assert.deepEqual([...new Set(changes.map(change => change.score))], [0, 100, 250, 450]);
  board.assertValid();
});

test('a simultaneous clear awards the current step value for each cleared row', async () => {
  const board = new Board();
  for (const row of [ROWS - 2, ROWS - 1]) {
    add(board, row, 0, 4);
    add(board, row, 4, 5);
  }
  const selected = add(board, ROWS - 3, 0, 1);
  const { game, clears, frames } = captureGame(board);
  assert.equal(await turn(game, selected.id, 1), true);
  assert.deepEqual(clears, [{ rows: [ROWS - 2, ROWS - 1], chain: 1, points: 200 }]);
  assert.equal(game.score, 200);
  assert.equal(game.moves, 1);
  assert.equal(frames.filter(frame => frame.kind === 'insert').length, 1);
  board.assertValid();
});

test('a whole-board scan clears nonadjacent full rows in one animation and one mutation batch', async () => {
  const board = new Board();
  const fullRows = [2, ROWS - 1];
  for (const row of fullRows) {
    add(board, row, 0, 4);
    add(board, row, 4, 5);
  }
  // Two narrow support columns keep the upper full row stable while leaving
  // every intervening row incomplete. The selected spool falls above it.
  for (let row = 3; row < ROWS - 1; row += 1) {
    add(board, row, 0, 1);
    add(board, row, 4, 1);
  }
  const selected = add(board, 0, 0, 1);
  const clearedIds = new Set(fullRows.flatMap(row => board.grid[row]));
  const harness = gatedGame(board);
  const { game, frames, clears, scores } = harness;
  const scan = board.fullRows.bind(board);
  const clear = board.clearRows.bind(board);
  const gravity = board.gravityStep.bind(board);
  const batches = [];
  let clearing = false;

  board.fullRows = () => {
    assert.equal(harness.pending, null, 'scan must await the current animation');
    return scan();
  };
  board.clearRows = rows => {
    assert.deepEqual(rows, fullRows, 'both distant rows must be collected before mutation');
    assert.equal(harness.pending, null, 'all clear visuals must finish before removal');
    assert.ok([...clearedIds].every(id => board.getSpool(id)), 'all rows remain intact until the batch starts');
    clearing = true;
    const removed = clear(rows);
    clearing = false;
    batches.push([...rows]);
    assert.ok([...clearedIds].every(id => board.getSpool(id) === null));
    return removed;
  };
  board.gravityStep = onlyId => {
    assert.equal(clearing, false, 'gravity cannot run between row removals');
    if (batches.length) assert.ok([...clearedIds].every(id => board.getSpool(id) === null));
    return gravity(onlyId);
  };

  assert.equal(game.beginDrag(selected.id), true);
  assert.equal(game.moveDrag(1), true);
  const finished = game.releaseDrag().then(result => ({ finished: true, result }));
  let steps = 0;
  while (true) {
    const step = await Promise.race([harness.nextFrame(), finished]);
    if (step.finished) { assert.equal(step.result, true); break; }
    assert.ok(++steps < 100);
    if (step.frame.kind === 'clear') {
      assert.deepEqual(step.frame.rows, fullRows);
      assert.deepEqual(scan(), fullRows);
      assert.ok([...clearedIds].every(id => board.getSpool(id)));
      assert.deepEqual(batches, []);
      assert.equal(game.score, 0);
    }
    step.finish();
  }

  assert.deepEqual(batches, [fullRows]);
  assert.deepEqual(clears, [{ rows: fullRows, chain: 1, points: 200 }]);
  assert.equal(frames.filter(frame => frame.kind === 'clear').length, 1);
  assert.equal(frames.filter(frame => frame.kind === 'insert').length, 1);
  assert.deepEqual([...new Set(scores)], [0, 200]);
  assert.equal(game.score, 200);
  assert.equal(game.moves, 1);
  assert.equal(game.state, STATES.IDLE);
  board.assertValid();
});

test('global gravity finishes every fall animation before scanning already-full nonadjacent rows', async () => {
  const board = new Board();
  const fullRows = [ROWS - 3, ROWS - 1];
  add(board, ROWS - 1, 0, 4);
  add(board, ROWS - 1, 4, 4);
  add(board, ROWS - 2, 0, 1);
  add(board, ROWS - 2, 4, 1);
  add(board, ROWS - 3, 0, 4);
  add(board, ROWS - 3, 4, 5);
  add(board, ROWS - 2, 8, 1);
  const slowFalling = add(board, 2, 1, 1);
  const harness = gatedGame(board);
  const { game, frames, clears } = harness;
  const scan = board.fullRows.bind(board);
  let scans = 0;
  let initialFallFrames = 0;

  board.fullRows = () => {
    assert.equal(harness.pending, null, 'a pending fall frame cannot be scanned');
    if (scans === 0) {
      assert.equal(board.getSpool(slowFalling.id).row, ROWS - 4);
      assert.equal(initialFallFrames, ROWS - 6, 'every initial fall frame must finish first');
    }
    scans += 1;
    return scan();
  };
  game.setState(STATES.RESOLVING);
  const finished = game.resolve().then(() => ({ finished: true }));
  let steps = 0;
  while (true) {
    const step = await Promise.race([harness.nextFrame(), finished]);
    if (step.finished) break;
    assert.ok(++steps < 100);
    if (clears.length === 0) {
      // The first gravity tick fills the bottom row, but the separate spool
      // still needs several ticks. Neither full row may clear during that wait.
      assert.equal(step.frame.kind, 'fall');
      assert.deepEqual(scan(), fullRows);
      assert.equal(scans, 0);
      assert.equal(game.score, 0);
      initialFallFrames += 1;
    } else if (step.frame.kind === 'clear') {
      assert.equal(scans, 1);
      assert.deepEqual(step.frame.rows, fullRows);
      assert.deepEqual(scan(), fullRows);
      assert.equal(game.score, 0);
    }
    step.finish();
  }

  assert.deepEqual(clears, [{ rows: fullRows, chain: 1, points: 200 }]);
  assert.equal(frames.filter(frame => frame.kind === 'clear').length, 1);
  assert.equal(game.score, 200);
  assert.deepEqual(scan(), []);
  board.assertValid();
});

test('the post-insertion resolution starts a fresh chain at 100 points', async () => {
  const { board, selected, nextRow } = bothResolutionFixture();
  const { game, clears, frames } = captureGame(board);
  game.nextRow = nextRow;
  assert.equal(await turn(game, selected.id, 7), true);
  assert.deepEqual(clears, [
    { rows: [ROWS - 2], chain: 1, points: 100 },
    { rows: [ROWS - 1], chain: 1, points: 100 },
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
  const selected = add(board, ROWS - 1, 1, 2);
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
  const selected = add(board, ROWS - 1, 0, 1);
  const floating = add(board, 4, 7, 1);
  const { game, frames } = captureGame(board);
  game.nextRow = [{ col: 1, length: 1, color: '#a8caa5' }, { col: 5, length: 1, color: '#a6c8df' }];
  assert.equal(await turn(game, selected.id, 1), true);
  const insertion = frames.find(frame => frame.kind === 'insert');
  assert.equal(insertion.before.find(spool => spool.id === floating.id).row, 4);
  assert.equal(insertion.after.find(spool => spool.id === floating.id).row, 3);
  assert.equal(board.getSpool(floating.id).row, ROWS - 1);
  assert.equal(board.getSpool(selected.id).row, ROWS - 2);
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
  const selected = add(board, ROWS - 1, 3, 1);
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
  assert.equal(board.getSpool(selected.id).row, ROWS - 1);
  assert.equal(frames.filter(frame => frame.kind === 'insert').length, 1);
  const insertIndex = frames.findIndex(frame => frame.kind === 'insert');
  assert.equal(frames.slice(0, insertIndex).filter(frame => frame.kind === 'fall').length, ROWS - 1);
  board.assertValid();
});

test('drag acquisition and reset obey the idle and game-over boundaries', () => {
  const board = new Board();
  const selected = add(board, ROWS - 6, 0, 2);
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
