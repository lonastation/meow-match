/* Meow Match: deterministic, DOM-free board rules. */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.MeowEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const COLS = 9;
  const ROWS = 12;
  const COLORS = Object.freeze(["#f59ba7", "#f4c776", "#a8caa5", "#a6c8df", "#c5b1e0"]);
  const ROW_LAYOUT_CACHE = new Map();

  function rowLayouts(occupied, gap) {
    const key = occupied + ":" + gap;
    if (ROW_LAYOUT_CACHE.has(key)) return ROW_LAYOUT_CACHE.get(key);
    const layouts = [];

    // Enumerate only fresh two- or three-spool layouts. Depth is at most three
    // on a nine-cell row: generation is bounded and never relies on retries.
    function place(nextCol, remaining, pieces, mask, singles) {
      if (remaining === 0) {
        if (pieces.length >= 2) {
          layouts.push({
            pieces: pieces.slice(), mask, singles,
            weight: pieces.some((piece) => piece.length === 5) ? 1 : 3
          });
        }
        return;
      }
      if (pieces.length === 3) return;
      for (let col = nextCol; col < COLS; col += 1) {
        for (let length = 1; length <= Math.min(5, remaining, COLS - col); length += 1) {
          if (col <= gap && col + length > gap) continue;
          if (length === 1 && singles === 1) continue;
          pieces.push({ col, length });
          const cells = ((1 << length) - 1) << col;
          place(col + length, remaining - length, pieces, mask | cells, singles + (length === 1 ? 1 : 0));
          pieces.pop();
        }
      }
    }

    place(0, occupied, [], 0, 0);
    ROW_LAYOUT_CACHE.set(key, layouts);
    return layouts;
  }

  function emptyGrid() {
    return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  }

  function requireInteger(value, name, min, max) {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new RangeError(name + " must be an integer from " + min + " to " + max + ".");
    }
  }

  class Board {
    constructor({ random = Math.random } = {}) {
      if (typeof random !== "function") throw new TypeError("random must be a function.");
      this.random = random;
      this.grid = emptyGrid();
      this.spools = new Map();
      this.nextId = 1;
    }

    _int(limit) {
      const value = this.random();
      if (!Number.isFinite(value) || value < 0 || value >= 1) {
        throw new RangeError("random() must return a number in [0, 1).");
      }
      return Math.floor(value * limit);
    }

    _color(color) {
      if (color === undefined) return COLORS[this._int(COLORS.length)];
      if (typeof color !== "string" || !color.trim()) throw new TypeError("Invalid spool color.");
      return color;
    }

    _requireSpool(id) {
      const spool = this.spools.get(id);
      if (!spool) throw new Error("Unknown spool: " + id);
      return spool;
    }

    _validatePlacement({ row, col, length }) {
      requireInteger(row, "row", 0, ROWS - 1);
      requireInteger(col, "col", 0, COLS - 1);
      requireInteger(length, "length", 1, 5);
      if (col + length > COLS) throw new RangeError("Spool extends beyond the board.");
    }

    // The grid is the collision and occupancy authority. Metadata describes each ID.
    addSpool({ id = this.nextId, row, col, length, color } = {}) {
      this._validatePlacement({ row, col, length });
      requireInteger(id, "id", 1, Number.MAX_SAFE_INTEGER - 1);
      if (this.spools.has(id)) throw new Error("Duplicate spool ID: " + id);
      for (let x = col; x < col + length; x += 1) {
        if (this.grid[row][x] !== null) throw new Error("Spools cannot overlap.");
      }
      const spool = { id, row, col, length, color: this._color(color) };
      this.spools.set(id, spool);
      for (let x = col; x < col + length; x += 1) this.grid[row][x] = id;
      this.nextId = Math.max(this.nextId, id + 1);
      return spool;
    }

    getSpool(id) {
      return this.spools.get(id) || null;
    }

    snapshot() {
      return Array.from(this.spools.values(), (spool) => ({ ...spool }));
    }

    reset() {
      this.grid = emptyGrid();
      this.spools = new Map();
      this.nextId = 1;

      // A shared empty column prevents automatic opening clears. A supported
      // column keeps the opening exactly three rows high after settling.
      // All other cells, piece boundaries, lengths, and colors are randomized.
      const height = 3;
      const gap = this._int(COLS);
      const supportChoice = this._int(COLS - 1);
      const support = supportChoice >= gap ? supportChoice + 1 : supportChoice;
      for (let row = ROWS - height; row < ROWS; row += 1) {
        for (const spec of this._makeRow(gap, support)) this.addSpool({ ...spec, row });
      }
      this.settle();
      this.assertValid();
      return this.snapshot();
    }

    dragBounds(id) {
      const spool = this._requireSpool(id);
      let min = spool.col;
      let max = spool.col;
      // Only the contiguous free interval is reachable: a long pointer jump
      // cannot teleport a spool through another spool on the same row.
      while (min > 0 && this.grid[spool.row][min - 1] === null) min -= 1;
      while (max + spool.length < COLS && this.grid[spool.row][max + spool.length] === null) max += 1;
      return { min, max };
    }

    moveSpool(id, col) {
      if (!Number.isFinite(col)) throw new TypeError("Drag column must be finite.");
      const spool = this._requireSpool(id);
      const { min, max } = this.dragBounds(id);
      const target = Math.max(min, Math.min(max, Math.round(col)));
      if (target === spool.col) return false;
      for (let x = spool.col; x < spool.col + spool.length; x += 1) this.grid[spool.row][x] = null;
      spool.col = target;
      for (let x = spool.col; x < spool.col + spool.length; x += 1) this.grid[spool.row][x] = id;
      return true;
    }

    gravityStep(onlyId = null) {
      const candidates = onlyId === null
        ? Array.from(this.spools.values()).sort((a, b) => b.row - a.row || a.col - b.col)
        : [this._requireSpool(onlyId)];
      const moved = [];
      // Bottom-first updates let a supported stack move one cell together. Each
      // spool is considered once, and even a single occupied cell below stops it.
      for (const spool of candidates) {
        if (spool.row === ROWS - 1) continue;
        let canFall = true;
        for (let x = spool.col; x < spool.col + spool.length; x += 1) {
          if (this.grid[spool.row + 1][x] !== null) {
            canFall = false;
            break;
          }
        }
        if (!canFall) continue;
        const fromRow = spool.row;
        for (let x = spool.col; x < spool.col + spool.length; x += 1) {
          this.grid[fromRow][x] = null;
          this.grid[fromRow + 1][x] = spool.id;
        }
        spool.row += 1;
        moved.push({ id: spool.id, fromRow, toRow: spool.row });
      }
      return moved;
    }

    settle(onlyId = null) {
      const moves = [];
      let step;
      do {
        step = this.gravityStep(onlyId);
        moves.push(...step);
      } while (step.length > 0);
      return moves;
    }

    fullRows() {
      const full = [];
      // Scan the whole grid without mutating it or stopping at the first match.
      for (let row = 0; row < ROWS; row += 1) {
        if (this.grid[row].every((id) => id !== null)) full.push(row);
      }
      return full;
    }

    clearRows(rows) {
      if (!Array.isArray(rows)) throw new TypeError("rows must be an array.");
      const uniqueRows = [...new Set(rows)];
      for (const row of uniqueRows) {
        requireInteger(row, "row", 0, ROWS - 1);
        if (this.grid[row].some((id) => id === null)) throw new Error("Only full rows can clear.");
      }
      const ids = new Set(uniqueRows.flatMap((row) => this.grid[row]));
      const removed = [];
      // Remove the complete batch synchronously. No gravity, rendering, or
      // callbacks run between removals, including rows far apart on the board.
      for (const id of ids) {
        const spool = this._requireSpool(id);
        removed.push({ ...spool });
        for (let x = spool.col; x < spool.col + spool.length; x += 1) this.grid[spool.row][x] = null;
        this.spools.delete(id);
      }
      // No cell compression: the caller resolves rigid-body gravity afterward.
      return removed;
    }

    _makeRow(gap, support = null) {
      const occupied = 4 + this._int(5);
      // Long spools tend to linger: wait until every existing length-five spool
      // clears before allowing another. Never resize or remove existing yarn.
      const hasLongSpool = Array.from(this.spools.values()).some((spool) => spool.length === 5);
      let candidates = rowLayouts(occupied, gap).filter((layout) =>
        (support === null || (layout.mask & (1 << support)) !== 0) &&
        (!hasLongSpool || layout.pieces.every((piece) => piece.length !== 5)));

      // Choose whole spool layouts rather than scattering individual cells,
      // which made single-cell fragments dominate. About one third of rows
      // request one singleton; most spools consequently have lengths 2–4.
      const wantSingleton = this._int(100) < 35;
      const matchingSingles = candidates.filter((layout) => (layout.singles === 1) === wantSingleton);
      if (matchingSingles.length) candidates = matchingSingles;

      // Prefer two spools, with occasional three-spool rows. A protected gap or
      // opening support can constrain the options; use the remaining valid set.
      const pieceCount = this._int(4) === 0 ? 3 : 2;
      const matchingCount = candidates.filter((layout) => layout.pieces.length === pieceCount);
      if (matchingCount.length) candidates = matchingCount;

      let ticket = this._int(candidates.reduce((sum, layout) => sum + layout.weight, 0));
      let chosen = candidates[0];
      for (const layout of candidates) {
        if (ticket < layout.weight) {
          chosen = layout;
          break;
        }
        ticket -= layout.weight;
      }
      // Return fresh specs: cached layouts and every existing spool are intact.
      return chosen.pieces.map((piece) => ({ ...piece, color: this._color() }));
    }

    makeRow() {
      return this._makeRow(this._int(COLS));
    }

    insertRow(spec = this.makeRow()) {
      // Overflow is checked before any mutation. The final frame can animate
      // the old snapshot upward while the valid board remains available.
      if (this.grid[0].some((id) => id !== null)) return { overflow: true };
      if (!Array.isArray(spec) || spec.length < 2) throw new Error("A new row needs at least two spools.");
      const bottom = Array(COLS).fill(null);
      const additions = [];
      let id = this.nextId;
      for (const piece of spec) {
        this._validatePlacement({ row: ROWS - 1, col: piece.col, length: piece.length });
        const spool = { id, row: ROWS - 1, col: piece.col, length: piece.length, color: this._color(piece.color) };
        requireInteger(id, "id", 1, Number.MAX_SAFE_INTEGER - 1);
        for (let x = spool.col; x < spool.col + spool.length; x += 1) {
          if (bottom[x] !== null) throw new Error("New-row spools cannot overlap.");
          bottom[x] = id;
        }
        additions.push(spool);
        id += 1;
      }
      if (bottom.every((cell) => cell !== null)) throw new Error("A new row must have an empty cell.");

      // Validate the complete incoming row before committing any changes.
      const shifted = new Map();
      for (const spool of this.spools.values()) shifted.set(spool.id, { ...spool, row: spool.row - 1 });
      for (const spool of additions) shifted.set(spool.id, spool);
      this.grid = this.grid.slice(1).map((row) => row.slice());
      this.grid.push(bottom);
      this.spools = shifted;
      this.nextId = id;
      return { overflow: false };
    }

    assertValid() {
      if (this.grid.length !== ROWS || this.grid.some((row) => row.length !== COLS)) {
        throw new Error("Board must contain exactly 9 columns and 12 rows.");
      }
      const counts = new Map();
      for (let row = 0; row < ROWS; row += 1) {
        for (let col = 0; col < COLS; col += 1) {
          const id = this.grid[row][col];
          if (id === null) continue;
          const spool = this.spools.get(id);
          if (!spool || spool.row !== row || col < spool.col || col >= spool.col + spool.length) {
            throw new Error("Grid and spool metadata disagree.");
          }
          counts.set(id, (counts.get(id) || 0) + 1);
        }
      }
      for (const [id, spool] of this.spools) {
        this._validatePlacement(spool);
        if (spool.id !== id || counts.get(id) !== spool.length) throw new Error("Spool cells are missing or duplicated.");
        for (let col = spool.col; col < spool.col + spool.length; col += 1) {
          if (this.grid[spool.row][col] !== id) throw new Error("Spool must be one horizontal rigid bar.");
        }
      }
      return true;
    }
  }

  return Object.freeze({ Board, COLS, ROWS, COLORS });
});
