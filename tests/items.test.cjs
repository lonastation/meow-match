'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Board, COLS, ROWS } = require('../engine.js');
const { Game, STATES, ITEMS, ITEM_USES } = require('../game.js');

const NEXT_ROW = Object.freeze([
  Object.freeze({ col: 0, length: 2, color: '#a8caa5' }),
  Object.freeze({ col: 6, length: 2, color: '#a6c8df' }),
]);

function add(board, row, col, length, color = '#f59ba7') {
  return board.addSpool({ row, col, length, color });
}

function emptyBoard(board) {
  while (board.spools.size > 0) board.removeRandomColor();
}

function captureGame(board) {
  const frames = [];
  const clears = [];
  const game = new Game({
    board,
    animate: async frame => { frames.push(frame); },
    onClear: event => { clears.push(event); },
  });
  game.nextRow = NEXT_ROW;
  return { game, frames, clears };
}

function gatedGame(board) {
  const frames = [];
  const clears = [];
  const queue = [];
  let waiter = null;
  let pending = null;
  const game = new Game({
    board,
    onClear: event => { clears.push(event); },
    animate: frame => new Promise(resolve => {
      assert.equal(pending, null, 'item and slide resolutions must not overlap');
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
      if (waiter) { const deliver = waiter; waiter = null; deliver(step); }
      else queue.push(step);
    }),
  });
  game.nextRow = NEXT_ROW;
  return {
    game, frames, clears,
    nextFrame() {
      return queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => { waiter = resolve; });
    },
  };
}

async function drain(harness, result) {
  const completed = result.then(value => ({ completed: true, value }));
  let count = 0;
  while (true) {
    const step = await Promise.race([harness.nextFrame(), completed]);
    if (step.completed) return step.value;
    assert.ok(++count < 100, 'an item must finish within finite sequential animations');
    step.finish();
  }
}

test('item availability reflects eligibility and rejects unknown item names without spending', async () => {
  assert.equal(ITEM_USES, 3);
  assert.deepEqual(ITEMS, { CUTTER: 'cutter', COLOR: 'color', FILL: 'fill' });
  const board = new Board({ random: () => 0 });
  const { game, frames } = captureGame(board);
  assert.deepEqual(game.items, { cutter: 3, color: 3, fill: 3 });
  assert.equal(game.canUseItem(ITEMS.CUTTER), false);
  assert.equal(game.canUseItem(ITEMS.COLOR), false);
  assert.equal(game.canUseItem(ITEMS.FILL), true);
  for (const item of [undefined, null, '', 'unknown', 'toString', '__proto__', ITEMS.CUTTER, ITEMS.COLOR]) {
    assert.equal(game.canUseItem(item), false);
    assert.equal(await game.useItem(item), false);
  }
  for (const [col, length] of [[0, 1], [1, 2], [3, 5]]) add(board, ROWS - 1, col, length);
  assert.equal(game.canUseItem(ITEMS.CUTTER), false, 'one-, two-, and five-cell spools cannot be cut');
  assert.equal(game.canUseItem(ITEMS.COLOR), true);
  const before = board.snapshot();
  assert.equal(await game.useItem(ITEMS.CUTTER), false);
  assert.deepEqual(board.snapshot(), before, 'a board with no eligible spool is unchanged');
  assert.deepEqual(game.items, { cutter: 3, color: 3, fill: 3 });
  assert.deepEqual(frames, []);
  assert.equal(game.moves, 0);
  assert.equal(game.nextRow, NEXT_ROW);
  add(board, ROWS - 2, 0, 3);
  assert.equal(game.canUseItem(ITEMS.CUTTER), true);
  board.assertValid();
});

test('a full board has no fill target and an attempted fill does not consume a use or resolve it', async () => {
  const board = new Board();
  for (let row = 0; row < ROWS; row += 1) {
    add(board, row, 0, 4);
    add(board, row, 4, COLS - 4);
  }
  const { game, frames } = captureGame(board);
  const before = board.snapshot();
  assert.equal(game.canUseItem(ITEMS.FILL), false);
  assert.equal(await game.useItem(ITEMS.FILL), false);
  assert.equal(game.items.fill, 3);
  assert.equal(game.score, 0);
  assert.deepEqual(board.snapshot(), before);
  assert.deepEqual(frames, []);
  board.assertValid();
});

test('each cutter size creates the specified independent pieces and adds no move or incoming row', async () => {
  for (const [length, expected] of [[3, [1, 1, 1]], [4, [2, 2]]]) {
    const board = new Board();
    const target = add(board, ROWS - 1, 2, length, '#c5b1e0');
    const { game, frames, clears } = captureGame(board);
    assert.equal(await game.useItem(ITEMS.CUTTER), true);
    assert.equal(board.getSpool(target.id), null);
    const pieces = board.snapshot().sort((a, b) => a.col - b.col);
    assert.deepEqual(pieces.map(spool => spool.length), expected);
    assert.equal(new Set(pieces.map(spool => spool.id)).size, expected.length);
    assert.ok(pieces.every(spool => spool.color === target.color && spool.row === ROWS - 1));
    assert.equal(pieces[0].col, 2);
    assert.equal(pieces.at(-1).col + pieces.at(-1).length, 2 + length);
    assert.deepEqual(game.items, { cutter: 2, color: 3, fill: 3 });
    assert.equal(game.score, 0);
    assert.equal(game.moves, 0);
    assert.equal(game.pendingRows, 0);
    assert.equal(game.nextRow, NEXT_ROW);
    assert.equal(game.state, STATES.IDLE);
    assert.deepEqual(frames, []);
    assert.deepEqual(clears, []);
    board.assertValid();
  }
});

test('one cutter use splits every eligible spool before gravity while preserving other lengths and colors', async () => {
  const board = new Board();
  const untouched = [
    add(board, ROWS - 1, 0, 5, '#a8caa5'),
    add(board, ROWS - 1, 6, 2, '#a6c8df'),
    add(board, ROWS - 1, 8, 1, '#c5b1e0'),
    add(board, ROWS - 2, 4, 1, '#f4c776'),
  ].map(spool => ({ ...spool }));
  const targets = [
    add(board, ROWS - 2, 0, 3, '#f59ba7'),
    add(board, ROWS - 2, 5, 4, '#c5b1e0'),
    add(board, ROWS - 3, 0, 4, '#a8caa5'),
    add(board, ROWS - 3, 5, 3, '#a6c8df'),
  ];
  const expected = targets.flatMap(spool => (spool.length === 3 ? [0, 1, 2] : [0, 2]).map(offset => ({
    row: spool.row, col: spool.col + offset, length: spool.length === 3 ? 1 : 2, color: spool.color,
  })));
  const untouchedIds = new Set(untouched.map(spool => spool.id));
  const { game, frames, clears } = captureGame(board);
  const settle = board.settle.bind(board);
  let gravityCalls = 0;
  board.settle = () => {
    gravityCalls += 1;
    assert.ok(targets.every(spool => board.getSpool(spool.id) === null), 'all original long spools must be replaced before the first gravity step');
    const replacements = board.snapshot().filter(spool => !untouchedIds.has(spool.id));
    assert.deepEqual(replacements.map(({ row, col, length, color }) => ({ row, col, length, color })), expected);
    assert.equal(new Set(replacements.map(spool => spool.id)).size, expected.length, 'every cut piece remains independent');
    for (const spool of untouched) assert.deepEqual(board.getSpool(spool.id), spool);
    return settle();
  };
  assert.equal(await game.useItem(ITEMS.CUTTER), true);
  assert.equal(gravityCalls, 1, 'the whole batch resolves once');
  assert.equal(game.canUseItem(ITEMS.CUTTER), false);
  assert.deepEqual(game.items, { cutter: 2, color: 3, fill: 3 });
  assert.equal(game.moves, 0);
  assert.equal(game.pendingRows, 0);
  assert.equal(game.score, 0);
  assert.equal(game.nextRow, NEXT_ROW);
  assert.equal(game.state, STATES.IDLE);
  assert.deepEqual(frames, []);
  assert.deepEqual(clears, []);
  assert.equal(await game.useItem(ITEMS.CUTTER), false, 'using the cutter again without eligible spools is free');
  assert.equal(game.items.cutter, 2);
  assert.equal(gravityCalls, 1);
  board.assertValid();
});

test('color removal clears every matching spool and resolves falling survivors without awarding clear points', async () => {
  const board = new Board({ random: () => 0 });
  const removed = [add(board, ROWS - 1, 0, 3, '#red'), add(board, ROWS - 1, 5, 4, '#red')];
  const survivor = add(board, ROWS - 2, 1, 2, '#blue');
  const { game, frames, clears } = captureGame(board);
  assert.equal(await game.useItem(ITEMS.COLOR), true);
  assert.ok(removed.every(spool => board.getSpool(spool.id) === null));
  assert.deepEqual(board.snapshot(), [{ ...survivor, row: ROWS - 1 }]);
  assert.ok(frames.some(frame => frame.kind === 'fall'));
  assert.ok(frames.every(frame => frame.kind !== 'insert' && frame.kind !== 'settle'));
  assert.deepEqual(clears, []);
  assert.equal(game.score, 0, 'item removal itself is not a full-row clear');
  assert.equal(game.moves, 0);
  assert.equal(game.pendingRows, 0);
  assert.equal(game.nextRow, NEXT_ROW);
  assert.equal(game.state, STATES.IDLE);
  assert.deepEqual(game.items, { cutter: 3, color: 2, fill: 3 });
  board.assertValid();
});

test('filling an empty board adds five unit spools, settles them, and preserves the advertised row', async () => {
  const board = new Board({ random: () => 0 });
  const { game, frames, clears } = captureGame(board);
  assert.equal(await game.useItem(ITEMS.FILL), true);
  assert.equal(board.spools.size, 5);
  assert.ok(board.snapshot().every(spool => spool.length === 1));
  const beforeSettlingAgain = board.snapshot();
  board.settle();
  assert.deepEqual(board.snapshot(), beforeSettlingAgain, 'item resolution settles the complete board');
  assert.equal(game.moves, 0);
  assert.equal(game.pendingRows, 0);
  assert.equal(game.score, 0);
  assert.equal(game.nextRow, NEXT_ROW);
  assert.ok(frames.every(frame => frame.kind !== 'insert' && frame.kind !== 'settle'));
  assert.deepEqual(clears, []);
  assert.equal(game.state, STATES.IDLE);
  assert.deepEqual(game.items, { cutter: 3, color: 3, fill: 2 });
  board.assertValid();
});

test('all item uses are rejected during dragging, resolution, insertion, clearing, and game over', async () => {
  const board = new Board();
  const target = add(board, ROWS - 1, 1, 3);
  const { game, frames } = captureGame(board);
  assert.equal(game.beginDrag(target.id), true);
  const before = board.snapshot();
  for (const item of Object.values(ITEMS)) {
    assert.equal(game.canUseItem(item), false);
    assert.equal(await game.useItem(item), false);
  }
  game.setState(STATES.IDLE);
  assert.equal(game.canUseItem(ITEMS.CUTTER), false, 'a held drag also blocks use independently of state');
  assert.equal(await game.useItem(ITEMS.CUTTER), false);
  assert.equal(game.cancelDrag(), true);
  for (const state of [STATES.DRAGGING, STATES.RESOLVING, STATES.INSERTING_ROW, STATES.CLEARING, STATES.GAME_OVER]) {
    game.setState(state);
    assert.equal(game.drag, null, 'state alone must block an item without a held gesture');
    for (const item of Object.values(ITEMS)) {
      assert.equal(game.canUseItem(item), false, `${item} must be unavailable in ${state}`);
      assert.equal(await game.useItem(item), false);
    }
  }
  assert.deepEqual(board.snapshot(), before);
  assert.deepEqual(game.items, { cutter: 3, color: 3, fill: 3 });
  assert.deepEqual(frames, []);
});

test('a successful item spends its charge and locks input before any asynchronous work', async () => {
  const board = new Board();
  add(board, 3, 0, 3);
  const other = add(board, ROWS - 1, 5, 2);
  const harness = gatedGame(board);
  const { game } = harness;
  const finished = game.useItem(ITEMS.CUTTER);
  assert.equal(game.state, STATES.RESOLVING);
  assert.deepEqual(game.items, { cutter: 2, color: 3, fill: 3 });
  const firstFrame = await harness.nextFrame();
  assert.equal(firstFrame.frame.kind, 'fall');
  const before = board.snapshot();
  for (const item of Object.values(ITEMS)) {
    assert.equal(game.canUseItem(item), false);
    assert.equal(await game.useItem(item), false);
  }
  assert.equal(game.reset(), false, 'a pending item cannot be reset to refund its charge');
  assert.equal(game.beginDrag(other.id), false);
  assert.deepEqual(board.snapshot(), before);
  assert.deepEqual(game.items, { cutter: 2, color: 3, fill: 3 });
  firstFrame.finish();
  assert.equal(await drain(harness, finished), true);
  assert.equal(game.state, STATES.IDLE);
  assert.equal(game.nextRow, NEXT_ROW);
  board.assertValid();
});

test('each item has exactly three independent uses and an exhausted item cannot mutate an eligible board', async () => {
  for (const item of Object.values(ITEMS)) {
    const board = new Board({ random: () => 0 });
    const { game } = captureGame(board);
    for (let use = 1; use <= ITEM_USES; use += 1) {
      emptyBoard(board);
      add(board, ROWS - 1, 0, 3);
      assert.equal(game.canUseItem(item), true);
      assert.equal(await game.useItem(item), true);
      for (const key of Object.values(ITEMS)) assert.equal(game.items[key], key === item ? ITEM_USES - use : ITEM_USES);
    }
    emptyBoard(board);
    add(board, ROWS - 1, 0, 3);
    const before = board.snapshot();
    assert.equal(game.canUseItem(item), false);
    assert.equal(await game.useItem(item), false);
    assert.deepEqual(board.snapshot(), before);
    assert.equal(game.items[item], 0);
    assert.equal(game.moves, 0);
    assert.equal(game.nextRow, NEXT_ROW);
    for (const key of Object.values(ITEMS).filter(key => key !== item)) assert.equal(game.canUseItem(key), true);
    board.assertValid();
  }
});

test('restart restores every item allowance from idle and game over', async () => {
  for (const state of [STATES.IDLE, STATES.GAME_OVER]) {
    const board = new Board({ random: () => 0 });
    const { game } = captureGame(board);
    for (const item of Object.values(ITEMS)) {
      emptyBoard(board);
      add(board, ROWS - 1, 0, 3);
      assert.equal(await game.useItem(item), true);
    }
    assert.deepEqual(game.items, { cutter: 2, color: 2, fill: 2 });
    game.setState(state);
    assert.equal(game.reset(), true);
    assert.deepEqual(game.items, { cutter: 3, color: 3, fill: 3 });
    assert.equal(game.state, STATES.IDLE);
    assert.equal(game.score, 0);
    assert.equal(game.moves, 0);
    board.assertValid();
  }
});

test('a color item resolves a three-step chain at 100, 150, and 200 points without inserting a row', async () => {
  const board = new Board({ random: () => 0 });
  add(board, 0, 0, 1, '#a6c8df');
  add(board, ROWS - 1, 0, 1);
  add(board, ROWS - 1, 4, 1);
  add(board, ROWS - 1, 8, 1);
  add(board, ROWS - 2, 0, 4);
  add(board, ROWS - 2, 4, 1);
  add(board, ROWS - 3, 0, 4);
  add(board, ROWS - 3, 4, 5);
  add(board, ROWS - 4, 1, 3);
  add(board, ROWS - 4, 5, 4);
  add(board, ROWS - 5, 5, 3);
  const { game, frames, clears } = captureGame(board);
  assert.equal(await game.useItem(ITEMS.COLOR), true);
  assert.deepEqual(clears, [
    { rows: [ROWS - 3], chain: 1, points: 100 },
    { rows: [ROWS - 2], chain: 2, points: 150 },
    { rows: [ROWS - 1], chain: 3, points: 200 },
  ]);
  assert.equal(game.score, 450);
  assert.equal(game.moves, 0);
  assert.equal(game.pendingRows, 0);
  assert.equal(game.nextRow, NEXT_ROW);
  assert.equal(game.state, STATES.IDLE);
  assert.equal(board.spools.size, 0);
  assert.deepEqual(game.items, { cutter: 3, color: 2, fill: 3 });
  assert.ok(frames.every(frame => frame.kind !== 'insert' && frame.kind !== 'settle'));
  board.assertValid();
});

test('a survivor slide during an item clear queues exactly one row in the same resolver', async () => {
  const board = new Board();
  add(board, ROWS - 1, 0, 4);
  add(board, ROWS - 1, 4, 5);
  add(board, ROWS - 2, 1, 3);
  const survivor = add(board, ROWS - 2, 6, 2);
  const harness = gatedGame(board);
  const { game, frames, clears } = harness;
  board.makeRow = () => NEXT_ROW.map(spool => ({ ...spool }));
  const finished = game.useItem(ITEMS.CUTTER);
  const clearing = await harness.nextFrame();
  assert.equal(clearing.frame.kind, 'clear');
  assert.equal(game.state, STATES.CLEARING);
  assert.equal(game.beginDrag(survivor.id), true);
  assert.equal(game.moveDrag(5), true);
  for (const item of Object.values(ITEMS)) assert.equal(await game.useItem(item), false);
  assert.equal(await game.releaseDrag(), true);
  assert.equal(game.pendingRows, 1);
  assert.equal(game.moves, 1);
  assert.equal(frames.length, 1, 'the survivor slide cannot launch a second resolver');
  clearing.finish();
  assert.equal(await drain(harness, finished), true);
  assert.equal(frames.filter(frame => frame.kind === 'insert').length, 1);
  assert.equal(frames.filter(frame => frame.kind === 'settle').length, 1);
  assert.deepEqual(clears, [{ rows: [ROWS - 1], chain: 1, points: 100 }]);
  assert.equal(game.score, 100);
  assert.equal(game.moves, 1);
  assert.equal(game.pendingRows, 0);
  assert.equal(game.state, STATES.IDLE);
  assert.notEqual(game.nextRow, NEXT_ROW, 'only the queued player move advances the preview');
  assert.deepEqual(game.items, { cutter: 2, color: 3, fill: 3 });
  board.assertValid();
});
