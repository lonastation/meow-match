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
  assert.ok(occupied > 0 && occupied <= 8);
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

test('generated bottom rows contain several valid spools and at least one gap', () => {
  const board = new Board({ random: seededRandom(918273) });
  const lengths = new Set();
  for (let i = 0; i < 2000; i += 1) {
    const specs = board.makeRow();
    checkNewRow(specs);
    for (const spec of specs) lengths.add(spec.length);
  }
  assert.deepEqual([...lengths].sort(), [1, 2, 3, 4, 5]);
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
