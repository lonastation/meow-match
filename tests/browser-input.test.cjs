'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { COLS, ROWS } = require('../engine.js');

const CELL = 30;
const BOTTOM_CENTER_Y = (ROWS - 0.5) * CELL;

const ROOT = path.resolve(__dirname, '..');
const ENGINE_SOURCE = fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf8');
const GAME_SOURCE = fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8');

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
    emit(type, event = {}) {
      for (const callback of listeners.get(type) || []) callback(event);
    },
  };
}

// This is a DOM/event regression harness, not a browser layout or touch-device
// emulator. It runs the unchanged browser scripts and their registered handlers.
// Canvas drawing is inert; its real CSS-pixel dimensions still drive hit testing.
function browserHarness() {
  const nodes = new Map();
  const scheduledFrames = [];
  let now = 0;
  let game;
  let publishedGameAPI;

  const context2d = new Proxy({}, {
    get(target, property) { return target[property] || (() => {}); },
    set(target, property, value) { target[property] = value; return true; },
  });

  function makeElement(id) {
    const capturedPointers = new Set();
    return Object.assign(eventTarget(), {
      id,
      style: {},
      dataset: {},
      hidden: true,
      width: 300,
      height: 150,
      clientWidth: 150,
      clientHeight: 22,
      classList: { toggle() {} },
      setAttribute() {},
      focus() {},
      getContext() { return context2d; },
      getBoundingClientRect() {
        return {
          left: 0,
          top: 0,
          width: parseFloat(this.style.width) || COLS * CELL,
          height: parseFloat(this.style.height) || ROWS * CELL,
        };
      },
      setPointerCapture(pointerId) { capturedPointers.add(pointerId); },
      hasPointerCapture(pointerId) { return capturedPointers.has(pointerId); },
      releasePointerCapture(pointerId) {
        capturedPointers.delete(pointerId);
        this.emit('lostpointercapture', { pointerId });
      },
      querySelector() { return makeElement('nested-button'); },
    });
  }

  function getElement(id) {
    if (!nodes.has(id)) nodes.set(id, makeElement(id));
    return nodes.get(id);
  }

  const region = getElement('board-region');
  region.clientWidth = COLS * CELL;
  region.clientHeight = ROWS * CELL;
  const document = Object.assign(eventTarget(), {
    getElementById: getElement,
    querySelector: () => getElement('brand'),
    hidden: false,
  });
  const sandbox = Object.assign(eventTarget(), {
    console,
    document,
    performance: { now: () => now },
    localStorage: { getItem: () => null, setItem() {} },
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame(callback) { scheduledFrames.push(callback); },
    ResizeObserver: class { observe() {} },
    // No navigation occurs. This protocol only disables optional PWA setup in
    // the in-memory harness; actual local-file browser behavior is not tested.
    location: { protocol: 'file:' },
    navigator: {},
    devicePixelRatio: 1,
  });
  sandbox.window = sandbox;

  // Capture the instance through the normal published browser API, without
  // rewriting the production source or exporting its private event functions.
  Object.defineProperty(sandbox, 'MeowGame', {
    configurable: true,
    get() { return publishedGameAPI; },
    set(api) {
      publishedGameAPI = {
        ...api,
        Game: class extends api.Game {
          constructor(options) {
            super(options);
            game = this;
          }
        },
      };
    },
  });
  vm.createContext(sandbox);
  vm.runInContext(ENGINE_SOURCE, sandbox, { filename: 'engine.js' });
  vm.runInContext(GAME_SOURCE, sandbox, { filename: 'game.js' });

  // A single movable bottom spool makes an unexpected turn or row insertion
  // unambiguous. The next row supports its target column after a valid move.
  game.board = new sandbox.MeowEngine.Board();
  const spool = game.board.addSpool({ row: ROWS - 1, col: 4, length: 1, color: '#f59ba7' });
  game.nextRow = [
    { col: 0, length: 2, color: '#a8caa5' },
    { col: 6, length: 2, color: '#a6c8df' },
  ];
  game.notify();

  function pointer(type, x, y = BOTTOM_CENTER_Y, pointerType = 'touch') {
    getElement('board').emit(type, {
      pointerId: 1,
      pointerType,
      isPrimary: true,
      button: 0,
      clientX: x,
      clientY: y,
      preventDefault() {},
    });
  }

  async function finishAnimations() {
    for (let step = 0; step < 100; step += 1) {
      // Drain Promise continuations between actual requestAnimationFrame ticks.
      await new Promise(setImmediate);
      if (game.state === 'IDLE' || game.state === 'GAME_OVER') return;
      now += 300;
      const frame = scheduledFrames.splice(0);
      for (const callback of frame) callback(now);
    }
    assert.fail('The browser turn failed to return to an input-ready state.');
  }

  return {
    game,
    spool,
    pointer,
    getElement,
    finishAnimations,
    resize(width, height) {
      region.clientWidth = width;
      region.clientHeight = height;
      sandbox.emit('resize');
    },
  };
}

test('resizing during a touch gesture rolls back the drag and ignores its later release', () => {
  for (const moveBeforeResize of [false, true]) {
    const app = browserHarness();
    const { game, spool } = app;
    const before = game.board.snapshot();
    const nextRow = game.nextRow;
    const nextId = game.board.nextId;

    app.pointer('pointerdown', 135);
    assert.equal(game.state, 'DRAGGING');
    if (moveBeforeResize) {
      app.pointer('pointermove', 195);
      assert.equal(game.board.getSpool(spool.id).col, 6);
    }

    // Without cancellation, the same physical X coordinate is interpreted in
    // the new 180px board and a stationary release can consume a turn.
    app.resize(COLS * 20, ROWS * 20);
    assert.equal(game.state, 'IDLE');
    app.pointer('pointerup', moveBeforeResize ? 195 : 135);

    assert.deepEqual(game.board.snapshot(), before);
    assert.equal(game.board.nextId, nextId, 'no incoming row may be allocated');
    assert.equal(game.nextRow, nextRow);
    assert.equal(game.moves, 0);
    assert.equal(game.score, 0);
    assert.equal(game.drag, null);
    assert.equal(app.getElement('board').hasPointerCapture(1), false);
    game.board.assertValid();
  }
});

test('pointercancel restores a moved touch spool without gravity or a new row', () => {
  const app = browserHarness();
  const { game, spool } = app;
  const before = game.board.snapshot();
  const nextRow = game.nextRow;
  app.pointer('pointerdown', 135);
  app.pointer('pointermove', 225, 100);
  assert.equal(game.board.getSpool(spool.id).col, 7);
  assert.equal(game.board.getSpool(spool.id).row, ROWS - 1, 'vertical motion never changes its row');
  assert.equal(game.state, 'DRAGGING');

  app.pointer('pointercancel', 225, 100);
  app.pointer('pointerup', 225, 100);

  assert.deepEqual(game.board.snapshot(), before);
  assert.equal(game.nextRow, nextRow);
  assert.equal(game.state, 'IDLE');
  assert.equal(game.moves, 0);
  assert.equal(game.score, 0);
  assert.equal(game.drag, null);
  assert.equal(app.getElement('board').hasPointerCapture(1), false);
  game.board.assertValid();
});

test('touch and mouse use the same pointer path and a valid release inserts exactly one row', async () => {
  for (const pointerType of ['touch', 'mouse']) {
    const app = browserHarness();
    const { game, spool } = app;
    const nextRow = game.nextRow;
    const preview = app.getElement('next-row');
    assert.equal(preview.dataset.visible, 'true');

    app.pointer('pointerdown', 135, BOTTOM_CENTER_Y, pointerType);
    app.pointer('pointermove', 195, 100, pointerType);
    assert.equal(game.state, 'DRAGGING');
    assert.equal(preview.dataset.visible, 'false', 'hide the incoming row while the player is dragging');
    assert.equal(game.board.getSpool(spool.id).col, 6);
    assert.equal(game.board.getSpool(spool.id).row, ROWS - 1);
    assert.equal(game.moves, 0, 'a drag alone must not consume a turn');

    app.pointer('pointerup', 195, 100, pointerType);
    assert.equal(game.state, 'RESOLVING');
    assert.equal(preview.dataset.visible, 'false', 'keep the preview hidden while the outcome resolves');
    assert.equal(app.getElement('help-button').disabled, true);
    assert.equal(app.getElement('restart-button').disabled, true);

    // A second input attempt during animation must be ignored.
    app.pointer('pointerdown', 195, BOTTOM_CENTER_Y, pointerType);
    assert.equal(game.drag, null);
    await app.finishAnimations();

    assert.equal(game.state, 'IDLE');
    assert.equal(preview.dataset.visible, 'true', 'reveal the following preview only when input resumes');
    assert.equal(game.moves, 1);
    assert.equal(game.score, 0);
    assert.equal(game.board.spools.size, 3, 'one existing spool plus exactly two new spools');
    assert.equal(game.board.getSpool(spool.id).col, 6);
    assert.equal(game.board.getSpool(spool.id).row, ROWS - 2, 'the new row supports the lifted spool');
    assert.equal(game.board.grid[ROWS - 1].filter((id) => id !== null).length, 4);
    assert.notEqual(game.nextRow, nextRow, 'the next-row preview advances once');
    assert.equal(app.getElement('help-button').disabled, false);
    assert.equal(app.getElement('restart-button').disabled, false);
    game.board.assertValid();
  }
});

test('square cells fit width- and height-limited regions and preserve touch hit testing', async () => {
  const cases = [
    { regionWidth: 360, regionHeight: 600, boardWidth: 360, boardHeight: 480, cellSize: 40, startX: 180, endX: 260, y: 460 },
    { regionWidth: 360, regionHeight: 360, boardWidth: 270, boardHeight: 360, cellSize: 30, startX: 135, endX: 195, y: 345 },
  ];

  for (const size of cases) {
    const app = browserHarness();
    const { game, spool } = app;
    const nextRow = game.nextRow;

    app.resize(size.regionWidth, size.regionHeight);
    const bounds = app.getElement('board').getBoundingClientRect();
    assert.equal(bounds.width, size.boardWidth);
    assert.equal(bounds.height, size.boardHeight);
    assert.equal(bounds.width / COLS, size.cellSize);
    assert.equal(bounds.height / ROWS, size.cellSize);
    assert.ok(bounds.width <= size.regionWidth && bounds.height <= size.regionHeight);
    app.pointer('pointerdown', size.startX, size.y);
    assert.equal(game.state, 'DRAGGING');
    app.pointer('pointermove', size.endX, size.y);
    assert.equal(game.board.getSpool(spool.id).col, 6);
    assert.equal(game.board.getSpool(spool.id).row, ROWS - 1);
    assert.equal(game.moves, 0);

    app.pointer('pointerup', size.endX, size.y);
    await app.finishAnimations();

    assert.equal(game.state, 'IDLE');
    assert.equal(game.moves, 1);
    assert.equal(game.score, 0);
    assert.equal(game.board.getSpool(spool.id).col, 6);
    assert.equal(game.board.getSpool(spool.id).row, ROWS - 2);
    assert.equal(game.board.spools.size, 3, 'exactly one row of two new spools was inserted');
    assert.equal(game.board.grid[ROWS - 1].filter(id => id !== null).length, 4);
    assert.notEqual(game.nextRow, nextRow);
    game.board.assertValid();
  }
});
