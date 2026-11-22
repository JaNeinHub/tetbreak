/* TetBreak – game logic only (no DOM). Used by the web app and by the tests. */
(function (root) {
  'use strict';

  const SIZE = 8;     // normal mode board is SIZE x SIZE; other modes use MODES[...].size
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

  // ---- Modes "Fortgeschritten" and "Schwer": 10x10 board, the normal shapes plus pentominoes and big/gapped pieces.
  // Groups list base shapes; every rotation and mirror image becomes its own shape (pieces never rotate),
  // skipping shapes that already exist. Each group gets a share of the total odds, spread evenly in the group.
  // "Fortgeschritten": 4 pieces per round, all must be placed. Mix = tools/sim-size.sh set "mD".
  // Median moves casual / strong bot: 31 / 143 (normal mode 35 / 659).
  const ADVANCED_GROUPS = [
    { share: 0.22, bases: [   // pentominoes L P T U Y (I and V are already normal shapes)
      ['#...', '####'], ['##', '##', '#.'], ['###', '.#.', '.#.'], ['#.#', '###'], ['.#..', '####']] },
    { share: 0.06, bases: [   // pentominoes F N W X Z
      ['.##', '##.', '.#.'], ['##..', '.###'], ['#..', '##.', '.##'], ['.#.', '###', '.#.'], ['##.', '.#.', '.##']] },
    { share: 0.06, bases: [   // big and gapped pieces
      ['######'], ['####', '####'], ['###', '#.#', '###'], ['#.#', '###', '#.#'], ['#..', '#..', '#..', '####'],
      ['#..', '.#.', '..#'], ['#.#'], ['###', '###', '##.'], ['.##', '###', '##.'], ['#.#', '.#.', '#.#']] }
  ];

  // "Schwer": 4 pieces per round, place 3, the 4th stays for the next round; harder mix = sim set "h3"
  // (all 12 pentominoes 40 %, big pieces 25 %, normal shapes 35 %). Median moves: 28 / 89.
  const BIG_BASES = ADVANCED_GROUPS[2].bases;
  const HARD_GROUPS = [
    { share: 0.40, bases: [   // all pentominoes F I L N P T U V W X Y Z
      ['.##', '##.', '.#.'], ['#####'], ['#...', '####'], ['##..', '.###'], ['##', '##', '#.'], ['###', '.#.', '.#.'],
      ['#.#', '###'], ['#..', '#..', '###'], ['#..', '##.', '.##'], ['.#.', '###', '.#.'], ['.#..', '####'], ['##.', '.#.', '.##']] },
    { share: 0.25, bases: BIG_BASES }
  ];

  const cellKey = cells => cells.map(c => c[0] + ',' + c[1]).sort().join(';');
  function normCells(cells) {   // shift to the top-left corner, row-major order (like parseShape)
    const mx = Math.min(...cells.map(c => c[0])), my = Math.min(...cells.map(c => c[1]));
    return cells.map(([x, y]) => [x - mx, y - my]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  }
  function orientations(rows) {
    const out = [], seen = new Set();
    let c = parseShape(rows, 0, 0).cells;
    for (let m = 0; m < 2; m++) {
      for (let r = 0; r < 4; r++) {
        c = normCells(c.map(([x, y]) => [y, -x]));
        const k = cellKey(c);
        if (!seen.has(k)) { seen.add(k); out.push(c); }
      }
      c = normCells(c.map(([x, y]) => [-x, y]));
    }
    return out;
  }
  function buildShapeSet(groups) {
    const groupShare = groups.reduce((a, g) => a + g.share, 0);
    const normalTotal = WEIGHTS.reduce((a, b) => a + b, 0);
    const list = SHAPES.map(s => ({ cells: s.cells, weight: s.weight / normalTotal * (1 - groupShare) }));
    const seen = new Set(SHAPES.map(s => cellKey(s.cells)));
    for (const g of groups) {
      const add = [];
      for (const rows of g.bases) for (const cells of orientations(rows)) {
        const k = cellKey(cells);
        if (!seen.has(k)) { seen.add(k); add.push(cells); }
      }
      for (const cells of add) list.push({ cells, weight: g.share / add.length });
    }
    const shapes = list.map((s, i) => ({
      id: i, weight: s.weight, cells: s.cells,
      w: Math.max(...s.cells.map(c => c[0])) + 1, h: Math.max(...s.cells.map(c => c[1])) + 1
    }));
    return { shapes, weights: shapes.map(s => s.weight) };
  }
  const ADVANCED = buildShapeSet(ADVANCED_GROUPS);
  const HARD = buildShapeSet(HARD_GROUPS);

  // tray: pieces per round. refill: 'all' = new pieces once all are placed;
  // 'keep' = after `perRound` placements the unused piece stays and the empty slots are refilled.
  const MODES = {
    normal: { id: 'normal', size: SIZE, tray: 3, refill: 'all', perRound: 3, shapes: SHAPES, weights: WEIGHTS },
    advanced: { id: 'advanced', size: 10, tray: 4, refill: 'all', perRound: 4, shapes: ADVANCED.shapes, weights: ADVANCED.weights },
    hard: { id: 'hard', size: 10, tray: 4, refill: 'keep', perRound: 3, shapes: HARD.shapes, weights: HARD.weights }
  };

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

  // Boards are flat arrays of n*n cells; the board size is taken from the array length.
  function sizeOf(board) {
    return board.length === 64 ? 8 : board.length === 100 ? 10 : Math.round(Math.sqrt(board.length));
  }

  function createBoard(n) {
    n = n || SIZE;
    return new Array(n * n).fill(0);
  }

  function canPlace(board, shape, ox, oy, n) {
    n = n || sizeOf(board);
    for (const [x, y] of shape.cells) {
      const bx = ox + x, by = oy + y;
      if (bx < 0 || by < 0 || bx >= n || by >= n) return false;
      if (board[by * n + bx]) return false;
    }
    return true;
  }

  function fitsAnywhere(board, shape, n) {
    n = n || sizeOf(board);
    for (let oy = 0; oy <= n - shape.h; oy++)
      for (let ox = 0; ox <= n - shape.w; ox++)
        if (canPlace(board, shape, ox, oy, n)) return true;
    return false;
  }

  function fullLines(board, n) {
    n = n || sizeOf(board);
    const rows = [], cols = [];
    for (let i = 0; i < n; i++) {
      let rowFull = true, colFull = true;
      for (let j = 0; j < n; j++) {
        if (!board[i * n + j]) rowFull = false;
        if (!board[j * n + i]) colFull = false;
      }
      if (rowFull) rows.push(i);
      if (colFull) cols.push(i);
    }
    return { rows, cols };
  }

  function cellsOfLines(rows, cols, n) {
    n = n || SIZE;
    const set = new Set();
    for (const r of rows) for (let x = 0; x < n; x++) set.add(r * n + x);
    for (const c of cols) for (let y = 0; y < n; y++) set.add(y * n + c);
    return [...set];
  }

  // Which lines would clear if `shape` were placed at (ox, oy)? null if it does not fit.
  function previewPlacement(board, shape, ox, oy) {
    const n = sizeOf(board);
    if (!canPlace(board, shape, ox, oy, n)) return null;
    const b = board.slice();
    for (const [x, y] of shape.cells) b[(oy + y) * n + ox + x] = 1;
    const { rows, cols } = fullLines(b, n);
    return { rows, cols, cells: cellsOfLines(rows, cols, n) };
  }

  // Board after placing `shape` at (ox, oy) and clearing full lines (no fit check).
  function placeAndClear(board, shape, ox, oy, n) {
    n = n || sizeOf(board);
    const b = board.slice();
    for (const [x, y] of shape.cells) b[(oy + y) * n + ox + x] = 1;
    const { rows, cols } = fullLines(b, n);
    for (const r of rows) for (let x = 0; x < n; x++) b[r * n + x] = 0;
    for (const c of cols) for (let y = 0; y < n; y++) b[y * n + c] = 0;
    return b;
  }

  // Can some `k` of the `shapes` be placed one after another (k >= length: all of them)?
  function somePlaceable(board, shapes, k, budget) {
    if (k >= shapes.length) return allPlaceable(board, shapes, budget);
    const pickIdx = [];
    function comb(start) {
      if (pickIdx.length === k) return allPlaceable(board, pickIdx.map(i => shapes[i]), budget);
      for (let i = start; i < shapes.length; i++) {
        pickIdx.push(i);
        if (comb(i + 1)) return true;
        pickIdx.pop();
      }
      return false;
    }
    return comb(0);
  }

  // Can all `shapes` be placed one after another, in some order (line clears included)?
  // Depth-first search with a node budget; running out of budget counts as "no".
  function allPlaceable(board, shapes, budget) {
    const n = sizeOf(board);
    const state = { left: budget || 4000 };
    function solve(b, rest) {
      if (rest.length === 1) return fitsAnywhere(b, rest[0], n);
      const seen = new Set();
      for (let i = 0; i < rest.length; i++) {
        const sh = rest[i];
        if (seen.has(sh.id)) continue;   // same shape twice: one order is enough
        seen.add(sh.id);
        const others = rest.slice(0, i).concat(rest.slice(i + 1));
        for (let oy = 0; oy <= n - sh.h; oy++)
          for (let ox = 0; ox <= n - sh.w; ox++) {
            if (!canPlace(b, sh, ox, oy, n)) continue;
            if (--state.left < 0) return false;
            if (solve(placeAndClear(b, sh, ox, oy, n), others)) return true;
          }
      }
      return false;
    }
    return shapes.length === 0 || solve(board, shapes);
  }

  // n = board size: a line has n cells, so 10x10 lines are worth more (100 instead of 80 for one line).
  function lineScore(lines, streak, n) {
    if (!lines) return 0;
    const base = SCORING.perLineCell * (n || SIZE) * lines * lines; // 8x8: 1 line 80, 2 lines 320, 3 lines 720 …
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
    // opts.mode: 'normal' (default), 'advanced' ("Fortgeschritten") or 'hard' ("Schwer"):
    // board size, pieces per round, refill rule, shapes and odds.
    // opts.weights: override the mode's shape odds. opts.fairDeal: false = old dealing,
    // where only one of the three pieces had to fit (default true).
    constructor(rng, opts) {
      this.rng = rng || Math.random;
      opts = opts || {};
      const mode = MODES[opts.mode] || MODES.normal;
      this.mode = mode.id;
      this.size = mode.size;
      this.traySize = mode.tray;
      this.refill = mode.refill;
      this.perRound = mode.perRound;
      this.shapes = mode.shapes;
      this.weights = opts.weights || mode.weights;
      this.fairDeal = opts.fairDeal !== false;
      this.reset();
    }

    reset() {
      this.board = createBoard(this.size);
      this.score = 0;
      this.streak = 0;
      this.movesSinceClear = 0;
      this.moves = 0;
      this.over = false;
      this.placedThisRound = 0;
      this.tray = this.deal();
    }

    // `count` new random pieces (default: a full tray) next to the `kept` ones (refill 'keep').
    // Fair deal (default): re-rolled until the pieces of the round (kept + new; all of them, or
    // `perRound` of them in 'keep' mode) can be placed one after another in some order, so a game
    // never ends just because of an unlucky deal. Fallbacks for very full boards: pieces made only
    // of currently fitting shapes, then a set where at least one piece fits, then one forced fitting
    // shape (the old rules).
    deal(count, kept) {
      count = count || this.traySize;
      kept = kept || [];
      const keptShapes = kept.map(p => p.shape);
      const need = this.refill === 'keep' ? this.perRound : count + kept.length;
      const roll = shapes => Array.from({ length: count }, () => ({ shape: randomShape(this.rng, this.weights, shapes || this.shapes), color: 0 }));
      const anyFits = t => t.some(p => fitsAnywhere(this.board, p.shape)) || keptShapes.some(s => fitsAnywhere(this.board, s));
      const allFit = t => somePlaceable(this.board, keptShapes.concat(t.map(p => p.shape)), need);
      let tray = null, done = false, oneFits = null;
      if (this.fairDeal) {
        for (let attempt = 0; attempt < 40 && !done; attempt++) {
          tray = roll();
          if (!oneFits && anyFits(tray)) oneFits = tray;
          done = allFit(tray);
        }
        if (!done) {
          const fitting = this.shapes.filter(s => fitsAnywhere(this.board, s));
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
        const fitting = this.shapes.filter(s => fitsAnywhere(this.board, s));
        if (fitting.length) tray[Math.floor(this.rng() * count)].shape = randomShape(this.rng, this.weights, fitting);
      }
      const used = new Set(kept.map(p => p.color));
      const colors = shuffled(Array.from({ length: COLORS }, (_, i) => i + 1).filter(c => !used.has(c)), this.rng);
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
        const i = (oy + y) * this.size + ox + x;
        this.board[i] = piece.color;
        placed.push(i);
      }

      const { rows, cols } = fullLines(this.board);
      const lines = rows.length + cols.length;
      const cleared = cellsOfLines(rows, cols, this.size).map(i => ({ index: i, color: this.board[i] }));
      for (const c of cleared) this.board[c.index] = 0;

      let lineBonus = 0, clearBonus = 0;
      if (lines) {
        this.streak++;
        this.movesSinceClear = 0;
        lineBonus = lineScore(lines, this.streak, this.size);
      } else if (++this.movesSinceClear >= SCORING.comboGrace) {
        this.streak = 0;
      }
      const boardCleared = lines > 0 && this.board.every(v => v === 0);
      if (boardCleared) clearBonus = SCORING.boardClear;

      const points = piece.shape.cells.length * SCORING.perCell + lineBonus + clearBonus;
      this.score += points;
      this.moves++;

      this.tray[slot] = null;
      this.placedThisRound++;
      let dealt = false, dealtSlots = [], keptMoves = [];
      if (this.tray.every(p => !p)) {
        this.tray = this.deal();
        dealt = true;
        dealtSlots = this.tray.map((p, i) => i);
        this.placedThisRound = 0;
      } else if (this.refill === 'keep' && this.placedThisRound >= this.perRound) {
        // "Schwer": the unused piece moves to the first slot, the new pieces fill the slots after it
        const kept = this.tray.filter(p => p);
        const fresh = this.deal(this.traySize - kept.length, kept);
        this.tray.forEach((p, i) => { if (p) keptMoves.push({ from: i, to: keptMoves.length }); });
        this.tray = kept.concat(fresh);
        for (let i = kept.length; i < this.traySize; i++) dealtSlots.push(i);
        dealt = true;
        this.placedThisRound = 0;
      }
      this.over = !this.tray.some(p => p && fitsAnywhere(this.board, p.shape));

      return {
        slot, ox, oy, color: piece.color, shape: piece.shape, placed,
        rows, cols, lines, cleared, points, lineBonus, clearBonus,
        streak: this.streak, boardCleared, dealt, dealtSlots, keptMoves, over: this.over
      };
    }
  }

  const api = {
    SIZE, COLORS, SCORING, SHAPES, WEIGHTS, CLASSIC_WEIGHTS, MODES, Game, makeRng, createBoard, canPlace, sizeOf,
    fitsAnywhere, fullLines, previewPlacement, placeAndClear, allPlaceable, lineScore, randomShape
  };
  root.TBCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
