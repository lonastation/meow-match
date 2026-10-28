/* Turn orchestration is independent of Canvas so the exact rules can be tested. */
(function (root, factory) {
  "use strict";
  const engine = typeof module === "object" && module.exports ? require("./engine.js") : root.MeowEngine;
  const api = factory(engine);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MeowGame = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (engine) {
  "use strict";
  const { Board } = engine;
  const STATES = Object.freeze({ IDLE: "IDLE", DRAGGING: "DRAGGING", RESOLVING: "RESOLVING", INSERTING_ROW: "INSERTING_ROW", GAME_OVER: "GAME_OVER" });

  function sampleFallRow(fromRow, toRow, maxDrop, progress) {
    const t = Math.max(0, Math.min(1, progress));
    const travel = maxDrop * t * t;
    // Every spool shares one accelerating displacement and stops at its own
    // landing. This keeps stacked bars ordered even when their drops differ.
    return fromRow + Math.min(toRow - fromRow, travel);
  }

  class Game {
    constructor({ board = new Board(), animate = async () => {}, onChange = () => {}, onClear = () => {} } = {}) {
      this.board = board;
      this.animate = animate;
      this.onChange = onChange;
      this.onClear = onClear;
      this.state = STATES.IDLE;
      this.score = 0;
      this.moves = 0;
      this.drag = null;
      this.nextRow = board.makeRow();
    }
    notify() { this.onChange(this); }
    setState(state) { this.state = state; this.notify(); }
    reset() {
      if (![STATES.IDLE, STATES.GAME_OVER].includes(this.state)) return false;
      this.board.reset();
      this.score = 0;
      this.moves = 0;
      this.drag = null;
      this.nextRow = this.board.makeRow();
      this.setState(STATES.IDLE);
      return true;
    }
    beginDrag(id) {
      if (this.state !== STATES.IDLE) return false;
      const spool = this.board.getSpool(id);
      if (!spool) return false;
      this.drag = { id, startCol: spool.col };
      this.setState(STATES.DRAGGING);
      return true;
    }
    moveDrag(col) {
      if (this.state !== STATES.DRAGGING) return false;
      const changed = this.board.moveSpool(this.drag.id, col);
      if (changed) this.notify();
      return changed;
    }
    cancelDrag() {
      if (this.state !== STATES.DRAGGING) return false;
      // No other piece moves during a drag, so the original cell is reachable.
      this.board.moveSpool(this.drag.id, this.drag.startCol);
      this.drag = null;
      this.setState(STATES.IDLE);
      return true;
    }
    async fall() {
      const before = this.board.snapshot();
      // Resolve the authoritative grid once, then animate the entire fall as
      // one continuous phase. Input and row scanning stay locked until it ends.
      this.board.settle();
      const after = this.board.snapshot();
      const moved = [];
      let maxDrop = 0;
      for (const spool of before) {
        const toRow = this.board.getSpool(spool.id).row;
        const drop = toRow - spool.row;
        if (drop > 0) {
          moved.push({ id: spool.id, fromRow: spool.row, toRow });
          maxDrop = Math.max(maxDrop, drop);
        }
      }
      if (!moved.length) return;
      const duration = Math.max(150, Math.min(300, 90 * Math.sqrt(maxDrop)));
      await this.animate({ kind: "fall", before, after, moved, maxDrop, duration });
    }
    async resolve() {
      // A slide can remove another spool's support. Settle the WHOLE board
      // before scanning for clears, both after a drag and after insertion.
      await this.fall();
      let chain = 0;
      while (true) {
        // Capture ALL full rows across the settled board before changing it.
        // One batch shares one animation, one chain step, and one score award.
        const rows = this.board.fullRows();
        if (!rows.length) return;
        chain += 1;
        const points = rows.length * (100 + 50 * (chain - 1));
        const before = this.board.snapshot();
        this.onClear({ rows, chain, points });
        await this.animate({ kind: "clear", before, after: before, rows, chain, points, duration: 240 });
        this.board.clearRows(rows);
        this.score += points;
        this.notify();
        // Gravity resumes only after the entire batch has disappeared.
        await this.fall();
      }
    }
    async releaseDrag() {
      if (this.state !== STATES.DRAGGING) return false;
      const { id, startCol } = this.drag;
      this.drag = null;
      if (this.board.getSpool(id).col === startCol) {
        this.setState(STATES.IDLE);
        return false;
      }
      this.moves += 1;
      this.setState(STATES.RESOLVING);
      // Finish every fall, simultaneous clear, chain, and score award caused
      // by this move before the incoming row can appear or affect the board.
      await this.resolve();
      // A top-row occupant would leave the board on this insertion: end now,
      // before gravity could hide an overflow. Keep the last valid grid intact.
      if (this.board.grid[0].some((cell) => cell !== null)) {
        this.setState(STATES.GAME_OVER);
        return true;
      }
      this.setState(STATES.INSERTING_ROW);
      const before = this.board.snapshot();
      this.board.insertRow(this.nextRow);
      await this.animate({ kind: "insert", before, after: this.board.snapshot(), duration: 240 });
      this.setState(STATES.RESOLVING);
      // Insertion starts a separate resolution, so its first clear scores 100.
      await this.resolve();
      this.board.assertValid();
      // Reveal the following preview only when the complete turn is settled.
      this.nextRow = this.board.makeRow();
      this.setState(STATES.IDLE);
      return true;
    }
  }
  return Object.freeze({ Game, STATES, sampleFallRow });
});

/* Browser view: the grid is never inferred from drawn pixels or tween positions. */
if (typeof document !== "undefined") (() => {
  "use strict";
  const { COLS, ROWS } = MeowEngine;
  const { Game, STATES, sampleFallRow } = MeowGame;
  const $ = (id) => document.getElementById(id);
  const canvas = $("board");
  const ctx = canvas.getContext("2d");
  const preview = $("next-row");
  const previewCtx = preview.getContext("2d");
  const background = document.createElement("canvas");
  const spoolArt = new Map();
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let cell = 28;
  let rowHeight = 28;
  let dpr = 1;
  let tween = null;
  let popup = null;
  let pointer = null;
  let selectedId = null;
  let dirty = true;
  let frameRequest = null;
  let pausedAt = null;
  let best = 0;
  let modal = null;
  try { best = Math.max(0, Number(localStorage.getItem("meow-match-best")) || 0); } catch (_) { /* File/private mode may deny storage. */ }
  const game = new Game({
    animate: animate,
    onChange: updateUI,
    onClear: ({ rows, chain, points }) => {
      popup = { row: Math.min(...rows), rowCount: rows.length, chain, points, start: animationNow() };
      const clearLabel = rows.length > 1 ? `${rows.length} rows together!` : "A little more room!";
      setStatus(`${clearLabel}${chain > 1 ? ` Chain ${chain} ·` : ""} +${points}`, true);
    }
  });

  function setStatus(text, busy = false) {
    $("status-text").textContent = text;
    $("game-status").classList.toggle("busy", busy);
  }
  function updateUI() {
    invalidate();
    $("score").textContent = game.score.toLocaleString();
    $("moves").textContent = game.moves.toLocaleString();
    if (game.score > best) {
      best = game.score;
      try { localStorage.setItem("meow-match-best", String(best)); } catch (_) { /* The game still works without persistence. */ }
    }
    $("best").textContent = best.toLocaleString();
    const busy = game.state !== STATES.IDLE && game.state !== STATES.GAME_OVER;
    $("help-button").disabled = busy;
    $("restart-button").disabled = busy;
    canvas.classList.toggle("dragging", game.state === STATES.DRAGGING);
    canvas.setAttribute("aria-busy", String(busy));
    canvas.dataset.state = game.state;
    if (game.state === STATES.IDLE) {
      // Finish transient score effects before returning input to the player.
      popup = null;
      const movable = game.board.snapshot().some((s) => { const b = game.board.dragBounds(s.id); return b.min !== b.max; });
      setStatus(movable ? "Your move. Slide a spool." : "No room to slide. Start a fresh basket.");
    } else if (game.state === STATES.DRAGGING) setStatus("Find a little room, then let go.");
    else if (game.state === STATES.INSERTING_ROW) {
      popup = null;
      setStatus("All settled. Here comes more yarn…", true);
    }
    else if (game.state === STATES.RESOLVING) setStatus("Let the yarn settle…", true);
    else {
      setStatus("The basket is full. Ready for another?");
      $("final-score").textContent = game.score.toLocaleString();
      $("game-over").hidden = false;
      $("play-again").focus({ preventScroll: true });
    }
    drawPreview();
  }

  function rounded(context, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.arcTo(x + width, y, x + width, y + height, r);
    context.arcTo(x + width, y + height, x, y + height, r);
    context.arcTo(x, y + height, x, y, r);
    context.arcTo(x, y, x + width, y, r);
    context.closePath();
  }

  function paintSpool(context, spool, unitX, unitY, selected = false) {
    const x = spool.col * unitX + 1.5;
    const y = spool.row * unitY + 2;
    const w = spool.length * unitX - 3;
    const h = unitY - 4;
    if (w <= 0 || h <= 0) return;
    context.save();
    // Each spool is drawn as ONE continuous yarn bar, with flanges only at its
    // two ends. Interior stitch lines are texture, never gameplay divisions.
    context.fillStyle = "#59604a22";
    rounded(context, x, y + 1.8, w, h, 5);
    context.fill();
    context.fillStyle = spool.color;
    rounded(context, x, y, w, h, 5);
    context.fill();
    context.save();
    rounded(context, x + 3, y + 1, Math.max(1, w - 6), h - 2, 3);
    context.clip();
    context.strokeStyle = "#fff9e961";
    context.lineWidth = .9;
    for (let tx = x - h; tx < x + w + h; tx += 4.3) {
      context.beginPath();
      context.moveTo(tx, y);
      context.bezierCurveTo(tx + h * .48, y + h * .35, tx - h * .08, y + h * .7, tx + h * .4, y + h);
      context.stroke();
    }
    context.fillStyle = "#ffffff23";
    context.fillRect(x, y + 3, w, h * .27);
    context.fillStyle = "#6b483613";
    context.fillRect(x, y + h * .73, w, h * .27);
    context.restore();
    context.fillStyle = "#fff8e94d";
    rounded(context, x, y, Math.min(5, w / 4), h, 2.5); context.fill();
    rounded(context, x + w - Math.min(5, w / 4), y, Math.min(5, w / 4), h, 2.5); context.fill();
    context.strokeStyle = selected ? "#526a48" : "#66533f28";
    context.lineWidth = selected ? 2 : .75;
    rounded(context, x + .4, y + .4, w - .8, h - .8, 4.5); context.stroke();
    context.restore();
  }

  function drawSpool(context, spool, unitX, unitY, selected = false, alpha = 1, row = spool.row) {
    // Yarn stitches are expensive vector paths. Rasterize each appearance once
    // at the current DPR; animation frames only composite the cached artwork.
    const key = `${unitX}/${unitY}/${spool.length}/${spool.color}/${selected}`;
    let art = spoolArt.get(key);
    if (!art) {
      art = document.createElement("canvas");
      art.width = Math.ceil(spool.length * unitX * dpr);
      art.height = Math.ceil(unitY * dpr);
      const artCtx = art.getContext("2d");
      artCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paintSpool(artCtx, { ...spool, row: 0, col: 0 }, unitX, unitY, selected);
      spoolArt.set(key, art);
    }
    context.save();
    context.globalAlpha = alpha;
    context.drawImage(art, spool.col * unitX, row * unitY, art.width / dpr, art.height / dpr);
    context.restore();
  }

  function drawPaw(context, x, y, size, color, angle = 0) {
    context.save(); context.translate(x, y); context.rotate(angle); context.fillStyle = color;
    context.beginPath(); context.ellipse(0, size * .15, size * .27, size * .23, 0, 0, Math.PI * 2); context.fill();
    [[-.31,-.13,-.4],[-.12,-.36,-.1],[.14,-.36,.1],[.33,-.12,.4]].forEach(([px,py,r]) => {
      context.beginPath(); context.ellipse(px * size, py * size, size * .1, size * .13, r, 0, Math.PI * 2); context.fill();
    }); context.restore();
  }

  function cacheBackground() {
    // The grid and cat decorations only change when the canvas size changes.
    background.width = canvas.width;
    background.height = canvas.height;
    const ctx = background.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#efeee3"; ctx.fillRect(0, 0, cell * COLS, rowHeight * ROWS);
    for (let row = 0; row < ROWS; row += 1) for (let col = 0; col < COLS; col += 1) {
      ctx.fillStyle = (row + col) % 2 ? "#f5f3e94d" : "#ffffff12";
      ctx.fillRect(col * cell, row * rowHeight, cell, rowHeight);
    }
    ctx.strokeStyle = "#d8d9c85c"; ctx.lineWidth = .65; ctx.beginPath();
    for (let col = 1; col < COLS; col += 1) { ctx.moveTo(col * cell, 0); ctx.lineTo(col * cell, ROWS * rowHeight); }
    for (let row = 1; row < ROWS; row += 1) { ctx.moveTo(0, row * rowHeight); ctx.lineTo(COLS * cell, row * rowHeight); }
    ctx.stroke();
    // Faint paw prints and a sleepy cat live in the empty space behind the grid.
    drawPaw(ctx, cell * 7.4, rowHeight * 2.2, cell * .65, "#aab69a29", -.35);
    drawPaw(ctx, cell * 6.7, rowHeight * 3.4, cell * .65, "#aab69a24", .2);
    const cx = cell * 4.5, cy = rowHeight * 5.2, r = cell * .6;
    ctx.save(); ctx.translate(cx, cy); ctx.strokeStyle = "#a1ac922c"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-r, -.2*r); ctx.lineTo(-r, -r); ctx.lineTo(-.35*r, -.55*r); ctx.quadraticCurveTo(0,-.7*r,.35*r,-.55*r); ctx.lineTo(r,-r); ctx.lineTo(r,-.2*r); ctx.bezierCurveTo(1.8*r,1.5*r,-1.8*r,1.5*r,-r,-.2*r); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-.65*r,.1*r); ctx.quadraticCurveTo(-.4*r,.35*r,-.15*r,.1*r); ctx.moveTo(.15*r,.1*r); ctx.quadraticCurveTo(.4*r,.35*r,.65*r,.1*r); ctx.stroke(); ctx.restore();
    ctx.save(); ctx.strokeStyle = "#c6977761"; ctx.setLineDash([3,5]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(5,rowHeight); ctx.lineTo(COLS*cell-5,rowHeight); ctx.stroke(); ctx.restore();
  }

  function render(now) {
    ctx.drawImage(background, 0, 0, background.width / dpr, background.height / dpr);
    // Paths are prepared once per animation, with no snapshots/maps/objects
    // allocated per spool on every frame. Time comes from RAF, not frame count.
    const spools = tween ? tween.pieces : game.board.spools.values();
    const t = tween ? Math.max(0, Math.min(1, (now - tween.start) / tween.duration)) : 1;
    const riseProgress = 1 - (1 - t) ** 3;
    if (game.drag) {
      const s = game.board.getSpool(game.drag.id);
      const bounds = game.board.dragBounds(s.id);
      ctx.fillStyle = "#7b977a1c";
      ctx.fillRect(bounds.min*cell, s.row*rowHeight, (bounds.max-bounds.min+s.length)*cell, rowHeight);
    }
    for (const s of spools) {
      let row = s.row;
      if (tween && tween.kind === "fall") row = sampleFallRow(s.fromRow, s.row, tween.maxDrop, t);
      else if (tween && tween.kind === "insert") row = s.fromRow + (s.row - s.fromRow) * riseProgress;
      let alpha = 1;
      if (tween && tween.kind === "clear" && tween.clearRows.has(s.row)) alpha = 1 - t * .9;
      drawSpool(ctx, s, cell, rowHeight, (game.drag && game.drag.id === s.id) || selectedId === s.id, alpha, row);
    }
    if (tween && tween.kind === "clear") {
      tween.rows.forEach((row) => { ctx.fillStyle = `rgba(255,250,217,${Math.sin(t*Math.PI)*.8})`; ctx.fillRect(0,row*rowHeight,COLS*cell,rowHeight); });
    }
    if (game.drag) {
      const s = game.board.getSpool(game.drag.id);
      drawPaw(ctx, (s.col+s.length/2)*cell, (s.row+.48)*rowHeight, Math.min(22,cell*.8), "#456047d9", -.15);
    }
    if (popup) {
      const progress = (now - popup.start) / 950;
      if (progress >= 1) popup = null;
      else {
        const width = Math.min(cell*7, 205), height = 32;
        const y = Math.max(12, Math.min((popup.row-.8)*rowHeight, ROWS*rowHeight-48)) - progress*rowHeight*.55;
        ctx.save(); ctx.globalAlpha = Math.min(1, (1-progress)*3);
        ctx.fillStyle = "#fcfbf3f2"; rounded(ctx,(COLS*cell-width)/2,y,width,height,16); ctx.fill();
        ctx.strokeStyle="#80957744"; ctx.lineWidth=1; ctx.stroke();
        drawPaw(ctx, COLS*cell/2-width/2+19,y+17,16,"#b98a59");
        ctx.fillStyle="#5c7653"; ctx.font=`bold ${Math.min(12,cell*.44)}px 'Trebuchet MS', sans-serif`; ctx.textAlign="center"; ctx.textBaseline="middle";
        const clearLabel = popup.rowCount > 1 ? `${popup.rowCount} ROWS` : popup.chain > 1 ? "PURRFECT" : "MEOW-VELOUS!";
        ctx.fillText(`${clearLabel}${popup.chain > 1 ? ` ×${popup.chain}` : ""}  +${popup.points}`,COLS*cell/2+11,y+17); ctx.restore();
      }
    }
  }

  function drawPreview() {
    // Keep the tray in place, but hide its yarn while the current outcome is
    // unresolved. The incoming row is revealed as its insertion begins.
    const visible = game.state === STATES.IDLE || game.state === STATES.INSERTING_ROW;
    preview.dataset.visible = String(visible);
    preview.setAttribute("aria-label", visible ? "Preview of the next bottom row" : "Next row hidden while the board resolves");
    if (!preview.width) return;
    const width = preview.clientWidth, height = preview.clientHeight;
    previewCtx.clearRect(0,0,width,height);
    const unit = width / COLS;
    for (let col=0;col<COLS;col+=1) { previewCtx.fillStyle="#edeee3"; rounded(previewCtx,col*unit+1,3,unit-2,height-6,3); previewCtx.fill(); }
    if (visible) game.nextRow.forEach((s) => drawSpool(previewCtx,{...s,row:0},unit,height));
  }
  function resize() {
    // CSS owns available space; the backing stores use DPR, keeping hit-testing
    // in CSS pixels even on high-density Android displays and after rotation.
    // A captured pointer uses the original cell scale. Cancel its gesture
    // before a size change can reinterpret the finger's horizontal movement.
    const region = $("board-region");
    // Use the largest shared cell size that fits both axes, preserving square
    // cells on every screen while keeping the whole 9-by-12 board visible.
    const nextCell = Math.max(1, Math.min(region.clientWidth / COLS, region.clientHeight / ROWS));
    const nextDpr = window.devicePixelRatio || 1;
    const previewWidth = Math.round(preview.clientWidth * nextDpr);
    const previewHeight = Math.round(preview.clientHeight * nextDpr);
    // ResizeObserver and window.resize can report the same geometry. Avoid
    // resetting backing stores/caches or cancelling a drag for those repeats.
    if (cell === nextCell && dpr === nextDpr &&
        canvas.width === Math.round(nextCell * COLS * nextDpr) &&
        canvas.height === Math.round(nextCell * ROWS * nextDpr) &&
        preview.width === previewWidth && preview.height === previewHeight) return;
    if (pointer) finishPointer(null, true);
    cell = nextCell;
    rowHeight = cell;
    const width = cell * COLS, height = rowHeight * ROWS;
    dpr = nextDpr;
    $("board-wrap").style.width = `${width}px`; $("board-wrap").style.height = `${height}px`;
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    canvas.width = Math.round(width*dpr); canvas.height = Math.round(height*dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);
    preview.width = previewWidth; preview.height = previewHeight;
    previewCtx.setTransform(dpr,0,0,dpr,0,0);
    spoolArt.clear();
    cacheBackground();
    drawPreview(); invalidate();
  }
  function animationNow() {
    return document.hidden && pausedAt !== null ? pausedAt : performance.now();
  }
  function animate(frame) {
    const starts = new Map(frame.before.map((s) => [s.id, s.row]));
    const pieces = frame.after.map((s) => ({ ...s, fromRow: starts.has(s.id) ? starts.get(s.id) : ROWS }));
    return new Promise((done) => {
      tween = { ...frame, pieces, clearRows: new Set(frame.rows), duration: reducedMotion.matches ? 35 : frame.duration, start: animationNow(), done };
      invalidate();
    });
  }
  function scheduleFrame() {
    if (frameRequest === null && !document.hidden) frameRequest = requestAnimationFrame(tick);
  }
  function invalidate() {
    dirty = true;
    scheduleFrame();
  }
  function tick(now) {
    frameRequest = null;
    if (document.hidden) return;
    if (dirty || tween || popup) {
      dirty = false;
      render(now);
      if (tween && now-tween.start >= tween.duration) {
        const done=tween.done; tween=null; dirty=true; done();
      }
    }
    // Let the phone rest between moves; pointer events and state changes wake
    // one frame, while active animations keep requesting the next frame.
    if (dirty || tween || popup) scheduleFrame();
  }

  function localPoint(event) {
    const rect=canvas.getBoundingClientRect();
    return { x:(event.clientX-rect.left)/rect.width*COLS, y:(event.clientY-rect.top)/rect.height*ROWS, cellWidth:rect.width/COLS };
  }
  function dragColumn(event) {
    // Track finger displacement in screen coordinates. If layout re-centers
    // an unchanged-size board, a stationary finger must not slide its spool.
    return pointer.startCol + (event.clientX - pointer.startClientX) / pointer.cellWidth;
  }
  canvas.addEventListener("pointerdown",(event) => {
    if (modal || game.state!==STATES.IDLE || !event.isPrimary || (event.pointerType==="mouse" && event.button!==0)) return;
    const p=localPoint(event), col=Math.floor(p.x), row=Math.floor(p.y);
    if (row<0 || row>=ROWS || col<0 || col>=COLS) return;
    const id=game.board.grid[row][col];
    if (id===null || !game.beginDrag(id)) return;
    event.preventDefault(); selectedId=null;
    pointer={id:event.pointerId,startClientX:event.clientX,cellWidth:p.cellWidth,startCol:game.drag.startCol};
    canvas.setPointerCapture(event.pointerId);
    canvas.focus({preventScroll:true});
  });
  canvas.addEventListener("pointermove",(event) => {
    if (!pointer || event.pointerId!==pointer.id) return;
    event.preventDefault();
    game.moveDrag(dragColumn(event));
  });
  function finishPointer(event,cancelled=false) {
    if (!pointer || (event && event.pointerId!==pointer.id)) return;
    const id=pointer.id;
    if (!cancelled && event) game.moveDrag(dragColumn(event));
    pointer=null;
    if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    if (cancelled) game.cancelDrag();
    else void game.releaseDrag();
  }
  canvas.addEventListener("pointerup",(event)=>finishPointer(event));
  canvas.addEventListener("pointercancel",(event)=>finishPointer(event,true));
  canvas.addEventListener("lostpointercapture",(event)=>finishPointer(event,true));
  canvas.addEventListener("contextmenu",(event)=>event.preventDefault());
  window.addEventListener("blur",()=>{ finishPointer(null,true); if(game.state===STATES.DRAGGING) game.cancelDrag(); });
  document.addEventListener("visibilitychange",()=>{
    if (document.hidden) {
      pausedAt = performance.now();
      if (frameRequest !== null) cancelAnimationFrame(frameRequest);
      frameRequest = null;
      finishPointer(null, true);
      if (game.state === STATES.DRAGGING) game.cancelDrag();
    } else {
      // Background tabs throttle RAF. Exclude hidden time so returning to the
      // game resumes the drop in place rather than jumping to its last frame.
      if (pausedAt !== null) {
        const elapsed = performance.now() - pausedAt;
        if (tween) tween.start += elapsed;
        if (popup) popup.start += elapsed;
        pausedAt = null;
      }
      invalidate();
    }
  });

  canvas.addEventListener("keydown",(event)=>{
    if(modal || pointer || ![STATES.IDLE,STATES.DRAGGING].includes(game.state)) return;
    const keys=["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Enter"," ","Escape"];
    if(!keys.includes(event.key))return;
    event.preventDefault();
    if(event.key==="Escape"){game.cancelDrag();selectedId=null;invalidate();return;}
    const list=game.board.snapshot().sort((a,b)=>b.row-a.row || a.col-b.col);
    if(!list.length)return;
    if(event.key==="ArrowUp" || event.key==="ArrowDown"){
      if(game.state===STATES.DRAGGING)return;
      const index=list.findIndex(s=>s.id===selectedId);
      selectedId=list[(index+(event.key==="ArrowUp"?1:-1)+list.length)%list.length].id;invalidate();
    }else if(event.key==="Enter" || event.key===" "){
      if(game.state===STATES.DRAGGING){selectedId=null;void game.releaseDrag();}
      else {selectedId=selectedId || list[0].id;game.beginDrag(selectedId);}
    }else{
      if(game.state===STATES.IDLE){selectedId=game.board.getSpool(selectedId)?selectedId:list[0].id;game.beginDrag(selectedId);}
      const s=game.board.getSpool(game.drag.id);game.moveDrag(s.col+(event.key==="ArrowRight"?1:-1));
    }
  });

  function showModal(id) {
    if(![STATES.IDLE,STATES.GAME_OVER].includes(game.state))return;
    closeModal(false);modal=id;$(id).hidden=false;
    canvas.tabIndex=-1;
    $(id).querySelector("button").focus({preventScroll:true});
  }
  function closeModal(focus=true) {if(modal)$(modal).hidden=true;modal=null;canvas.tabIndex=0;if(focus)canvas.focus({preventScroll:true});}
  function newGame(){closeModal(false);$("game-over").hidden=true;popup=null;selectedId=null;game.reset();canvas.focus({preventScroll:true});}
  $("help-button").addEventListener("click",()=>showModal("help-overlay"));
  $("close-help").addEventListener("click",()=>closeModal());
  $("restart-button").addEventListener("click",()=>showModal("restart-overlay"));
  $("confirm-restart").addEventListener("click",newGame);
  $("cancel-restart").addEventListener("click",()=>closeModal());
  $("play-again").addEventListener("click",newGame);
  document.addEventListener("keydown",(event)=>{if(event.key==="Escape"&&modal){event.preventDefault();closeModal();}});
  document.querySelector(".brand").addEventListener("click",(event)=>event.preventDefault());
  new ResizeObserver(resize).observe($("board-region"));
  window.addEventListener("resize",resize);
  game.reset(); resize();

  // file:// needs no worker. On secure static hosting the optional worker
  // precaches only this folder's files; gameplay never makes network requests.
  if(location.protocol!=="file:") {
    const manifest=document.createElement("link");manifest.rel="manifest";manifest.href="manifest.json";document.head.appendChild(manifest);
    if("serviceWorker" in navigator && window.isSecureContext) {
      navigator.serviceWorker.register("./service-worker.js").catch(()=>{ /* Static/file play remains fully functional if installation is denied. */ });
    }
  }
})();
