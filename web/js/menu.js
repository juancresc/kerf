// Menu bar, action toolbar, tool palette and keyboard shortcuts.

import { app, on, emit, selectedItems } from './state.js';
import { icons, esc } from './ui.js';
import * as canvas from './canvas.js';
import * as actions from './actions.js';
import { connectDialog } from './connect.js';
import { addLayer, deleteLayer } from './panels.js';

const mac = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = mac ? '⌘' : 'Ctrl+';
const SHIFT = mac ? '⇧' : 'Shift+';

const hasSel = () => app.selection.size > 0;
const hasGroupSel = () => selectedItems().some(i => i.startsWith('g-'));
const toggleCode = () => document.dispatchEvent(new CustomEvent('toggle-code'));
const toggleSide = () => document.dispatchEvent(new CustomEvent('toggle-side'));

// Items: [label, fn, shortcut, enabled(), checked()] · '-' separator · '# Header'
const MENUS = [
  ['File', [
    ['New…', actions.newDocument],
    ['Open…', actions.openDocument, MOD + 'O'],
    ['Open from computer…', actions.openFromComputer],
    '-',
    ['Save', actions.save, MOD + 'S'],
    ['Save As…', () => actions.saveAs(), SHIFT + MOD + 'S'],
    ['Download project (.kerf)', actions.saveToComputer],
    ['Copy link to this project', actions.copyShareLink, null, () => !!app.server?.file],
    ['Copy tab link for Claude', () => actions.copyTabRef()],
    ['Revert to saved', actions.revert, null, () => !!app.server?.file],
    '-',
    ['# Import'],
    ['SVG into this document…', actions.importSvg, MOD + 'I'],
    ['DXF as new document…', () => actions.importDxf(false)],
    ['DXF into this document…', () => actions.importDxf(true)],
    '-',
    ['Rename project…', actions.renameProject],
    ['Material & stock…', actions.materialDialog],
    ['Document size…', actions.documentSize],
    '-',
    ['Close tab', () => actions.closeTab(), mac ? '⌥W' : 'Alt+W'],
  ]],
  ['Edit', [
    [() => `Undo${app.server?.undo_label ? ' ' + app.server.undo_label : ''}`, actions.undo, MOD + 'Z', () => app.server?.can_undo],
    [() => `Redo${app.server?.redo_label ? ' ' + app.server.redo_label : ''}`, actions.redo, SHIFT + MOD + 'Z', () => app.server?.can_redo],
    '-',
    ['Duplicate', actions.duplicate, MOD + 'D', hasSel],
    ['Delete', actions.deleteSelection, '⌫', hasSel],
    '-',
    ['Select all', actions.selectAll, MOD + 'A'],
    ['Deselect / go up', () => canvas.cancel(), 'Esc'],
    '-',
    ['# Entities'],
    ['Group into entity…', actions.group, MOD + 'G', hasSel],
    ['Ungroup', actions.ungroup, SHIFT + MOD + 'G', hasGroupSel],
    ['Add selection to entity…', () => actions.addToEntity(), null, hasSel],
    ['Remove from entity', actions.removeFromEntity, null, () => hasSel() && !!app.context],
    ['Enter entity (edit inside)', actions.enterGroup, '↵', hasGroupSel],
    ['Exit entity', () => canvas.exitGroup(), 'Esc', () => !!app.context],
    '-',
    ['Bring to front', () => actions.reorder('front'), ']', hasSel],
    ['Send to back', () => actions.reorder('back'), '[', hasSel],
    '-',
    ['Clear all…', actions.clearAll],
  ]],
  ['View', [
    [() => app.view === '3d' ? 'Drawing (2D)' : '3D preview', () => actions.toggle3d(), '3'],
    '-',
    ['Zoom in', canvas.zoomIn, '+'],
    ['Zoom out', canvas.zoomOut, '−'],
    ['Actual size (100%)', canvas.zoom100, '1'],
    ['Fit document', canvas.zoomFit, '0'],
    ['Zoom to selection', canvas.zoomToSelection, '2', hasSel],
    '-',
    [() => 'Show selection dimensions', () => canvas.setShowDims(!app.showDims), 'D', null, () => app.showDims],
    [() => 'Show grid', () => canvas.setGrid({ showGrid: !app.showGrid }), '#', null, () => app.showGrid],
    [() => 'Snap to grid', () => canvas.setGrid({ snap: !app.snap }), '%', null, () => app.snap],
    [() => `Ruler units: ${app.unit}`, canvas.toggleUnit],
    '-',
    [() => 'Side panel', toggleSide, MOD + '\\', null, () => !app.sideHidden],
    [() => 'SVG code', toggleCode, MOD + '/', null, () => app.codeOpen],
  ]],
  ['Layer', [
    ['New layer…', addLayer, SHIFT + MOD + 'N'],
    [() => `Delete layer “${app.activeLayer}”…`, () => deleteLayer(), null, () => (app.doc?.layers.length || 0) > 1],
    '-',
    ['Reference image to trace over…', actions.setBackground],
    ['Remove reference image', actions.removeBackground, null, () => !!app.doc?.background],
  ]],
  ['Export', [
    ['# For the CNC'],
    ['CNC file — SVG (mm)', actions.exportCnc, MOD + 'E'],
    ['CNC file — DXF (mm)', actions.exportDxf, SHIFT + MOD + 'E'],
    ['Parts for nesting — SVG + DXF per entity (zip)', actions.exportParts],
    '-',
    ['# 3D (the assembled model)'],
    ['3D model — GLB / glTF (colours; Blender, viewers, web)', () => actions.export3d('glb')],
    ['3D model — STL (mesh; CAD, 3D printing)', () => actions.export3d('stl')],
    '-',
    ['# Other'],
    ['SVG — all layers (Inkscape, Illustrator…)', actions.downloadSvg],
    [() => app.view === '3d' ? 'PNG image (3D view)' : 'PNG image (drawing)', () => app.view === '3d' ? actions.export3d('png') : actions.exportPng()],
  ]],
  ['Help', [
    ['Connect Claude (MCP / curl)…', () => connectDialog()],
    ['Kerf guide (how Claude designs here)…', () => connectDialog('guide')],
  ]],
];

const menubar = document.getElementById('menubar');
let openMenu = null;

function renderMenu(i) {
  const [, items] = MENUS[i];
  return items.map((it, j) => {
    if (it === '-') return '<div class="menu-sep"></div>';
    if (it[0].startsWith?.('# ')) return `<div class="menu-head">${esc(it[0].slice(2))}</div>`;
    const [label, , kbd, enabled, checked] = it;
    const text = typeof label === 'function' ? label() : label;
    const dis = enabled && !enabled() ? 'disabled' : '';
    const check = checked ? `<span class="check">${checked() ? '✓' : ''}</span>` : '';
    return `<button class="menu-item" data-m="${i}" data-i="${j}" ${dis}>${check}${esc(text)}<span class="kbd">${kbd || ''}</span></button>`;
  }).join('');
}

menubar.innerHTML = MENUS.map(([title], i) =>
  `<div class="menu" data-menu="${i}"><button class="menu-title">${title}</button><div class="menu-list"></div></div>`).join('');

function setOpen(menu) {
  if (openMenu) openMenu.classList.remove('open');
  openMenu = menu;
  if (menu) {
    menu.querySelector('.menu-list').innerHTML = renderMenu(+menu.dataset.menu);
    menu.classList.add('open');
  }
}

export function openMenuByName(name) {
  const i = MENUS.findIndex(([t]) => t === name);
  setOpen(menubar.querySelector(`[data-menu="${i}"]`));
}

menubar.addEventListener('click', (e) => {
  const item = e.target.closest('.menu-item');
  if (item) {
    setOpen(null);
    MENUS[+item.dataset.m][1][+item.dataset.i][1]();
    return;
  }
  const menu = e.target.closest('.menu');
  if (menu) setOpen(openMenu === menu ? null : menu);
});
menubar.addEventListener('mouseover', (e) => {
  const menu = e.target.closest('.menu');
  if (openMenu && menu && menu !== openMenu) setOpen(menu);
});
document.addEventListener('pointerdown', (e) => {
  if (openMenu && !menubar.contains(e.target)) setOpen(null);
});

// ── Toolbar ────────────────────────────────────────────────

const toolbar = document.getElementById('toolbar');
const tb = (id, icon, title, label = '') =>
  `<button class="tb-btn" id="tb-${id}" title="${esc(title)}">${icon}${label ? `<span>${label}</span>` : ''}</button>`;

toolbar.innerHTML = [
  tb('new', icons.new, 'New document'), tb('open', icons.open, `Open (${MOD}O)`), tb('save', icons.save, `Save (${MOD}S)`),
  '<span class="tb-sep"></span>',
  tb('undo', icons.undo, `Undo (${MOD}Z)`), tb('redo', icons.redo, `Redo (${SHIFT}${MOD}Z)`),
  '<span class="tb-sep"></span>',
  tb('duplicate', icons.duplicate, `Duplicate (${MOD}D)`), tb('delete', icons.trash, 'Delete (⌫)'),
  tb('front', icons.front, 'Bring to front (])'), tb('back', icons.back, 'Send to back ([)'),
  tb('group', icons.group, `Group into entity (${MOD}G)`), tb('ungroup', icons.ungroup, `Ungroup (${SHIFT}${MOD}G)`),
  '<span class="tb-sep"></span>',
  tb('zoom-out', icons.zoomOut, 'Zoom out (−)'),
  '<button class="tb-btn tb-zoom" id="tb-zoom" title="Actual size (1)">100%</button>',
  tb('zoom-in', icons.zoomIn, 'Zoom in (+)'), tb('fit', icons.fit, 'Fit document (0)'),
  '<span class="tb-sep"></span>',
  tb('grid', icons.grid, 'Show grid (#)'), tb('snap', icons.magnet, 'Snap to grid (%)'),
  `<select class="tb-select" id="tb-grid-size" title="Grid / snap size">${[0.5, 1, 2, 5, 10, 25, 50, 100].map(g => `<option value="${g}">${g} mm</option>`).join('')}</select>`,
  tb('dims', icons.dims, 'Show selection dimensions (D)'),
  '<span class="tb-spacer"></span>',
  '<button class="tb-btn tb-material" id="tb-material" title="Material & stock (click to change)"><span class="mat-dot"></span><span id="tb-material-label">Material</span></button>',
  tb('3d', icons.cube, '3D preview (3)', '3D'),
  tb('code', icons.code, `SVG code (${MOD}/)`),
  tb('side', icons.side, `Side panel (${MOD}\\)`),
].join('');

const click = (id, fn) => document.getElementById('tb-' + id).addEventListener('click', fn);
click('new', actions.newDocument);
click('open', actions.openDocument);
click('save', actions.save);
click('undo', actions.undo);
click('redo', actions.redo);
click('duplicate', actions.duplicate);
click('delete', actions.deleteSelection);
click('front', () => actions.reorder('front'));
click('back', () => actions.reorder('back'));
click('group', actions.group);
click('ungroup', actions.ungroup);
click('zoom-out', canvas.zoomOut);
click('zoom', canvas.zoom100);
click('zoom-in', canvas.zoomIn);
click('fit', canvas.zoomFit);
click('grid', () => canvas.setGrid({ showGrid: !app.showGrid }));
click('snap', () => canvas.setGrid({ snap: !app.snap }));
click('dims', () => canvas.setShowDims(!app.showDims));
click('3d', () => actions.toggle3d());
click('code', toggleCode);
click('side', toggleSide);
click('material', actions.materialDialog);
document.getElementById('tb-grid-size').addEventListener('change', (e) => canvas.setGrid({ grid: +e.target.value }));

export function updateToolbar() {
  const s = app.server;
  const set = (id, prop, v) => { const el = document.getElementById('tb-' + id); if (el) el[prop] = v; };
  set('undo', 'disabled', !s?.can_undo);
  set('redo', 'disabled', !s?.can_redo);
  set('undo', 'title', `Undo ${s?.undo_label || ''} (${MOD}Z)`);
  set('redo', 'title', `Redo ${s?.redo_label || ''} (${SHIFT}${MOD}Z)`);
  for (const id of ['duplicate', 'delete', 'front', 'back', 'group']) set(id, 'disabled', !hasSel());
  set('ungroup', 'disabled', !hasGroupSel());
  document.getElementById('tb-zoom').textContent = Math.round(app.zoom * 100) + '%';
  document.getElementById('tb-grid').classList.toggle('on', app.showGrid);
  document.getElementById('tb-snap').classList.toggle('on', app.snap);
  document.getElementById('tb-dims').classList.toggle('on', app.showDims);
  document.getElementById('tb-code').classList.toggle('on', app.codeOpen);
  document.getElementById('tb-3d').classList.toggle('on', app.view === '3d');
  document.getElementById('tb-side').classList.toggle('on', !app.sideHidden);
  document.getElementById('tb-grid-size').value = String(app.grid);
  const m = app.doc?.material;
  if (m) {
    document.getElementById('tb-material-label').textContent = `${m.name} · ${m.thickness} mm`;
    document.querySelector('#tb-material .mat-dot').style.background = m.color || '#e3c592';
  }
}

// ── Tool palette ───────────────────────────────────────────

const TOOLS = [
  ['select', 'Select / move (V) — double-click an entity to edit inside'], ['pan', 'Pan (H, or hold Space)'],
  ['line', 'Line (L) — Shift: 45°'], ['rect', 'Rectangle (R) — Shift: square; type a radius for round corners'],
  ['circle', 'Circle (C)'], ['ellipse', 'Ellipse (E) — Shift: circle'],
  ['slot', 'Slot (S) — drag the centre line; type length, angle, width'],
  ['outline', 'Outline (O) — click the corners; Enter, double-click or the first corner closes it. Type a corner radius'],
  ['fillet', 'Fillet (F) — click a corner to round it; Shift-click: all corners. Type the radius'],
  ['dogbone', 'Dog-bone (B) — click a corner; Shift-click: every corner of a hole / inside corner of an outline. Type the tool Ø'],
  ['text', 'Text (T)'],
  ['measure', 'Measure (M) — drag between points; snaps to corners/ends/centres. Enter: add as dimension'],
];
const toolsBox = document.getElementById('tools');
toolsBox.innerHTML = TOOLS.map(([t, title]) => `<button class="tool" data-tool="${t}" title="${esc(title)}">${icons[t]}</button>`).join('');
toolsBox.addEventListener('click', (e) => {
  const t = e.target.closest('[data-tool]')?.dataset.tool;
  if (t) canvas.setTool(t);
});
on('tool', () => toolsBox.querySelectorAll('.tool').forEach(b => b.classList.toggle('on', b.dataset.tool === app.tool)));

// ── Keyboard ───────────────────────────────────────────────

const TOOL_KEYS = { v: 'select', h: 'pan', l: 'line', r: 'rect', c: 'circle', e: 'ellipse', t: 'text', m: 'measure',
                    s: 'slot', o: 'outline', f: 'fillet', b: 'dogbone' };

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  const typing = e.target.matches('textarea, [contenteditable], input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=button])');
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();

  if (mod) {
    const run = (fn) => { e.preventDefault(); fn(); };
    if (k === 's') return run(e.shiftKey ? () => actions.saveAs() : actions.save);
    if (k === 'o') return run(actions.openDocument);
    if (k === 'e') return run(e.shiftKey ? actions.exportDxf : actions.exportCnc);
    if (k === 'i') return run(actions.importSvg);
    if (k === 'n' && e.shiftKey) return run(addLayer);
    if (k === '/') return run(toggleCode);
    if (k === '\\') return run(toggleSide);
    if (typing) return;
    if (k === 'z') return run(e.shiftKey ? actions.redo : actions.undo);
    if (k === 'y') return run(actions.redo);
    if (k === 'd') return run(actions.duplicate);
    if (k === 'a') return run(actions.selectAll);
    if (k === 'g') return run(e.shiftKey ? actions.ungroup : actions.group);
    return;
  }
  if (e.altKey && k === 'w') { e.preventDefault(); return actions.closeTab(); }
  if (typing) return;
  if (e.target.matches('select') && e.key.startsWith('Arrow')) return;
  if (e.key === ' ') { e.preventDefault(); canvas.setSpace(true); return; }
  if (e.key === 'Escape') return canvas.cancel();
  const typable = canvas.isDrawing() || canvas.hasToolOptions();
  if (typable && /^[0-9.,]$/.test(e.key)) { e.preventDefault(); return canvas.beginNumericEntry(e.key); }
  if (typable && e.key === 'Tab') { e.preventDefault(); return canvas.beginNumericEntry(''); }
  if (e.key === 'Enter' && canvas.isDrawing()) return canvas.commitDraw();
  if (e.key === 'Enter') {
    if (app.tool === 'measure' && canvas.currentMeasure()) return actions.addDimension();
    if (hasGroupSel()) return actions.enterGroup();
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); return actions.deleteSelection(); }
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[e.key]) {
    if (app.view === '3d') return;          // arrows move the 3D view there
    e.preventDefault();
    const step = (e.shiftKey ? 10 : 1) * (app.snap ? app.grid : 1);
    return actions.nudge(arrows[e.key][0] * step, arrows[e.key][1] * step);
  }
  if (e.key === '+' || e.key === '=') return canvas.zoomIn();
  if (e.key === '-' || e.key === '_') return canvas.zoomOut();
  if (e.key === '0') return canvas.zoomFit();
  if (e.key === '1') return canvas.zoom100();
  if (e.key === '2') return canvas.zoomToSelection();
  if (e.key === '3') return actions.toggle3d();
  if (e.key === '#') return canvas.setGrid({ showGrid: !app.showGrid });
  if (e.key === '%') return canvas.setGrid({ snap: !app.snap });
  if (k === 'd') return canvas.setShowDims(!app.showDims);
  if (e.key === ']') return actions.reorder('front');
  if (e.key === '[') return actions.reorder('back');
  if (TOOL_KEYS[k] && !e.altKey) canvas.setTool(TOOL_KEYS[k]);
});
document.addEventListener('keyup', (e) => { if (e.key === ' ') canvas.setSpace(false); });

on('measure', () => emit('status-hint'));
