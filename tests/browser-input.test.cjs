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
const HTML_SOURCE = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

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
    const attributes = new Map();
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
      setAttribute(name, value) { attributes.set(name, value); },
      getAttribute(name) { return attributes.get(name); },
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
    if (['help-button', 'close-help', 'help-overlay'].includes(id)) return null;
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
    key(key) { getElement('board').emit('keydown', { key, preventDefault() {} }); },
    blur() { sandbox.emit('blur'); },
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

function cutterFixture() {
  const app = browserHarness();
  const board = new app.game.board.constructor();
  const four = board.addSpool({ row: ROWS - 1, col: 0, length: 4, color: '#f59ba7' });
  const three = board.addSpool({ row: ROWS - 1, col: 5, length: 3, color: '#a8caa5' });
  app.game.board = board;
  app.game.notify();
  return { app, board, four, three };
}

test('one cutter click immediately splits every eligible spool and consumes exactly one charge', async () => {
  const { app, board, four, three } = cutterFixture();
  const preview = JSON.stringify(app.game.nextRow);
  assert.equal(app.getElement('item-cutter').disabled, false);
  app.getElement('item-cutter').emit('click');
  assert.equal(board.getSpool(four.id), null, 'no board click or release is needed');
  assert.equal(board.getSpool(three.id), null, 'the same activation also cuts the other length');
  assert.deepEqual(Array.from(board.spools.values()).filter(s => s.color === four.color).map(s => s.length), [2, 2]);
  assert.deepEqual(Array.from(board.spools.values()).filter(s => s.color === three.color).map(s => s.length), [1, 1, 1]);
  assert.equal(app.game.items.cutter, 2);
  assert.equal(app.game.items.color, 3);
  assert.equal(app.game.items.fill, 3);
  await app.finishAnimations();
  assert.equal(app.getElement('item-cutter').getAttribute('aria-label'), 'Spool Cutter, 2 uses remaining');
  assert.equal(app.getElement('item-color').getAttribute('aria-label'), 'Color Sweep, 3 uses remaining');
  assert.equal(app.getElement('item-fill').getAttribute('aria-label'), 'Fill Five, 3 uses remaining');
  assert.equal(app.game.state, 'IDLE');
  assert.equal(app.game.moves, 0);
  assert.equal(JSON.stringify(app.game.nextRow), preview);
  assert.equal(app.animations.some(({ frame }) => frame.kind === 'insert'), false);
  board.assertValid();
});

test('cutter is disabled without eligible spools and repeated clicks cannot consume more charges', async () => {
  const emptyTargetApp = browserHarness();
  const unchanged = JSON.stringify(emptyTargetApp.game.board.snapshot());
  assert.equal(emptyTargetApp.getElement('item-cutter').disabled, true);
  emptyTargetApp.getElement('item-cutter').emit('click');
  assert.equal(emptyTargetApp.game.items.cutter, 3);
  assert.equal(JSON.stringify(emptyTargetApp.game.board.snapshot()), unchanged);

  const { app, board } = cutterFixture();
  app.getElement('item-cutter').emit('click');
  const cutBoard = JSON.stringify(board.snapshot());
  assert.equal(app.getElement('item-cutter').disabled, true);
  app.getElement('item-cutter').emit('click');
  assert.equal(app.game.items.cutter, 2, 'a second click during resolution is ignored');
  await app.finishAnimations();
  assert.equal(app.getElement('item-cutter').disabled, true);
  app.getElement('item-cutter').emit('click');
  assert.equal(app.game.items.cutter, 2, 'nothing remains eligible after resolution');
  assert.equal(JSON.stringify(board.snapshot()), cutBoard);
});

test('board keyboard and pointer controls remain ordinary sliding controls around a cutter use', async () => {
  const { app, board, four, three } = cutterFixture();
  app.key('ArrowUp');
  app.key('ArrowRight');
  assert.equal(app.game.drag.id, four.id);
  assert.equal(board.getSpool(four.id).col, 1);
  assert.equal(board.getSpool(four.id).length, 4);
  assert.equal(board.getSpool(three.id).length, 3);
  app.key('Escape');
  assert.equal(board.getSpool(four.id).col, 0);
  assert.equal(app.game.items.cutter, 3);
  app.getElement('item-cutter').emit('click');
  await app.finishAnimations();
  const fragment = board.snapshot().find(s => s.col === 2);
  app.pointer('pointerdown', 3 * CELL);
  app.pointer('pointermove', 4 * CELL);
  assert.equal(app.game.drag.id, fragment.id);
  assert.equal(board.getSpool(fragment.id).col, 3);
  assert.equal(board.getSpool(fragment.id).length, 2);
  app.pointer('pointercancel', 4 * CELL);
  assert.equal(board.getSpool(fragment.id).col, 2);
  assert.equal(app.game.items.cutter, 2);
  assert.equal(app.game.moves, 0);
  assert.equal(app.game.state, 'IDLE');
});

test('all item buttons reject activation during drags, modals, and item resolution', async () => {
  for (const lock of ['drag', 'restart', 'resolution']) {
    const { app, board } = cutterFixture();
    if (lock === 'drag') app.pointer('pointerdown', CELL);
    if (lock === 'restart') app.getElement('restart-button').emit('click');
    if (lock === 'resolution') app.getElement('item-fill').emit('click');
    const beforeBoard = JSON.stringify(board.snapshot());
    const beforeItems = JSON.stringify(app.game.items);
    for (const item of ['cutter', 'color', 'fill']) {
      assert.equal(app.getElement(`item-${item}`).disabled, true, `${item}: ${lock}`);
      app.getElement(`item-${item}`).emit('click');
    }
    assert.equal(JSON.stringify(board.snapshot()), beforeBoard, lock);
    assert.equal(JSON.stringify(app.game.items), beforeItems, lock);
    if (lock === 'drag') app.pointer('pointercancel', CELL);
    if (lock === 'restart') app.getElement('cancel-restart').emit('click');
    await app.finishAnimations();
    assert.equal(app.game.items.cutter, 3, lock);
    assert.equal(app.game.items.color, 3, lock);
    assert.equal(app.game.state, 'IDLE', lock);
  }
});

test('item buttons enforce modal and animation locks, display exhaustion, and refill on restart', async () => {
  const { app } = cutterFixture();
  app.getElement('restart-button').emit('click');
  assert.equal(app.getElement('item-fill').disabled, true);
  app.getElement('item-fill').emit('click');
  assert.equal(app.game.items.fill, 3);
  app.getElement('cancel-restart').emit('click');
  for (let use = 1; use <= 3; use += 1) {
    app.getElement('item-fill').emit('click');
    assert.equal(app.game.items.fill, 3 - use);
    assert.equal(app.getElement('item-fill').disabled, true);
    app.getElement('item-color').emit('click');
    app.getElement('item-fill').emit('click');
    assert.equal(app.game.items.color, 3, 'an animation cannot launch a second item');
    await app.finishAnimations();
    assert.equal(app.getElement('item-fill').getAttribute('aria-label'), `Fill Five, ${3 - use} uses remaining`);
  }
  app.getElement('item-fill').emit('click');
  assert.equal(app.game.items.fill, 0);
  assert.equal(app.getElement('item-fill').disabled, true);
  app.getElement('item-color').emit('click');
  await app.finishAnimations();
  assert.equal(app.getElement('item-color').getAttribute('aria-label'), 'Color Sweep, 2 uses remaining');
  app.getElement('restart-button').emit('click');
  app.getElement('confirm-restart').emit('click');
  assert.equal(app.game.items.cutter, 3);
  assert.equal(app.game.items.color, 3);
  assert.equal(app.game.items.fill, 3);
  assert.equal(app.getElement('item-fill').getAttribute('aria-label'), 'Fill Five, 3 uses remaining');
});

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

function drawnSpools(app, since = 0) {
  return app.metrics.drawImages.slice(since).filter(call =>
    call.owner === 'board' && call.args[0].height <= CELL * 2);
}

async function startClear(app, { multipleRows = false } = {}) {
  const board = new app.game.board.constructor();
  board.addSpool({ row: ROWS - 1, col: 0, length: 4, color: '#a8caa5' });
  const trigger = board.addSpool({ row: ROWS - 1, col: 8, length: 1, color: '#a6c8df' });
  const clearingIds = [
    board.addSpool({ row: ROWS - 2, col: 0, length: 5, color: '#f59ba7' }).id,
    board.addSpool({ row: ROWS - 2, col: 5, length: 4, color: '#f4c776' }).id,
  ];
  const survivor = board.addSpool({ row: ROWS - 3, col: 0, length: 1, color: '#c5b1e0' });
  if (multipleRows) {
    board.addSpool({ row: ROWS - 3, col: 5, length: 1, color: '#a6c8df' });
    clearingIds.push(
      board.addSpool({ row: ROWS - 4, col: 0, length: 4, color: '#f4c776' }).id,
      board.addSpool({ row: ROWS - 4, col: 4, length: 5, color: '#f59ba7' }).id,
    );
  }
  // Repeated queued insertions remain sparse and deterministic, so an extra
  // row cannot be concealed by an unrelated random clear in these fixtures.
  board.makeRow = () => [
    { col: 0, length: 2, color: '#a8caa5' },
    { col: 6, length: 2, color: '#a6c8df' },
  ];
  app.game.board = board;
  app.game.nextRow = board.makeRow();
  app.game.notify();
  await app.advance(0);
  app.pointer('pointerdown', 255);
  app.pointer('pointermove', 225);
  app.pointer('pointerup', 225);
  await app.advance(0);
  assert.equal(app.game.state, 'CLEARING');
  assert.equal(app.animations.length, 1);
  assert.equal(app.animations[0].frame.kind, 'clear');
  return { board, trigger, clearingIds, survivor, survivorY: (ROWS - 2.5) * CELL };
}

async function sampleBoardFrame(app, milliseconds) {
  const firstImage = app.metrics.drawImages.length;
  await app.advance(milliseconds);
  const boardImages = app.metrics.drawImages.slice(firstImage).filter(call => call.owner === 'board');
  return {
    spools: drawnSpools(app, firstImage),
    background: boardImages.find(call => call.args[0].height > CELL * 2),
    notice: scoreNoticeSnapshot(app),
  };
}

function scoreNoticeSnapshot(app) {
  const notice = app.getElement('score-notice');
  return {
    text: notice.textContent,
    hidden: notice.hidden,
    alpha: Number(notice.style.opacity),
    layout: Object.fromEntries(Object.entries(notice.style).filter(([key]) => key !== 'opacity')),
  };
}

test('score feedback has its own slot above the board and restart shares the item controls', () => {
  const noticeSlot = HTML_SOURCE.match(/<div\b[^>]*class="[^"]*\bscore-notice-slot\b[^"]*"[^>]*>[\s\S]*?<\/div>/);
  assert.ok(noticeSlot, 'score feedback needs a reserved element outside the canvas');
  assert.match(noticeSlot[0], /<span\b[^>]*id="score-notice"[^>]*\bhidden\b[^>]*>/);
  const boardRegion = HTML_SOURCE.search(/<div\b[^>]*id="board-region"[^>]*>/);
  assert.ok(boardRegion >= noticeSlot.index + noticeSlot[0].length, 'the notice slot closes before the board region begins');
  const itemToolbar = HTML_SOURCE.match(/<div\b[^>]*class="[^"]*\bitem-toolbar\b[^"]*"[^>]*>[\s\S]*?<\/div>/);
  assert.ok(itemToolbar);
  for (const id of ['item-cutter', 'item-color', 'item-fill', 'restart-button']) {
    assert.match(itemToolbar[0], new RegExp(`<button\\b[^>]*id="${id}"[^>]*>`));
  }
  assert.doesNotMatch(HTML_SOURCE, /id="(?:help-button|close-help|help-overlay)"/);
  assert.doesNotMatch(HTML_SOURCE, /class="[^"]*\bgame-toolbar\b/);
});

test('score feedback hides when its clear ends, stays cleared through restart, and shows fresh clear points', async () => {
  const app = browserHarness();
  const notice = app.getElement('score-notice');
  assert.equal(notice.hidden, true);
  assert.equal(notice.textContent, '');
  await startClear(app);
  assert.equal(notice.hidden, false);
  assert.equal(notice.textContent, 'MEOW-VELOUS!  +100');
  assert.equal(notice.style.opacity, '1');
  await app.advance(1400);
  assert.equal(app.game.score, 100);
  assert.equal(notice.hidden, true, 'feedback disappears when the clear finishes, before the following fall');
  assert.equal(notice.textContent, '');
  assert.equal(notice.style.opacity, '0');
  await app.finishAnimations();
  app.getElement('restart-button').emit('click');
  assert.equal(app.getElement('restart-overlay').hidden, false);
  app.getElement('cancel-restart').emit('click');
  assert.equal(app.game.score, 100);
  assert.equal(notice.hidden, true);
  app.getElement('restart-button').emit('click');
  app.getElement('confirm-restart').emit('click');
  assert.equal(app.game.score, 0);
  assert.equal(notice.hidden, true);
  assert.equal(notice.textContent, '');
  assert.equal(notice.style.opacity, '0');
  app.animations.length = 0;
  await startClear(app, { multipleRows: true });
  assert.equal(notice.hidden, false);
  assert.equal(notice.textContent, '2 ROWS  +200');
  assert.equal(notice.style.opacity, '1');
  await app.finishAnimations();
  assert.equal(notice.hidden, true);
  assert.equal(notice.textContent, '');
  assert.deepEqual(app.metrics.texts.filter(call => call.owner === 'board'), [], 'score feedback never draws over board cells');
});

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

test('normal drops land independently while reduced-motion drops share one linear progress', async () => {
  for (const reducedMotion of [false, true]) {
    const app = browserHarness({ reducedMotion });
    const board = new app.game.board.constructor();
    const pieces = [
      { row: 0, col: 0, targetCol: 1, drop: 11, duration: 550 },
      { row: 10, col: 4, targetCol: 4, drop: 1, duration: 250 },
      { row: 7, col: 6, targetCol: 6, drop: 4, duration: 500 },
      { row: 6, col: 8, targetCol: 8, drop: 5, duration: 550 },
      { row: 11, col: 2, targetCol: 2, drop: 0, duration: 0 },
    ];
    for (const piece of pieces) board.addSpool({ row: piece.row, col: piece.col, length: 1, color: '#a8caa5' });
    app.game.board = board;
    app.game.notify();
    await app.advance(0);
    app.pointer('pointerdown', 15, 15);
    app.pointer('pointermove', 45, 15);
    app.pointer('pointerup', 45, 15);
    await app.advance(0);
    assert.equal(app.animations[0].frame.kind, 'fall');
    assert.equal(app.animations[0].frame.maxDrop, 11);
    assert.equal(app.animations[0].frame.duration, 550);

    const times = reducedMotion ? [0, 8.75, 17.5, 34, 35] : [0, 125, 249, 250, 500, 549, 550];
    let elapsed = 0;
    for (const time of times) {
      const firstImage = app.metrics.drawImages.length;
      await app.advance(time - elapsed);
      elapsed = time;
      const images = drawnSpools(app, firstImage);
      assert.equal(images.length, pieces.length);
      for (const piece of pieces) {
        const image = images.find(call => call.args[1] === piece.targetCol * CELL);
        assert.ok(image);
        const progress = piece.drop === 0 ? 0 : reducedMotion ? time / 35 : Math.min(1, time / piece.duration);
        const expectedY = (piece.row + piece.drop * progress) * CELL;
        assert.ok(Number.isFinite(image.args[2]));
        assert.ok(Math.abs(image.args[2] - expectedY) < 1e-8,
          `${reducedMotion ? 'reduced' : 'normal'} drop ${piece.drop} at ${time} ms`);
        assert.equal(image.args[3], CELL, 'a falling spool keeps its width');
        assert.equal(image.alpha, 1);
      }
      assert.equal(app.game.state, 'RESOLVING');
      assert.equal(app.game.moves, 1);
      assert.equal(app.game.beginDrag(board.snapshot()[0].id), false);
      if (time < times.at(-1)) assert.equal(app.animations.length, 1);
    }
    assert.equal(app.animations[1].frame.kind, 'settle');
    assert.equal(app.animations[1].now, reducedMotion ? 35 : 550);
    await app.finishAnimations();
    assert.equal(app.game.state, 'IDLE');
    assert.equal(app.animations.filter(({ frame }) => frame.kind === 'insert').length, 1);
    board.assertValid();
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
  assert.equal(reduced.game.state, 'RESOLVING');
  assert.equal(reduced.animations.at(-1).frame.kind, 'settle');
  assert.equal(reduced.animations.at(-1).now, 35);
  await reduced.advance(199);
  assert.equal(reduced.game.state, 'RESOLVING', 'reduced motion keeps the whole settle pause');
  await reduced.advance(1);
  assert.equal(reduced.game.state, 'INSERTING_ROW');
  assert.equal(reduced.animations.at(-1).now, 235);
  await reduced.advance(35);
  assert.equal(reduced.game.state, 'IDLE');
  await normal.finishAnimations();
  await reduced.finishAnimations();
  assert.deepEqual(plainSnapshot(reduced), plainSnapshot(normal));
  assert.equal(reduced.game.moves, normal.game.moves);
  assert.equal(reduced.game.score, normal.game.score);
  assert.equal(reduced.pendingFrames, 0);
});

test('completed rows and score feedback hold for 1250 ms and fade together until 1400 ms in both motion modes', async () => {
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
    assert.equal(app.animations[0].frame.duration, 1400);
    assert.equal(app.animations[0].frame.holdDuration, 1250);
    let elapsed = 0;
    let initialPositions;
    let noticeLayout;
    let previousFade = 1;
    let holdHighlight;
    let previousHighlight;

    for (const interval of [0, 625, 624, 1, 75, 74]) {
      const imageStart = app.metrics.drawImages.length;
      const fillStart = app.metrics.fills.length;
      await app.advance(interval);
      elapsed += interval;
      const images = app.metrics.drawImages.slice(imageStart).filter(call =>
        call.owner === 'board' && call.args[0].height <= CELL * 2);
      const positions = images.map(({ args }) => ({ x: args[1], y: args[2], width: args[3], height: args[4] }));
      assert.equal(images.length, frozenBoard.length);
      if (!initialPositions) initialPositions = positions;
      else positions.forEach((position, index) => {
        const initial = initialPositions[index];
        assert.equal(position.y, initial.y, 'no spool falls during the clear');
        assert.equal(position.width, initial.width);
        assert.equal(position.height, initial.height);
        if (reducedMotion || initial.y !== (ROWS - 2) * CELL || elapsed >= 1250) {
          assert.equal(position.x, initial.x, 'survivors and reduced-motion pieces stay fixed; fading starts at rest');
        } else {
          assert.ok(position.x <= initial.x + 1e-8 && position.x >= initial.x - 8,
            'only clearing spools can sway slightly to the left');
        }
      });
      const clearing = images.filter(call => call.args[2] === (ROWS - 2) * CELL);
      assert.equal(clearing.length, 2);
      assert.equal(clearing[0].alpha, clearing[1].alpha, 'the row fades as one simultaneous batch');
      if (elapsed <= 1250) assert.ok(clearing.every(call => call.alpha === 1), 'hold keeps completed rows fully opaque');
      else {
        assert.ok(clearing[0].alpha >= 0 && clearing[0].alpha < previousFade, 'the final 150 ms softly fades the row');
        previousFade = clearing[0].alpha;
      }
      assert.ok(images.filter(call => call.args[2] !== (ROWS - 2) * CELL).every(call => call.alpha === 1));
      const notice = scoreNoticeSnapshot(app);
      assert.equal(notice.hidden, false, 'clear feedback remains present during the reaction interval');
      assert.equal(notice.text, 'MEOW-VELOUS!  +100');
      assert.equal(notice.alpha, clearing[0].alpha, 'score notice and completed rows use the exact same hold and fade clock');
      const expectedAlpha = elapsed <= 1250 ? 1 : 1 - (elapsed - 1250) / 150;
      assert.ok(Math.abs(notice.alpha - expectedAlpha) < 1e-10);
      if (noticeLayout === undefined) noticeLayout = notice.layout;
      else assert.deepEqual(notice.layout, noticeLayout, 'score feedback does not move with the resting board');
      assert.deepEqual(app.metrics.texts.filter(call => call.owner === 'board'), []);
      const rowHighlights = app.metrics.fills.slice(fillStart).filter(call =>
        call.owner === 'board' && call.args[2] === COLS * CELL && call.args[3] === CELL);
      assert.equal(rowHighlights.length, 1);
      const highlight = Number(rowHighlights[0].color.match(/,\s*([\d.]+)\)$/)[1]);
      if (holdHighlight === undefined) holdHighlight = highlight;
      if (elapsed <= 1250) assert.equal(highlight, holdHighlight, 'the row highlight stays steady during the hold');
      else assert.ok(highlight >= 0 && highlight < previousHighlight, 'the highlight fades without pulsing');
      previousHighlight = highlight;

      assert.deepEqual(plainSnapshot(app), frozenBoard);
      assert.ok(clearingIds.every(id => board.getSpool(id)));
      assert.equal(board.getSpool(survivor.id).row, ROWS - 3);
      assert.equal(board.nextId, nextId);
      assert.equal(app.game.nextRow, incoming);
      assert.equal(app.game.score, 0);
      assert.equal(app.game.state, 'CLEARING');
      assert.equal(app.game.reset(), false);
      assert.equal(app.game.canBeginDrag(survivor.id), true, 'surviving rows remain available during the clear');
      assert.equal(app.game.beginDrag(clearingIds[0]), false, 'the completed batch cannot move');
      assert.equal(app.animations.length, 1, 'no gravity or insertion can begin before the clear ends');
    }

    assert.equal(elapsed, 1399);
    await app.advance(1);
    assert.ok(clearingIds.every(id => board.getSpool(id) === null));
    assert.equal(app.game.score, 100);
    assert.equal(app.animations.length, 2);
    assert.equal(app.animations[1].frame.kind, 'fall');
    assert.equal(app.animations[1].now, 1400, 'following gravity begins only after the full reaction interval');
    await app.finishAnimations();
    assert.equal(app.game.state, 'IDLE');
    assert.equal(app.game.score, 100);
    assert.equal(app.game.moves, 1);
    assert.equal(app.animations.filter(({ frame }) => frame.kind === 'insert').length, 1);
    board.assertValid();
  }
});

test('a whole turn preserves its pacing when no additional drag is made during the clear', async () => {
  let normalFinalBoard;
  for (const reducedMotion of [false, true]) {
    const app = browserHarness({ reducedMotion });
    const board = new app.game.board.constructor();
    board.addSpool({ row: ROWS - 1, col: 0, length: 4, color: '#a8caa5' });
    board.addSpool({ row: ROWS - 1, col: 7, length: 1, color: '#a6c8df' });
    board.addSpool({ row: ROWS - 2, col: 0, length: 5, color: '#f59ba7' });
    board.addSpool({ row: ROWS - 2, col: 5, length: 4, color: '#f4c776' });
    board.addSpool({ row: ROWS - 3, col: 0, length: 1, color: '#c5b1e0' });
    const selected = board.addSpool({ row: ROWS - 4, col: 8, length: 1, color: '#f59ba7' });
    app.game.board = board;
    app.game.nextRow = [
      { col: 1, length: 2, color: '#a8caa5' },
      { col: 4, length: 2, color: '#a6c8df' },
    ];
    const incoming = app.game.nextRow;
    app.game.notify();
    await app.advance(0);
    const dragY = (ROWS - 3.5) * CELL;
    app.pointer('pointerdown', 255, dragY);
    app.pointer('pointermove', 225, dragY);
    app.pointer('pointerup', 225, dragY);
    await app.advance(0);

    // Every fall is one cell in this fixture. The incoming row leaves column
    // seven empty, creating a real final fall after its rise has completed.
    const phases = [
      { kind: 'fall', duration: 250 },
      { kind: 'clear', duration: 1400 },
      { kind: 'fall', duration: 250 },
      { kind: 'settle', duration: 200 },
      { kind: 'insert', duration: 180 },
      { kind: 'fall', duration: 250 },
    ];
    let elapsed = 0;
    for (let index = 0; index < phases.length; index += 1) {
      const phase = phases[index];
      const animation = app.animations[index];
      assert.equal(app.animations.length, index + 1, 'only one phase may be active');
      assert.equal(animation.frame.kind, phase.kind);
      assert.equal(animation.frame.duration, phase.duration);
      assert.equal(animation.now, elapsed, `${phase.kind} begins as the previous phase ends`);
      const duration = reducedMotion && ['fall', 'insert'].includes(phase.kind) ? 35 : phase.duration;
      const frozenBoard = plainSnapshot(app);
      const frozenNextId = board.nextId;
      let restingPositions;
      for (const interval of [0, duration / 2, duration / 2 - 1]) {
        const firstImage = app.metrics.drawImages.length;
        await app.advance(interval);
        assert.equal(app.animations.length, index + 1, 'the following phase must wait for the full duration');
        assert.deepEqual(plainSnapshot(app), frozenBoard);
        assert.equal(board.nextId, frozenNextId);
        assert.equal(app.game.nextRow, incoming, 'the next preview cannot advance during a turn');
        assert.equal(app.game.score, index < 2 ? 0 : 100);
        assert.equal(app.game.moves, 1);
        assert.equal(app.game.state, phase.kind === 'insert' ? 'INSERTING_ROW' : phase.kind === 'clear' ? 'CLEARING' : 'RESOLVING');
        assert.equal(app.getElement('next-row').dataset.visible, String(phase.kind === 'insert'));
        assert.equal(app.getElement('restart-button').disabled, true);
        const lockedY = phase.kind === 'clear' ? (ROWS - 1.5) * CELL : BOTTOM_CENTER_Y;
        app.pointer('pointerdown', 225, lockedY);
        app.pointer('pointermove', 195, lockedY);
        app.pointer('pointerup', 195, lockedY);
        assert.equal(app.game.drag, null);
        const lockedId = phase.kind === 'clear' ? board.grid[ROWS - 2][0] : selected.id;
        assert.equal(app.game.beginDrag(lockedId), false);
        assert.equal(app.game.reset(), false);
        assert.deepEqual(plainSnapshot(app), frozenBoard, 'locked pointer events cannot move a spool');
        if (phase.kind === 'settle') {
          const images = drawnSpools(app, firstImage);
          const positions = images.map(({ args }) => ({ x: args[1], y: args[2], width: args[3], height: args[4] }));
          assert.equal(images.length, frozenBoard.length);
          assert.ok(images.every(image => image.alpha === 1));
          if (!restingPositions) restingPositions = positions;
          else assert.deepEqual(positions, restingPositions, 'the entire board rests throughout the settle beat');
          assert.equal(JSON.stringify(animation.frame.before), JSON.stringify(animation.frame.after));
        }
      }
      await app.advance(1);
      elapsed += duration;
    }

    assert.equal(elapsed, reducedMotion ? 1740 : 2530, 'the complete turn obeys the combined phase budget');
    assert.deepEqual(app.animations.map(({ frame }) => frame.kind), phases.map(phase => phase.kind));
    assert.equal(app.game.state, 'IDLE');
    assert.equal(app.game.moves, 1);
    assert.equal(app.game.score, 100);
    assert.notEqual(app.game.nextRow, incoming);
    assert.equal(app.getElement('next-row').dataset.visible, 'true');
    assert.equal(app.getElement('restart-button').disabled, false);
    assert.equal(board.getSpool(selected.id).row, ROWS - 2);
    if (!normalFinalBoard) normalFinalBoard = plainSnapshot(app);
    else assert.deepEqual(plainSnapshot(app), normalFinalBoard, 'motion preference cannot change the outcome');
    await app.advance(0);
    assert.equal(app.pendingFrames, 0);
    board.assertValid();
  }
});

test('touch dragging a surviving row during a clear updates its live position and queues one extra insertion', async () => {
  for (const reducedMotion of [false, true]) {
    const app = browserHarness({ reducedMotion });
    const { board, clearingIds, survivor, survivorY } = await startClear(app);
    const batchBefore = clearingIds.map(id => ({ ...board.getSpool(id) }));
    const incoming = app.game.nextRow;
    const nextId = board.nextId;

    app.pointer('pointerdown', 15, (ROWS - 1.5) * CELL);
    app.pointer('pointermove', 75, (ROWS - 1.5) * CELL);
    app.pointer('pointerup', 75, (ROWS - 1.5) * CELL);
    assert.equal(app.game.drag, null, 'a clearing row cannot be acquired');
    assert.equal(app.game.moves, 1);
    await app.advance(250);
    app.pointer('pointerdown', 15, survivorY);
    app.pointer('pointermove', 75, 1);
    assert.equal(app.game.drag.id, survivor.id);
    assert.equal(app.game.state, 'CLEARING');
    assert.equal(board.getSpool(survivor.id).col, 2);
    assert.equal(board.getSpool(survivor.id).row, ROWS - 3, 'vertical pointer motion cannot move the spool down');
    assert.equal(app.game.canBeginDrag(board.snapshot()[0].id), false, 'only one gesture can be held');

    for (const interval of [0, 1075]) {
      const firstImage = app.metrics.drawImages.length;
      await app.advance(interval);
      const images = drawnSpools(app, firstImage);
      const moving = images.find(image => image.args[2] === (ROWS - 3) * CELL);
      assert.ok(moving, 'the surviving spool is drawn while dragging');
      assert.equal(moving.args[1], 2 * CELL, 'the clear renders live metadata rather than the original snapshot');
      assert.equal(moving.alpha, 1);
      const clearing = images.filter(image => image.args[2] === (ROWS - 2) * CELL);
      const expectedAlpha = interval === 0 ? 1 : 0.5;
      assert.ok(clearing.every(image => image.alpha === expectedAlpha));
      assert.deepEqual(clearingIds.map(id => ({ ...board.getSpool(id) })), batchBefore);
      const notice = scoreNoticeSnapshot(app);
      assert.equal(notice.hidden, false);
      assert.equal(notice.text, 'MEOW-VELOUS!  +100');
      assert.equal(notice.alpha, expectedAlpha, 'dragging cannot restart the clear or score-notice clock');
      assert.equal(board.getSpool(survivor.id).row, ROWS - 3);
      assert.equal(app.animations.length, 1, 'horizontal input must not start gravity during the clear');
      assert.equal(board.nextId, nextId);
      assert.equal(app.game.nextRow, incoming);
    }

    app.pointer('pointerup', 75, 1);
    assert.equal(app.game.drag, null);
    assert.equal(app.game.state, 'CLEARING');
    assert.equal(app.game.moves, 2, 'only release commits the additional move');
    await app.advance(74);
    assert.equal(app.game.score, 0);
    assert.equal(app.animations.length, 1);
    await app.advance(1);
    assert.equal(app.game.score, 100);
    assert.ok(clearingIds.every(id => board.getSpool(id) === null));
    assert.equal(app.animations[1].frame.kind, 'fall');
    assert.equal(app.animations[1].now, 1400);
    await app.finishAnimations();
    assert.equal(app.game.state, 'IDLE');
    assert.equal(app.game.moves, 2);
    assert.equal(app.game.score, 100);
    assert.equal(app.animations.filter(({ frame }) => frame.kind === 'insert').length, 2);
    assert.equal(app.animations.filter(({ frame }) => frame.kind === 'settle').length, 2);
    assert.equal(board.getSpool(survivor.id).col, 2);
    board.assertValid();
  }
});

test('a touch held across the clear boundary keeps moving horizontally and defers gravity until release', async () => {
  const app = browserHarness();
  const { board, trigger, clearingIds, survivor, survivorY } = await startClear(app);
  await app.advance(1300);
  app.pointer('pointerdown', 15, survivorY);
  app.pointer('pointermove', 75, survivorY);
  await app.advance(100);
  assert.equal(app.game.state, 'CLEARING');
  assert.equal(app.game.score, 100);
  assert.ok(clearingIds.every(id => board.getSpool(id) === null));
  assert.equal(app.game.drag.id, survivor.id);
  assert.equal(app.game.canBeginDrag(trigger.id), false, 'new gestures close when the clear visual ends');
  assert.equal(board.getSpool(survivor.id).row, ROWS - 3);
  assert.equal(app.animations.length, 1);
  const heldBoard = plainSnapshot(app);
  await app.advance(500);
  assert.deepEqual(plainSnapshot(app), heldBoard, 'gravity cannot run beneath a held spool');
  assert.equal(app.animations.length, 1);
  assert.equal(app.getElement('board').hasPointerCapture(1), true);

  app.pointer('pointermove', 105, survivorY);
  const firstImage = app.metrics.drawImages.length;
  await app.advance(0);
  assert.equal(board.getSpool(survivor.id).col, 3);
  const image = drawnSpools(app, firstImage).find(call => call.args[2] === (ROWS - 3) * CELL);
  assert.equal(image.args[1], 3 * CELL);
  assert.equal(image.alpha, 1);
  app.pointer('pointerup', 105, survivorY);
  await app.advance(0);
  assert.equal(app.game.drag, null);
  assert.equal(app.game.moves, 2);
  assert.equal(app.animations[1].frame.kind, 'fall');
  assert.equal(app.animations[1].now, 1900);
  assert.equal(app.getElement('board').hasPointerCapture(1), false);
  await app.finishAnimations();
  assert.equal(app.game.state, 'IDLE');
  assert.equal(app.animations.filter(({ frame }) => frame.kind === 'insert').length, 2);
  board.assertValid();
});

test('cancellation paths release a held clear-boundary gesture without consuming an additional move', async () => {
  for (const method of ['pointercancel', 'lostpointercapture', 'blur', 'resize', 'hidden']) {
    const app = browserHarness();
    const { board, survivor, survivorY } = await startClear(app);
    app.pointer('pointerdown', 15, survivorY);
    app.pointer('pointermove', 75, survivorY);
    await app.advance(1400);
    assert.equal(app.game.state, 'CLEARING');
    assert.equal(app.game.drag.id, survivor.id);
    assert.equal(app.animations.length, 1);

    if (method === 'pointercancel') app.pointer('pointercancel', 75, survivorY);
    else if (method === 'lostpointercapture') app.getElement('board').releasePointerCapture(1);
    else if (method === 'blur') app.blur();
    else if (method === 'resize') app.resize(COLS * 20, ROWS * 20);
    else app.setHidden(true);
    assert.equal(app.game.drag, null, method);
    assert.equal(board.getSpool(survivor.id).col, 0, `${method} rolls back the held move`);
    assert.equal(app.game.moves, 1);
    assert.equal(app.getElement('board').hasPointerCapture(1), false);
    app.pointer('pointerup', 75, survivorY);
    await app.advance(0);
    assert.equal(app.animations[1].frame.kind, 'fall', `${method} must wake the waiting resolver`);
    if (method === 'hidden') {
      const paintCount = app.metrics.boardPaints;
      await app.advance(2000);
      assert.equal(app.pendingFrames, 0);
      assert.equal(app.metrics.boardPaints, paintCount);
      assert.equal(app.animations.length, 2, 'a fall scheduled while hidden must stay paused');
      app.setHidden(false);
    }
    await app.finishAnimations();
    assert.equal(app.game.state, 'IDLE', method);
    assert.equal(app.game.moves, 1);
    assert.equal(app.game.score, 100);
    assert.equal(app.animations.filter(({ frame }) => frame.kind === 'insert').length, 1);
    board.assertValid();
  }
});

test('keyboard clear-time selection skips disappearing rows, Enter commits, and Escape wakes a held boundary', async () => {
  const app = browserHarness();
  const { board, survivor } = await startClear(app);
  function selectSurvivor() {
    // Two bottom spools precede the survivor. The full row between them must
    // be filtered out of keyboard selection while its clear is active.
    for (let index = 0; index < 3; index += 1) app.key('ArrowUp');
    app.key('Enter');
    assert.equal(app.game.drag.id, survivor.id);
  }
  selectSurvivor();
  app.key('ArrowRight');
  assert.equal(board.getSpool(survivor.id).col, 1);
  app.key('Escape');
  assert.equal(board.getSpool(survivor.id).col, 0);
  assert.equal(app.game.state, 'CLEARING');
  assert.equal(app.game.moves, 1);

  app.key('Enter');
  app.key('Enter');
  assert.equal(app.game.drag, null);
  assert.equal(app.game.moves, 1, 'an Enter tap without horizontal movement is a no-op');
  selectSurvivor();
  app.key('ArrowRight');
  app.key('Enter');
  assert.equal(app.game.drag, null);
  assert.equal(app.game.state, 'CLEARING');
  assert.equal(app.game.moves, 2);
  selectSurvivor();
  app.key('ArrowRight');
  assert.equal(board.getSpool(survivor.id).col, 2);
  await app.advance(1400);
  assert.equal(app.game.state, 'CLEARING');
  assert.equal(app.game.score, 100);
  assert.equal(app.animations.length, 1);
  app.key('Escape');
  assert.equal(app.game.drag, null);
  assert.equal(board.getSpool(survivor.id).col, 1, 'Escape restores the last committed column');
  await app.advance(0);
  assert.equal(app.animations[1].frame.kind, 'fall');
  await app.finishAnimations();
  assert.equal(app.game.state, 'IDLE');
  assert.equal(app.game.moves, 2);
  assert.equal(app.animations.filter(({ frame }) => frame.kind === 'insert').length, 2);
  board.assertValid();
});

test('all clearing rows share three diminishing sweeps while survivors, background, score notice, and grid stay fixed', async () => {
  for (const { unit, reducedMotion } of [
    { unit: 30, reducedMotion: false },
    { unit: 40, reducedMotion: false },
    { unit: 40, reducedMotion: true },
  ]) {
    const app = browserHarness({ reducedMotion });
    const { board, clearingIds } = await startClear(app, { multipleRows: true });
    app.resize(COLS * unit, ROWS * unit);
    await app.advance(0);
    const before = plainSnapshot(app);
    const beforeGrid = JSON.stringify(board.grid);
    const nextId = board.nextId;
    const incoming = app.game.nextRow;
    const clearSet = new Set(clearingIds);
    assert.deepEqual(JSON.parse(JSON.stringify(app.animations[0].frame.rows)), [ROWS - 4, ROWS - 2]);
    const warmArtCount = app.metrics.canvasCreations;
    const warmPaintCount = app.metrics.offscreenPaints;
    let baselineBackground;
    let baselineNoticeLayout;
    let elapsed = 0;
    // The first midpoint and each extremum/return make the three leftward
    // sweeps observable, without using the production sampler as the oracle.
    const keyframes = [
      [0, 0], [125, -0.12], [250, -0.24], [500, 0], [700, -0.12],
      [900, 0], [1075, -0.06], [1250, 0], [1325, 0], [1399, 0],
    ];
    for (const [time, cellOffset] of keyframes) {
      const frame = await sampleBoardFrame(app, time - elapsed);
      elapsed = time;
      assert.equal(frame.spools.length, before.length);
      const offset = reducedMotion ? 0 : cellOffset * Math.min(unit, 8 / 0.24);
      const expectedAlpha = time <= 1250 ? 1 : 1 - (time - 1250) / 150;
      frame.spools.forEach((image, index) => {
        const spool = before[index];
        const isClearing = clearSet.has(spool.id);
        const x = spool.col * unit + (isClearing ? offset : 0);
        assert.ok(Math.abs(image.args[1] - x) < 1e-8,
          `row ${spool.row}, col ${spool.col}, ${time} ms, cell ${unit}, reduced ${reducedMotion}`);
        assert.equal(image.args[2], spool.row * unit, 'the sway never changes vertical positions');
        assert.equal(image.args[3], spool.length * unit);
        assert.equal(image.args[4], unit);
        assert.ok(Math.abs(image.alpha - (isClearing ? expectedAlpha : 1)) < 1e-10);
        assert.ok(Math.abs(image.args[1] - spool.col * unit) <= 8 + 1e-8, 'the screen-space amplitude is capped');
      });
      assert.ok(frame.background);
      const backgroundDestination = frame.background.args.slice(1);
      if (!baselineBackground) baselineBackground = backgroundDestination;
      else assert.deepEqual(backgroundDestination, baselineBackground, 'the board background never sways');
      assert.equal(frame.notice.hidden, false);
      assert.equal(frame.notice.text, '2 ROWS  +200');
      if (!baselineNoticeLayout) baselineNoticeLayout = frame.notice.layout;
      else assert.deepEqual(frame.notice.layout, baselineNoticeLayout, 'score text does not follow the row motion');
      assert.ok(Math.abs(frame.notice.alpha - expectedAlpha) < 1e-10);
      assert.deepEqual(app.metrics.texts.filter(call => call.owner === 'board'), [], 'the canvas contains only the board visuals');
      assert.deepEqual(plainSnapshot(app), before, 'horizontal motion is visual only');
      assert.equal(JSON.stringify(board.grid), beforeGrid);
      assert.equal(board.nextId, nextId);
      assert.equal(app.game.nextRow, incoming);
      assert.equal(app.game.score, 0);
      assert.equal(app.game.state, 'CLEARING');
      assert.equal(app.animations.length, 1);
      assert.equal(app.metrics.canvasCreations, warmArtCount, 'sway reuses cached sprites');
      assert.equal(app.metrics.offscreenPaints, warmPaintCount);
    }
    await app.advance(1);
    assert.ok(clearingIds.every(id => board.getSpool(id) === null));
    assert.equal(app.game.score, 200, 'both rows score together only after the full clear');
    assert.equal(app.animations[1].frame.kind, 'fall');
    assert.equal(app.animations[1].now, 1400);
    await app.finishAnimations();
    assert.equal(app.game.state, 'IDLE');
    assert.equal(app.animations.filter(({ frame }) => frame.kind === 'insert').length, 1);
    board.assertValid();
  }
});

test('clear sway uses visible elapsed time across frame rates and pauses with the hidden tab', async () => {
  function cadence(hz) {
    const intervals = [];
    let remaining = 625;
    while (remaining > 1000 / hz) {
      intervals.push(1000 / hz);
      remaining -= 1000 / hz;
    }
    intervals.push(remaining);
    return intervals;
  }
  let expectedPositions;
  let expectedFinalBoard;
  for (const intervals of [cadence(30), cadence(60), cadence(120), [17, 233, 1, 300, 74]]) {
    const app = browserHarness();
    await startClear(app);
    for (const interval of intervals) await app.advance(interval);
    const frame = await sampleBoardFrame(app, 0);
    const positions = frame.spools.map(image => image.args.slice(1));
    if (!expectedPositions) expectedPositions = positions;
    else positions.forEach((position, index) => position.forEach((value, axis) =>
      assert.ok(Math.abs(value - expectedPositions[index][axis]) < 1e-8,
        'identical elapsed time gives identical clearing-row positions')));
    assert.equal(app.game.state, 'CLEARING');
    assert.equal(app.game.score, 0);
    await app.finishAnimations();
    if (!expectedFinalBoard) expectedFinalBoard = plainSnapshot(app);
    else assert.deepEqual(plainSnapshot(app), expectedFinalBoard);
  }

  const app = browserHarness();
  const { board, clearingIds } = await startClear(app);
  const beforeHide = await sampleBoardFrame(app, 625);
  const frozenBoard = plainSnapshot(app);
  const paintCount = app.metrics.boardPaints;
  app.setHidden(true);
  await app.advance(10000);
  assert.equal(app.pendingFrames, 0);
  assert.equal(app.metrics.boardPaints, paintCount);
  assert.deepEqual(plainSnapshot(app), frozenBoard);
  assert.equal(app.game.state, 'CLEARING');
  assert.equal(app.game.score, 0);
  app.setHidden(false);
  const resumed = await sampleBoardFrame(app, 0);
  assert.deepEqual(resumed.spools.map(image => image.args.slice(1)), beforeHide.spools.map(image => image.args.slice(1)),
    'returning from a hidden tab resumes the sway at the same position');
  assert.deepEqual(resumed.notice, beforeHide.notice, 'the fixed score notice also resumes at the same opacity and text');
  const rested = await sampleBoardFrame(app, 625);
  rested.spools.forEach((image, index) => assert.equal(image.args[1], frozenBoard[index].col * CELL));
  const fading = await sampleBoardFrame(app, 75);
  assert.equal(fading.notice.hidden, false);
  assert.equal(fading.notice.text, 'MEOW-VELOUS!  +100');
  assert.equal(fading.notice.alpha, 0.5);
  const fadingRows = fading.spools.filter(image => image.args[2] === (ROWS - 2) * CELL);
  assert.ok(fadingRows.every(image => image.alpha === 0.5));
  assert.equal(app.game.score, 0);
  await app.advance(74);
  assert.ok(clearingIds.every(id => board.getSpool(id)));
  await app.advance(1);
  assert.ok(clearingIds.every(id => board.getSpool(id) === null));
  assert.equal(app.game.score, 100);
  assert.equal(app.animations[1].now, 11400, 'hidden time is excluded from the clear duration');
  await app.finishAnimations();
  assert.equal(app.game.state, 'IDLE');
  assert.deepEqual(plainSnapshot(app), expectedFinalBoard);
});
