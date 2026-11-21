/* TetBreak – rendering, input and UI. Game rules live in game-core.js. */
(function () {
  'use strict';

  const { SIZE, Game, previewPlacement } = TBCore;

  // ---------------------------------------------------------------- storage (high score only)
  // In the Android app a native bridge (window.TetBreakNative) is used; in the browser, localStorage.
  const BEST_KEY = 'tetbreak.best';
  const Store = {
    getBest() {
      try {
        const n = window.TetBreakNative;
        if (n && n.getHighScore) return parseInt(n.getHighScore(), 10) || 0;
        return parseInt(localStorage.getItem(BEST_KEY), 10) || 0;
      } catch (e) { return 0; }
    },
    setBest(v) {
      try {
        const n = window.TetBreakNative;
        if (n && n.setHighScore) { n.setHighScore(String(v)); return; }
        localStorage.setItem(BEST_KEY, String(v));
      } catch (e) { /* storage unavailable: keep in memory only */ }
    }
  };

  function haptic(ms) {
    try {
      const n = window.TetBreakNative;
      if (n && n.vibrate) n.vibrate(ms);
      else if (navigator.vibrate) navigator.vibrate(ms);
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- colours
  const BASE = [null, '#ff6b5e', '#ffb238', '#8fd14f', '#23c9a8', '#3fa7ff', '#9b6bff', '#ff6fb5'];
  function mix(hex, target, t) {
    const n = parseInt(hex.slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(c => Math.round(c + (target - c) * t));
    return `rgb(${ch[0]},${ch[1]},${ch[2]})`;
  }
  const TILE = BASE.map(h => h && { base: h, light: mix(h, 255, 0.3), dark: mix(h, 0, 0.35) });
  const GRAY = { base: '#555a70', light: '#6b7089', dark: '#363949' };
  const WELL = '#1a1c29';
  const EMPTY = '#23263a';

  // ---------------------------------------------------------------- timing
  const GROW_DUR = 110, RETURN_DUR = 180, PLACE_DUR = 170;
  const CLEAR_DUR = 360, CLEAR_STAGGER = 24;
  const DEAL_DUR = 320, DEAL_STAGGER = 70;
  const TEXT_DUR = 950, OVER_ROW = 60, BUMP_DUR = 260;

  const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
  const easeInQuad = t => t * t;
  const easeOutBack = t => { const c = 1.7; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };

  // ---------------------------------------------------------------- DOM
  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');
  const probe = document.getElementById('probe');
  const $ = id => document.getElementById(id);

  // ---------------------------------------------------------------- state
  let game = new Game();
  let best = Store.getBest();
  let bestAtStart = best;
  let shownScore = 0;
  let drag = null;        // { slot, piece, x, y, touch, t0, ghost }
  let returning = [];     // pieces flying back to the tray
  let clearFx = null;     // { cells: [{index, color, delay}], t0 }
  let placeFx = null;     // { cells: Set, t0 }
  let texts = [];         // floating texts
  let dealT0 = performance.now();
  let overT0 = 0;         // time the board starts greying out (0 = game running)
  let bumpT0 = -1e9;
  let dpr = 1;
  const L = {};           // layout (CSS pixels)

  // ---------------------------------------------------------------- layout
  function readSafeArea() {
    const cs = getComputedStyle(probe);
    return {
      top: parseFloat(cs.paddingTop) || 0,
      right: parseFloat(cs.paddingRight) || 0,
      bottom: parseFloat(cs.paddingBottom) || 0,
      left: parseFloat(cs.paddingLeft) || 0
    };
  }

  // Canvas pixels per CSS pixel. Phone screens are 2x-3.5x, but some browsers / privacy
  // modes report a lower devicePixelRatio, which makes the canvas blurry. On touch screens
  // render at least 3x (downscaling a sharper canvas costs nothing visible), capped at 3.
  function pixelRatio() {
    let r = window.devicePixelRatio || 1;
    try { if (window.matchMedia('(pointer: coarse)').matches) r = Math.max(r, 3); } catch (e) { /* old browser */ }
    return Math.min(r, 3);
  }

  // Add ?debug to the URL to show the canvas resolution values on screen.
  function showDebug() {
    if (!/[?&]debug/.test(location.search)) return;
    let d = document.getElementById('dbg');
    if (!d) {
      d = document.createElement('div');
      d.id = 'dbg';
      d.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99;font:12px ui-monospace,monospace;color:#9fe;background:rgba(0,0,0,.6);padding:4px 6px;border-radius:6px;pointer-events:none';
      document.body.appendChild(d);
    }
    const vv = window.visualViewport;
    d.textContent = `devicePixelRatio ${window.devicePixelRatio} \u2192 ${dpr} | ${window.innerWidth}\u00d7${window.innerHeight} | ` +
      `canvas ${canvas.width}\u00d7${canvas.height} | zoom ${vv ? vv.scale : '-'} | refresh ${layerRefreshes}`;
  }

  function layout() {
    const W = window.innerWidth, H = window.innerHeight;
    dpr = pixelRatio();
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';

    const safe = readSafeArea();
    const top = safe.top + 64;            // header row (restart button, best score)
    const bottom = safe.bottom + 16;
    const scoreH = 70, gap = 18, TRAY = 0.36;
    const availH = H - top - bottom - scoreH - 2 * gap;
    const availW = W - safe.left - safe.right - 24;
    const board = Math.max(160, Math.floor(Math.min(availW, availH / (1 + TRAY), 560)));
    const trayH = Math.floor(board * TRAY);
    const blockH = scoreH + gap + board + gap + trayH;
    const y0 = top + Math.max(0, (H - top - bottom - blockH) / 2);

    Object.assign(L, {
      W, H, safe,
      headerY: safe.top + 32,
      scoreY: y0 + scoreH / 2,
      boardX: Math.round(safe.left + (W - safe.left - safe.right - board) / 2),
      boardY: Math.round(y0 + scoreH + gap),
      boardSize: board,
      trayY: Math.round(y0 + scoreH + gap + board + gap),
      trayH
    });
    L.pad = Math.max(5, Math.round(board * 0.02));
    L.cell = (board - 2 * L.pad) / SIZE;
    L.gap = Math.max(1.5, L.cell * 0.06);
    L.gridX = L.boardX + L.pad;
    L.gridY = L.boardY + L.pad;
    L.slotW = board / 3;
    L.trayCell = Math.min(L.cell * 0.52, (L.slotW * 0.88) / 5, (trayH * 0.88) / 5);
  }

  // ---------------------------------------------------------------- drawing helpers
  function rr(x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
    r = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawTile(x, y, s, t, alpha) {
    if (s <= 0.5) return;
    ctx.globalAlpha = alpha;
    const r = s * 0.22;
    ctx.fillStyle = t.dark;
    rr(x, y, s, s, r); ctx.fill();
    const g = ctx.createLinearGradient(0, y, 0, y + s);
    g.addColorStop(0, t.light);
    g.addColorStop(1, t.base);
    ctx.fillStyle = g;
    rr(x, y, s, s * 0.88, r); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    rr(x + s * 0.16, y + s * 0.13, s * 0.3, s * 0.1, s * 0.05); ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Tile in a board cell, optionally scaled around the cell centre.
  function drawCell(gx, gy, t, alpha, scale) {
    const s = (L.cell - L.gap) * scale;
    const cx = L.gridX + (gx + 0.5) * L.cell, cy = L.gridY + (gy + 0.5) * L.cell;
    drawTile(cx - s / 2, cy - s / 2, s, t, alpha);
  }

  function drawPiece(shape, t, x, y, s, alpha) {
    const gap = Math.max(1, s * 0.06);
    for (const [cx, cy] of shape.cells) drawTile(x + cx * s + gap / 2, y + cy * s + gap / 2, s - gap, t, alpha);
  }

  function drawCrown(cx, cy, w) {
    const h = w * 0.72, x = cx - w / 2, y = cy - h / 2;
    ctx.fillStyle = '#ffc94d';
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + h * 0.25);
    ctx.lineTo(x + w * 0.28, y + h * 0.55);
    ctx.lineTo(x + w * 0.5, y);
    ctx.lineTo(x + w * 0.72, y + h * 0.55);
    ctx.lineTo(x + w, y + h * 0.25);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
    ctx.fill();
  }

  // ---------------------------------------------------------------- drag geometry
  function liftFor(shape) { return L.cell * 0.9 + (shape.h * L.cell) / 2; } // piece centre above the finger

  function dragGeom(d, now) {
    const shape = d.piece.shape;
    const k = easeOutCubic(clamp01((now - d.t0) / GROW_DUR));
    const s = lerp(L.trayCell, L.cell, k);
    const lift = d.touch ? liftFor(shape) * k : 0;
    return { s, x: d.x - (shape.w * s) / 2, y: d.y - lift - (shape.h * s) / 2 };
  }

  function updateGhost() {
    const shape = drag.piece.shape;
    const cy = drag.y - (drag.touch ? liftFor(shape) : 0);
    const left = drag.x - (shape.w * L.cell) / 2;
    const top = cy - (shape.h * L.cell) / 2;
    const ox = Math.round((left - L.gridX) / L.cell);
    const oy = Math.round((top - L.gridY) / L.cell);
    const pv = previewPlacement(game.board, shape, ox, oy);
    if (!pv) { drag.ghost = null; return; }
    const cells = new Set(shape.cells.map(([x, y]) => (oy + y) * SIZE + ox + x));
    drag.ghost = { ox, oy, rows: pv.rows, cols: pv.cols, lineCells: new Set(pv.cells), cells };
  }

  function slotCenter(i) {
    return { x: L.boardX + L.slotW * (i + 0.5), y: L.trayY + L.trayH / 2 };
  }

  // ---------------------------------------------------------------- render
  function render(now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, L.W, L.H);
    let active = false;

    // --- best score (top centre)
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '700 20px system-ui, -apple-system, Roboto, sans-serif';
    const bestText = String(best);
    const tw = ctx.measureText(bestText).width;
    const crownW = 22, totalW = crownW + 8 + tw;
    const hx = L.W / 2 - totalW / 2;
    drawCrown(hx + crownW / 2, L.headerY, crownW);
    ctx.fillStyle = '#ffd877';
    ctx.fillText(bestText, hx + crownW + 8, L.headerY + 1);

    // --- score
    if (shownScore !== game.score) {
      const diff = game.score - shownScore;
      shownScore += diff > 0 ? Math.max(1, Math.ceil(diff * 0.16)) : diff;
      active = true;
    }
    const bk = clamp01((now - bumpT0) / BUMP_DUR);
    if (bk < 1) active = true;
    const scoreSize = Math.min(58, L.boardSize * 0.14) * (1 + 0.12 * Math.sin(Math.PI * bk) * (bk < 1 ? 1 : 0));
    ctx.textAlign = 'center';
    ctx.font = `800 ${scoreSize.toFixed(1)}px system-ui, -apple-system, Roboto, sans-serif`;
    ctx.fillStyle = '#f2f3f8';
    ctx.fillText(String(shownScore), L.W / 2, L.scoreY);

    // --- board well + empty cells
    ctx.fillStyle = WELL;
    rr(L.boardX, L.boardY, L.boardSize, L.boardSize, L.pad * 2.4); ctx.fill();
    ctx.fillStyle = EMPTY;
    const es = L.cell - L.gap;
    for (let gy = 0; gy < SIZE; gy++)
      for (let gx = 0; gx < SIZE; gx++) {
        rr(L.gridX + gx * L.cell + L.gap / 2, L.gridY + gy * L.cell + L.gap / 2, es, es, es * 0.2);
        ctx.fill();
      }

    // --- line highlight while hovering a placement that would clear lines
    const ghost = drag && drag.ghost;
    const hi = ghost ? TILE[drag.piece.color] : null;
    if (ghost && (ghost.rows.length || ghost.cols.length)) {
      active = true;
      ctx.fillStyle = `rgba(255,255,255,${0.07 + 0.05 * Math.sin(now / 140)})`;
      for (const r of ghost.rows) { rr(L.gridX, L.gridY + r * L.cell, L.cell * SIZE, L.cell, L.cell * 0.22); ctx.fill(); }
      for (const c of ghost.cols) { rr(L.gridX + c * L.cell, L.gridY, L.cell, L.cell * SIZE, L.cell * 0.22); ctx.fill(); }
    }

    // --- tiles
    const placeK = placeFx ? clamp01((now - placeFx.t0) / PLACE_DUR) : 1;
    if (placeFx && placeK >= 1) placeFx = null;
    if (placeFx) active = true;
    for (let i = 0; i < SIZE * SIZE; i++) {
      const gx = i % SIZE, gy = (i / SIZE) | 0;
      const v = game.board[i];
      if (v) {
        let t = TILE[v];
        if (overT0 && now - overT0 > gy * OVER_ROW) t = GRAY;
        else if (ghost && ghost.lineCells.has(i)) t = hi;
        const scale = placeFx && placeFx.cells.has(i) ? 0.8 + 0.2 * easeOutBack(placeK) : 1;
        drawCell(gx, gy, t, 1, scale);
      } else if (ghost && ghost.cells.has(i)) {
        drawCell(gx, gy, hi, ghost.lineCells.has(i) ? 1 : 0.38, 1);
      }
    }
    if (overT0 && now < overT0 + SIZE * OVER_ROW + 50) active = true;

    // --- clearing animation
    if (clearFx) {
      let alive = false;
      for (const c of clearFx.cells) {
        const k = (now - clearFx.t0 - c.delay) / CLEAR_DUR;
        if (k >= 1) continue;
        alive = true;
        if (game.board[c.index]) continue; // cell already refilled
        const gx = c.index % SIZE, gy = (c.index / SIZE) | 0;
        if (k < 0) { drawCell(gx, gy, TILE[c.color], 1, 1); continue; }
        const scale = 1 - easeInQuad(k);
        drawCell(gx, gy, TILE[c.color], 1, scale);
        const s = (L.cell - L.gap) * scale;
        ctx.globalAlpha = 0.75 * (1 - k);
        ctx.fillStyle = '#ffffff';
        rr(L.gridX + (gx + 0.5) * L.cell - s / 2, L.gridY + (gy + 0.5) * L.cell - s / 2, s, s, s * 0.22);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      if (alive) active = true; else clearFx = null;
    }

    // --- tray
    for (let i = 0; i < 3; i++) {
      const piece = game.tray[i];
      if (!piece || (drag && drag.slot === i) || returning.some(r => r.slot === i)) continue;
      const shape = piece.shape, s = L.trayCell, c = slotCenter(i);
      let x = c.x - (shape.w * s) / 2;
      const y = c.y - (shape.h * s) / 2;
      const k = clamp01((now - dealT0 - i * DEAL_STAGGER) / DEAL_DUR);
      if (k < 1) { x += (1 - easeOutCubic(k)) * L.W * 0.7; active = true; }
      drawPiece(shape, TILE[piece.color], x, y, s, game.pieceFits(i) ? 1 : 0.28);
    }

    // --- pieces flying back to the tray
    returning = returning.filter(r => {
      const k = clamp01((now - r.t0) / RETURN_DUR), e = easeOutCubic(k);
      const shape = r.piece.shape, c = slotCenter(r.slot);
      const s = lerp(r.s, L.trayCell, e);
      const tx = c.x - (shape.w * L.trayCell) / 2, ty = c.y - (shape.h * L.trayCell) / 2;
      drawPiece(shape, TILE[r.piece.color], lerp(r.x, tx, e), lerp(r.y, ty, e), s, 1);
      return k < 1;
    });
    if (returning.length) active = true;

    // --- dragged piece
    if (drag) {
      const g = dragGeom(drag, now);
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = 14;
      ctx.shadowOffsetY = 6;
      drawPiece(drag.piece.shape, TILE[drag.piece.color], g.x, g.y, g.s, 1);
      ctx.restore();
      if (now - drag.t0 < GROW_DUR) active = true;
    }

    // --- floating texts
    texts = texts.filter(t => {
      const k = (now - t.t0 - t.delay) / TEXT_DUR;
      if (k >= 1) return false;
      if (k < 0) return true;
      const pop = k < 0.14 ? 0.6 + 0.4 * easeOutBack(k / 0.14) : 1;
      const alpha = k < 0.7 ? 1 : (1 - k) / 0.3;
      let size = t.size * pop;
      ctx.font = `800 ${size.toFixed(1)}px system-ui, -apple-system, Roboto, sans-serif`;
      const maxW = L.boardSize * 0.92, textW = ctx.measureText(t.text).width;
      if (textW > maxW) {
        size *= maxW / textW;
        ctx.font = `800 ${size.toFixed(1)}px system-ui, -apple-system, Roboto, sans-serif`;
      }
      ctx.globalAlpha = alpha;
      ctx.textAlign = 'center';
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(3, size * 0.16);
      ctx.strokeStyle = 'rgba(10,11,18,0.85)';
      const y = t.y - 46 * easeOutCubic(k);
      ctx.strokeText(t.text, t.x, y);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, y);
      ctx.globalAlpha = 1;
      return true;
    });
    if (texts.length) active = true;

    return active;
  }

  let rafPending = false;
  function requestRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(now => {
      rafPending = false;
      if (render(now)) requestRender();
    });
  }

  // ---------------------------------------------------------------- game flow
  function addText(text, x, y, color, size, delay) {
    texts.push({ text, x, y, color, size, delay: delay || 0, t0: performance.now() });
  }

  function onPlaced(res) {
    const now = performance.now();
    placeFx = { cells: new Set(res.placed), t0: now };
    bumpT0 = now;

    // centre of the placed piece in screen coordinates
    const pcx = L.gridX + (res.ox + res.shape.w / 2) * L.cell;
    const pcy = L.gridY + (res.oy + res.shape.h / 2) * L.cell;

    if (res.lines) {
      clearFx = {
        t0: now,
        cells: res.cleared.map(c => {
          const gx = c.index % SIZE, gy = (c.index / SIZE) | 0;
          const d = Math.hypot(gx + 0.5 - (res.ox + res.shape.w / 2), gy + 0.5 - (res.oy + res.shape.h / 2));
          return { index: c.index, color: c.color, delay: d * CLEAR_STAGGER };
        })
      };
      const big = Math.min(40, L.boardSize * 0.1);
      const midX = L.boardX + L.boardSize / 2, midY = L.boardY + L.boardSize / 2;
      addText('+' + res.points, pcx, pcy, '#ffffff', big * 0.8);
      const words = { 2: 'Doppelt!', 3: 'Dreifach!' };
      let row = 0;
      if (res.lines >= 2) addText(words[res.lines] || 'Unglaublich!', midX, midY - big * 0.6 + big * 1.2 * row++, TILE[res.color].light, big, 80);
      if (res.streak >= 2) addText('Combo \u00d7' + res.streak, midX, midY - big * 0.6 + big * 1.2 * row++, '#ffd877', big * 0.85, 140);
      if (res.boardCleared) addText('Alles abger\u00e4umt! +' + res.clearBonus, midX, midY - big * 0.6 + big * 1.2 * row, '#7ef0d0', big * 0.8, 220);
      haptic(res.lines >= 2 ? 35 : 20);
    } else {
      haptic(8);
    }

    if (res.dealt) dealT0 = now;

    if (game.score > best) {
      best = game.score;
      Store.setBest(best);
    }

    if (res.over) {
      overT0 = now + (res.lines ? 500 : 200);
      const delay = overT0 - now + SIZE * OVER_ROW + 450;
      setTimeout(showGameOver, delay);
    }
    requestRender();
  }

  function showGameOver() {
    if (!overT0) return; // a new game was started in the meantime
    $('goScore').textContent = game.score;
    $('goBest').textContent = best;
    $('goRecord').classList.toggle('show', game.score > bestAtStart && game.score > 0);
    $('gameOver').classList.add('show');
  }

  function newGame() {
    game.reset();
    bestAtStart = best;
    shownScore = 0;
    drag = null;
    returning = [];
    clearFx = placeFx = null;
    texts = [];
    overT0 = 0;
    dealT0 = performance.now();
    $('gameOver').classList.remove('show');
    $('confirm').classList.remove('show');
    requestRender();
  }

  // ---------------------------------------------------------------- input
  function slotAt(x, y) {
    if (y < L.trayY - 10 || y > L.H) return -1;
    return Math.max(0, Math.min(2, Math.floor((x - L.boardX) / L.slotW)));
  }

  canvas.addEventListener('pointerdown', e => {
    if (drag || overT0) return;
    const slot = slotAt(e.clientX, e.clientY);
    if (slot < 0 || !game.tray[slot]) return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
    returning = returning.filter(r => r.slot !== slot);
    drag = {
      slot, piece: game.tray[slot], pointerId: e.pointerId,
      x: e.clientX, y: e.clientY, touch: e.pointerType !== 'mouse',
      t0: performance.now(), ghost: null
    };
    updateGhost();
    requestRender();
  });

  canvas.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.preventDefault();
    drag.x = e.clientX;
    drag.y = e.clientY;
    updateGhost();
    requestRender();
  });

  function endDrag(e, cancelled) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = drag;
    drag = null;
    if (!cancelled && d.ghost) {
      const res = game.place(d.slot, d.ghost.ox, d.ghost.oy);
      if (res) { onPlaced(res); return; }
    }
    const g = dragGeom(d, performance.now());
    returning.push({ slot: d.slot, piece: d.piece, x: g.x, y: g.y, s: g.s, t0: performance.now() });
    requestRender();
  }
  canvas.addEventListener('pointerup', e => endDrag(e, false));
  canvas.addEventListener('pointercancel', e => endDrag(e, true));

  // Block page gestures (pinch zoom, long-press menus) inside the game.
  ['gesturestart', 'gesturechange', 'contextmenu'].forEach(type =>
    document.addEventListener(type, e => e.preventDefault(), { passive: false }));
  document.addEventListener('touchmove', e => e.preventDefault(), { passive: false });

  $('restartBtn').addEventListener('click', () => {
    if (game.score === 0 || overT0) newGame();
    else $('confirm').classList.add('show');
  });
  $('cfCancel').addEventListener('click', () => $('confirm').classList.remove('show'));
  $('cfOk').addEventListener('click', newGame);
  $('goPlay').addEventListener('click', newGame);

  function onResize() { layout(); showDebug(); requestRender(); }

  // iOS Safari sometimes shows the canvas blurry although its pixel buffer is full
  // resolution (seen with devicePixelRatio 3 and a 3x canvas, in some tabs only).
  // Likely cause: the compositing layer was created at a lower scale (e.g. while the tab
  // was opened or restored in the background) and is never rebuilt. Taking the canvas
  // out of the render tree and back forces a new layer. The pixel buffer is kept.
  let layerRefreshes = 0;
  function refreshLayer() {
    canvas.style.display = 'none';
    void canvas.offsetHeight;
    canvas.style.display = 'block';
    layerRefreshes++;
    showDebug();
    requestRender();
  }
  window.addEventListener('pageshow', refreshLayer);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshLayer();
  });
  window.addEventListener('load', () => setTimeout(refreshLayer, 300));
  window.addEventListener('resize', onResize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);

  // Hooks for automated tests / the Android shell.
  window.TetBreak = {
    get game() { return game; },
    get best() { return best; },
    layout: () => L,
    newGame,
    relayout: onResize
  };

  // Installed web app (GitHub Pages, HTTPS): offline cache via sw.js, and ask the browser to keep
  // our storage (high score) even when space runs low. Local http testing skips both.
  if (location.protocol === 'https:') {
    try { if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {}); } catch (e) { /* ignore */ }
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) { /* ignore */ }
  }

  layout();
  showDebug();
  requestRender();
})();
