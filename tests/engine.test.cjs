'use strict';

// Run without installing dependencies: node --test tests/engine.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { Board, COLS, ROWS } = require('../engine.js');

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function add(board, row, col, length, color = '#df8f7d') {
  return board.addSpool({ row, col, length, color });
}

// Check both directions of the authoritative cell-to-spool mapping.
function checkBoard(board) {
  assert.equal(board.grid.length, ROWS);
  assert.equal(board.spools instanceof Map, true);
  const counts = new Map();
  for (let row = 0; row < ROWS; row += 1) {
    assert.equal(board.grid[row].length, 9);
    for (let col = 0; col < 9; col += 1) {
      const id = board.grid[row][col];
      if (id === null) continue;
      const spool = board.getSpool(id);
      assert.ok(spool, `cell ${row},${col} references missing spool`);
      assert.equal(spool.row, row);
      assert.ok(col >= spool.col && col < spool.col + spool.length);
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  for (const [id, spool] of board.spools) {
    assert.equal(spool.id, id);
    assert.ok(Number.isInteger(spool.length) && spool.length >= 1 && spool.length <= 5);
    assert.ok(Number.isInteger(spool.row) && spool.row >= 0 && spool.row < ROWS);
    assert.ok(Number.isInteger(spool.col) && spool.col >= 0 && spool.col + spool.length <= 9);
    assert.equal(counts.get(id), spool.length);
    for (let col = spool.col; col < spool.col + spool.length; col += 1) {
      assert.equal(board.grid[spool.row][col], id);
    }
  }
  board.assertValid();
}

function isStable(board) {
  return board.snapshot().every(spool => spool.row === ROWS - 1 ||
    board.grid[spool.row + 1].slice(spool.col, spool.col + spool.length).some(id => id !== null));
}

function resolveRows(board) {
  const waves = [];
  let rows = board.fullRows();
  while (rows.length > 0) {
    assert.ok(waves.length < ROWS, 'row resolution must terminate');
    waves.push(rows.length);
    board.clearRows(rows);
    board.settle();
    checkBoard(board);
    rows = board.fullRows();
  }
  return waves;
}

function checkNewRow(specs) {
  assert.ok(specs.length >= 2, 'a new row contains several independent spools');
  assert.ok(specs.length <= 3, 'new rows use a few substantial spools');
  assert.ok(specs.filter(spec => spec.length === 1).length <= 1, 'a new row has at most one singleton');
  const cells = new Array(9).fill(false);
  let occupied = 0;
  for (const spec of specs) {
    assert.ok(Number.isInteger(spec.length) && spec.length >= 1 && spec.length <= 5);
    assert.ok(Number.isInteger(spec.col) && spec.col >= 0 && spec.col + spec.length <= 9);
    for (let col = spec.col; col < spec.col + spec.length; col += 1) {
      assert.equal(cells[col], false, 'generated spools cannot overlap');
      cells[col] = true;
      occupied += 1;
    }
  }
  assert.ok(occupied >= 4 && occupied <= 8);
  assert.ok(cells.includes(false));
}

test('the empty board is exactly 9 columns by 12 rows', () => {
  assert.equal(COLS, 9);
  assert.equal(ROWS, 12);
  const board = new Board();
  checkBoard(board);
  assert.equal(board.spools.size, 0);
  assert.ok(board.grid.every(row => row.every(id => id === null)));
});

test('new games and restarts contain exactly three sparse, stable rows and allow a horizontal move', () => {
  const layouts = new Set();
  const lengths = new Set();
  for (let seed = 1; seed <= 250; seed += 1) {
    const board = new Board({ random: seededRandom(seed) });
    for (let restart = 0; restart < 2; restart += 1) {
      board.reset();
      checkBoard(board);
      assert.ok(board.spools.size >= 2);
      assert.ok(board.snapshot().filter(spool => spool.length === 4).length <= 1,
        `opening board permits at most one length-four spool: seed ${seed}, restart ${restart}`);
      assert.ok(board.snapshot().filter(spool => spool.length === 5).length <= 1,
        `opening board permits at most one length-five spool: seed ${seed}, restart ${restart}`);
      const occupiedRows = board.grid.flatMap((cells, row) => cells.some(id => id !== null) ? [row] : []);
      assert.deepEqual(occupiedRows, [ROWS - 3, ROWS - 2, ROWS - 1], `seed ${seed}, restart ${restart}`);
      assert.ok(board.grid.slice(0, ROWS - 3).every(row => row.every(id => id === null)));
      assert.ok(board.grid.slice(ROWS - 3).every(row => row.includes(null)));
      assert.equal(isStable(board), true);
      assert.deepEqual(board.fullRows(), []);
      assert.ok(board.snapshot().some(spool => {
        const { min, max } = board.dragBounds(spool.id);
        return min < spool.col || max > spool.col;
      }), 'initial board should give the player a valid move');
      for (const spool of board.spools.values()) lengths.add(spool.length);
      layouts.add(JSON.stringify(board.snapshot().map(({ row, col, length }) => [row, col, length])));

      if (restart === 0) {
        // Grow the board before restarting, so the next reset must remove old
        // spools above the three opening rows as well as generate a fresh layout.
        assert.equal(board.insertRow(board.makeRow()).overflow, false);
        assert.ok(board.grid[ROWS - 4].some(id => id !== null));
        checkBoard(board);
      }
    }
  }
  assert.ok(layouts.size > 200, 'seeded initial boards should vary');
  assert.deepEqual([...lengths].sort(), [1, 2, 3, 4, 5]);
});

test('invalid spool placement fails without corrupting the existing board', () => {
  const board = new Board();
  add(board, 5, 3, 3);
  const before = board.snapshot();
  for (const spec of [
    { row: 5, col: 4, length: 1 },
    { row: 5, col: -1, length: 2 },
    { row: 5, col: 7, length: 3 },
    { row: -1, col: 0, length: 1 },
    { row: ROWS, col: 0, length: 1 },
    { row: 0, col: 0, length: 0 },
    { row: 0, col: 0, length: 6 },
    { row: 0, col: 0, length: 1.5 },
  ]) {
    assert.throws(() => board.addSpool({ ...spec, color: '#df8f7d' }));
    assert.deepEqual(board.snapshot(), before);
    checkBoard(board);
  }
});

test('dragging is horizontal and clamps to adjacent blockers and board edges', () => {
  const board = new Board();
  add(board, 8, 0, 2);
  const moving = add(board, 8, 3, 2);
  add(board, 8, 7, 2);
  const otherRow = add(board, 9, 4, 2);
  assert.deepEqual(board.dragBounds(moving.id), { min: 2, max: 5 });
  assert.equal(board.moveSpool(moving.id, 100), true);
  assert.equal(board.getSpool(moving.id).col, 5);
  assert.equal(board.getSpool(moving.id).row, 8);
  assert.equal(board.moveSpool(moving.id, 100), false);
  assert.equal(board.moveSpool(moving.id, -100), true);
  assert.equal(board.getSpool(moving.id).col, 2);
  assert.equal(board.getSpool(otherRow.id).row, 9);
  assert.equal(board.getSpool(otherRow.id).col, 4);
  checkBoard(board);

  const open = new Board();
  const spool = add(open, 3, 3, 5);
  assert.deepEqual(open.dragBounds(spool.id), { min: 0, max: 4 });
  open.moveSpool(spool.id, -100);
  assert.equal(open.getSpool(spool.id).col, 0);
  open.moveSpool(spool.id, 100);
  assert.equal(open.getSpool(spool.id).col, 4);
  checkBoard(open);
});

test('a large pointer jump cannot teleport a spool through a blocker', () => {
  const board = new Board();
  const moving = add(board, 7, 0, 2);
  add(board, 7, 3, 1);
  board.moveSpool(moving.id, 7);
  assert.equal(board.getSpool(moving.id).col, 1);
  checkBoard(board);
});

test('one occupied cell below blocks an entire rigid spool, including its overhang', () => {
  const board = new Board();
  const support = add(board, ROWS - 1, 4, 1);
  const overhang = add(board, ROWS - 2, 0, 5);
  assert.deepEqual(board.gravityStep(overhang.id), []);
  board.settle();
  assert.equal(board.getSpool(overhang.id).row, ROWS - 2);
  assert.equal(board.getSpool(overhang.id).length, 5);
  assert.equal(board.getSpool(support.id).row, ROWS - 1);
  checkBoard(board);
});

test('gravity advances bottom to top by one cell per step without changing spool shapes', () => {
  const board = new Board();
  const upper = add(board, ROWS - 4, 2, 4);
  const lower = add(board, ROWS - 3, 2, 4);
  assert.equal(board.gravityStep().length, 2);
  assert.equal(board.getSpool(lower.id).row, ROWS - 2);
  assert.equal(board.getSpool(upper.id).row, ROWS - 3);
  board.settle();
  assert.equal(board.getSpool(lower.id).row, ROWS - 1);
  assert.equal(board.getSpool(upper.id).row, ROWS - 2);
  assert.equal(board.spools.size, 2, 'adjacent same-color spools must not merge');
  assert.equal(board.getSpool(upper.id).length, 4);
  assert.equal(board.getSpool(lower.id).length, 4);
  checkBoard(board);
});

test('the optional single-spool gravity helper leaves other spools untouched', () => {
  const board = new Board();
  const selected = add(board, 2, 0, 3);
  const untouched = add(board, 4, 6, 2);
  board.settle(selected.id);
  assert.equal(board.getSpool(selected.id).row, ROWS - 1);
  assert.equal(board.getSpool(untouched.id).row, 4);
  checkBoard(board);
});

test('full rows clear every spool regardless of color and never cut another spool', () => {
  const board = new Board();
  const survivors = [add(board, ROWS - 6, 2, 5), add(board, ROWS - 3, 0, 1)];
  for (const row of [ROWS - 4, ROWS - 1]) {
    add(board, row, 0, 5, '#112233');
    add(board, row, 5, 3, '#aabbcc');
    add(board, row, 8, 1, '#112233');
  }
  assert.deepEqual(board.fullRows(), [ROWS - 4, ROWS - 1]);
  board.clearRows(board.fullRows());
  assert.equal(board.spools.size, 2);
  assert.deepEqual(board.snapshot().map(spool => spool.id).sort(), survivors.map(spool => spool.id).sort());
  assert.equal(board.getSpool(survivors[0].id).row, ROWS - 6, 'clearing itself does not teleport survivors');
  board.settle();
  assert.equal(board.getSpool(survivors[0].id).row, ROWS - 1);
  assert.equal(board.getSpool(survivors[0].id).length, 5);
  assert.deepEqual(board.fullRows(), []);
  checkBoard(board);
});

test('clearing a supported full row causes a second chain clear after rigid gravity', () => {
  const board = new Board();
  add(board, ROWS - 1, 0, 1);
  add(board, ROWS - 1, 4, 1);
  add(board, ROWS - 2, 0, 4);
  add(board, ROWS - 2, 4, 5);
  add(board, ROWS - 3, 1, 3);
  add(board, ROWS - 3, 5, 4);
  assert.equal(isStable(board), true);
  assert.deepEqual(board.fullRows(), [ROWS - 2]);
  assert.deepEqual(resolveRows(board), [1, 1]);
  assert.equal(board.spools.size, 0);
  checkBoard(board);
});

test('the cutter replaces a four with two pairs and a three with three independent singletons', () => {
  for (const [length, expectedLengths] of [[4, [2, 2]], [3, [1, 1, 1]]]) {
    const board = new Board();
    const original = add(board, 4, 2, length, '#123abc');
    const survivor = { ...add(board, ROWS - 1, 0, 2, '#456def') };
    const occupiedBefore = board.grid.flat().filter(id => id !== null).length;
    const nextId = board.nextId;
    const replacements = board.splitSpool(original.id);
    assert.equal(board.getSpool(original.id), null);
    assert.deepEqual(replacements.map(spool => spool.length), expectedLengths);
    assert.deepEqual(replacements.map(spool => spool.col), length === 4 ? [2, 4] : [2, 3, 4]);
    assert.ok(replacements.every(spool => spool.row === 4 && spool.color === original.color));
    assert.equal(new Set(replacements.map(spool => spool.id)).size, replacements.length);
    assert.ok(replacements.every(spool => spool.id >= nextId));
    assert.equal(board.grid.flat().filter(id => id !== null).length, occupiedBefore);
    assert.deepEqual(board.getSpool(survivor.id), survivor, 'cutting does not settle or change other spools');
    replacements[0].col = 99;
    assert.equal(board.getSpool(nextId).col, 2, 'returned snapshots cannot mutate the board');
    const last = replacements[replacements.length - 1];
    assert.equal(board.moveSpool(last.id, 8), true, 'cut pieces can move independently');
    checkBoard(board);
  }
});

test('cutting an ineligible or missing spool is a no-op', () => {
  const board = new Board();
  const singles = add(board, 7, 0, 1);
  const pair = add(board, 7, 2, 2);
  const five = add(board, 8, 1, 5);
  const before = board.snapshot();
  const gridBefore = board.grid.map(cells => cells.slice());
  const nextId = board.nextId;
  for (const id of [singles.id, pair.id, five.id, null, undefined, -1, 1000]) {
    assert.deepEqual(board.splitSpool(id), []);
    assert.deepEqual(board.snapshot(), before);
    assert.deepEqual(board.grid, gridBefore);
    assert.equal(board.nextId, nextId);
  }
  checkBoard(board);
});

test('the batch cutter splits every original three and four once while preserving cells and other lengths', () => {
  const board = new Board({ random: () => { throw new Error('cutting preserves existing colors'); } });
  const targets = [
    add(board, 0, 1, 3, '#first'),
    add(board, 3, 0, 4, '#second'),
    add(board, 3, 4, 3, '#third'),
    add(board, ROWS - 1, 5, 4, '#fourth'),
  ];
  const survivors = [add(board, 0, 8, 1), add(board, 6, 0, 2), add(board, 7, 2, 5)]
    .map(spool => ({ ...spool }));
  const occupancy = board.grid.map(row => row.map(id => id !== null));
  const nextId = board.nextId;
  const replacements = board.splitAllSpools();
  assert.equal(replacements.length, 10);
  assert.equal(new Set(replacements.map(spool => spool.id)).size, 10);
  assert.ok(replacements.every(spool => spool.id >= nextId && spool.length <= 2));
  assert.equal(board.spools.size, survivors.length + replacements.length);
  assert.equal(board.nextId, nextId + 10, 'the batch creates only the requested original-spool fragments');
  assert.deepEqual(board.grid.map(row => row.map(id => id !== null)), occupancy, 'cutting preserves every occupied position without settling');
  for (const target of targets) {
    assert.equal(board.getSpool(target.id), null);
    const pieces = replacements.filter(spool => spool.color === target.color);
    assert.deepEqual(pieces.map(spool => spool.length), target.length === 4 ? [2, 2] : [1, 1, 1]);
    assert.ok(pieces.every(spool => spool.row === target.row));
    assert.equal(pieces[0].col, target.col);
    assert.equal(pieces.at(-1).col + pieces.at(-1).length, target.col + target.length);
  }
  for (const survivor of survivors) assert.deepEqual(board.getSpool(survivor.id), survivor);
  replacements[0].col = 99;
  assert.notEqual(board.getSpool(replacements[0].id).col, 99, 'the returned replacements are detached snapshots');
  const after = board.snapshot();
  assert.deepEqual(board.splitAllSpools(), [], 'a second batch cannot reprocess the fragments');
  assert.deepEqual(board.snapshot(), after);
  assert.equal(board.nextId, nextId + 10);
  checkBoard(board);
});

test('the batch cutter is a no-op when there are no eligible spools', () => {
  const board = new Board({ random: () => { throw new Error('an empty cut does not need randomness'); } });
  assert.deepEqual(board.splitAllSpools(), []);
  assert.equal(board.nextId, 1);
  add(board, 2, 0, 1);
  add(board, 4, 1, 2);
  add(board, 9, 3, 5);
  const before = board.snapshot();
  const gridBefore = board.grid.map(row => row.slice());
  const nextId = board.nextId;
  assert.deepEqual(board.splitAllSpools(), []);
  assert.deepEqual(board.snapshot(), before);
  assert.deepEqual(board.grid, gridBefore);
  assert.equal(board.nextId, nextId);
  checkBoard(board);
});

test('the color item selects an existing color and removes every spool of that color without gravity', () => {
  for (const [random, expectedColor] of [[() => 0, '#first'], [() => 1 - Number.EPSILON, '#last']]) {
    const board = new Board({ random });
    add(board, 1, 0, 4, '#first');
    add(board, 3, 5, 3, '#last');
    add(board, ROWS - 1, 1, 2, '#first');
    add(board, ROWS - 1, 5, 4, '#last');
    const before = board.snapshot();
    const nextId = board.nextId;
    const result = board.removeRandomColor();
    assert.equal(result.color, expectedColor);
    assert.deepEqual(result.removed, before.filter(spool => spool.color === expectedColor));
    assert.deepEqual(board.snapshot(), before.filter(spool => spool.color !== expectedColor));
    assert.ok(result.removed.every(spool => board.getSpool(spool.id) === null));
    assert.equal(board.nextId, nextId);
    checkBoard(board);
    board.removeRandomColor();
    assert.equal(board.spools.size, 0);
    assert.equal(board.removeRandomColor(), null);
    checkBoard(board);
  }
  const empty = new Board({ random: () => { throw new Error('empty board should not sample a color'); } });
  assert.equal(empty.removeRandomColor(), null);
});

test('the filler completes supported rows before spending remaining cells elsewhere', () => {
  const board = new Board({ random: seededRandom(216) });
  add(board, ROWS - 1, 0, 3);
  add(board, ROWS - 1, 4, 4);
  add(board, ROWS - 2, 0, 5);
  add(board, ROWS - 2, 6, 2);
  const original = board.snapshot();
  const added = board.fillEmptySpaces();
  assert.equal(added.length, 5);
  assert.deepEqual(added.slice(0, 2).map(spool => spool.row), [ROWS - 1, ROWS - 1]);
  assert.deepEqual(added.slice(2, 4).map(spool => spool.row), [ROWS - 2, ROWS - 2]);
  assert.ok(added.every(spool => spool.length === 1));
  assert.equal(new Set(added.map(spool => spool.row + ':' + spool.col)).size, 5);
  for (const spool of original) assert.deepEqual(board.getSpool(spool.id), spool);
  assert.deepEqual(board.fullRows(), [ROWS - 2, ROWS - 1], 'the item leaves clearing to its caller');
  assert.deepEqual(board.settle(), [], 'filled gaps must survive normal gravity');
  assert.deepEqual(board.fullRows(), [ROWS - 2, ROWS - 1]);
  added[0].color = '#changed';
  assert.notEqual(board.getSpool(added[0].id).color, '#changed');
  checkBoard(board);
});

test('the filler prioritizes the fewest missing cells and can complete more than one row', () => {
  const board = new Board({ random: () => 0 });
  add(board, ROWS - 1, 0, 5);
  add(board, ROWS - 1, 5, 3);
  add(board, ROWS - 2, 0, 3);
  add(board, ROWS - 2, 5, 4);
  const added = board.fillEmptySpaces(3);
  assert.deepEqual(added.map(({ row, col }) => [row, col]), [[ROWS - 1, 8], [ROWS - 2, 3], [ROWS - 2, 4]]);
  assert.deepEqual(board.fullRows(), [ROWS - 2, ROWS - 1]);
  checkBoard(board);
});

test('the filler avoids unsupported tempting gaps and uses random stable spaces when no row can complete', () => {
  const layouts = new Set();
  for (let seed = 1; seed <= 100; seed += 1) {
    const board = new Board({ random: seededRandom(seed * 31) });
    add(board, ROWS - 1, 0, 1);
    add(board, ROWS - 1, 8, 1);
    add(board, ROWS - 2, 0, 4);
    add(board, ROWS - 2, 5, 4);
    const added = board.fillEmptySpaces(1);
    assert.equal(added.length, 1);
    assert.notDeepEqual([added[0].row, added[0].col], [ROWS - 2, 4], 'unsupported one-cell gap cannot produce a lasting clear');
    assert.deepEqual(board.settle(), []);
    layouts.add(added[0].row + ':' + added[0].col);
    checkBoard(board);
  }
  assert.ok(layouts.size > 5, 'equal-priority fallback positions should be randomized');
});

test('the filler adds exactly five unique cells on empty boards and respects limited capacity', () => {
  for (let seed = 1; seed <= 100; seed += 1) {
    const board = new Board({ random: seededRandom(seed * 127) });
    const added = board.fillEmptySpaces();
    assert.equal(added.length, 5);
    assert.equal(new Set(added.map(spool => spool.id)).size, 5);
    assert.equal(new Set(added.map(spool => spool.row + ':' + spool.col)).size, 5);
    assert.equal(board.grid.flat().filter(id => id !== null).length, 5);
    assert.ok(added.every(spool => spool.length === 1));
    assert.deepEqual(board.settle(), []);
    checkBoard(board);
  }
  const board = new Board({ random: seededRandom(21) });
  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) {
      if ((row === 0 && col === 0) || (row === ROWS - 1 && col === COLS - 1)) continue;
      add(board, row, col, 1);
    }
  }
  assert.equal(board.fillEmptySpaces().length, 2);
  assert.deepEqual(board.fillEmptySpaces(), []);
  checkBoard(board);
  const before = board.snapshot();
  assert.deepEqual(board.fillEmptySpaces(0), []);
  for (const count of [-1, 1.5, NaN, COLS * ROWS + 1]) assert.throws(() => board.fillEmptySpaces(count), RangeError);
  assert.deepEqual(board.snapshot(), before);
});

test('generated bottom rows contain several valid spools and at least one gap', () => {
  const board = new Board({ random: seededRandom(918273) });
  const lengths = new Set();
  for (let i = 0; i < 2000; i += 1) {
    const specs = board.makeRow();
    checkNewRow(specs);
    assert.ok(specs.filter(spec => spec.length === 4).length <= 1);
    for (const spec of specs) lengths.add(spec.length);
  }
  assert.deepEqual([...lengths].sort(), [1, 2, 3, 4, 5]);
});

test('an existing four excludes new fours until its final instance is cut or removed', () => {
  const board = new Board({ random: seededRandom(1097) });
  const first = add(board, 3, 0, 4);
  const last = add(board, ROWS - 1, 3, 4);
  for (let pass = 0; pass < 2; pass += 1) {
    const before = board.snapshot();
    const available = new Set();
    for (let sample = 0; sample < 1000; sample += 1) {
      const specs = board.makeRow();
      checkNewRow(specs);
      assert.ok(specs.every(spool => spool.length !== 4));
      for (const spool of specs) available.add(spool.length);
    }
    assert.deepEqual([...available].sort(), [1, 2, 3, 5]);
    assert.deepEqual(board.snapshot(), before);
    board.splitSpool(pass === 0 ? first.id : last.id);
  }
  let sawFour = false;
  for (let sample = 0; sample < 1000; sample += 1) {
    const specs = board.makeRow();
    assert.ok(specs.filter(spool => spool.length === 4).length <= 1);
    sawFour ||= specs.some(spool => spool.length === 4);
  }
  assert.equal(sawFour, true, 'cutting the final four makes that length eligible again');
  checkBoard(board);
});

test('an existing length-five spool anywhere on the board excludes new fives without excluding lengths one to four', () => {
  for (const row of [0, Math.floor(ROWS / 2), ROWS - 1]) {
    const board = new Board({ random: seededRandom(4273) });
    // A smaller spool appears first in metadata order: eligibility must inspect
    // all live pieces, including a five high above the incoming bottom row.
    add(board, ROWS - 2, 0, 2);
    const five = add(board, row, 3, 5, '#102030');
    const before = board.snapshot();
    const beforeGrid = board.grid.map(cells => cells.slice());
    const nextId = board.nextId;
    const lengths = new Set();
    for (let sample = 0; sample < 2000; sample += 1) {
      const specs = board.makeRow();
      checkNewRow(specs);
      for (const spec of specs) {
        assert.ok(spec.length <= 4, `existing five on row ${row} must prevent a new five`);
        lengths.add(spec.length);
      }
    }
    assert.deepEqual([...lengths].sort(), [1, 2, 3, 4]);
    assert.deepEqual(board.snapshot(), before, 'generation cannot shorten, recolor, or move existing pieces');
    assert.deepEqual(board.grid, beforeGrid);
    assert.equal(board.getSpool(five.id), five, 'the existing five remains the same independent spool');
    assert.equal(board.nextId, nextId);
    checkBoard(board);
  }
});

test('length five becomes eligible only after the last existing five clears', () => {
  const board = new Board({ random: seededRandom(7901) });
  const survivor = add(board, ROWS - 3, 2, 2);
  const fives = [];
  for (const row of [ROWS - 2, ROWS - 1]) {
    fives.push(add(board, row, 0, 5));
    add(board, row, 5, 4);
  }

  // Fixtures can contain multiple old fives. Clearing just one must not enable
  // another; the policy is based on current board contents, not a toggle.
  board.clearRows([ROWS - 1]);
  assert.equal(board.getSpool(fives[1].id), null);
  assert.equal(board.getSpool(fives[0].id).length, 5);
  for (let sample = 0; sample < 300; sample += 1) {
    const specs = board.makeRow();
    checkNewRow(specs);
    assert.ok(specs.every(spec => spec.length <= 4));
  }

  board.clearRows([ROWS - 2]);
  assert.equal(board.getSpool(fives[0].id), null);
  assert.deepEqual(board.snapshot(), [{ ...survivor }]);
  const lengths = new Set();
  for (let sample = 0; sample < 2000; sample += 1) {
    const specs = board.makeRow();
    checkNewRow(specs);
    for (const spec of specs) lengths.add(spec.length);
  }
  assert.deepEqual([...lengths].sort(), [1, 2, 3, 4, 5], 'clearing the last five restores every legal length');
  assert.deepEqual(board.snapshot(), [{ ...survivor }]);
  checkBoard(board);
});

test('long-run generation favors lengths two and three and keeps fours and singletons occasional', () => {
  const board = new Board({ random: seededRandom(918273) });
  const samples = 10000;
  const counts = new Array(6).fill(0);
  const columns = new Array(COLS).fill(0);
  const layouts = new Set();
  let occupied = 0;
  for (let i = 0; i < samples; i += 1) {
    const specs = board.makeRow();
    checkNewRow(specs);
    layouts.add(JSON.stringify(specs.map(({ col, length }) => [col, length])));
    for (const spec of specs) {
      counts[spec.length] += 1;
      occupied += spec.length;
      for (let col = spec.col; col < spec.col + spec.length; col += 1) columns[col] += 1;
    }
  }
  const total = counts.reduce((sum, count) => sum + count, 0);
  const singleShare = counts[1] / total;
  assert.ok(singleShare >= 0.10 && singleShare < 0.20, `singleton share was ${singleShare}`);
  assert.ok((counts[2] + counts[3] + counts[4]) / total > 0.70, 'medium spools should dominate');
  assert.ok((counts[2] + counts[3]) / total > 0.65, 'pairs and triples should dominate the available shapes');
  assert.ok(counts[4] / total > 0.01 && counts[4] / total < 0.08, 'fours should remain available but uncommon');
  assert.ok(counts[5] / total > 0.02 && counts[5] / total < 0.12, 'length five stays an occasional option');
  assert.ok(occupied / samples > 5.8 && occupied / samples < 6.2, 'changing lengths must not increase row density');
  assert.ok(layouts.size > 500, 'the reduction must preserve varied horizontal layouts');
  for (let col = 0; col < COLS; col += 1) {
    assert.ok(columns[col] > samples * 0.4 && columns[col] < samples * 0.85, `column ${col} needs varied occupancy`);
    assert.ok(Math.abs(columns[col] - columns[COLS - 1 - col]) < samples * 0.03,
      `horizontal generation should not favor one side: column ${col}`);
  }
});

test('row generation preserves every gap and support with each combination of existing long lengths', () => {
  for (let gap = 0; gap < COLS; gap += 1) {
    const supports = [null, ...Array.from({ length: COLS }, (_, col) => col).filter(col => col !== gap)];
    for (const support of supports) {
      for (const [hasFour, hasFive] of [[false, false], [true, false], [false, true], [true, true]]) {
        const randomSources = [seededRandom(7300 + gap * 101 + (support === null ? 0 : support + 1)), () => 0, () => 1 - Number.EPSILON];
        for (const random of randomSources) {
          const board = new Board({ random });
          if (hasFour) add(board, ROWS - 2, 1, 4);
          if (hasFive) add(board, ROWS - 1, 1, 5);
          const before = board.snapshot();
          for (let sample = 0; sample < 10; sample += 1) {
            const specs = board._makeRow(gap, support);
            checkNewRow(specs);
            assert.ok(specs.filter(spec => spec.length === 4).length <= (hasFour ? 0 : 1));
            if (hasFive) assert.ok(specs.every(spec => spec.length <= 4));
            const covers = col => specs.some(spec => spec.col <= col && col < spec.col + spec.length);
            assert.equal(covers(gap), false, `gap ${gap} must remain empty`);
            if (support !== null) assert.equal(covers(support), true, `support ${support} beside gap ${gap}`);
          }
          assert.deepEqual(board.snapshot(), before);
          checkBoard(board);
        }
      }
    }
  }
});

test('future row generation preserves existing spool shapes and returns independent specifications', () => {
  const board = new Board({ random: () => 0 });
  add(board, ROWS - 1, 2, 4);
  const before = board.snapshot();
  const nextId = board.nextId;
  const first = board.makeRow();
  const expected = first.map(spec => ({ ...spec }));
  first[0].col = 99;
  first[0].length = 99;
  first[0].color = '#000000';
  for (let i = 0; i < 20; i += 1) {
    assert.deepEqual(board.makeRow(), expected, 'a returned row cannot mutate cached creation layouts');
    assert.deepEqual(board.snapshot(), before, 'existing spools are never resized or merged');
    assert.equal(board.nextId, nextId, 'preview generation does not insert spools');
  }
  checkBoard(board);
});

test('insertion moves each existing spool up exactly once and adds only the supplied row', () => {
  const board = new Board();
  const first = add(board, ROWS - 4, 1, 3);
  const second = add(board, ROWS - 1, 4, 5);
  const before = board.snapshot();
  const specs = [{ col: 0, length: 2, color: '#998877' }, { col: 5, length: 3, color: '#abc123' }];
  assert.equal(board.insertRow(specs).overflow, false);
  assert.equal(board.spools.size, 4);
  for (const old of before) {
    assert.deepEqual(board.getSpool(old.id), { ...old, row: old.row - 1 });
  }
  const inserted = board.snapshot().filter(spool => ![first.id, second.id].includes(spool.id));
  assert.deepEqual(inserted.map(({ row, col, length, color }) => ({ row, col, length, color })),
    specs.map(spec => ({ row: ROWS - 1, ...spec })));
  checkBoard(board);
  board.settle();
  assert.ok(inserted.every(spool => board.getSpool(spool.id).row === ROWS - 1));
  assert.equal(isStable(board), true);
  checkBoard(board);
});

test('insertion detects a spool passing the top immediately and preserves a valid board', () => {
  const board = new Board();
  add(board, 0, 1, 3);
  add(board, ROWS - 1, 2, 2);
  const before = board.snapshot();
  const specs = [{ col: 0, length: 2, color: '#998877' }, { col: 5, length: 3, color: '#abc123' }];
  assert.equal(board.insertRow(specs).overflow, true);
  assert.deepEqual(board.snapshot(), before);
  checkBoard(board);
});

test('row insertion and its gravity can create a full row and clear it', () => {
  const board = new Board();
  add(board, ROWS - 1, 0, 4);
  add(board, ROWS - 1, 5, 4);
  // The new single-cell support catches the left spool, while the right falls
  // into the new row. The left then remains a separate rigid bar above it.
  const specs = [{ col: 0, length: 1, color: '#998877' }, { col: 1, length: 4, color: '#abc123' }];
  assert.equal(board.insertRow(specs).overflow, false);
  board.settle();
  assert.deepEqual(board.fullRows(), [ROWS - 1]);
  assert.deepEqual(resolveRows(board), [1]);
  assert.equal(board.spools.size, 1);
  assert.equal(board.snapshot()[0].length, 4);
  assert.equal(board.snapshot()[0].row, ROWS - 1);
  checkBoard(board);
});

test('seeded multi-turn stress preserves cell ownership, rigid lengths, and finite resolution', () => {
  let validTurns = 0;
  let clearedRows = 0;
  let overflows = 0;
  for (let seed = 1; seed <= 100; seed += 1) {
    const random = seededRandom(seed * 1709);
    const board = new Board({ random });
    board.reset();
    for (let turn = 0; turn < 100; turn += 1) {
      const choices = board.snapshot().filter(spool => {
        const { min, max } = board.dragBounds(spool.id);
        return min < max;
      });
      if (choices.length === 0) break;
      const original = new Map(board.snapshot().map(spool => [spool.id, spool]));
      const selected = choices[Math.floor(random() * choices.length)];
      const { min, max } = board.dragBounds(selected.id);
      const columns = Array.from({ length: max - min + 1 }, (_, index) => min + index)
        .filter(col => col !== selected.col);
      assert.equal(board.moveSpool(selected.id, columns[Math.floor(random() * columns.length)]), true);
      validTurns += 1;
      checkBoard(board);
      board.settle();
      clearedRows += resolveRows(board).reduce((sum, count) => sum + count, 0);
      const specs = board.makeRow();
      checkNewRow(specs);
      if (board.insertRow(specs).overflow) {
        overflows += 1;
        checkBoard(board);
        break;
      }
      board.settle();
      clearedRows += resolveRows(board).reduce((sum, count) => sum + count, 0);
      checkBoard(board);
      assert.ok(board.snapshot().filter(spool => spool.length === 4).length <= 1);
      assert.ok(board.snapshot().filter(spool => spool.length === 5).length <= 1);
      assert.equal(isStable(board), true);
      assert.deepEqual(board.fullRows(), []);
      for (const spool of board.spools.values()) {
        if (!original.has(spool.id)) continue;
        assert.equal(spool.length, original.get(spool.id).length);
        assert.equal(spool.color, original.get(spool.id).color);
      }
    }
  }
  assert.ok(validTurns > 1000, `expected broad turn coverage, got ${validTurns}`);
  assert.ok(clearedRows > 0, 'stress should exercise row clearing');
  assert.ok(overflows > 0, 'stress should exercise top overflow');
});
