// Bootstrap: wires server state → views, status bar, code panel, screenshots.

import { app, on, emit, setSelection, setContext, savePref } from './state.js';
import { api, startSync } from './api.js';
import { fmt, esc, toast } from './ui.js';
import { docToPng } from './geometry.js';
import * as canvas from './canvas.js';
import { renderLayers, refreshInspector, renderEntities } from './panels.js';
import { updateToolbar } from './menu.js';
import { renderTabs } from './tabs.js';
import * as preview3d from './preview3d.js';
import * as actions from './actions.js';
import { connectDialog } from './connect.js';

const titleEl = document.getElementById('doc-title');
const conn = document.getElementById('conn');
const st = id => document.getElementById('st-' + id);

let firstDoc = true;

on('tab-changed', () => {
  setSelection([]);
  setContext(null);
  app.view = app.tabViews[app.server.active] || '2d';   // each tab remembers Drawing / 3D
  emit('view-mode');
  requestAnimationFrame(canvas.zoomFit);
});

on('doc', () => {
  const s = app.server;
  canvas.render();
  renderLayers();
  renderEntities();
  refreshInspector();
  updateToolbar();
  updateTitle();
  updateStatus();
  refreshCode();
  if (firstDoc) {             // always start with the whole document in view
    firstDoc = false;
    requestAnimationFrame(canvas.zoomFit);
  }
});

on('selection', () => { updateToolbar(); updateStatus(); reportSelection(); });

// ── Selection shared with Claude (MCP get_selection / set_selection) ──

let seenSeq = {};            // tab id → last selection_seq applied
on('server-restarted', () => { seenSeq = {}; });
let selTimer = null;
function reportSelection() {
  clearTimeout(selTimer);
  const tab = app.server?.active, ids = [...app.selection];
  selTimer = setTimeout(() => fetch('/api/selection', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tab, ids }) }).catch(() => {}), 250);
}
on('doc', () => {
  const s = app.server;
  if (seenSeq[s.active] === undefined) { seenSeq[s.active] = s.selection_seq; return; }
  if (s.selection_seq > seenSeq[s.active]) {     // Claude selected something to show the user
    seenSeq[s.active] = s.selection_seq;
    setContext(null);
    setSelection(s.selection || []);
    if (s.selection?.length) canvas.zoomToSelection();
  }
});


on('context', () => { updateStatus(); refreshInspector(); renderEntities(); });

// ── 2D drawing ↔ 3D preview ────────────────────────────────

const canvasArea = document.querySelector('.canvas-area');
const view3d = document.getElementById('view3d');
on('view-mode', () => {
  const is3d = app.view === '3d';
  canvasArea.hidden = is3d;
  view3d.hidden = !is3d;
  document.getElementById('tools').classList.toggle('disabled', is3d);
  updateToolbar();
  if (is3d) preview3d.show();
  else requestAnimationFrame(canvas.onShown);
});

// ── Collapsible side panel and sections ────────────────────

const side = document.querySelector('.side');
app.sideHidden = !!JSON.parse(localStorage.getItem('kerf.sideHidden') || 'false');
const collapsed = new Set(JSON.parse(localStorage.getItem('kerf.collapsed') || '[]'));
function applySide() {
  side.hidden = app.sideHidden;
  for (const sec of side.querySelectorAll('.panel')) sec.classList.toggle('collapsed', collapsed.has(sec.id));
  updateToolbar();
  requestAnimationFrame(canvas.drawRulers);
}
// Side panel width: drag its left edge (remembered)
const resizer = document.getElementById('side-resizer');
const setSideW = (w) => document.documentElement.style.setProperty('--side-w', Math.max(260, Math.min(560, w)) + 'px');
try { const w = +localStorage.getItem('kerf.sideW'); if (w) setSideW(w); } catch (_) {}
resizer.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  resizer.setPointerCapture(e.pointerId);
  resizer.classList.add('dragging');
  const right = side.getBoundingClientRect().right;
  const move = (ev) => { setSideW(right - ev.clientX); canvas.drawRulers(); };
  const up = () => {
    resizer.classList.remove('dragging');
    resizer.removeEventListener('pointermove', move);
    try { localStorage.setItem('kerf.sideW', side.getBoundingClientRect().width); } catch (_) {}
  };
  resizer.addEventListener('pointermove', move);
  resizer.addEventListener('pointerup', up, { once: true });
});
resizer.addEventListener('dblclick', () => { setSideW(320); try { localStorage.removeItem('kerf.sideW'); } catch (_) {} canvas.drawRulers(); });

document.getElementById('connect-claude').addEventListener('click', () => connectDialog());

// Edit links in the 3D panel
document.addEventListener('rename-project', () => actions.renameProject());
document.addEventListener('material-dialog', () => actions.materialDialog());
document.addEventListener('edit-sliders', () => {
  if (app.sideHidden) document.dispatchEvent(new Event('toggle-side'));
  setSelection([]);                      // the Inspector shows the document (with its sliders)
  setTimeout(() => {
    const sec = document.querySelector('#inspector .params-edit');
    if (!sec) return;
    if (collapsed.delete('inspector-panel')) applySide();
    sec.previousElementSibling?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    sec.classList.add('flash');
  }, 150);
});
document.addEventListener('toggle-side', () => {
  app.sideHidden = !app.sideHidden;
  savePref('sideHidden', app.sideHidden);
  applySide();
});
side.addEventListener('click', (e) => {
  const head = e.target.closest('.panel-head, .panel > h2:first-child');
  if (!head || e.target.closest('button')) return;
  const sec = head.closest('.panel');
  collapsed.has(sec.id) ? collapsed.delete(sec.id) : collapsed.add(sec.id);
  localStorage.setItem('kerf.collapsed', JSON.stringify([...collapsed]));
  applySide();
});
applySide();
on('zoom', () => { updateToolbar(); updateStatus(); });
on('view', updateToolbar);
on('active-layer', updateStatus);
on('connection', () => {
  conn.className = 'conn ' + (app.connected ? 'ok' : 'err');
  document.getElementById('conn-label').textContent = app.connected ? 'Connected' : 'Server offline — retrying';
});

function updateTitle() {
  const s = app.server;
  // Project name first; the file (or "not saved") after it, dimmer
  const where = s.file || s.tabs?.find(t => t.id === s.active)?.local_name || 'not saved';
  titleEl.innerHTML = `${esc(s.name || 'Untitled')}${where !== s.name ? ` <span class="file">— ${esc(where)}</span>` : ''}` +
    `${s.dirty ? ' <span class="dirty" title="Unsaved changes">● edited</span>' : ''}`;
  document.title = `${s.dirty ? '• ' : ''}${s.name} — Kerf`;
}

let selectionGeometry = null;
on('selection-geometry', (b) => { selectionGeometry = b; updateStatus(); });
on('cursor', (p) => { st('cursor').textContent = p ? `x ${fmt(p.x, 1)}  y ${fmt(p.y, 1)} mm` : '—'; });
on('moving', ({ dx, dy }) => { st('selection').textContent = `move Δx ${fmt(dx)}  Δy ${fmt(dy)} mm`; });
on('drafting', (d) => {
  if (!d) return;
  const a = d.attrs;
  if (d.hint) { st('selection').textContent = 'click the end point, or type the size (Tab / Enter)'; return; }
  if (d.tool === 'outline') {
    st('selection').textContent = `${a.n} corner(s)${a.radius ? `, radius ${fmt(a.radius)} mm` : ''} — click the next corner; Enter / double-click / first corner closes; type a radius`;
    return;
  }
  st('selection').textContent = d.tool === 'slot' ? `slot ${fmt(Math.hypot(a.x2 - a.x1, a.y2 - a.y1) + a.width)} × ${fmt(a.width)} mm (type length, angle, width)`
    : d.tool === 'line' ? `length ${fmt(Math.hypot(a.x2 - a.x1, a.y2 - a.y1))} mm`
    : d.tool === 'rect' ? `${fmt(a.width)} × ${fmt(a.height)} mm`
    : d.tool === 'circle' ? `⌀ ${fmt(2 * a.r)} mm` : `${fmt(2 * a.rx)} × ${fmt(2 * a.ry)} mm`;
});

// Corner tools: show the value they'll use
function cornerToolHint() {
  const o = canvas.toolOpts, tool = app.doc?.material?.tool_diameter || 6;
  if (app.tool === 'fillet') st('selection').textContent = `fillet r ${fmt(o.fillet)} mm — click a corner (Shift: all corners) · type to change`;
  else if (app.tool === 'dogbone') st('selection').textContent = `dog-bone Ø ${fmt(o.dogbone || tool)} mm — click a corner (Shift: every corner of a hole / inside corner) · type to change`;
  else if (app.tool === 'outline' && o.radius) st('selection').textContent = `outline, corner radius ${fmt(o.radius)} mm — click the first corner`;
}
on('tool', cornerToolHint);
on('tool-options', cornerToolHint);

let measureInfo = null;
on('measure', (m) => { measureInfo = m; updateStatus(); });

function updateStatus() {
  const doc = app.doc;
  if (!doc) return;
  const n = app.selection.size, b = selectionGeometry;
  if (measureInfo) {
    st('selection').textContent = `measure ${fmt(measureInfo.len)} mm · Δx ${fmt(Math.abs(measureInfo.dx))} · Δy ${fmt(Math.abs(measureInfo.dy))}` +
      (measureInfo.done ? '  —  Enter: add as dimension · Esc: clear' : '');
  } else {
    const hasBox = b && (b.width || b.height);          // no geometry while the 2D canvas is hidden (3D view)
    st('selection').textContent = n ? `${n} selected${hasBox ? ` · ${fmt(b.width)} × ${fmt(b.height)} mm at ${fmt(b.x)}, ${fmt(b.y)}` : ''}` :
      (app.context ? 'inside an entity — Esc to go up' : '');
  }
  st('layer').textContent = app.activeLayer ? `layer ${app.activeLayer}` : '';
  st('doc').textContent = `${fmt(doc.width)} × ${fmt(doc.height)} mm · ${doc.elements.length} elements`;
  st('zoom').textContent = `${Math.round(app.zoom * 100)}%`;
}

// ── SVG code panel ─────────────────────────────────────────

const codePanel = document.getElementById('code-panel');
const code = document.getElementById('code');
const codeMsg = document.getElementById('code-msg');
let codeDirty = false;

async function refreshCode(force = false) {
  if (!app.codeOpen || (codeDirty && !force)) return;
  const resp = await fetch('/api/export/file');
  code.value = await resp.text();
  codeDirty = false;
  highlightCode(true);
  codeMsg.textContent = 'Edit the SVG and press Apply (one undo step).';
}

document.addEventListener('toggle-code', () => {
  app.codeOpen = !app.codeOpen;
  codePanel.hidden = !app.codeOpen;
  updateToolbar();
  refreshCode(true);
  requestAnimationFrame(canvas.drawRulers);
});
code.addEventListener('input', () => { codeDirty = true; codeMsg.textContent = 'Unapplied changes'; highlightCode(); });
code.addEventListener('scroll', () => { codeHl.scrollTop = code.scrollTop; codeHl.scrollLeft = code.scrollLeft; });

// Mark the selected elements' tags in the code (a mirror <pre> behind the transparent textarea)
const codeHl = document.getElementById('code-hl');
const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
function highlightCode(reveal = false) {
  if (!app.codeOpen) return;
  const text = code.value;
  const ranges = [];
  for (const id of app.selection) {
    const at = text.indexOf(` id="${id}"`);
    if (at < 0) continue;
    const start = text.lastIndexOf('<', at);
    const end = text.indexOf('>', at) + 1;
    if (start >= 0 && end > 0) ranges.push([start, end]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let html = '', pos = 0;
  for (const [a, b] of ranges) {
    if (a < pos) continue;
    html += escText(text.slice(pos, a)) + '<mark>' + escText(text.slice(a, b)) + '</mark>';
    pos = b;
  }
  codeHl.innerHTML = html + escText(text.slice(pos)) + '\n';
  codeHl.scrollTop = code.scrollTop; codeHl.scrollLeft = code.scrollLeft;
  if (reveal && ranges.length) {
    const mark = codeHl.querySelector('mark');
    code.scrollTop = Math.max(0, mark.offsetTop - code.clientHeight / 3);
    code.scrollLeft = 0;
    codeHl.scrollTop = code.scrollTop; codeHl.scrollLeft = 0;
  }
}
on('selection', () => highlightCode(true));
document.getElementById('code-reload').addEventListener('click', () => refreshCode(true));
document.getElementById('code-apply').addEventListener('click', async () => {
  const s = await api.ops([{ op: 'replace_svg', svg: code.value }], 'Edit code');
  if (s) { codeDirty = false; toast('Applied', 'ok'); refreshCode(true); }
});

// ── Screenshots for Claude (MCP take_screenshot) ───────────

let capturing = false;
on('screenshot-requested', async () => {
  if (capturing || !app.doc) return;
  capturing = true;
  try {
    // The 3D view when it's showing, otherwise the whole 2D document
    const v = app.server?.screenshot_view || '2d';
    const shot3d = v.startsWith('3d') ? await preview3d.capture(1600, 1000, v === '3d-exploded' ? 0.8 : null) : null;
    const data = shot3d || (await docToPng(app.doc, 1800, 4)).toDataURL('image/png');
    await api.screenshot(data.split(',')[1]);
  } catch (e) {
    console.error('screenshot failed', e);
  } finally {
    capturing = false;
  }
});

// ── Start ──────────────────────────────────────────────────

document.getElementById('ruler-corner').textContent = app.unit;
document.getElementById('ruler-corner').addEventListener('click', canvas.toggleUnit);
app.zoom = +app.zoom || 1;
canvas.setTool('select');
startSync();

// Share links: /?open=desk/desk.kerf[&view=3d] opens that file (or switches to its tab)
const shareParams = new URLSearchParams(location.search);
if (shareParams.get('open')) actions.openShared(shareParams.get('open'), shareParams.get('view'));
