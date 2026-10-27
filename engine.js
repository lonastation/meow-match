/* Meow Match: deterministic, DOM-free board rules. */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.MeowEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const COLS = 9;
  const ROWS = 16;
  const COLORS = Object.freeze(["#f59ba7", "#f4c776", "#a8caa5", "#a6c8df", "#c5b1e0"]);

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
      // column keeps the opening between five and seven rows high after settling.
      // All other cells, piece boundaries, lengths, and colors are randomized.
      const height = 5 + this._int(3);
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
      const choices = Array.from({ length: COLS }, (_, col) => col).filter((col) => col !== gap);
      for (let i = choices.length - 1; i > 0; i -= 1) {
        const j = this._int(i + 1);
        [choices[i], choices[j]] = [choices[j], choices[i]];
      }
      const selected = choices.slice(0, occupied);
      if (support !== null && !selected.includes(support)) selected[selected.length - 1] = support;
      const filled = new Set(selected);
      const specs = [];
      for (let col = 0; col < COLS;) {
        if (!filled.has(col)) {
          col += 1;
          continue;
        }
        let run = 0;
        while (col + run < COLS && filled.has(col + run)) run += 1;
        const length = 1 + this._int(Math.min(5, run));
        specs.push({ col, length, color: this._color() });
        col += length;
      }
      // A contiguous four- or five-cell run may have become one piece. Split it
      // during creation so every incoming row contains at least two new spools.
      if (specs.length === 1) {
        const first = specs[0];
        const tailLength = first.length - 1;
        first.length = 1;
        specs.push({ col: first.col + 1, length: tailLength, color: this._color() });
      }
      return specs;
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
        throw new Error("Board must contain exactly 9 columns and 16 rows.");
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
