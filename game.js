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
      this.notify();
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
    async fall(onlyId = null) {
      while (true) {
        const before = this.board.snapshot();
        const moved = this.board.gravityStep(onlyId);
        if (!moved.length) return;
        await this.animate({ kind: "fall", before, after: this.board.snapshot(), moved, duration: 150 });
      }
    }
    async resolve(onlyId = null) {
      // Release initially drops only the selected spool. After a clear, every
      // spool is eligible. No row compression or per-cell falling is used.
      await this.fall(onlyId);
      let chain = 0;
      while (true) {
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
      await this.resolve(id);
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
      this.nextRow = this.board.makeRow();
      this.setState(STATES.RESOLVING);
      // Insertion starts a separate resolution, so its first clear scores 100.
      await this.resolve();
      this.board.assertValid();
      this.setState(STATES.IDLE);
      return true;
    }
  }
  return Object.freeze({ Game, STATES });
});

/* Browser view: the grid is never inferred from drawn pixels or tween positions. */
if (typeof document !== "undefined") (() => {
  "use strict";
  const { COLS, ROWS } = MeowEngine;
  const { Game, STATES } = MeowGame;
  const $ = (id) => document.getElementById(id);
  const canvas = $("board");
  const ctx = canvas.getContext("2d");
  const preview = $("next-row");
  const previewCtx = preview.getContext("2d");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let cell = 28;
  let dpr = 1;
  let tween = null;
  let popup = null;
  let pointer = null;
  let selectedId = null;
  let dirty = true;
  let best = 0;
  let modal = null;
  try { best = Math.max(0, Number(localStorage.getItem("meow-match-best")) || 0); } catch (_) { /* File/private mode may deny storage. */ }
  const game = new Game({
    animate: animate,
    onChange: updateUI,
    onClear: ({ rows, chain, points }) => {
      popup = { row: Math.min(...rows), chain, points, start: performance.now() };
      setStatus(chain > 1 ? `Purrfect! Chain ${chain} · +${points}` : `A little more room! +${points}`, true);
    }
  });

  function setStatus(text, busy = false) {
    $("status-text").textContent = text;
    $("game-status").classList.toggle("busy", busy);
  }
  function updateUI() {
    dirty = true;
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
    else if (game.state === STATES.INSERTING_ROW) setStatus("A little more yarn is on its way…", true);
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

  function drawSpool(context, spool, unitX, unitY, selected = false, alpha = 1) {
    const x = spool.col * unitX + 2;
    const y = spool.row * unitY + 2.5;
    const w = spool.length * unitX - 4;
    const h = unitY - 5;
    if (w <= 0 || h <= 0) return;
    context.save();
    context.globalAlpha = alpha;
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

  function drawPaw(context, x, y, size, color, angle = 0) {
    context.save(); context.translate(x, y); context.rotate(angle); context.fillStyle = color;
    context.beginPath(); context.ellipse(0, size * .15, size * .27, size * .23, 0, 0, Math.PI * 2); context.fill();
    [[-.31,-.13,-.4],[-.12,-.36,-.1],[.14,-.36,.1],[.33,-.12,.4]].forEach(([px,py,r]) => {
      context.beginPath(); context.ellipse(px * size, py * size, size * .1, size * .13, r, 0, Math.PI * 2); context.fill();
    }); context.restore();
  }

  function drawBackground() {
    ctx.fillStyle = "#efeee3"; ctx.fillRect(0, 0, cell * COLS, cell * ROWS);
    for (let row = 0; row < ROWS; row += 1) for (let col = 0; col < COLS; col += 1) {
      ctx.fillStyle = (row + col) % 2 ? "#f5f3e94d" : "#ffffff12";
      ctx.fillRect(col * cell, row * cell, cell, cell);
    }
    ctx.strokeStyle = "#d8d9c85c"; ctx.lineWidth = .65; ctx.beginPath();
    for (let col = 1; col < COLS; col += 1) { ctx.moveTo(col * cell, 0); ctx.lineTo(col * cell, ROWS * cell); }
    for (let row = 1; row < ROWS; row += 1) { ctx.moveTo(0, row * cell); ctx.lineTo(COLS * cell, row * cell); }
    ctx.stroke();
    // Faint paw prints and a sleepy cat live in the empty space behind the grid.
    drawPaw(ctx, cell * 7.4, cell * 2.2, cell * .65, "#aab69a29", -.35);
    drawPaw(ctx, cell * 6.7, cell * 3.4, cell * .65, "#aab69a24", .2);
    const cx = cell * 4.5, cy = cell * 5.2, r = cell * .6;
    ctx.save(); ctx.translate(cx, cy); ctx.strokeStyle = "#a1ac922c"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-r, -.2*r); ctx.lineTo(-r, -r); ctx.lineTo(-.35*r, -.55*r); ctx.quadraticCurveTo(0,-.7*r,.35*r,-.55*r); ctx.lineTo(r,-r); ctx.lineTo(r,-.2*r); ctx.bezierCurveTo(1.8*r,1.5*r,-1.8*r,1.5*r,-r,-.2*r); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-.65*r,.1*r); ctx.quadraticCurveTo(-.4*r,.35*r,-.15*r,.1*r); ctx.moveTo(.15*r,.1*r); ctx.quadraticCurveTo(.4*r,.35*r,.65*r,.1*r); ctx.stroke(); ctx.restore();
    ctx.save(); ctx.strokeStyle = "#c6977761"; ctx.setLineDash([3,5]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(5,cell); ctx.lineTo(COLS*cell-5,cell); ctx.stroke(); ctx.restore();
  }

  function render(now) {
    drawBackground();
    let spools = game.board.snapshot();
    let t = 1;
    if (tween) {
      t = Math.min(1, (now - tween.start) / tween.duration);
      const p = tween.kind === "fall" ? t * t : 1 - (1 - t) ** 3;
      const starts = new Map(tween.before.map((s) => [s.id, s]));
      spools = tween.after.map((s) => {
        const start = starts.get(s.id);
        const fromRow = start ? start.row : ROWS;
        return { ...s, row: fromRow + (s.row - fromRow) * p };
      });
    }
    if (game.drag) {
      const s = game.board.getSpool(game.drag.id);
      const bounds = game.board.dragBounds(s.id);
      ctx.fillStyle = "#7b977a1c";
      ctx.fillRect(bounds.min*cell, s.row*cell, (bounds.max-bounds.min+s.length)*cell, cell);
    }
    spools.forEach((s) => {
      let alpha = 1;
      if (tween && tween.kind === "clear" && tween.rows.includes(s.row)) alpha = 1 - t * .9;
      drawSpool(ctx, s, cell, cell, (game.drag && game.drag.id === s.id) || selectedId === s.id, alpha);
    });
    if (tween && tween.kind === "clear") {
      tween.rows.forEach((row) => { ctx.fillStyle = `rgba(255,250,217,${Math.sin(t*Math.PI)*.8})`; ctx.fillRect(0,row*cell,COLS*cell,cell); });
    }
    if (game.drag) {
      const s = game.board.getSpool(game.drag.id);
      drawPaw(ctx, (s.col+s.length/2)*cell, (s.row+.48)*cell, Math.min(22,cell*.8), "#456047d9", -.15);
    }
    if (popup) {
      const progress = (now - popup.start) / 950;
      if (progress >= 1) popup = null;
      else {
        const width = Math.min(cell*7, 205), height = 32;
        const y = Math.max(12, Math.min((popup.row-.8)*cell, ROWS*cell-48)) - progress*cell*.55;
        ctx.save(); ctx.globalAlpha = Math.min(1, (1-progress)*3);
        ctx.fillStyle = "#fcfbf3f2"; rounded(ctx,(COLS*cell-width)/2,y,width,height,16); ctx.fill();
        ctx.strokeStyle="#80957744"; ctx.lineWidth=1; ctx.stroke();
        drawPaw(ctx, COLS*cell/2-width/2+19,y+17,16,"#b98a59");
        ctx.fillStyle="#5c7653"; ctx.font=`bold ${Math.min(12,cell*.44)}px 'Trebuchet MS', sans-serif`; ctx.textAlign="center"; ctx.textBaseline="middle";
        ctx.fillText(popup.chain > 1 ? `PURRFECT ×${popup.chain}  +${popup.points}` : `MEOW-VELOUS!  +${popup.points}`,COLS*cell/2+11,y+17); ctx.restore();
      }
    }
  }

  function drawPreview() {
    if (!preview.width) return;
    const width = preview.clientWidth, height = preview.clientHeight;
    previewCtx.clearRect(0,0,width,height);
    const unit = width / COLS;
    for (let col=0;col<COLS;col+=1) { previewCtx.fillStyle="#edeee3"; rounded(previewCtx,col*unit+1,3,unit-2,height-6,3); previewCtx.fill(); }
    game.nextRow.forEach((s) => drawSpool(previewCtx,{...s,row:0},unit,height));
  }
  function resize() {
    // CSS owns available space; the backing stores use DPR, keeping hit-testing
    // in CSS pixels even on high-density Android displays and after rotation.
    // A captured pointer uses the old canvas origin/scale. Cancel its gesture
    // before a resize can reinterpret an unchanged finger as a horizontal move.
    if (pointer) finishPointer(null, true);
    const region = $("board-region");
    cell = Math.max(1, Math.min(region.clientWidth / COLS, region.clientHeight / ROWS));
    const width = cell * COLS, height = cell * ROWS;
    dpr = window.devicePixelRatio || 1;
    $("board-wrap").style.width = `${width}px`; $("board-wrap").style.height = `${height}px`;
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    canvas.width = Math.round(width*dpr); canvas.height = Math.round(height*dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);
    preview.width = Math.round(preview.clientWidth*dpr); preview.height = Math.round(preview.clientHeight*dpr);
    previewCtx.setTransform(dpr,0,0,dpr,0,0);
    drawPreview(); dirty = true;
  }
  function animate(frame) {
    return new Promise((done) => { tween = { ...frame, duration: reducedMotion.matches ? 35 : frame.duration, start: performance.now(), done }; dirty = true; });
  }
  function tick(now) {
    if (dirty || tween || popup) {
      render(now); dirty = false;
      if (tween && now-tween.start >= tween.duration) {
        const done=tween.done; tween=null; dirty=true; done();
      }
    }
    requestAnimationFrame(tick);
  }

  function localPoint(event) {
    const rect=canvas.getBoundingClientRect();
    return { x:(event.clientX-rect.left)/rect.width*COLS, y:(event.clientY-rect.top)/rect.height*ROWS };
  }
  canvas.addEventListener("pointerdown",(event) => {
    if (modal || game.state!==STATES.IDLE || !event.isPrimary || (event.pointerType==="mouse" && event.button!==0)) return;
    const p=localPoint(event), col=Math.floor(p.x), row=Math.floor(p.y);
    if (row<0 || row>=ROWS || col<0 || col>=COLS) return;
    const id=game.board.grid[row][col];
    if (id===null || !game.beginDrag(id)) return;
    event.preventDefault(); selectedId=null;
    pointer={id:event.pointerId,startX:p.x,startCol:game.drag.startCol};
    canvas.setPointerCapture(event.pointerId);
    canvas.focus({preventScroll:true});
  });
  canvas.addEventListener("pointermove",(event) => {
    if (!pointer || event.pointerId!==pointer.id) return;
    event.preventDefault();
    game.moveDrag(pointer.startCol+localPoint(event).x-pointer.startX);
  });
  function finishPointer(event,cancelled=false) {
    if (!pointer || (event && event.pointerId!==pointer.id)) return;
    const id=pointer.id;
    if (!cancelled && event) game.moveDrag(pointer.startCol+localPoint(event).x-pointer.startX);
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
  document.addEventListener("visibilitychange",()=>{ if(document.hidden){ finishPointer(null,true); if(game.state===STATES.DRAGGING) game.cancelDrag(); } });

  canvas.addEventListener("keydown",(event)=>{
    if(modal || pointer || ![STATES.IDLE,STATES.DRAGGING].includes(game.state)) return;
    const keys=["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Enter"," ","Escape"];
    if(!keys.includes(event.key))return;
    event.preventDefault();
    if(event.key==="Escape"){game.cancelDrag();selectedId=null;dirty=true;return;}
    const list=game.board.snapshot().sort((a,b)=>b.row-a.row || a.col-b.col);
    if(!list.length)return;
    if(event.key==="ArrowUp" || event.key==="ArrowDown"){
      if(game.state===STATES.DRAGGING)return;
      const index=list.findIndex(s=>s.id===selectedId);
      selectedId=list[(index+(event.key==="ArrowUp"?1:-1)+list.length)%list.length].id;dirty=true;
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
  game.reset(); resize(); requestAnimationFrame(tick);

  // file:// needs no worker. On secure static hosting the optional worker
  // precaches only this folder's files; gameplay never makes network requests.
  if(location.protocol!=="file:") {
    const manifest=document.createElement("link");manifest.rel="manifest";manifest.href="manifest.json";document.head.appendChild(manifest);
    if("serviceWorker" in navigator && window.isSecureContext) {
      navigator.serviceWorker.register("./service-worker.js").catch(()=>{ /* Static/file play remains fully functional if installation is denied. */ });
    }
  }
})();
