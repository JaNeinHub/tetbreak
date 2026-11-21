/* TetBreak – game logic only (no DOM). Used by the web app and by the tests. */
(function (root) {
  'use strict';

  const SIZE = 8;     // board is SIZE x SIZE
  const COLORS = 7;   // tile colour indices 1..COLORS (0 = empty)

  const SCORING = {
    perCell: 1,        // points per placed cell
    perLineCell: 10,   // points per cleared cell, before multipliers
    comboStep: 0.5,    // each consecutive clearing move adds +0.5x
    comboGrace: 3,     // combo is lost after this many moves without a clear
    boardClear: 500    // bonus when the board ends up completely empty
  };

  // [weight, classicWeight, rows]  '#' = filled. Pieces never rotate, so every orientation is its own shape.
  // weight: current odds (easier: more small pieces; 3x3, 5-bars, big corners and diagonals rarer).
  // classicWeight: the odds before 2026-11-10, kept for tools/sim.js comparisons.
  const SHAPE_DEFS = [
    [2.5, 2.0, ['#']],
    [3.5, 3.0, ['##']], [3.5, 3.0, ['#', '#']],
    [3.0, 3.0, ['###']], [3.0, 3.0, ['#', '#', '#']],
    [2.0, 2.5, ['####']], [2.0, 2.5, ['#', '#', '#', '#']],
    [0.8, 1.5, ['#####']], [0.8, 1.5, ['#', '#', '#', '#', '#']],
    [3.5, 4.0, ['##', '##']],
    [0.6, 1.5, ['###', '###', '###']],
    [1.5, 2.0, ['###', '###']], [1.5, 2.0, ['##', '##', '##']],
    // small corners (3 cells)
    [2.5, 2.0, ['#.', '##']], [2.5, 2.0, ['.#', '##']], [2.5, 2.0, ['##', '#.']], [2.5, 2.0, ['##', '.#']],
    // L / J (4 cells)
    [1.3, 1.5, ['#.', '#.', '##']], [1.3, 1.5, ['.#', '.#', '##']], [1.3, 1.5, ['##', '#.', '#.']], [1.3, 1.5, ['##', '.#', '.#']],
    [1.3, 1.5, ['###', '#..']], [1.3, 1.5, ['###', '..#']], [1.3, 1.5, ['#..', '###']], [1.3, 1.5, ['..#', '###']],
    // big corners (5 cells)
    [0.6, 1.0, ['#..', '#..', '###']], [0.6, 1.0, ['..#', '..#', '###']], [0.6, 1.0, ['###', '#..', '#..']], [0.6, 1.0, ['###', '..#', '..#']],
    // T
    [1.2, 1.5, ['###', '.#.']], [1.2, 1.5, ['.#.', '###']], [1.2, 1.5, ['#.', '##', '#.']], [1.2, 1.5, ['.#', '##', '.#']],
    // S / Z
    [1.0, 1.2, ['.##', '##.']], [1.0, 1.2, ['##.', '.##']], [1.0, 1.2, ['#.', '##', '.#']], [1.0, 1.2, ['.#', '##', '#.']],
    // diagonals
    [0.4, 1.0, ['#.', '.#']], [0.4, 1.0, ['.#', '#.']]
  ];

  function parseShape(rows, id, weight) {
    const cells = [];
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) if (row[x] === '#') cells.push([x, y]);
    });
    return { id, weight, cells, w: Math.max(...rows.map(r => r.length)), h: rows.length };
  }

  const SHAPES = SHAPE_DEFS.map(([weight, , rows], i) => parseShape(rows, i, weight));
  const WEIGHTS = SHAPE_DEFS.map(d => d[0]);
  const CLASSIC_WEIGHTS = SHAPE_DEFS.map(d => d[1]);

  // Small seeded RNG (mulberry32) for reproducible tests.
  function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Weighted random pick from `shapes` (default: all), using `weights` indexed by shape id.
  function randomShape(rng, weights, shapes) {
    weights = weights || WEIGHTS;
    shapes = shapes || SHAPES;
    let total = 0;
    for (const s of shapes) total += weights[s.id];
    let r = rng() * total;
    for (const s of shapes) {
      r -= weights[s.id];
      if (r < 0) return s;
    }
    return shapes[shapes.length - 1];
  }

  function createBoard() {
    return new Array(SIZE * SIZE).fill(0);
  }

  function canPlace(board, shape, ox, oy) {
    for (const [x, y] of shape.cells) {
      const bx = ox + x, by = oy + y;
      if (bx < 0 || by < 0 || bx >= SIZE || by >= SIZE) return false;
      if (board[by * SIZE + bx]) return false;
    }
    return true;
  }

  function fitsAnywhere(board, shape) {
    for (let oy = 0; oy <= SIZE - shape.h; oy++)
      for (let ox = 0; ox <= SIZE - shape.w; ox++)
        if (canPlace(board, shape, ox, oy)) return true;
    return false;
  }

  function fullLines(board) {
    const rows = [], cols = [];
    for (let i = 0; i < SIZE; i++) {
      let rowFull = true, colFull = true;
      for (let j = 0; j < SIZE; j++) {
        if (!board[i * SIZE + j]) rowFull = false;
        if (!board[j * SIZE + i]) colFull = false;
      }
      if (rowFull) rows.push(i);
      if (colFull) cols.push(i);
    }
    return { rows, cols };
  }

  function cellsOfLines(rows, cols) {
    const set = new Set();
    for (const r of rows) for (let x = 0; x < SIZE; x++) set.add(r * SIZE + x);
    for (const c of cols) for (let y = 0; y < SIZE; y++) set.add(y * SIZE + c);
    return [...set];
  }

  // Which lines would clear if `shape` were placed at (ox, oy)? null if it does not fit.
  function previewPlacement(board, shape, ox, oy) {
    if (!canPlace(board, shape, ox, oy)) return null;
    const b = board.slice();
    for (const [x, y] of shape.cells) b[(oy + y) * SIZE + ox + x] = 1;
    const { rows, cols } = fullLines(b);
    return { rows, cols, cells: cellsOfLines(rows, cols) };
  }

  // Board after placing `shape` at (ox, oy) and clearing full lines (no fit check).
  function placeAndClear(board, shape, ox, oy) {
    const b = board.slice();
    for (const [x, y] of shape.cells) b[(oy + y) * SIZE + ox + x] = 1;
    const { rows, cols } = fullLines(b);
    for (const r of rows) for (let x = 0; x < SIZE; x++) b[r * SIZE + x] = 0;
    for (const c of cols) for (let y = 0; y < SIZE; y++) b[y * SIZE + c] = 0;
    return b;
  }

  // Can all `shapes` be placed one after another, in some order (line clears included)?
  // Depth-first search with a node budget; running out of budget counts as "no".
  function allPlaceable(board, shapes, budget) {
    const state = { left: budget || 4000 };
    function solve(b, rest) {
      if (rest.length === 1) return fitsAnywhere(b, rest[0]);
      const seen = new Set();
      for (let i = 0; i < rest.length; i++) {
        const sh = rest[i];
        if (seen.has(sh.id)) continue;   // same shape twice: one order is enough
        seen.add(sh.id);
        const others = rest.slice(0, i).concat(rest.slice(i + 1));
        for (let oy = 0; oy <= SIZE - sh.h; oy++)
          for (let ox = 0; ox <= SIZE - sh.w; ox++) {
            if (!canPlace(b, sh, ox, oy)) continue;
            if (--state.left < 0) return false;
            if (solve(placeAndClear(b, sh, ox, oy), others)) return true;
          }
      }
      return false;
    }
    return shapes.length === 0 || solve(board, shapes);
  }

  function lineScore(lines, streak) {
    if (!lines) return 0;
    const base = SCORING.perLineCell * SIZE * lines * lines; // 1 line 80, 2 lines 320, 3 lines 720 …
    return Math.round(base * (1 + SCORING.comboStep * (streak - 1)));
  }

  function shuffled(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  class Game {
    // opts.weights: shape odds (default WEIGHTS). opts.fairDeal: false = old dealing,
    // where only one of the three pieces had to fit (default true).
    constructor(rng, opts) {
      this.rng = rng || Math.random;
      opts = opts || {};
      this.weights = opts.weights || WEIGHTS;
      this.fairDeal = opts.fairDeal !== false;
      this.reset();
    }

    reset() {
      this.board = createBoard();
      this.score = 0;
      this.streak = 0;
      this.movesSinceClear = 0;
      this.moves = 0;
      this.over = false;
      this.tray = this.deal();
    }

    // Three random pieces. Fair deal (default): re-rolled until all three can be placed
    // one after another in some order, so a game never ends just because of an unlucky deal.
    // Fallbacks for very full boards: trays made only of currently fitting shapes, then a tray
    // where at least one piece fits, then one forced fitting shape (the old rules).
    deal() {
      const roll = shapes => [0, 1, 2].map(() => ({ shape: randomShape(this.rng, this.weights, shapes), color: 0 }));
      const anyFits = t => t.some(p => fitsAnywhere(this.board, p.shape));
      const allFit = t => allPlaceable(this.board, t.map(p => p.shape));
      let tray = null, done = false, oneFits = null;
      if (this.fairDeal) {
        for (let attempt = 0; attempt < 40 && !done; attempt++) {
          tray = roll();
          if (!oneFits && anyFits(tray)) oneFits = tray;
          done = allFit(tray);
        }
        if (!done) {
          const fitting = SHAPES.filter(s => fitsAnywhere(this.board, s));
          for (let attempt = 0; attempt < 40 && !done && fitting.length; attempt++) {
            tray = roll(fitting);
            if (!oneFits) oneFits = tray;
            done = allFit(tray);
          }
        }
        if (!done && oneFits) { tray = oneFits; done = true; }
      }
      for (let attempt = 0; attempt < 30 && !done; attempt++) {
        tray = roll();
        done = anyFits(tray);
      }
      if (!done) {
        const fitting = SHAPES.filter(s => fitsAnywhere(this.board, s));
        if (fitting.length) tray[Math.floor(this.rng() * 3)].shape = randomShape(this.rng, this.weights, fitting);
      }
      const colors = shuffled(Array.from({ length: COLORS }, (_, i) => i + 1), this.rng);
      tray.forEach((p, i) => { p.color = colors[i]; });
      return tray;
    }

    pieceFits(slot) {
      const p = this.tray[slot];
      return !!p && fitsAnywhere(this.board, p.shape);
    }

    // Places tray piece `slot` with its top-left cell at (ox, oy). Returns a result object, or null if invalid.
    place(slot, ox, oy) {
      const piece = this.tray[slot];
      if (this.over || !piece || !canPlace(this.board, piece.shape, ox, oy)) return null;

      const placed = [];
      for (const [x, y] of piece.shape.cells) {
        const i = (oy + y) * SIZE + ox + x;
        this.board[i] = piece.color;
        placed.push(i);
      }

      const { rows, cols } = fullLines(this.board);
      const lines = rows.length + cols.length;
      const cleared = cellsOfLines(rows, cols).map(i => ({ index: i, color: this.board[i] }));
      for (const c of cleared) this.board[c.index] = 0;

      let lineBonus = 0, clearBonus = 0;
      if (lines) {
        this.streak++;
        this.movesSinceClear = 0;
        lineBonus = lineScore(lines, this.streak);
      } else if (++this.movesSinceClear >= SCORING.comboGrace) {
        this.streak = 0;
      }
      const boardCleared = lines > 0 && this.board.every(v => v === 0);
      if (boardCleared) clearBonus = SCORING.boardClear;

      const points = piece.shape.cells.length * SCORING.perCell + lineBonus + clearBonus;
      this.score += points;
      this.moves++;

      this.tray[slot] = null;
      let dealt = false;
      if (this.tray.every(p => !p)) {
        this.tray = this.deal();
        dealt = true;
      }
      this.over = !this.tray.some(p => p && fitsAnywhere(this.board, p.shape));

      return {
        slot, ox, oy, color: piece.color, shape: piece.shape, placed,
        rows, cols, lines, cleared, points, lineBonus, clearBonus,
        streak: this.streak, boardCleared, dealt, over: this.over
      };
    }
  }

  const api = {
    SIZE, COLORS, SCORING, SHAPES, WEIGHTS, CLASSIC_WEIGHTS, Game, makeRng, createBoard, canPlace,
    fitsAnywhere, fullLines, previewPlacement, placeAndClear, allPlaceable, lineScore, randomShape
  };
  root.TBCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
