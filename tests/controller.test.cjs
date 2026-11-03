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

async function drainAnimations(harness, finished, inspect = () => {}) {
  const completion = finished.then(result => ({ finished: true, result }));
  let count = 0;
  while (true) {
    const step = await Promise.race([harness.nextFrame(), completion]);
    if (step.finished) return step.result;
    assert.ok(++count < 100, 'queued turns must finish in finite sequential phases');
    await inspect(step.frame);
    step.finish();
  }
}

async function flushMicrotasks() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function clearInteractionFixture() {
  const board = new Board();
  add(board, ROWS - 1, 0, 4);
  add(board, ROWS - 1, 4, 5);
  const selected = add(board, ROWS - 2, 1, 2);
  const other = add(board, ROWS - 2, 5, 2);
  const harness = gatedGame(board);
  // Fixed sparse rows make the number of queued insertions observable without
  // unrelated generated clears. Production row generation has its own tests.
  board.makeRow = () => NEXT_ROW.map(spool => ({ ...spool }));
  return { board, selected, other, harness };
}

async function startClearTurn(harness, selected, col = 0) {
  assert.equal(harness.game.beginDrag(selected.id), true);
  assert.equal(harness.game.moveDrag(col), true);
  const finished = harness.game.releaseDrag();
  const clearing = await harness.nextFrame();
  assert.equal(clearing.frame.kind, 'clear');
  assert.equal(harness.game.state, STATES.CLEARING);
  return { finished, clearing };
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
  assert.equal(frames.filter(frame => frame.kind === 'settle').length, 1, 'one pause follows the entire chain, not every clear');
  assert.equal(frames[insertIndex - 1].kind, 'settle');
  assert.deepEqual(frames[insertIndex - 1].before, frames[insertIndex - 1].after);
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
      assert.equal(step.frame.duration, 1400);
      assert.equal(step.frame.holdDuration, 1250);
      assert.deepEqual(step.frame.before, step.frame.after, 'clearing never moves the board during its reaction pause');
      assert.deepEqual(step.frame.rows, fullRows);
      assert.deepEqual(scan(), fullRows);
      assert.ok([...clearedIds].every(id => board.getSpool(id)));
      assert.deepEqual(batches, []);
      assert.equal(game.score, 0);
      const pausedBoard = board.snapshot();
      await Promise.resolve();
      assert.deepEqual(board.snapshot(), pausedBoard);
      assert.equal(frames.at(-1), step.frame, 'no gravity or insertion may overtake the pending clear');
      assert.equal(game.reset(), false);
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

test('global gravity finishes its continuous fall phase before scanning already-full nonadjacent rows', async () => {
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
  let initialFallPhases = 0;

  board.fullRows = () => {
    assert.equal(harness.pending, null, 'a pending fall frame cannot be scanned');
    if (scans === 0) {
      assert.equal(board.getSpool(slowFalling.id).row, ROWS - 4);
      assert.equal(initialFallPhases, 1, 'the entire continuous fall phase must finish first');
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
      // The final grid is ready, but its complete visual fall must finish
      // before either full row can be scanned or cleared.
      assert.equal(step.frame.kind, 'fall');
      assert.equal(step.frame.before.find(spool => spool.id === slowFalling.id).row, 2);
      assert.equal(step.frame.after.find(spool => spool.id === slowFalling.id).row, ROWS - 4);
      assert.ok(step.frame.moved.some(move => move.id === slowFalling.id && move.fromRow === 2 && move.toRow === ROWS - 4));
      assert.deepEqual(scan(), fullRows);
      assert.equal(scans, 0);
      assert.equal(game.score, 0);
      initialFallPhases += 1;
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
  assert.deepEqual(frames.filter(frame => frame.kind !== 'fall').map(frame => frame.kind), ['clear', 'settle', 'insert', 'clear']);
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
  assert.equal(frames.filter(frame => frame.kind === 'settle').length, 1, 'valid no-clear moves still pause before insertion');
  assert.equal(board.spools.size, 1 + NEXT_ROW.length);
  assert.equal(board.getSpool(selected.id).length, 2);
  board.assertValid();
});

test('the one settling pause holds the stable grid and input lock until insertion, with no second pause afterward', async () => {
  const board = new Board();
  const selected = add(board, ROWS - 1, 1, 2);
  const floating = add(board, 4, 7, 1);
  const harness = gatedGame(board);
  const { game, frames } = harness;
  const incoming = game.nextRow;
  const insertRow = board.insertRow.bind(board);
  const makeRow = board.makeRow.bind(board);
  let insertions = 0;
  let previewsGenerated = 0;
  board.insertRow = row => { insertions += 1; return insertRow(row); };
  board.makeRow = () => { previewsGenerated += 1; return makeRow(); };

  assert.equal(game.beginDrag(selected.id), true);
  assert.equal(game.moveDrag(3), true);
  const finished = game.releaseDrag();
  const falling = await harness.nextFrame();
  assert.equal(falling.frame.kind, 'fall');
  assert.ok(falling.frame.moved.some(move => move.id === floating.id));
  falling.finish();

  const settling = await harness.nextFrame();
  assert.equal(settling.frame.kind, 'settle');
  assert.equal(settling.frame.duration, 200);
  assert.equal(game.state, STATES.RESOLVING);
  const settledBoard = board.snapshot();
  assert.deepEqual(settling.frame.before, settledBoard);
  assert.deepEqual(settling.frame.after, settledBoard);
  assert.deepEqual(board.fullRows(), []);
  assert.ok(settledBoard.every(spool => spool.row === ROWS - 1 ||
    board.grid[spool.row + 1].slice(spool.col, spool.col + spool.length).some(id => id !== null)),
  'all pieces must already have support before the quiet pause starts');
  assert.equal(insertions, 0);
  assert.equal(previewsGenerated, 0);
  assert.equal(game.nextRow, incoming);
  assert.equal(game.moves, 1);
  assert.equal(game.score, 0);
  assert.equal(game.beginDrag(selected.id), false);
  assert.equal(game.moveDrag(5), false);
  assert.equal(game.cancelDrag(), false);
  assert.equal(game.reset(), false);
  assert.equal(await game.releaseDrag(), false);
  await Promise.resolve();
  assert.equal(harness.pending, settling.frame, 'the turn cannot advance until the pause finishes');
  assert.deepEqual(board.snapshot(), settledBoard);
  assert.equal(insertions, 0);
  assert.equal(previewsGenerated, 0);
  settling.finish();

  const insertion = await harness.nextFrame();
  assert.equal(insertion.frame.kind, 'insert');
  assert.equal(insertion.frame.duration, 180);
  assert.equal(game.state, STATES.INSERTING_ROW);
  assert.deepEqual(insertion.frame.before, settledBoard);
  assert.equal(insertions, 1);
  assert.equal(previewsGenerated, 0);
  insertion.finish();

  const fallingAfterInsertion = await harness.nextFrame();
  assert.equal(fallingAfterInsertion.frame.kind, 'fall');
  assert.deepEqual(fallingAfterInsertion.frame.moved, [{ id: selected.id, fromRow: ROWS - 2, toRow: ROWS - 1 }]);
  assert.equal(game.state, STATES.RESOLVING);
  assert.equal(game.nextRow, incoming);
  assert.equal(previewsGenerated, 0);
  fallingAfterInsertion.finish();
  assert.equal(await finished, true);
  assert.deepEqual(frames.map(frame => frame.kind), ['fall', 'settle', 'insert', 'fall']);
  assert.equal(game.state, STATES.IDLE);
  assert.equal(insertions, 1);
  assert.equal(previewsGenerated, 1);
  assert.equal(game.moves, 1);
  assert.equal(game.score, 0);
  board.assertValid();
});

test('all spools settle before insertion and resume gravity after the new row rises', async () => {
  const board = new Board();
  const selected = add(board, ROWS - 1, 0, 1);
  const floating = add(board, 4, 7, 1);
  const { game, frames } = captureGame(board);
  game.nextRow = [{ col: 1, length: 1, color: '#a8caa5' }, { col: 5, length: 1, color: '#a6c8df' }];
  assert.equal(await turn(game, selected.id, 1), true);
  const insertion = frames.find(frame => frame.kind === 'insert');
  assert.equal(insertion.before.find(spool => spool.id === floating.id).row, ROWS - 1);
  assert.equal(insertion.after.find(spool => spool.id === floating.id).row, ROWS - 2);
  assert.equal(board.getSpool(floating.id).row, ROWS - 1);
  assert.equal(board.getSpool(selected.id).row, ROWS - 2);
  assert.ok(frames.slice(0, frames.indexOf(insertion)).some(frame =>
    frame.kind === 'fall' && frame.moved.some(move => move.id === floating.id)));
  assert.ok(frames.slice(frames.indexOf(insertion) + 1).some(frame => frame.kind === 'fall'));
  board.assertValid();
});

test('sliding a support finishes all resulting falls and chains before insertion, then advances the preview last', async () => {
  const board = new Board();
  add(board, ROWS - 1, 0, 1);
  add(board, ROWS - 1, 4, 1);
  add(board, ROWS - 2, 0, 4);
  const selected = add(board, ROWS - 3, 3, 2);
  add(board, ROWS - 4, 3, 1);
  const freed = add(board, ROWS - 4, 4, 5);
  const survivor = add(board, ROWS - 5, 3, 1);
  add(board, ROWS - 5, 5, 4);
  assert.deepEqual(board.gravityStep(), [], 'the initial pieces must all have support');
  assert.deepEqual(board.fullRows(), []);

  const harness = gatedGame(board);
  const { game, frames, clears } = harness;
  const incomingRow = game.nextRow;
  const makeRow = board.makeRow.bind(board);
  let followingRowsGenerated = 0;
  board.makeRow = () => { followingRowsGenerated += 1; return makeRow(); };
  assert.equal(game.beginDrag(selected.id), true);
  assert.equal(game.moveDrag(1), true);
  assert.equal(board.getSpool(freed.id).row, ROWS - 4, 'gravity stays paused throughout dragging');

  const finished = game.releaseDrag().then(result => ({ finished: true, result }));
  let insertionSeen = false;
  let freedSpoolFellBeforeInsertion = false;
  let survivorFellAfterInsertion = false;
  let steps = 0;
  while (true) {
    const step = await Promise.race([harness.nextFrame(), finished]);
    if (step.finished) { assert.equal(step.result, true); break; }
    assert.ok(++steps < 100);
    const { frame } = step;
    assert.equal(game.nextRow, incomingRow, 'the next preview cannot advance during either resolution');
    assert.equal(followingRowsGenerated, 0, 'the following row is generated only after the complete turn');
    if (frame.kind === 'insert') {
      insertionSeen = true;
      assert.equal(freedSpoolFellBeforeInsertion, true);
      assert.deepEqual(clears, [
        { rows: [ROWS - 2], chain: 1, points: 100 },
        { rows: [ROWS - 1], chain: 2, points: 150 },
      ]);
      assert.equal(game.score, 250, 'both chain awards must finish before the incoming row appears');
      assert.deepEqual(frame.before.map(({ id, row }) => ({ id, row })), [{ id: survivor.id, row: ROWS - 1 }]);
    } else if (frame.kind === 'clear') {
      assert.equal(insertionSeen, false, 'this fixture must finish its entire chain before insertion');
    } else if (frame.kind === 'fall') {
      if (!insertionSeen && frame.moved.some(move => move.id === freed.id)) freedSpoolFellBeforeInsertion = true;
      if (insertionSeen && frame.moved.some(move => move.id === survivor.id)) survivorFellAfterInsertion = true;
    }
    step.finish();
  }

  assert.equal(survivorFellAfterInsertion, true, 'preview timing must also cover post-insertion gravity');
  assert.equal(frames.filter(frame => frame.kind === 'clear').length, 2);
  assert.equal(frames.filter(frame => frame.kind === 'insert').length, 1);
  assert.equal(game.score, 250);
  assert.equal(game.moves, 1);
  assert.equal(game.state, STATES.IDLE);
  assert.notEqual(game.nextRow, incomingRow);
  assert.equal(followingRowsGenerated, 1);
  board.assertValid();
});

test('fall, settle, and insertion lock input while clear phases keep their captured rows locked', async () => {
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
    const state = frame.kind === 'insert' ? STATES.INSERTING_ROW :
      frame.kind === 'clear' ? STATES.CLEARING : STATES.RESOLVING;
    assert.equal(game.state, state);
    if (frame.kind === 'fall') {
      assert.ok(frame.duration >= 250 && frame.duration <= 550);
    } else if (frame.kind === 'clear') {
      assert.equal(frame.duration, 1400);
      assert.equal(frame.holdDuration, 1250);
    } else if (frame.kind === 'settle') {
      assert.equal(frame.duration, 200);
      assert.deepEqual(frame.before, frame.after, 'settling feedback cannot move any spool');
    } else {
      assert.equal(frame.duration, 180);
    }
    const before = board.snapshot();
    const score = game.score;
    const moves = game.moves;
    if (frame.kind === 'clear') {
      for (const spool of board.snapshot().filter(spool => frame.rows.includes(spool.row))) {
        assert.equal(game.canBeginDrag(spool.id), false);
        assert.equal(game.beginDrag(spool.id), false);
      }
    } else {
      assert.equal(game.canBeginDrag(board.snapshot()[0].id), false);
      assert.equal(game.beginDrag(board.snapshot()[0].id), false);
    }
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
  assert.deepEqual([...kinds].sort(), ['clear', 'fall', 'insert', 'settle']);
  assert.equal(game.state, STATES.IDLE);
  assert.equal(game.score, 200);
  assert.equal(game.moves, 1);
});

test('survivors move on the live grid during clearing and each valid release queues exactly one serial insertion', { timeout: 3000 }, async () => {
  const { board, selected, other, harness } = clearInteractionFixture();
  const { game, frames } = harness;
  const { finished, clearing } = await startClearTurn(harness, selected);
  const capturedRow = [...board.grid[ROWS - 1]];
  const incoming = game.nextRow;
  const makeRow = board.makeRow.bind(board);
  let generated = 0;
  board.makeRow = () => {
    assert.equal(harness.pending, null, 'new previews wait for the preceding resolution');
    assert.deepEqual(board.fullRows(), []);
    generated += 1;
    return makeRow();
  };

  assert.equal(game.canBeginDrag(selected.id), true);
  assert.equal(game.canBeginDrag(other.id), true);
  assert.equal(game.canBeginDrag(99999), false);
  for (const id of new Set(capturedRow)) {
    assert.equal(game.canBeginDrag(id), false);
    assert.equal(game.beginDrag(id), false);
  }
  assert.equal(game.beginDrag(selected.id), true);
  assert.equal(game.drag.duringClear, true);
  assert.equal(game.state, STATES.CLEARING);
  assert.equal(game.canBeginDrag(other.id), false, 'only one spool can be held');
  assert.equal(game.beginDrag(other.id), false);
  assert.equal(game.moveDrag(100), true);
  assert.equal(board.getSpool(selected.id).col, 3, 'the next spool still blocks the drag');
  assert.equal(game.moveDrag(-100), true);
  assert.equal(board.getSpool(selected.id).col, 0, 'the board edge still clamps the drag');
  assert.equal(game.moveDrag(2), true);
  assert.equal(board.getSpool(selected.id).row, ROWS - 2, 'no gravity runs during a clear-time drag');
  assert.deepEqual(board.grid[ROWS - 1], capturedRow);
  assert.equal(clearing.frame.before.find(spool => spool.id === selected.id).col, 0,
    'moving a survivor cannot mutate the captured animation snapshot');
  assert.equal(await game.releaseDrag(), true, 'a nested release must return without launching another resolver');
  assert.equal(harness.pending, clearing.frame);
  assert.equal(game.pendingRows, 2);
  assert.equal(game.moves, 2);
  assert.equal(game.score, 0);
  assert.equal(game.state, STATES.CLEARING);
  assert.equal(game.canBeginDrag(selected.id), true);
  assert.equal(game.beginDrag(selected.id), true);
  assert.equal(game.moveDrag(1), true);
  assert.equal(await game.releaseDrag(), true);
  assert.equal(game.pendingRows, 3);
  assert.equal(game.moves, 3);
  assert.equal(game.nextRow, incoming);
  assert.equal(generated, 0);
  assert.equal(frames.length, 1, 'queued moves cannot start overlapping animations');
  board.assertValid();

  clearing.finish();
  assert.equal(await drainAnimations(harness, finished), true);
  assert.equal(frames.filter(frame => frame.kind === 'clear').length, 1);
  assert.equal(frames.filter(frame => frame.kind === 'settle').length, 3);
  assert.equal(frames.filter(frame => frame.kind === 'insert').length, 3);
  assert.equal(generated, 3, 'each inserted row is followed by a fresh stable-board preview');
  assert.equal(game.pendingRows, 0);
  assert.equal(game.moves, 3);
  assert.equal(game.score, 100);
  assert.equal(game.state, STATES.IDLE);
  board.assertValid();
});

test('clear-time taps, clamped moves, round trips, and cancellation add no queued rows', { timeout: 3000 }, async () => {
  const { board, selected, harness } = clearInteractionFixture();
  const { game, frames } = harness;
  const { finished, clearing } = await startClearTurn(harness, selected);
  const before = board.snapshot();
  for (const mode of ['tap', 'clamped', 'roundtrip', 'cancel']) {
    assert.equal(game.beginDrag(selected.id), true);
    if (mode === 'clamped') assert.equal(game.moveDrag(-20), false);
    if (mode === 'roundtrip' || mode === 'cancel') assert.equal(game.moveDrag(3), true);
    if (mode === 'roundtrip') assert.equal(game.moveDrag(0), true);
    if (mode === 'cancel') assert.equal(game.cancelDrag(), true);
    else assert.equal(await game.releaseDrag(), false);
    assert.deepEqual(board.snapshot(), before, mode);
    assert.equal(game.drag, null);
    assert.equal(game.pendingRows, 1);
    assert.equal(game.moves, 1);
    assert.equal(game.state, STATES.CLEARING);
    assert.equal(game.canBeginDrag(selected.id), true, 'the ongoing clear stays open after a no-op');
    assert.equal(harness.pending, clearing.frame);
  }
  clearing.finish();
  assert.equal(await drainAnimations(harness, finished), true);
  assert.equal(frames.filter(frame => frame.kind === 'insert').length, 1);
  assert.equal(game.pendingRows, 0);
  assert.equal(game.moves, 1);
  board.assertValid();
});

test('a held survivor outlasts the clear deadline while deletion and scoring finish on schedule', async t => {
  for (const mode of ['valid release', 'no-op release', 'cancel']) {
    await t.test(mode, { timeout: 3000 }, async () => {
      const { board, selected, other, harness } = clearInteractionFixture();
      const { game, frames } = harness;
      const { finished, clearing } = await startClearTurn(harness, selected);
      const capturedIds = new Set(board.grid[ROWS - 1]);
      const settle = board.settle.bind(board);
      let gravityPhases = 0;
      board.settle = () => { gravityPhases += 1; return settle(); };
      assert.equal(game.beginDrag(selected.id), true);
      assert.equal(game.moveDrag(2), true);
      clearing.finish();
      await flushMicrotasks();

      assert.ok([...capturedIds].every(id => board.getSpool(id) === null), 'the clear batch is removed at its deadline');
      assert.equal(game.score, 100, 'the score must not wait for the held pointer');
      assert.equal(game.state, STATES.CLEARING);
      assert.equal(game.drag.id, selected.id);
      assert.equal(board.getSpool(selected.id).row, ROWS - 2);
      assert.equal(board.getSpool(selected.id).col, 2);
      assert.equal(gravityPhases, 0);
      assert.equal(harness.pending, null, 'the ended clear is not extended as another animation');
      assert.equal(frames.length, 1);
      assert.equal(game.pendingRows, 1);
      assert.equal(game.canBeginDrag(other.id), false);
      assert.equal(game.beginDrag(other.id), false);
      assert.equal(game.reset(), false);
      assert.equal(game.moveDrag(3), true, 'the already-held drag remains controllable after the deadline');
      if (mode === 'cancel') {
        assert.equal(game.cancelDrag(), true);
        assert.equal(board.getSpool(selected.id).col, 0);
      } else {
        if (mode === 'no-op release') assert.equal(game.moveDrag(0), true);
        assert.equal(await game.releaseDrag(), mode === 'valid release');
      }
      assert.equal(game.canBeginDrag(other.id), false, 'the expired clear window cannot acquire another drag');
      assert.equal(game.beginDrag(other.id), false);
      assert.equal(await drainAnimations(harness, finished), true);
      const expectedMoves = mode === 'valid release' ? 2 : 1;
      assert.equal(frames.filter(frame => frame.kind === 'insert').length, expectedMoves);
      assert.equal(game.moves, expectedMoves);
      assert.equal(game.score, 100);
      assert.equal(game.pendingRows, 0);
      assert.equal(game.state, STATES.IDLE);
      assert.ok(gravityPhases > 0);
      board.assertValid();
    });
  }
});

test('steering a surviving spool during clearing can create the next chain without restarting its score multiplier', { timeout: 3000 }, async () => {
  const { board, selected } = threeChainFixture();
  const harness = gatedGame(board);
  const { game, frames, clears } = harness;
  board.makeRow = () => NEXT_ROW.map(spool => ({ ...spool }));
  const { finished, clearing } = await startClearTurn(harness, selected, 6);
  assert.equal(game.beginDrag(selected.id), true);
  assert.equal(game.moveDrag(5), true);
  assert.equal(await game.releaseDrag(), true);
  assert.equal(game.score, 0);
  assert.equal(game.pendingRows, 2);
  clearing.finish();
  assert.equal(await drainAnimations(harness, finished), true);
  assert.deepEqual(clears, [
    { rows: [ROWS - 3], chain: 1, points: 100 },
    { rows: [ROWS - 2], chain: 2, points: 150 },
    { rows: [ROWS - 1], chain: 3, points: 200 },
  ]);
  const firstInsertion = frames.findIndex(frame => frame.kind === 'insert');
  assert.equal(frames.slice(0, firstInsertion).filter(frame => frame.kind === 'clear').length, 3);
  assert.equal(frames.filter(frame => frame.kind === 'insert').length, 2);
  assert.equal(game.score, 450);
  assert.equal(game.moves, 2);
  assert.equal(game.pendingRows, 0);
  assert.equal(game.state, STATES.IDLE);
  board.assertValid();
});

test('a drag during a post-insertion clear keeps the existing resolver alive for its queued row', { timeout: 3000 }, async () => {
  const { board, selected, nextRow } = bothResolutionFixture();
  const survivor = add(board, ROWS - 3, 0, 1);
  const harness = gatedGame(board);
  const { game, frames, clears } = harness;
  game.nextRow = nextRow;
  board.makeRow = () => NEXT_ROW.map(spool => ({ ...spool }));
  assert.equal(game.beginDrag(selected.id), true);
  assert.equal(game.moveDrag(7), true);
  const finished = game.releaseDrag();
  let queued = false;
  assert.equal(await drainAnimations(harness, finished, async frame => {
    if (frame.kind !== 'clear' || clears.length !== 2) return;
    assert.equal(frames.filter(value => value.kind === 'insert').length, 1);
    assert.equal(game.pendingRows, 0, 'the original insertion has already been consumed');
    assert.equal(game.score, 100);
    assert.equal(game.canBeginDrag(survivor.id), true);
    assert.equal(game.beginDrag(survivor.id), true);
    assert.equal(game.moveDrag(2), true);
    assert.equal(await game.releaseDrag(), true);
    assert.equal(game.pendingRows, 1);
    assert.equal(harness.pending, frame);
    queued = true;
  }), true);
  assert.equal(queued, true);
  assert.deepEqual(clears, [
    { rows: [ROWS - 2], chain: 1, points: 100 },
    { rows: [ROWS - 1], chain: 1, points: 100 },
  ]);
  assert.equal(frames.filter(frame => frame.kind === 'insert').length, 2);
  assert.equal(frames.filter(frame => frame.kind === 'settle').length, 2);
  assert.equal(game.moves, 2);
  assert.equal(game.score, 200);
  assert.equal(game.pendingRows, 0);
  assert.equal(game.state, STATES.IDLE);
  board.assertValid();
});

test('overflow after an earlier queued insertion aborts all remaining rows and allows a clean reset', { timeout: 3000 }, async () => {
  const board = new Board();
  for (let row = 0; row < ROWS - 1; row += 1) add(board, row, 0, 1);
  add(board, ROWS - 1, 0, 4);
  add(board, ROWS - 1, 4, 5);
  const selected = add(board, ROWS - 2, 4, 1);
  const harness = gatedGame(board);
  const { game, frames } = harness;
  board.makeRow = () => NEXT_ROW.map(spool => ({ ...spool }));
  const { finished, clearing } = await startClearTurn(harness, selected, 5);
  for (const col of [6, 7]) {
    assert.equal(game.beginDrag(selected.id), true);
    assert.equal(game.moveDrag(col), true);
    assert.equal(await game.releaseDrag(), true);
  }
  assert.equal(game.pendingRows, 3);
  clearing.finish();
  assert.equal(await drainAnimations(harness, finished), true);
  assert.equal(frames.filter(frame => frame.kind === 'insert').length, 1);
  assert.equal(frames.filter(frame => frame.kind === 'settle').length, 1, 'overflow is checked before the next pause');
  assert.equal(game.pendingRows, 0);
  assert.equal(game.moves, 3);
  assert.equal(game.score, 100);
  assert.equal(game.state, STATES.GAME_OVER);
  assert.ok(board.grid[0].some(id => id !== null));
  assert.equal(game.canBeginDrag(selected.id), false);
  assert.equal(game.beginDrag(selected.id), false);
  const finalBoard = board.snapshot();
  await flushMicrotasks();
  assert.deepEqual(board.snapshot(), finalBoard);
  board.assertValid();
  assert.equal(game.reset(), true);
  assert.equal(game.pendingRows, 0);
  assert.equal(game.moves, 0);
  assert.equal(game.score, 0);
  assert.equal(game.drag, null);
  assert.equal(game.state, STATES.IDLE);
  board.assertValid();
});

test('top overflow ends the turn before insertion or post-insertion gravity can hide it', async () => {
  const board = new Board();
  const top = add(board, 0, 0, 1);
  for (let row = 1; row < ROWS; row += 1) add(board, row, 0, 1);
  const selected = add(board, ROWS - 1, 3, 1);
  const { game, frames, clears } = captureGame(board);
  assert.equal(await turn(game, selected.id, 4), true);
  assert.equal(game.state, STATES.GAME_OVER);
  assert.equal(game.moves, 1);
  assert.equal(game.score, 0);
  assert.equal(board.getSpool(top.id).row, 0);
  assert.equal(board.spools.size, ROWS + 1);
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
  const falls = frames.slice(0, insertIndex).filter(frame => frame.kind === 'fall');
  assert.equal(falls.length, 1, 'a long drop is one uninterrupted animation');
  assert.deepEqual(falls[0].moved, [{ id: selected.id, fromRow: 0, toRow: ROWS - 1 }]);
  assert.equal(falls[0].maxDrop, ROWS - 1);
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

test('long spools cannot accumulate across real turns, resets, and queued previews', async () => {
  let turns = 0;
  let insertedLongs = 0;
  let clearedLongs = 0;
  const countLongs = spools => spools.filter(spool => spool.length === 5).length;
  for (let seed = 1; seed <= 100; seed += 1) {
    let state = seed;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    const board = new Board({ random });
    let incoming = null;
    const game = new Game({
      board,
      onChange: current => {
        if (current.state === STATES.IDLE || current.state === STATES.DRAGGING) {
          assert.ok(countLongs(board.snapshot()) + countLongs(current.nextRow) <= 1,
            'the visible board and advertised next row share one long-spool allowance');
        }
      },
      onClear: ({ rows }) => {
        clearedLongs += countLongs(board.snapshot().filter(spool => rows.includes(spool.row)));
      },
      animate: async frame => {
        assert.ok(countLongs(frame.before) <= 1);
        assert.ok(countLongs(frame.after) <= 1);
        assert.equal(game.nextRow, incoming, 'a committed preview stays fixed throughout resolution');
        if (frame.kind === 'insert') {
          const oldIds = new Set(frame.before.map(spool => spool.id));
          const inserted = frame.after.filter(spool => !oldIds.has(spool.id));
          assert.deepEqual(inserted.map(({ col, length, color }) => ({ col, length, color })), incoming);
          insertedLongs += countLongs(inserted);
        }
      },
    });
    assert.equal(game.reset(), true);
    for (let move = 0; move < 60 && game.state === STATES.IDLE; move += 1) {
      const choices = board.snapshot().flatMap(spool => {
        const bounds = board.dragBounds(spool.id);
        return [bounds.min, bounds.max].filter(col => col !== spool.col).map(col => ({ id: spool.id, col }));
      });
      if (!choices.length) break;
      const selected = choices[Math.floor(random() * choices.length)];
      incoming = game.nextRow;
      assert.equal(await turn(game, selected.id, selected.col), true);
      board.assertValid();
      turns += 1;
    }
    assert.equal(game.reset(), true, 'restarting must apply the same allowance');
  }
  assert.ok(turns > 1000, `exercised ${turns} complete turns`);
  assert.ok(insertedLongs > 0, 'length five remains a playable incoming piece');
  assert.ok(clearedLongs > 0, 'the run includes long-spool clearance and renewed eligibility');
});
