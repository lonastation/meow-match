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
function browserHarness({ reducedMotion = false } = {}) {
  const nodes = new Map();
  const scheduledFrames = new Map();
  const metrics = { canvasCreations: 0, offscreenPaints: 0, boardPaints: 0, drawImages: [], fills: [], texts: [] };
  const animations = [];
  const boardOrigin = { left: 0, top: 0 };
  let nextFrameId = 1;
  let now = 0;
  let game;
  let publishedGameAPI;

  function makeContext(owner) {
    const savedStates = [];
    return new Proxy({ globalAlpha: 1 }, {
      get(target, property) {
        if (!(property in target)) target[property] = (...args) => {
          if (owner.id.startsWith('offscreen-')) metrics.offscreenPaints += 1;
          if (owner.id === 'board') metrics.boardPaints += 1;
          if (property === 'save') savedStates.push({ globalAlpha: target.globalAlpha, fillStyle: target.fillStyle });
          if (property === 'restore') Object.assign(target, savedStates.pop() || {});
          if (property === 'drawImage') metrics.drawImages.push({ owner: owner.id, args, now, alpha: target.globalAlpha });
          if (property === 'fillRect') metrics.fills.push({ owner: owner.id, args, now, alpha: target.globalAlpha, color: target.fillStyle });
          if (property === 'fillText') metrics.texts.push({ owner: owner.id, args, now, alpha: target.globalAlpha });
        };
        return target[property];
      },
      set(target, property, value) { target[property] = value; return true; },
    });
  }

  function makeElement(id) {
    const capturedPointers = new Set();
    let context2d;
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
      getContext() { return context2d || (context2d = makeContext(this)); },
      getBoundingClientRect() {
        return {
          left: id === 'board' ? boardOrigin.left : 0,
          top: id === 'board' ? boardOrigin.top : 0,
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
    createElement(tag) {
      assert.equal(tag, 'canvas');
      return makeElement(`offscreen-${++metrics.canvasCreations}`);
    },
    hidden: false,
  });
  const sandbox = Object.assign(eventTarget(), {
    console,
    document,
    performance: { now: () => now },
    localStorage: { getItem: () => null, setItem() {} },
    matchMedia: () => ({ matches: reducedMotion }),
    requestAnimationFrame(callback) {
      const id = nextFrameId++;
      scheduledFrames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { scheduledFrames.delete(id); },
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
            super({
              ...options,
              animate: frame => {
                animations.push({ frame, now });
                return options.animate(frame);
              },
            });
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

  async function advance(milliseconds) {
    // Advance the visible clock independently of RAF cadence, then drain
    // controller continuations before the next browser frame can run.
    await new Promise(setImmediate);
    now += milliseconds;
    const callbacks = [...scheduledFrames.values()];
    scheduledFrames.clear();
    for (const callback of callbacks) callback(now);
    await new Promise(setImmediate);
  }

  async function finishAnimations() {
    for (let step = 0; step < 100; step += 1) {
      await new Promise(setImmediate);
      if ((game.state === 'IDLE' || game.state === 'GAME_OVER') && scheduledFrames.size === 0) return;
      await advance(300);
    }
    assert.fail('The browser turn failed to return to an input-ready state.');
  }

  return {
    game,
    spool,
    pointer,
    getElement,
    finishAnimations,
    advance,
    metrics,
    animations,
    get pendingFrames() { return scheduledFrames.size; },
    setHidden(hidden) {
      document.hidden = hidden;
      document.emit('visibilitychange');
    },
    setBoardOrigin(left, top) {
      boardOrigin.left = left;
      boardOrigin.top = top;
    },
    resize(width, height) {
      region.clientWidth = width;
      region.clientHeight = height;
      sandbox.emit('resize');
    },
  };
}

async function startLongFall(app) {
  const board = new app.game.board.constructor();
  board.addSpool({ row: 2, col: 4, length: 1, color: '#f59ba7' });
  app.game.board = board;
  app.game.notify();
  await app.advance(0);
  app.pointer('pointerdown', 135, 75);
  app.pointer('pointermove', 195, 75);
  app.pointer('pointerup', 195, 75);
  await app.advance(0);
  assert.equal(app.game.state, 'RESOLVING');
}

function lastSpoolY(app) {
  const calls = app.metrics.drawImages.filter(call =>
    call.owner === 'board' && call.args[0].height <= CELL * 2);
  assert.ok(calls.length > 0, 'a cached spool must actually be drawn on the board');
  return calls.at(-1).args[2];
}

function plainSnapshot(app) {
  return JSON.parse(JSON.stringify(app.game.board.snapshot()));
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

test('a same-size layout shift cannot turn a stationary touch release into a move', () => {
  const app = browserHarness();
  const { game } = app;
  const before = game.board.snapshot();
  const incoming = game.nextRow;
  const nextId = game.board.nextId;

  app.pointer('pointerdown', 135);
  assert.equal(game.state, 'DRAGGING');
  app.setBoardOrigin(60, 25);
  app.resize(COLS * CELL, ROWS * CELL);
  assert.equal(game.state, 'DRAGGING', 'unchanged scale keeps the gesture active');
  app.pointer('pointerup', 135);

  assert.equal(game.state, 'IDLE');
  assert.equal(game.drag, null);
  assert.equal(game.moves, 0, 'a stationary finger did not move the spool');
  assert.equal(game.score, 0);
  assert.deepEqual(game.board.snapshot(), before);
  assert.equal(game.board.nextId, nextId, 'no incoming row may be inserted');
  assert.equal(game.nextRow, incoming);
  assert.equal(app.getElement('board').hasPointerCapture(1), false);
  game.board.assertValid();
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

test('rendered falling positions depend on elapsed time across 30, 60, 120 Hz and irregular frames', async () => {
  function cadence(hz) {
    const intervals = [];
    let remaining = 120;
    while (remaining > 1000 / hz) {
      intervals.push(1000 / hz);
      remaining -= 1000 / hz;
    }
    intervals.push(remaining);
    return intervals;
  }
  let expectedY;
  let expectedFinalBoard;
  for (const intervals of [cadence(30), cadence(60), cadence(120), [7, 41, 3, 69]]) {
    const app = browserHarness();
    await startLongFall(app);
    assert.equal(lastSpoolY(app), CELL * 2);
    for (const interval of intervals) await app.advance(interval);
    const y = lastSpoolY(app);
    assert.ok(y > CELL * 2 && y < CELL * (ROWS - 1));
    if (expectedY === undefined) expectedY = y;
    else assert.ok(Math.abs(y - expectedY) < 1e-8, 'different frame schedules must produce the same position');
    assert.equal(app.game.state, 'RESOLVING');
    await app.finishAnimations();
    assert.equal(app.game.moves, 1);
    assert.equal(app.game.score, 0);
    if (!expectedFinalBoard) expectedFinalBoard = plainSnapshot(app);
    else assert.deepEqual(plainSnapshot(app), expectedFinalBoard);
  }
});

test('hiding the tab pauses the animation clock and resumes without a jump or an extra turn', async () => {
  const app = browserHarness();
  await startLongFall(app);
  await app.advance(90);
  const yBeforeHide = lastSpoolY(app);
  const boardBeforeHide = plainSnapshot(app);
  const incoming = app.game.nextRow;
  const paintsBeforeHide = app.metrics.boardPaints;
  app.setHidden(true);
  assert.equal(app.pendingFrames, 0);
  await app.advance(10000);
  assert.equal(app.pendingFrames, 0);
  assert.equal(app.metrics.boardPaints, paintsBeforeHide);
  assert.deepEqual(plainSnapshot(app), boardBeforeHide);
  assert.equal(app.game.nextRow, incoming);
  assert.equal(app.game.state, 'RESOLVING');
  assert.equal(app.game.moves, 1);
  assert.equal(app.game.score, 0);

  app.setHidden(false);
  assert.equal(app.pendingFrames, 1);
  await app.advance(0);
  assert.ok(Math.abs(lastSpoolY(app) - yBeforeHide) < 1e-8, 'hidden time must not advance the falling visual');
  await app.advance(30);
  assert.ok(lastSpoolY(app) > yBeforeHide);
  assert.equal(app.game.beginDrag(app.game.board.snapshot()[0].id), false);
  await app.finishAnimations();
  assert.equal(app.game.state, 'IDLE');
  assert.equal(app.game.moves, 1);
  assert.equal(app.game.board.spools.size, 3);
  assert.equal(app.pendingFrames, 0);
});

test('idle rendering sleeps, repeated inputs coalesce, and cached art is reused until geometry changes', async () => {
  const app = browserHarness();
  await app.advance(0);
  assert.equal(app.pendingFrames, 0);
  const idlePaints = app.metrics.boardPaints;
  await app.advance(1000);
  assert.equal(app.metrics.boardPaints, idlePaints);
  assert.equal(app.pendingFrames, 0);

  app.pointer('pointerdown', 135);
  app.pointer('pointermove', 195);
  app.pointer('pointermove', 165);
  app.pointer('pointermove', 195);
  assert.equal(app.pendingFrames, 1, 'several input events need only one pending redraw');
  app.resize(COLS * CELL, ROWS * CELL);
  assert.equal(app.game.state, 'DRAGGING', 'a duplicate resize notification must not cancel input');
  await app.advance(0);
  assert.equal(app.pendingFrames, 0);
  app.pointer('pointermove', 195);
  assert.equal(app.pendingFrames, 0, 'an unchanged snapped column needs no redraw');
  app.pointer('pointercancel', 195);
  await app.advance(0);

  await startLongFall(app);
  const createdBefore = app.metrics.canvasCreations;
  const pathsBefore = app.metrics.offscreenPaints;
  const compositesBefore = app.metrics.drawImages.length;
  for (const interval of [30, 30, 60]) await app.advance(interval);
  assert.equal(app.metrics.canvasCreations, createdBefore);
  assert.equal(app.metrics.offscreenPaints, pathsBefore, 'steady animation must not repaint yarn paths or the background');
  assert.ok(app.metrics.drawImages.length > compositesBefore, 'animation should composite the cached artwork');
  await app.finishAnimations();
  const pathsBeforeResize = app.metrics.offscreenPaints;
  app.resize(360, 480);
  await app.advance(0);
  assert.ok(app.metrics.offscreenPaints > pathsBeforeResize, 'changed geometry rebuilds crisp artwork');
  assert.equal(app.pendingFrames, 0);
});

test('reduced motion shortens animation without changing the completed move', async () => {
  const normal = browserHarness();
  const reduced = browserHarness({ reducedMotion: true });
  await startLongFall(normal);
  await startLongFall(reduced);
  await normal.advance(35);
  await reduced.advance(35);
  assert.equal(normal.game.state, 'RESOLVING');
  assert.equal(reduced.game.state, 'INSERTING_ROW');
  await normal.finishAnimations();
  await reduced.finishAnimations();
  assert.deepEqual(plainSnapshot(reduced), plainSnapshot(normal));
  assert.equal(reduced.game.moves, normal.game.moves);
  assert.equal(reduced.game.score, normal.game.score);
  assert.equal(reduced.pendingFrames, 0);
});

test('completed rows stay fully visible for 450 ms, then fade in place until 900 ms in both motion modes', async () => {
  for (const reducedMotion of [false, true]) {
    const app = browserHarness({ reducedMotion });
    const board = new app.game.board.constructor();
    board.addSpool({ row: ROWS - 1, col: 0, length: 4, color: '#a8caa5' });
    board.addSpool({ row: ROWS - 1, col: 8, length: 1, color: '#a6c8df' });
    const clearingIds = [
      board.addSpool({ row: ROWS - 2, col: 0, length: 5, color: '#f59ba7' }).id,
      board.addSpool({ row: ROWS - 2, col: 5, length: 4, color: '#f4c776' }).id,
    ];
    const survivor = board.addSpool({ row: ROWS - 3, col: 0, length: 1, color: '#c5b1e0' });
    app.game.board = board;
    app.game.notify();
    await app.advance(0);
    app.pointer('pointerdown', 255);
    app.pointer('pointermove', 225);
    app.pointer('pointerup', 225);
    await app.advance(0);

    const frozenBoard = plainSnapshot(app);
    const incoming = app.game.nextRow;
    const nextId = board.nextId;
    assert.equal(app.animations.length, 1);
    assert.equal(app.animations[0].frame.kind, 'clear');
    assert.equal(app.animations[0].frame.duration, 900);
    assert.equal(app.animations[0].frame.holdDuration, 450);
    let elapsed = 0;
    let initialPositions;
    let popupY;
    let previousFade = 1;
    let holdHighlight;
    let previousHighlight;

    for (const interval of [0, 225, 224, 1, 225, 224]) {
      const imageStart = app.metrics.drawImages.length;
      const textStart = app.metrics.texts.length;
      const fillStart = app.metrics.fills.length;
      await app.advance(interval);
      elapsed += interval;
      const images = app.metrics.drawImages.slice(imageStart).filter(call =>
        call.owner === 'board' && call.args[0].height <= CELL * 2);
      const positions = images.map(({ args }) => ({ x: args[1], y: args[2], width: args[3], height: args[4] }));
      assert.equal(images.length, frozenBoard.length);
      if (!initialPositions) initialPositions = positions;
      else assert.deepEqual(positions, initialPositions, 'the complete board stays visually static while rows disappear');
      const clearing = images.filter(call => call.args[2] === (ROWS - 2) * CELL);
      assert.equal(clearing.length, 2);
      assert.equal(clearing[0].alpha, clearing[1].alpha, 'the row fades as one simultaneous batch');
      if (elapsed <= 450) assert.ok(clearing.every(call => call.alpha === 1), 'hold keeps completed rows fully opaque');
      else {
        assert.ok(clearing[0].alpha >= 0 && clearing[0].alpha < previousFade, 'the second half softly fades the row');
        previousFade = clearing[0].alpha;
      }
      assert.ok(images.filter(call => call.args[2] !== (ROWS - 2) * CELL).every(call => call.alpha === 1));
      const popup = app.metrics.texts.slice(textStart).filter(call => call.owner === 'board').at(-1);
      assert.ok(popup, 'clear feedback remains present during the reaction interval');
      if (popupY === undefined) popupY = popup.args[2];
      else assert.equal(popup.args[2], popupY, 'score feedback does not float over the resting board');
      const rowHighlights = app.metrics.fills.slice(fillStart).filter(call =>
        call.owner === 'board' && call.args[2] === COLS * CELL && call.args[3] === CELL);
      assert.equal(rowHighlights.length, 1);
      const highlight = Number(rowHighlights[0].color.match(/,\s*([\d.]+)\)$/)[1]);
      if (holdHighlight === undefined) holdHighlight = highlight;
      if (elapsed <= 450) assert.equal(highlight, holdHighlight, 'the row highlight stays steady during the hold');
      else assert.ok(highlight >= 0 && highlight < previousHighlight, 'the highlight fades without pulsing');
      previousHighlight = highlight;

      assert.deepEqual(plainSnapshot(app), frozenBoard);
      assert.ok(clearingIds.every(id => board.getSpool(id)));
      assert.equal(board.getSpool(survivor.id).row, ROWS - 3);
      assert.equal(board.nextId, nextId);
      assert.equal(app.game.nextRow, incoming);
      assert.equal(app.game.score, 0);
      assert.equal(app.game.state, 'RESOLVING');
      assert.equal(app.game.reset(), false);
      assert.equal(app.game.beginDrag(survivor.id), false);
      assert.equal(app.animations.length, 1, 'no gravity or insertion can begin before the clear ends');
    }

    assert.equal(elapsed, 899);
    await app.advance(1);
    assert.ok(clearingIds.every(id => board.getSpool(id) === null));
    assert.equal(app.game.score, 100);
    assert.equal(app.animations.length, 2);
    assert.equal(app.animations[1].frame.kind, 'fall');
    assert.equal(app.animations[1].now, 900, 'following gravity begins only after the full reaction interval');
    await app.finishAnimations();
    assert.equal(app.game.state, 'IDLE');
    assert.equal(app.game.score, 100);
    assert.equal(app.game.moves, 1);
    assert.equal(app.animations.filter(({ frame }) => frame.kind === 'insert').length, 1);
    board.assertValid();
  }
});
