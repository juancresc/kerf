// Canvas view: renders the document, zoom/scroll, grid, rulers, and the tools
// (select + move + marquee, pan, line, rect (+ radius), circle, ellipse, slot, outline, fillet,
// dog-bone, text). Slots, rounded rects, outlines, fillets and dog-bones are made by server ops
// (exact arcs); the browser only previews them.

import { app, emit, on, savePref, setSelection, elementById, itemAt, elementsOf, selectItems, selectedItems,
         setContext, descendants, groupById, ancestors } from './state.js';
import { NS, createNode, bboxOf, unionBox, boxInside, boxTouches, slotPath } from './geometry.js';
import { api } from './api.js';
import { modal, toast } from './ui.js';

const svg = document.getElementById('canvas');
const wrap = document.getElementById('canvas-wrap');
const gBackground = document.getElementById('background');
const gContent = document.getElementById('content');
const gHits = document.getElementById('hits');
const gOverlay = document.getElementById('overlay');
const gMeasure = document.createElementNS('http://www.w3.org/2000/svg', 'g');   // measure tool layer
gMeasure.id = 'measure';
svg.appendChild(gMeasure);
const breadcrumb = document.getElementById('breadcrumb');
const rulerH = document.getElementById('ruler-h');
const rulerV = document.getElementById('ruler-v');

const ZOOM_MIN = 0.02, ZOOM_MAX = 20;
const HIT_WIDTH = 12;          // px: how far from a line you can click it
const DRAG_THRESHOLD = 3;      // px before a press becomes a drag

let nodes = new Map();         // id -> rendered node
let hitNodes = new Map();      // id -> hit-area node
let gesture = null;            // current pointer interaction
let pendingRender = false;
let spaceDown = false;
let cursorDoc = null;
let lastClient = { x: 0, y: 0 }; // last pointer position (screen), for the tool-options box
// Values the shape tools remember between uses (typed in the dimension box)
export const toolOpts = { radius: 0, slotWidth: 10, fillet: 10, dogbone: 0 };
const DRAFT_TAG = { slot: 'path', outline: 'polyline' };
const CORNER_TOOLS = new Set(['fillet', 'dogbone']);

// ── Rendering ──────────────────────────────────────────────

export function render() {
  if (gesture?.kind === 'move') { pendingRender = true; return; }
  pendingRender = false;
  const doc = app.doc;
  if (!doc) return;

  svg.setAttribute('viewBox', `0 0 ${doc.width} ${doc.height}`);
  applyZoom();

  gBackground.replaceChildren();
  if (doc.background?.href) {
    const img = document.createElementNS(NS, 'image');
    for (const [k, v] of Object.entries({ href: doc.background.href, x: 0, y: 0, width: doc.width,
      height: doc.height, opacity: doc.background.opacity, preserveAspectRatio: 'xMidYMid meet' })) img.setAttribute(k, v);
    gBackground.appendChild(img);
  }

  if (app.context && !groupById(app.context)) setContext(null);
  const inContext = app.context ? new Set(descendants(app.context)) : null;
  svg.classList.toggle('in-group', !!app.context);
  renderBreadcrumb();
  keyPointCache = null;
  nodes = new Map();
  hitNodes = new Map();
  const content = [], hits = [];
  for (const layer of doc.layers) {
    const g = document.createElementNS(NS, 'g');
    g.dataset.layer = layer.name;
    if (!layer.visible) g.setAttribute('display', 'none');
    for (const el of doc.elements) {
      if (el.layer !== layer.name) continue;
      const node = createNode(el, layer, { screen: true });
      node.dataset.id = el.id;
      if (app.selection.has(el.id)) node.classList.add('selected');
      if (inContext && inContext.has(el.id)) node.classList.add('in-context');
      g.appendChild(node);
      nodes.set(el.id, node);
      if (layer.visible && !layer.locked) {
        const hit = createNode(el, layer, { screen: true });
        hit.dataset.id = el.id;
        hit.removeAttribute('stroke-dasharray');
        hit.setAttribute('stroke-width', HIT_WIDTH);
        const filled = el.tag === 'text' || (el.attrs.fill && el.attrs.fill !== 'none');
        hit.setAttribute('pointer-events', filled ? 'all' : 'stroke');
        if (el.tag === 'text') hit.setAttribute('fill', 'transparent');
        hits.push(hit);
        hitNodes.set(el.id, hit);
      }
    }
    content.push(g);
  }
  gContent.replaceChildren(...content);
  gHits.replaceChildren(...hits);

  // Drop selected ids that no longer exist
  const alive = [...app.selection].filter(id => nodes.has(id));
  if (alive.length !== app.selection.size) setSelection(alive);
  else drawSelection();
}

export function drawSelection() {
  for (const [id, node] of nodes) node.classList.toggle('selected', app.selection.has(id));
  // One box per selected item (a group counts as one), plus overall dimensions
  const items = selectedItems();
  const loose = [...app.selection].filter(id => !items.some(it => elementsOf(it).includes(id)));
  const boxOf = ids => unionBox(ids.map(id => nodes.get(id) && bboxOf(nodes.get(id), svg)));
  const boxes = [...items.map(it => boxOf(elementsOf(it))), ...loose.map(id => boxOf([id]))].filter(Boolean);
  const px = 3 / app.zoom;
  const out = boxes.map(b => rectNode({ x: b.x - px, y: b.y - px, width: b.width + 2 * px, height: b.height + 2 * px }, 'sel-box'));
  const all = unionBox(boxes);
  if (all && app.showDims) out.push(...dimensionNodes(all));
  gOverlay.replaceChildren(...out);
  emit('selection-geometry', all);
}

// Width (above) and height (right) of a box, drawn in screen-constant sizes
function dimensionNodes(b) {
  const k = 1 / app.zoom, off = 14 * k, ext = 4 * k;
  const line = (x1, y1, x2, y2, cls) => {
    const l = document.createElementNS(NS, 'line');
    Object.entries({ x1, y1, x2, y2 }).forEach(([a, v]) => l.setAttribute(a, v));
    l.setAttribute('class', cls);
    return l;
  };
  const text = (x, y, s, rotate) => {
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', x); t.setAttribute('y', y);
    t.setAttribute('class', 'dim-text');
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('font-size', 11 * k);
    t.style.fontSize = (11 * k) + 'px';
    t.style.strokeWidth = (3 * k) + 'px';
    if (rotate) t.setAttribute('transform', `rotate(-90 ${x} ${y})`);
    t.textContent = s;
    return t;
  };
  const f = v => String(+v.toFixed(2));
  const yTop = b.y - off, xRight = b.x + b.width + off;
  return [
    line(b.x, yTop, b.x + b.width, yTop, 'dim-line'),
    line(b.x, b.y - ext, b.x, yTop - ext, 'dim-ext'), line(b.x + b.width, b.y - ext, b.x + b.width, yTop - ext, 'dim-ext'),
    text(b.x + b.width / 2, yTop - 4 * k, f(b.width)),
    line(xRight, b.y, xRight, b.y + b.height, 'dim-line'),
    line(b.x + b.width + ext, b.y, xRight + ext, b.y, 'dim-ext'), line(b.x + b.width + ext, b.y + b.height, xRight + ext, b.y + b.height, 'dim-ext'),
    text(xRight + 12 * k, b.y + b.height / 2, f(b.height), true),
  ];
}

export function setShowDims(v) {
  app.showDims = v;
  savePref('showDims', v);
  drawSelection();
  emit('view');
}

function renderBreadcrumb() {
  if (!app.context) { breadcrumb.hidden = true; return; }
  const chain = ancestors(app.context).reverse();       // outermost first
  breadcrumb.hidden = false;
  breadcrumb.innerHTML = `<button data-ctx="">Top</button>` + chain.map((g, i) =>
    ` › ${i === chain.length - 1 ? `<span class="here">${escHtml(groupById(g)?.name)}</span>` : `<button data-ctx="${g}">${escHtml(groupById(g)?.name)}</button>`}`).join('') +
    `<span class="hint">Esc: go up · double-click: enter</span>`;
}
const escHtml = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
breadcrumb.addEventListener('click', (e) => {
  const b = e.target.closest('[data-ctx]');
  if (!b) return;
  setSelection([]);
  setContext(b.dataset.ctx || null);
  render();
});

export function enterGroup(gid) {
  if (!gid?.startsWith('g-')) return;
  setContext(gid);
  setSelection([]);
  render();
}

export function exitGroup() {
  if (!app.context) return false;
  const up = groupById(app.context)?.parent ?? null;
  const was = app.context;
  setContext(up);
  selectItems([was]);
  render();
  return true;
}

function rectNode(b, cls) {
  const r = document.createElementNS(NS, 'rect');
  r.setAttribute('x', b.x); r.setAttribute('y', b.y);
  r.setAttribute('width', Math.max(0, b.width)); r.setAttribute('height', Math.max(0, b.height));
  r.setAttribute('class', cls);
  return r;
}

let keyPointCache = null;

export function selectionBox() {
  return unionBox([...app.selection].map(id => nodes.get(id) && bboxOf(nodes.get(id), svg)));
}

export function elementBox(id) {
  const n = nodes.get(id);
  return n ? bboxOf(n, svg) : null;
}

// ── Zoom, scroll, grid ─────────────────────────────────────

function applyZoom() {
  const doc = app.doc;
  if (!doc) return;
  svg.style.width = doc.width * app.zoom + 'px';
  svg.style.height = doc.height * app.zoom + 'px';
  applyGrid();
  drawRulers();
  emit('zoom');
}

function applyGrid() {
  if (!app.showGrid) { svg.style.backgroundImage = 'none'; return; }
  let step = app.grid;
  while (step * app.zoom < 8) step *= step % 10 === 0 || step === 1 ? 5 : 2;
  const px = step * app.zoom, major = px * 10;
  const minor = '#f0f0f0', majorC = '#e0e0e0';
  svg.style.backgroundImage = [
    `linear-gradient(to right, ${majorC} 1px, transparent 1px)`,
    `linear-gradient(to bottom, ${majorC} 1px, transparent 1px)`,
    `linear-gradient(to right, ${minor} 1px, transparent 1px)`,
    `linear-gradient(to bottom, ${minor} 1px, transparent 1px)`,
  ].join(',');
  svg.style.backgroundSize = `${major}px ${major}px, ${major}px ${major}px, ${px}px ${px}px, ${px}px ${px}px`;
}

export function setZoom(z, clientX, clientY) {
  if (!wrap.clientWidth) return;              // hidden (3D view): keep the current zoom
  const r = wrap.getBoundingClientRect();
  if (clientX == null) { clientX = r.left + wrap.clientWidth / 2; clientY = r.top + wrap.clientHeight / 2; }
  const before = toDoc(clientX, clientY);
  app.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  savePref('zoom', app.zoom);
  applyZoom();
  const after = svg.getBoundingClientRect();
  wrap.scrollLeft += after.left + before.x * app.zoom - clientX;
  wrap.scrollTop += after.top + before.y * app.zoom - clientY;
  drawRulers();
}

export const zoomIn = () => setZoom(app.zoom * 1.25);
export const zoomOut = () => setZoom(app.zoom / 1.25);
export const zoom100 = () => setZoom(1);

let fitPending = false;
export function zoomFit() {
  const d = app.doc;
  if (!d) return;
  // The 2D view is hidden (3D showing): fit when it becomes visible, not now (it measures 0 px)
  if (!wrap.clientWidth || !wrap.clientHeight) { fitPending = true; return; }
  fitPending = false;
  setZoom(Math.min((wrap.clientWidth - 80) / d.width, (wrap.clientHeight - 80) / d.height));
}

/** Called when the 2D view becomes visible again. */
export function onShown() {
  if (fitPending) zoomFit();
  drawRulers();
}

export function zoomToSelection() {
  const b = selectionBox();
  if (!b) return zoomFit();
  const z = Math.min((wrap.clientWidth - 120) / Math.max(b.width, 1), (wrap.clientHeight - 120) / Math.max(b.height, 1));
  setZoom(Math.min(z, 8));
  const r = svg.getBoundingClientRect();
  wrap.scrollLeft += r.left + (b.x + b.width / 2) * app.zoom - (wrap.getBoundingClientRect().left + wrap.clientWidth / 2);
  wrap.scrollTop += r.top + (b.y + b.height / 2) * app.zoom - (wrap.getBoundingClientRect().top + wrap.clientHeight / 2);
  drawRulers();
}

export function setGrid({ snap, grid, showGrid }) {
  if (snap !== undefined) { app.snap = snap; savePref('snap', snap); }
  if (grid !== undefined) { app.grid = grid; savePref('grid', grid); }
  if (showGrid !== undefined) { app.showGrid = showGrid; savePref('showGrid', showGrid); }
  applyGrid();
  emit('view');
}

// ── Rulers (cm or in labels; document is mm) ───────────────

export function toggleUnit() {
  app.unit = app.unit === 'cm' ? 'in' : 'cm';
  savePref('unit', app.unit);
  document.getElementById('ruler-corner').textContent = app.unit;
  drawRulers();
}

let rulerFrame = 0;
export function drawRulers() {
  if (rulerFrame) return;               // at most once per animation frame
  rulerFrame = requestAnimationFrame(() => { rulerFrame = 0; drawRulersNow(); });
}

function drawRulersNow() {
  if (!app.doc) return;
  const svgRect = svg.getBoundingClientRect(), wrapRect = wrap.getBoundingClientRect();
  const pxPerUnit = (app.unit === 'cm' ? 10 : 25.4) * app.zoom;
  const step = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100].find(n => pxPerUnit * n >= 45) || 100;
  const pxMajor = pxPerUnit * step;
  const subs = [10, 5, 4, 2, 1].find(n => pxMajor / n >= 6) || 1;
  axis(rulerH, 'h', wrap.clientWidth, svgRect.left - wrapRect.left, pxMajor, step, subs, cursorDoc && cursorDoc.x * app.zoom);
  axis(rulerV, 'v', wrap.clientHeight, svgRect.top - wrapRect.top, pxMajor, step, subs, cursorDoc && cursorDoc.y * app.zoom);
}

function axis(canvas, dir, length, offset, pxMajor, step, subs, mark) {
  const T = 22, dpr = devicePixelRatio;
  const [w, h] = dir === 'h' ? [length, T] : [T, length];
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#f7f7f7'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#bdbdbd'; ctx.fillStyle = '#777'; ctx.lineWidth = 1;
  ctx.font = '9px -apple-system, sans-serif'; ctx.textBaseline = 'top';
  const first = Math.floor(-offset / pxMajor) - 1, last = Math.ceil((length - offset) / pxMajor) + 1;
  for (let u = first; u <= last; u++) {
    for (let s = 0; s < subs; s++) {
      const p = Math.round(offset + u * pxMajor + s * pxMajor / subs) + .5;
      if (p < 0 || p > length) continue;
      const t = s === 0 ? T * .6 : (subs % 2 === 0 && s === subs / 2 ? T * .38 : T * .22);
      ctx.beginPath();
      if (dir === 'h') { ctx.moveTo(p, T); ctx.lineTo(p, T - t); } else { ctx.moveTo(T, p); ctx.lineTo(T - t, p); }
      ctx.stroke();
      if (s === 0) {
        const label = String(+(u * step).toFixed(2));
        if (dir === 'h') ctx.fillText(label, p + 2, 2);
        else { ctx.save(); ctx.translate(2, p + 2); ctx.rotate(Math.PI / 2); ctx.translate(0, -9); ctx.fillText(label, 0, 0); ctx.restore(); }
      }
    }
  }
  if (mark != null) {
    const p = offset + mark;
    ctx.strokeStyle = '#e5484d';
    ctx.beginPath();
    if (dir === 'h') { ctx.moveTo(p, 0); ctx.lineTo(p, T); } else { ctx.moveTo(0, p); ctx.lineTo(T, p); }
    ctx.stroke();
  }
}

// ── Coordinates ────────────────────────────────────────────

export function toDoc(clientX, clientY) {
  const m = svg.getScreenCTM();
  if (!m) return { x: 0, y: 0 };
  const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
  return { x: p.x, y: p.y };
}

const snapV = v => app.snap ? Math.round(v / app.grid) * app.grid : Math.round(v * 100) / 100;
const snapP = p => ({ x: snapV(p.x), y: snapV(p.y) });

// ── Tools ──────────────────────────────────────────────────

export function setTool(tool) {
  if (tool !== 'measure') clearMeasure();
  app.tool = tool;
  svg.className.baseVal = 'tool-' + tool;
  cancelGesture();
  emit('tool');
}

function cancelGesture() {
  hideNumBox();
  if (gesture?.kind === 'move') resetMovePreview();
  if (gesture?.draft) gesture.draft.remove();
  gesture = null;
  gOverlay.querySelectorAll('.marquee').forEach(n => n.remove());
  if (pendingRender) render();
}

export function cancel() {
  if (gesture) cancelGesture();
  else if (measure) clearMeasure();
  else if (app.selection.size) setSelection([]);
  else exitGroup();
}

function activeLayerUsable() {
  const layer = app.doc.layers.find(l => l.name === app.activeLayer);
  if (!layer) { toast('Choose a layer first', 'error'); return null; }
  if (layer.locked) { toast(`Layer ${layer.name} is locked`, 'error'); return null; }
  if (!layer.visible) { toast(`Layer ${layer.name} is hidden`, 'error'); return null; }
  return layer;
}

// Pointer handling lives on the scroll area, so clicks/marquees can start outside the page
wrap.addEventListener('pointerdown', (e) => {
  if (!app.doc || e.button === 2) return;
  if (gesture?.kind === 'draw' && gesture.clickMode) {   // second click of click–click drawing
    e.preventDefault();
    commitDraw();
    return;
  }
  // preventDefault below stops the browser moving focus: release panel inputs explicitly
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  if (e.target === wrap && (e.offsetX >= wrap.clientWidth || e.offsetY >= wrap.clientHeight)) return; // scrollbar
  const panning = app.tool === 'pan' || spaceDown || e.button === 1;
  if (!panning && app.tool === 'outline') { outlineClick(e); e.preventDefault(); return; }
  if (!panning && CORNER_TOOLS.has(app.tool)) { cornerClick(e); e.preventDefault(); return; }
  if (panning) {
    gesture = { kind: 'pan', x: e.clientX, y: e.clientY, sl: wrap.scrollLeft, st: wrap.scrollTop };
    svg.classList.add('panning');
  } else if (app.tool === 'select') {
    startSelect(e);
  } else if (app.tool === 'text') {
    if (e.target !== wrap) placeText(snapP(toDoc(e.clientX, e.clientY)));
    return;
  } else if (app.tool === 'measure') {
    const p = snapMeasure(e.clientX, e.clientY);
    measure = { a: p, b: p, done: false };
    gesture = { kind: 'measure' };
    drawMeasure();
  } else {
    const layer = activeLayerUsable();
    if (!layer) return;
    const p = snapP(toDoc(e.clientX, e.clientY));
    const draft = document.createElementNS(NS, DRAFT_TAG[app.tool] || app.tool);
    draft.setAttribute('class', 'draft');
    gOverlay.appendChild(draft);
    gesture = { kind: 'draw', tool: app.tool, start: p, draft, attrs: null, x: e.clientX, y: e.clientY };
    updateDraft(p, e.shiftKey);
  }
  wrap.setPointerCapture(e.pointerId);
  e.preventDefault();
});

wrap.addEventListener('pointermove', (e) => {
  cursorDoc = toDoc(e.clientX, e.clientY);
  lastClient = { x: e.clientX, y: e.clientY };
  emit('cursor', cursorDoc);
  drawRulers();
  if (!gesture) { if (app.tool === 'measure' || app.tool === 'outline' || CORNER_TOOLS.has(app.tool)) showSnap(e.clientX, e.clientY); return; }
  const g = gesture;
  if (g.kind === 'outline') {
    showSnap(e.clientX, e.clientY);
    if (numBox.hidden) { g.hover = outlinePoint(e); drawOutline(g); }
    return;
  }
  if (g.kind === 'pan') {
    wrap.scrollLeft = g.sl - (e.clientX - g.x);
    wrap.scrollTop = g.st - (e.clientY - g.y);
    drawRulers();
  } else if (g.kind === 'press' || g.kind === 'move') {
    if (g.kind === 'press' && Math.hypot(e.clientX - g.x, e.clientY - g.y) < DRAG_THRESHOLD) return;
    if (g.kind === 'press') beginMove(g);
    const p = toDoc(e.clientX, e.clientY);
    let dx = p.x - g.start.x, dy = p.y - g.start.y;
    if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    if (app.snap) { dx = snapV(dx); dy = snapV(dy); }
    g.dx = dx; g.dy = dy;
    for (const id of g.ids) {
      const t = `translate(${dx}, ${dy}) ${g.orig.get(id) || ''}`.trim();
      nodes.get(id)?.setAttribute('transform', t);
      hitNodes.get(id)?.setAttribute('transform', t);
    }
    drawSelection();
    emit('moving', { dx, dy });
  } else if (g.kind === 'marquee') {
    const p = toDoc(e.clientX, e.clientY);
    const r = { x: Math.min(g.start.x, p.x), y: Math.min(g.start.y, p.y), width: Math.abs(p.x - g.start.x), height: Math.abs(p.y - g.start.y) };
    g.rect = r;
    g.touch = p.x < g.start.x;
    g.node.setAttribute('class', 'marquee' + (g.touch ? ' touch' : ''));
    for (const k of ['x', 'y', 'width', 'height']) g.node.setAttribute(k, r[k]);
  } else if (g.kind === 'draw') {
    if (!numBox.hidden) return;          // typing dimensions: the mouse doesn't change them
    updateDraft(snapP(toDoc(e.clientX, e.clientY)), e.shiftKey);
    g.cx = e.clientX; g.cy = e.clientY;
  } else if (g.kind === 'measure') {
    let p = snapMeasure(e.clientX, e.clientY);
    if (e.shiftKey) {  // constrain to 0/45/90°
      const dx = p.x - measure.a.x, dy = p.y - measure.a.y;
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
      p = { x: measure.a.x + len * Math.cos(ang), y: measure.a.y + len * Math.sin(ang) };
    }
    measure.b = p;
    drawMeasure();
  }
});

wrap.addEventListener('pointerup', (e) => finishGesture(e));
wrap.addEventListener('pointercancel', () => cancelGesture());
wrap.addEventListener('pointerleave', () => { if (!gesture) { cursorDoc = null; emit('cursor', null); drawRulers(); } });

// Double-click: enter the group under the pointer (drill down one level)
wrap.addEventListener('dblclick', (e) => {
  if (gesture?.kind === 'outline') { commitDraw(); return; }
  if (app.tool !== 'select') return;
  const eid = pickAt(e.clientX, e.clientY);
  if (!eid) { exitGroup(); return; }
  const item = itemAt(eid);
  if (item?.startsWith('g-')) {
    setContext(item);
    render();
    const inner = itemAt(eid);
    if (inner) selectItems([inner]);
  }
});

// Hover highlight follows the same closest-shape rule as clicking
let hovered = null, hoverFrame = 0, hoverEvt = null;
svg.addEventListener('pointermove', (e) => {
  if (gesture || app.tool !== 'select') return setHover(null);
  hoverEvt = e;
  if (hoverFrame) return;               // closest-shape picking at most once per frame
  hoverFrame = requestAnimationFrame(() => {
    hoverFrame = 0;
    const ev = hoverEvt;
    setHover(ev.target.parentNode === gHits ? pickAt(ev.clientX, ev.clientY) : null);
  });
});
svg.addEventListener('pointerleave', () => setHover(null));
function setHover(id) {
  if (id === hovered) return;
  if (hovered) nodes.get(hovered)?.classList.remove('hover');
  hovered = id;
  if (id) nodes.get(id)?.classList.add('hover');
}

/** Of all shapes whose hit area is under the pointer, the one whose outline is closest. */
function pickAt(cx, cy) {
  const cands = document.elementsFromPoint(cx, cy).filter(n => n.parentNode === gHits && n.dataset.id);
  if (cands.length <= 1) return cands[0]?.dataset.id;
  let best = null, bestD = Infinity;
  for (const hit of cands) {
    const d = screenDistance(nodes.get(hit.dataset.id), cx, cy);
    if (d < bestD) { bestD = d; best = hit.dataset.id; }
  }
  return best;
}

function screenDistance(node, cx, cy) {
  if (!node || typeof node.getTotalLength !== 'function') return 6;   // text: treat as near
  const m = node.getScreenCTM();
  const len = node.getTotalLength();
  const steps = Math.min(600, Math.max(24, Math.ceil(len * app.zoom / 3)));
  let d = Infinity;
  for (let i = 0; i <= steps; i++) {
    const p = node.getPointAtLength(len * i / steps).matrixTransform(m);
    d = Math.min(d, Math.hypot(p.x - cx, p.y - cy));
  }
  const fill = node.getAttribute('fill');
  if (fill && fill !== 'none') {                     // inside a filled shape counts as close
    const local = new DOMPoint(cx, cy).matrixTransform(m.inverse());
    if (node.isPointInFill(local)) d = Math.min(d, 6);
  }
  return d;
}

function startSelect(e) {
  const eid = pickAt(e.clientX, e.clientY);
  const start = toDoc(e.clientX, e.clientY);
  if (eid) {
    let item = itemAt(eid);
    if (!item) {                     // clicked outside the entered group: back to the top level
      setContext(null);
      render();
      item = itemAt(eid);
    }
    const ids = elementsOf(item);
    const wasSelected = ids.every(i => app.selection.has(i));
    if (e.shiftKey) {
      const sel = new Set(app.selection);
      ids.forEach(i => wasSelected ? sel.delete(i) : sel.add(i));
      setSelection(sel);
      gesture = null;
      return;
    }
    if (!wasSelected) selectItems([item]);
    gesture = { kind: 'press', id: item, wasSelected, x: e.clientX, y: e.clientY, start };
  } else {
    if (!e.shiftKey) setSelection([]);
    const node = rectNode({ ...start, width: 0, height: 0 }, 'marquee');
    gOverlay.appendChild(node);
    gesture = { kind: 'marquee', start, node, additive: e.shiftKey, rect: null };
  }
}

function beginMove(g) {
  g.kind = 'move';
  g.ids = [...app.selection].filter(id => hitNodes.has(id));   // only editable layers
  g.orig = new Map(g.ids.map(id => [id, nodes.get(id)?.getAttribute('transform') || '']));
  g.dx = g.dy = 0;
}

function resetMovePreview(g = gesture) {
  for (const id of g.ids || []) {
    const t = g.orig.get(id);
    for (const n of [nodes.get(id), hitNodes.get(id)]) {
      if (!n) continue;
      t ? n.setAttribute('transform', t) : n.removeAttribute('transform');
    }
  }
}

async function finishGesture(e) {
  const g = gesture;
  if (!g || g.kind === 'outline') return;     // outlines finish on Enter / double-click / first point
  gesture = null;
  svg.classList.remove('panning');
  if (g.kind === 'press') {
    // Plain click on an already-selected item in a multi-selection: select just it
    if (g.wasSelected && selectedItems().length > 1) selectItems([g.id]);
  } else if (g.kind === 'move') {
    const { dx, dy, ids } = g;
    if (!dx && !dy) { resetMovePreview(g); if (pendingRender) render(); return; }
    pendingRender = true;
    // One `move` op: the server moves the shapes and keeps moved entities' 3D placement
    await api.ops([{ op: 'move', items: ids, dx, dy }], ids.length > 1 ? `Move ${ids.length} elements` : 'Move');
    render();
  } else if (g.kind === 'marquee') {
    g.node.remove();
    if (!g.rect || (g.rect.width < 1 / app.zoom && g.rect.height < 1 / app.zoom)) return;
    // Items at the current level: touching = any of its shapes touched; inside = all inside
    const hit = new Set();
    for (const [id] of hitNodes) {
      const b = bboxOf(nodes.get(id), svg);
      if (b && (g.touch ? boxTouches(b, g.rect) : boxInside(b, g.rect))) hit.add(id);
    }
    const items = new Set([...hit].map(id => itemAt(id)).filter(Boolean));
    const chosen = [...items].filter(it => {
      const els = elementsOf(it).filter(id => hitNodes.has(id));
      return g.touch ? els.some(id => hit.has(id)) : els.length && els.every(id => hit.has(id));
    });
    const ids = chosen.flatMap(elementsOf);
    setSelection(g.additive ? [...app.selection, ...ids] : ids);
  } else if (g.kind === 'measure') {
    measure.done = true;
    if (Math.hypot(measure.b.x - measure.a.x, measure.b.y - measure.a.y) < 1e-6) clearMeasure();
    else drawMeasure();
  } else if (g.kind === 'draw') {
    if (!g.attrs || Math.hypot(e.clientX - g.x, e.clientY - g.y) < DRAG_THRESHOLD) {
      // A click (no drag): keep drawing — move and click again, or type the size
      g.clickMode = true;
      gesture = g;
      emit('drafting', g.attrs && { tool: g.tool, attrs: g.attrs, hint: true });
      return;
    }
    gesture = g;
    await commitDraw();
  }
  if (pendingRender) render();
}

function updateDraft(p, constrain) {
  const g = gesture, s = g.start;
  let dx = p.x - s.x, dy = p.y - s.y;
  let a = null;
  const r3 = v => Math.round(v * 1000) / 1000;
  switch (g.tool) {
    case 'slot':
    case 'line':
      if (constrain) {  // snap angle to 45°
        const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
        dx = len * Math.cos(ang); dy = len * Math.sin(ang);
      }
      if (Math.hypot(dx, dy) >= 0.5) a = { x1: s.x, y1: s.y, x2: r3(s.x + dx), y2: r3(s.y + dy) };
      if (a && g.tool === 'slot') a.width = toolOpts.slotWidth;
      break;
    case 'rect':
      if (constrain) { const m = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * m; dy = Math.sign(dy || 1) * m; }
      if (Math.abs(dx) >= 0.5 && Math.abs(dy) >= 0.5)
        a = { x: r3(Math.min(s.x, s.x + dx)), y: r3(Math.min(s.y, s.y + dy)), width: r3(Math.abs(dx)), height: r3(Math.abs(dy)) };
      break;
    case 'circle': {
      const r = r3(Math.hypot(dx, dy));
      if (r >= 0.25) a = { cx: s.x, cy: s.y, r };
      break;
    }
    case 'ellipse':
      if (constrain) { const m = Math.max(Math.abs(dx), Math.abs(dy)); dx = dy = m; }
      if (Math.abs(dx) >= 0.25 && Math.abs(dy) >= 0.25) a = { cx: s.x, cy: s.y, rx: r3(Math.abs(dx)), ry: r3(Math.abs(dy)) };
      break;
  }
  g.attrs = a;
  if (a) setDraft(g, a);
  emit('drafting', a && { tool: g.tool, attrs: a });
}

/** Show the draft: slots as their path, rects with the remembered corner radius. */
function setDraft(g, a) {
  if (g.tool === 'slot') return g.draft.setAttribute('d', slotPath(a.x1, a.y1, a.x2, a.y2, a.width));
  for (const [k, v] of Object.entries(a)) g.draft.setAttribute(k, v);
  if (g.tool === 'rect') for (const k of ['rx', 'ry']) g.draft.setAttribute(k, toolOpts.radius);
}

// ── Outline tool: click corners; Enter, double-click or the first point closes it ──

function outlinePoint(e) {
  const g = gesture;
  let p = snapMeasure(e.clientX, e.clientY);
  const last = g?.kind === 'outline' && g.pts[g.pts.length - 1];
  if (last && e.shiftKey) {  // 0/45/90° from the last corner
    const dx = p.x - last.x, dy = p.y - last.y;
    const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
    p = { x: last.x + len * Math.cos(ang), y: last.y + len * Math.sin(ang) };
  }
  return { x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 };
}

function outlineClick(e) {
  if (!activeLayerUsable()) return;
  const p = outlinePoint(e);
  let g = gesture;
  if (g?.kind !== 'outline') {
    const draft = document.createElementNS(NS, 'polyline');
    draft.setAttribute('class', 'draft');
    gOverlay.appendChild(draft);
    g = gesture = { kind: 'outline', tool: 'outline', pts: [], draft, x: e.clientX, y: e.clientY };
  }
  const first = g.pts[0];
  if (first && g.pts.length >= 3 && Math.hypot(p.x - first.x, p.y - first.y) < SNAP_PX / app.zoom) return commitDraw();
  const last = g.pts[g.pts.length - 1];
  if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-6) g.pts.push(p);
  g.cx = e.clientX; g.cy = e.clientY;
  drawOutline(g);
}

function drawOutline(g) {
  const pts = g.hover ? [...g.pts, g.hover] : g.pts;
  g.draft.setAttribute('points', pts.map(p => `${p.x},${p.y}`).join(' '));
  emit('drafting', { tool: 'outline', attrs: { n: g.pts.length, radius: toolOpts.radius } });
}

// ── Fillet / dog-bone tools: click a corner (Shift: every corner / every inside corner) ──

async function cornerClick(e) {
  const eid = pickAt(e.clientX, e.clientY) || (app.selection.size === 1 ? [...app.selection][0] : null);
  const el = eid && elementById(eid);
  if (!el) { toast('Click a corner of a shape (a rectangle, polygon or path of straight lines)', 'error'); return; }
  const layer = app.doc.layers.find(l => l.name === el.layer);
  if (layer?.locked) { toast(`Layer ${layer.name} is locked`, 'error'); return; }
  const p = snapMeasure(e.clientX, e.clientY);
  const tol = Math.max(0.5, 2 * SNAP_PX / app.zoom);
  const op = app.tool === 'fillet'
    ? { op: 'fillet', id: eid, r: toolOpts.fillet, corners: e.shiftKey ? 'all' : [[p.x, p.y]], tol }
    : { op: 'dogbone', id: eid, corners: e.shiftKey ? 'auto' : [[p.x, p.y]], tol,
        ...(toolOpts.dogbone > 0 ? { tool_d: toolOpts.dogbone } : {}) };
  const state = await api.ops([op], app.tool === 'fillet' ? 'Fillet' : 'Dog-bones');
  if (state?.results) setSelection([eid]);
}

async function placeText(p) {
  const layer = activeLayerUsable();
  if (!layer) return;
  let values = null;
  const ok = await modal({
    title: 'Add text',
    html: `<div class="kv"><label>Text</label><input name="text" class="field" value="Text">
      <label>Size (mm)</label><input name="size" type="number" class="field" value="10" min="0.5" step="0.5"></div>
      <p class="hint" style="margin-top:10px">Text is for NOTES/labels. For engraving, CAM needs text converted to paths.</p>`,
    buttons: [{ label: 'Cancel', value: false }, { label: 'Add', value: true, kind: 'primary' }],
    onSubmit: (form) => { values = Object.fromEntries(new FormData(form)); return !!values.text.trim(); },
  });
  if (!ok) return;
  const state = await api.ops([{ op: 'add_element', tag: 'text', layer: app.activeLayer, text: values.text,
    attrs: { x: p.x, y: p.y, 'font-size': values.size || 10, 'font-family': 'sans-serif' } }], 'Add text');
  if (state?.results) setSelection([state.results[0]]);
}

// ── Keyboard helpers used by main ──────────────────────────

export function setSpace(down) {
  spaceDown = down;
  svg.classList.toggle('panning', down && app.tool !== 'pan');
}

// Ctrl/⌘ + wheel or trackpad pinch → zoom around the cursor
wrap.addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  setZoom(app.zoom * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
}, { passive: false });
wrap.addEventListener('scroll', drawRulers);
window.addEventListener('resize', drawRulers);
on('selection', drawSelection);


// ── Measure tool ───────────────────────────────────────────
// Drag to measure (snaps to shape corners, ends, centres and midpoints, else to the grid).
// Enter adds the measurement to the NOTES layer as a dimension; Esc clears it.

let measure = null;
const SNAP_PX = 10;

function keyPoints() {
  if (keyPointCache) return keyPointCache;
  const pts = [];
  const root = svg.getScreenCTM().inverse();
  for (const [id, node] of nodes) {
    if (!hitNodes.has(id)) continue;
    const el = elementById(id);
    const m = root.multiply(node.getScreenCTM());
    for (const [x, y] of localKeyPoints(el)) {
      const p = new DOMPoint(x, y).matrixTransform(m);
      pts.push({ x: p.x, y: p.y });
    }
  }
  return (keyPointCache = pts);
}

function localKeyPoints(el) {
  const a = el.attrs, n = k => parseFloat(a[k] || 0);
  switch (el.tag) {
    case 'line': return [[n('x1'), n('y1')], [n('x2'), n('y2')], [(n('x1') + n('x2')) / 2, (n('y1') + n('y2')) / 2]];
    case 'rect': {
      const x = n('x'), y = n('y'), w = n('width'), h = n('height');
      return [[x, y], [x + w, y], [x, y + h], [x + w, y + h], [x + w / 2, y + h / 2], [x + w / 2, y], [x + w / 2, y + h], [x, y + h / 2], [x + w, y + h / 2]];
    }
    case 'circle': case 'ellipse': {
      const cx = n('cx'), cy = n('cy'), rx = el.tag === 'circle' ? n('r') : n('rx'), ry = el.tag === 'circle' ? n('r') : n('ry');
      return [[cx, cy], [cx - rx, cy], [cx + rx, cy], [cx, cy - ry], [cx, cy + ry]];
    }
    case 'polygon': case 'polyline': {
      const v = (a.points || '').trim().split(/[\s,]+/).map(Number);
      const out = [];
      for (let i = 0; i + 1 < v.length; i += 2) out.push([v[i], v[i + 1]]);
      return out;
    }
    case 'path': return pathVertices(a.d || '');
    default: return [[n('x'), n('y')]];
  }
}

/** Segment end points of a path (absolute), plus arc/circle centres for full circles. */
function pathVertices(d) {
  const toks = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) || [];
  const out = [];
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0;
  const num = () => parseFloat(toks[i++]);
  const counts = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    const C = cmd.toUpperCase(), rel = cmd !== C;
    if (C === 'Z') { x = sx; y = sy; continue; }
    const v = [];
    for (let k = 0; k < counts[C]; k++) v.push(num());
    if (v.some(isNaN)) break;
    let nx = x, ny = y;
    if (C === 'H') nx = (rel ? x : 0) + v[0];
    else if (C === 'V') ny = (rel ? y : 0) + v[0];
    else { nx = (rel ? x : 0) + v[v.length - 2]; ny = (rel ? y : 0) + v[v.length - 1]; }
    if (C === 'A' && Math.abs(v[0] - v[1]) < 1e-9 && v[3] === 1) {
      // large arc of a circle: its centre is useful (hole centres)
      out.push([(x + nx) / 2, (y + ny) / 2]);
    }
    if (C === 'M') { sx = nx; sy = ny; if (cmd === 'm') cmd = 'l'; else cmd = 'L'; }
    x = nx; y = ny;
    out.push([x, y]);
  }
  return out;
}

function snapMeasure(cx, cy) {
  const p = toDoc(cx, cy);
  const r = SNAP_PX / app.zoom;
  let best = null, bd = r;
  for (const k of keyPoints()) {
    const d = Math.hypot(k.x - p.x, k.y - p.y);
    if (d < bd) { bd = d; best = k; }
  }
  return best ? { ...best, snapped: true } : { ...snapP(p), snapped: false };
}

function showSnap(cx, cy) {
  if (measure && !measure.done) return;
  const p = snapMeasure(cx, cy);
  gMeasure.querySelector('.snap-mark')?.remove();
  if (p.snapped) {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', p.x); c.setAttribute('cy', p.y); c.setAttribute('r', 5 / app.zoom);
    c.setAttribute('class', 'snap-mark');
    gMeasure.appendChild(c);
  }
}

function drawMeasure() {
  gMeasure.replaceChildren();
  if (!measure) return;
  const { a, b } = measure, k = 1 / app.zoom;
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
  const ang = Math.atan2(-dy, dx) * 180 / Math.PI;
  const mk = (tag, attrs, cls) => {
    const n = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([key, v]) => n.setAttribute(key, v));
    n.setAttribute('class', cls);
    gMeasure.appendChild(n);
    return n;
  };
  mk('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y }, 'measure-line');
  mk('circle', { cx: a.x, cy: a.y, r: 3 * k }, 'measure-dot');
  mk('circle', { cx: b.x, cy: b.y, r: 3 * k }, 'measure-dot');
  const t = mk('text', { x: (a.x + b.x) / 2 + 8 * k, y: (a.y + b.y) / 2 - 8 * k }, 'measure-text');
  t.style.fontSize = (12 * k) + 'px';
  t.style.strokeWidth = (3 * k) + 'px';
  const f = v => String(+v.toFixed(2));
  t.textContent = `${f(len)} mm  (Δx ${f(Math.abs(dx))}, Δy ${f(Math.abs(dy))}, ${f(ang)}°)`;
  emit('measure', { len, dx, dy, ang, done: measure.done });
}

export function clearMeasure() {
  measure = null;
  gMeasure.replaceChildren();
  emit('measure', null);
}

export function currentMeasure() {
  return measure?.done ? measure : null;
}


// ── Drawing with typed dimensions (CAD style) ──────────────
// While a shape is being drawn (after its first point), typing a number opens a small box:
// line = length + angle, rect = width + height, circle = diameter, ellipse = width + height.

const numBox = document.createElement('form');
numBox.className = 'num-box';
numBox.hidden = true;
document.querySelector('.canvas-area').appendChild(numBox);

const FIELDS = {
  line: [['len', 'Length', 'mm'], ['ang', 'Angle', '°']],
  rect: [['w', 'Width', 'mm'], ['h', 'Height', 'mm'], ['rad', 'Radius', 'mm']],
  circle: [['d', 'Diameter', 'mm']],
  slot: [['len', 'Length', 'mm'], ['ang', 'Angle', '°'], ['w', 'Width', 'mm']],
  outline: [['rad', 'Corner radius', 'mm']],
  fillet: [['r', 'Fillet radius', 'mm']],
  dogbone: [['d', 'Tool Ø (0 = material)', 'mm']],
  ellipse: [['w', 'Width', 'mm'], ['h', 'Height', 'mm']],
};

export function isDrawing() {
  return gesture?.kind === 'draw' || gesture?.kind === 'outline';
}

/** Tools whose value (radius, tool Ø) can be typed without drawing anything. */
export function hasToolOptions() {
  return !gesture && CORNER_TOOLS.has(app.tool);
}

function currentValues(g) {
  const a = g.attrs || {}, r = v => String(+(+v || 0).toFixed(3));
  switch (g.tool) {
    case 'slot':
    case 'line': {
      const dx = (a.x2 ?? g.start.x) - g.start.x, dy = (a.y2 ?? g.start.y) - g.start.y;
      return { len: r(Math.hypot(dx, dy)), ang: r(-Math.atan2(dy, dx) * 180 / Math.PI), w: r(toolOpts.slotWidth) };
    }
    case 'rect': return { w: r(a.width), h: r(a.height), rad: r(toolOpts.radius) };
    case 'outline': return { rad: r(toolOpts.radius) };
    case 'fillet': return { r: r(toolOpts.fillet) };
    case 'dogbone': return { d: r(toolOpts.dogbone) };
    case 'circle': return { d: r(2 * (a.r || 0)) };
    case 'ellipse': return { w: r(2 * (a.rx || 0)), h: r(2 * (a.ry || 0)) };
  }
  return {};
}

/** Open the dimension box, starting with the typed character in the first field. */
export function beginNumericEntry(firstKey) {
  const g = gesture && isDrawing() ? gesture
    : hasToolOptions() ? { tool: app.tool, cx: lastClient.x, cy: lastClient.y, options: true } : null;
  if (!g || !FIELDS[g.tool]) return;
  numBox.dataset.tool = g.options ? g.tool : '';
  const vals = currentValues(g);
  numBox.innerHTML = FIELDS[g.tool].map(([k, label, unit], i) =>
    `<label>${label}<input name="${k}" inputmode="decimal" value="${i === 0 && firstKey ? '' : vals[k]}" autocomplete="off"><span>${unit}</span></label>`).join('') +
    '<button type="submit">↵</button>';
  const area = document.querySelector('.canvas-area').getBoundingClientRect();
  numBox.style.left = Math.min((g.cx ?? g.x) - area.left + 16, area.width - 260) + 'px';
  numBox.style.top = Math.min((g.cy ?? g.y) - area.top + 16, area.height - 60) + 'px';
  numBox.hidden = false;
  const first = numBox.querySelector('input');
  first.focus();
  if (firstKey) first.value = firstKey; else first.select();
  updateFromBox();
}

function hideNumBox() {
  if (!numBox.hidden) { numBox.hidden = true; numBox.innerHTML = ''; }
  numBox.dataset.tool = '';
}

function valuesFromBox() {
  return Object.fromEntries([...numBox.querySelectorAll('input')].map(i => [i.name, parseFloat(i.value.replace(',', '.'))]));
}

// Live preview while typing
function updateFromBox() {
  if (numBox.hidden) return;
  const v = valuesFromBox(), ok = x => !isNaN(x) && x >= 0;
  const t = numBox.dataset.tool || gesture?.tool;
  if (t === 'fillet' && v.r > 0) toolOpts.fillet = v.r;
  if (t === 'dogbone' && ok(v.d)) toolOpts.dogbone = v.d;
  if ((t === 'rect' || t === 'outline') && ok(v.rad)) toolOpts.radius = v.rad;
  if (t === 'slot' && v.w > 0) toolOpts.slotWidth = v.w;
  emit('tool-options');
  const g = gesture;
  if (!g || numBox.dataset.tool) return;
  if (g.kind === 'outline') return drawOutline(g);
  const s = g.start, prev = g.attrs || {};
  const r3 = x => Math.round(x * 1000) / 1000;
  let a = null;
  switch (g.tool) {
    case 'slot':
    case 'line':
      if (v.len > 0) {
        const ang = (isNaN(v.ang) ? 0 : v.ang) * Math.PI / 180;
        a = { x1: s.x, y1: s.y, x2: r3(s.x + v.len * Math.cos(ang)), y2: r3(s.y - v.len * Math.sin(ang)) };
        if (g.tool === 'slot') a.width = toolOpts.slotWidth;
      }
      break;
    case 'rect':
      if (v.w > 0 && v.h > 0) {
        // keep the direction the mouse was dragging in
        const sx = prev.x !== undefined && prev.x < s.x ? -1 : 1, sy = prev.y !== undefined && prev.y < s.y ? -1 : 1;
        a = { x: r3(sx < 0 ? s.x - v.w : s.x), y: r3(sy < 0 ? s.y - v.h : s.y), width: r3(v.w), height: r3(v.h) };
      }
      break;
    case 'circle':
      if (v.d > 0) a = { cx: s.x, cy: s.y, r: r3(v.d / 2) };
      break;
    case 'ellipse':
      if (v.w > 0 && v.h > 0) a = { cx: s.x, cy: s.y, rx: r3(v.w / 2), ry: r3(v.h / 2) };
      break;
  }
  if (a) {
    g.attrs = a;
    setDraft(g, a);
    emit('drafting', { tool: g.tool, attrs: a });
  }
}

numBox.addEventListener('input', updateFromBox);
numBox.addEventListener('submit', (e) => {
  e.preventDefault();
  updateFromBox();
  // A tool option or the outline's radius: keep going; a shape's size: draw it
  if (numBox.dataset.tool || gesture?.kind === 'outline') hideNumBox(); else commitDraw();
});
numBox.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); if (numBox.dataset.tool || gesture?.kind === 'outline') hideNumBox(); else cancelGesture(); }
  e.stopPropagation();
});

export async function commitDraw() {
  const g = gesture;
  if (!g || !isDrawing()) return;
  gesture = null;
  hideNumBox();
  g.draft.remove();
  const layer = app.activeLayer;
  let op;
  if (g.kind === 'outline') {
    if (g.pts.length < 3) { toast('An outline needs at least 3 corners', 'error'); return; }
    op = { op: 'add_outline', points: g.pts.map(p => toolOpts.radius > 0 ? [p.x, p.y, toolOpts.radius] : [p.x, p.y]), layer };
  } else if (!g.attrs) {
    return;
  } else if (g.tool === 'slot') {
    op = { op: 'add_slot', ...g.attrs, layer };
  } else if (g.tool === 'rect' && toolOpts.radius > 0) {
    op = { op: 'add_rounded_rect', ...g.attrs, r: toolOpts.radius, layer };
  } else {
    op = { op: 'add_element', tag: g.tool, attrs: g.attrs, layer };
  }
  const state = await api.ops([op], `Draw ${g.tool}`);
  if (state?.results) setSelection([state.results[0]]);
  if (pendingRender) render();
}

/** Hover highlight (e.g. from the Inspector's entity contents): outline these element ids. */
export function highlight(ids) {
  document.querySelectorAll('#content .hover-hl').forEach(n => n.classList.remove('hover-hl'));
  for (const id of ids) document.querySelector(`#content [data-id="${CSS.escape(id)}"]`)?.classList.add('hover-hl');
}
