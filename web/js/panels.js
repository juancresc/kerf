// Right side: Layers panel and the Inspector (selected shape / document).

import { app, on, emit, setSelection, selectedElements, selectedItems, selectItems, elementsOf, groupById,
         setContext, descendants } from './state.js';
import { api } from './api.js';
import { icons, esc, fmt, modal, toast, confirmDialog } from './ui.js';
import { docToSvg, screenDashOf } from './geometry.js';
import { PRESETS, MATERIAL_TYPES } from './materials.js';
import * as canvas from './canvas.js';
import * as actions from './actions.js';

const layersBox = document.getElementById('layers');
const inspector = document.getElementById('inspector');
const expanded = new Set();     // layer names with details open

// ── Layers ─────────────────────────────────────────────────

let layersQueued = false;
export function renderLayers() {
  const doc = app.doc;
  if (!doc) return;
  const active = document.activeElement;
  if (layersBox.contains(active) && active.matches('input[type=text], input:not([type]), textarea')) {
    layersQueued = true;   // re-render after the rename/description edit ends
    return;
  }
  layersQueued = false;
  if (!doc.layers.some(l => l.name === app.activeLayer)) app.activeLayer = doc.layers[0]?.name;
  const counts = {};
  doc.elements.forEach(e => counts[e.layer] = (counts[e.layer] || 0) + 1);
  const selLayers = new Set(selectedElements().map(e => e.layer));

  // Top of the list = drawn on top (last in document order)
  layersBox.innerHTML = [...doc.layers].reverse().map(l => {
    const i = doc.layers.indexOf(l);
    const open = expanded.has(l.name);
    return `<div class="layer ${l.name === app.activeLayer ? 'active' : ''} ${selLayers.has(l.name) ? 'has-selection' : ''} ${l.visible ? '' : 'hidden'}" data-layer="${esc(l.name)}" title="${esc(l.description)}">
      <div class="layer-row" title="Click to draw on this layer · double-click the name to rename">
        <button class="icon-btn small ${l.visible ? '' : 'off'}" data-act="visible" title="${l.visible ? 'Hide' : 'Show'}">${l.visible ? icons.eye : icons.eyeOff}</button>
        <button class="icon-btn small ${l.locked ? '' : 'off'}" data-act="lock" title="${l.locked ? 'Unlock' : 'Lock (not selectable)'}">${l.locked ? icons.lock : icons.unlock}</button>
        <label class="swatch" style="background:${esc(l.color)}" title="Colour"><input type="color" value="${esc(l.color)}" data-act="color"></label>
        <span class="layer-name" data-act="name">${esc(l.name)}</span>
        ${l.export ? '' : '<span class="no-export" title="Not included in CNC export">no cut</span>'}
        ${l.depth ? `<span class="no-export" style="color:#6d28d9;border-color:#d8c8f5;background:#f5f0ff" title="Partial-depth cut (pocket) from the top face">${l.depth} mm</span>` : ''}
        <svg class="style-mini" viewBox="0 0 22 10"><line x1="1" y1="5" x2="21" y2="5" stroke="${esc(l.color)}" stroke-width="2" stroke-dasharray="${esc(screenDashOf(l) || 'none')}" stroke-linecap="round"/></svg>
        <span class="layer-count">${counts[l.name] || 0}</span>
        <button class="icon-btn small layer-del" data-act="delete" title="Delete layer">${icons.trash}</button>
        <button class="icon-btn small" data-act="expand" title="Details: description, line style, export, order">${open ? icons.chevronDown : icons.chevron}</button>
      </div>
      ${open ? `<div class="layer-details">
        <textarea data-act="description" placeholder="What is this layer for? (e.g. pocket 6 mm deep)">${esc(l.description)}</textarea>
        <div class="row"><span class="grow">Line style</span>
          <select class="field" style="width:auto" data-act="style">
            ${['solid', 'dashed', 'dotted'].map(s => `<option ${l.line_style === s ? 'selected' : ''}>${s}</option>`).join('')}
            ${['solid', 'dashed', 'dotted'].includes(l.line_style) ? '' : `<option selected>${esc(l.line_style)}</option>`}
          </select></div>
        <label class="row"><input type="checkbox" data-act="export" ${l.export ? 'checked' : ''}> <span class="grow">Include in CNC export</span></label>
        <div class="row"><span class="grow" title="Empty = cut all the way through. A number = pocket this deep from the top face.">Depth</span>
          <input type="number" class="field" style="width:80px" min="0" step="any" data-act="depth" placeholder="through" value="${l.depth ?? ''}"> mm</div>
        <div class="row">
          <button class="icon-btn" data-act="up" title="Move up (draw on top)" ${i === doc.layers.length - 1 ? 'disabled' : ''}>${icons.up}</button>
          <button class="icon-btn" data-act="down" title="Move down" ${i === 0 ? 'disabled' : ''}>${icons.down}</button>
          <span class="grow"></span>
          <button class="btn danger" data-act="delete">Delete layer</button>
        </div>
      </div>` : ''}
    </div>`;
  }).join('');
  emit('active-layer');
}

const layerOp = (name, fields, label) => api.ops([{ op: 'update_layer', name, ...fields }], label);

layersBox.addEventListener('click', async (e) => {
  const row = e.target.closest('.layer');
  if (!row) return;
  const name = row.dataset.layer;
  const layer = app.doc.layers.find(l => l.name === name);
  const act = e.target.closest('[data-act]')?.dataset.act;
  switch (act) {
    case 'expand':
      expanded.has(name) ? expanded.delete(name) : expanded.add(name);
      return renderLayers();
    case 'visible':
      return api.ops([{ op: 'set_layer_visibility', name, visible: !layer.visible }]);
    case 'lock':
      return layerOp(name, { locked: !layer.locked }, layer.locked ? 'Unlock layer' : 'Lock layer');
    case 'up':
    case 'down': {
      const i = app.doc.layers.indexOf(layer);
      return api.ops([{ op: 'move_layer', name, index: act === 'up' ? i + 1 : i - 1 }]);
    }
    case 'delete':
      return deleteLayer(layer);
    case 'color': case 'description': case 'style': case 'export': case 'name':
      if (act !== 'name') return;
  }
  if (!e.target.closest('.layer-details, input, select, textarea')) {
    app.activeLayer = name;
    renderLayers();
  }
});

layersBox.addEventListener('dblclick', (e) => {
  const span = e.target.closest('[data-act=name]');
  if (!span) return;
  const name = span.closest('.layer').dataset.layer;
  span.innerHTML = `<input value="${esc(name)}">`;
  const input = span.querySelector('input');
  input.focus(); input.select();
  let done = false;
  const commit = async (ok) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (ok && v && v !== name) {
      if (await layerOp(name, { new_name: v }, 'Rename layer')) {
        if (app.activeLayer === name) app.activeLayer = v;
        if (expanded.delete(name)) expanded.add(v);
      }
    }
    renderLayers();
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') commit(true);
    if (ev.key === 'Escape') commit(false);
    ev.stopPropagation();
  });
  input.addEventListener('blur', () => commit(true));
});

layersBox.addEventListener('change', (e) => {
  const act = e.target.dataset.act;
  const name = e.target.closest('.layer')?.dataset.layer;
  if (!name) return;
  if (act === 'color') layerOp(name, { color: e.target.value }, 'Layer colour');
  if (act === 'style') layerOp(name, { line_style: e.target.value }, 'Line style');
  if (act === 'export') layerOp(name, { export: e.target.checked }, 'Layer export');
  if (act === 'description') layerOp(name, { description: e.target.value }, 'Layer description');
  if (act === 'depth') layerOp(name, { depth: e.target.value === '' ? null : +e.target.value }, 'Layer depth');
});
layersBox.addEventListener('focusout', () => setTimeout(() => { if (layersQueued) renderLayers(); }, 0));

// Live colour preview while dragging in the picker
layersBox.addEventListener('input', (e) => {
  if (e.target.dataset.act === 'color') e.target.parentElement.style.background = e.target.value;
});

export async function deleteLayer(layer = app.doc?.layers.find(l => l.name === app.activeLayer)) {
  if (!layer) return;
  const doc = app.doc;
  if (doc.layers.length === 1) return toast('A document needs at least one layer', 'error');
  const n = doc.elements.filter(e => e.layer === layer.name).length;
  if (!n) {
    if (await confirmDialog('Delete layer?', `Delete the empty layer “${layer.name}”?`, 'Delete', true))
      api.ops([{ op: 'remove_layer', name: layer.name }], 'Delete layer');
    return;
  }
  const others = doc.layers.filter(l => l.name !== layer.name);
  let target = null;
  const ok = await modal({
    title: `Delete layer “${layer.name}”?`,
    html: `<p>It contains ${n} element(s). What should happen to them?</p>
      <div class="kv"><label>Elements</label><select name="target" class="field">
        ${others.map(l => `<option value="${esc(l.name)}">Move to ${esc(l.name)}</option>`).join('')}
        <option value="__delete__">Delete them</option></select></div>`,
    buttons: [{ label: 'Cancel', value: false }, { label: 'Delete layer', value: true, kind: 'primary danger-solid' }],
    onSubmit: (form) => { target = form.target.value; },
  });
  if (ok) api.ops([{ op: 'remove_layer', name: layer.name, move_to: target }], 'Delete layer');
}

export async function addLayer() {
  let v = null;
  const n = app.doc.layers.length + 1;
  const ok = await modal({
    title: 'New layer',
    html: `<div class="kv">
      <label>Name</label><input name="name" class="field" value="LAYER_${n}" required>
      <label>Colour</label><input name="color" type="color" value="#8e44ad" style="width:60px;height:28px">
      <label>Line style</label><select name="line_style" class="field"><option>solid</option><option>dashed</option><option>dotted</option></select>
      <label>CNC export</label><label><input type="checkbox" name="export" checked> include when exporting</label>
      <label>Depth</label><input name="depth" type="number" class="field" min="0" step="any" placeholder="empty = through-cut (mm for pockets)">
      <label>Description</label><textarea name="description" class="field" placeholder="e.g. Pocket, 6 mm deep, 6 mm end mill"></textarea>
    </div>`,
    buttons: [{ label: 'Cancel', value: false }, { label: 'Create', value: true, kind: 'primary' }],
    onSubmit: (form) => {
      v = { name: form.name.value.trim(), color: form.color.value, line_style: form.line_style.value,
            export: form.export.checked, description: form.description.value.trim(),
            depth: form.depth.value === '' ? null : +form.depth.value };
      return !!v.name;
    },
  });
  if (!ok) return;
  if (await api.ops([{ op: 'add_layer', ...v }], 'Add layer')) {
    app.activeLayer = v.name;
    renderLayers();
  }
}

// ── Inspector ──────────────────────────────────────────────

const GEOMETRY = {
  line: [['x1', 'y1'], ['x2', 'y2']],
  rect: [['x', 'y'], ['width', 'height'], ['rx']],
  circle: [['cx', 'cy'], ['r', 'diameter']],
  ellipse: [['cx', 'cy'], ['rx', 'ry']],
  text: [['x', 'y'], ['font-size']],
  path: [['d']],
  polygon: [['points']],
  polyline: [['points']],
};
const LABELS = { diameter: '⌀', 'font-size': 'size' };

export function renderInspector() {
  renderInspectorContent();
  sectionize();
  fitPreviews();
}

// Each <h3> and what follows it becomes a collapsible section; closed ones are remembered
const CLOSED_KEY = 'kerf.inspectorClosed';
const closedSecs = new Set((() => { try { return JSON.parse(localStorage.getItem(CLOSED_KEY)) || ['Tips']; } catch (_) { return ['Tips']; } })());
function sectionize() {
  for (const h of [...inspector.querySelectorAll(':scope > h3')]) {
    const name = h.textContent.replace(/:.*/, '').trim();
    const sec = document.createElement('details');
    sec.className = 'sec';
    sec.open = !closedSecs.has(name);
    const summary = document.createElement('summary');
    summary.innerHTML = h.innerHTML;
    sec.append(summary);
    let n = h.nextSibling;
    while (n && !(n.nodeType === 1 && n.tagName === 'H3')) { const next = n.nextSibling; sec.append(n); n = next; }
    h.replaceWith(sec);
    sec.addEventListener('toggle', () => {
      sec.open ? closedSecs.delete(name) : closedSecs.add(name);
      try { localStorage.setItem(CLOSED_KEY, JSON.stringify([...closedSecs])); } catch (_) {}
    });
  }
}

function renderInspectorContent() {
  const doc = app.doc;
  if (!doc) return;
  const sel = selectedElements();
  if (!sel.length) return renderDocumentInfo();
  const items = selectedItems();
  if (items.length === 1 && items[0].startsWith('g-')) return renderGroupInspector(groupById(items[0]), sel);
  const box = canvas.selectionBox();
  const preview = previewSvg(sel);
  const size = box && (box.width || box.height) ? `${fmt(box.width)} × ${fmt(box.height)} mm` : '—';

  if (sel.length > 1) {
    const layers = new Set(sel.map(e => e.layer));
    inspector.innerHTML = `<h2>${sel.length} selected</h2><div class="preview" style="margin-top:8px">${preview}</div>
      <div class="kv">
        <label>Size</label><span class="val" data-bounds="auto">${size}</span>
        <label>Position</label><span class="val">${box ? `${fmt(box.x)}, ${fmt(box.y)}` : '—'}</span>
        <label>Layer</label>${layerSelect(layers.size === 1 ? [...layers][0] : '')}
      </div>
      ${entityRow()}
      ${buttons()}`;
  } else {
    const el = sel[0];
    const rows = (GEOMETRY[el.tag] || []).map(group => {
      if (group[0] === 'd' || group[0] === 'points')
        return `<label>${group[0]}</label><textarea data-attr="${group[0]}" spellcheck="false">${esc(el.attrs[group[0]] || '')}</textarea>`;
      const inputs = group.map(a => {
        const v = a === 'diameter' ? 2 * (+el.attrs.r || 0) : el.attrs[a];
        return `<span class="unit" data-unit="${a === 'font-size' ? 'mm' : 'mm'}" title="${a}"><input type="number" step="any" data-attr="${a}" value="${fmt(v, 3)}"></span>`;
      }).join('');
      return `<label>${group.map(a => LABELS[a] || a).join(' / ')}</label><div class="${group.length > 1 ? 'pair' : ''}">${inputs}</div>`;
    }).join('');
    const hasFill = el.tag !== 'line' && el.tag !== 'text' && el.tag !== 'polyline';
    const fill = el.attrs.fill && el.attrs.fill !== 'none' ? el.attrs.fill : '';
    inspector.innerHTML = `<h2>Selected shape <span class="tag-pill">${esc(el.tag)}</span> <span class="tag-pill">${esc(el.id)}</span></h2>
      <div class="preview" style="margin-top:8px">${preview}</div>
      <div class="kv">
        <label>Name</label><input type="text" data-name value="${esc(el.name || '')}" placeholder="unnamed" title="A label for this shape (not exported)">
        <label>Layer</label>${layerSelect(el.layer)}
        <label>Bounds</label><span class="val" data-bounds="auto">${size}</span>
        ${rows}
        ${el.tag === 'text' ? `<label>text</label><input type="text" data-text value="${esc(el.text)}">` : ''}
        ${hasFill ? `<label>fill</label><div class="fill-row">
            <label><input type="checkbox" data-fill-on ${fill ? 'checked' : ''}> filled</label>
            <input type="color" data-fill value="${fill && fill.startsWith('#') && fill.length === 7 ? fill : '#cccccc'}" ${fill ? '' : 'disabled'}></div>` : ''}
        ${el.attrs.transform ? `<label>transform</label><input type="text" data-attr="transform" value="${esc(el.attrs.transform)}">` : ''}
      </div>
      <p class="hint" style="margin-top:8px">Stroke colour and line style come from the layer.</p>
      ${entityRow()}
      ${buttons()}`;
    bindShapeFields(el);
  }
  inspector.querySelector('[data-layer-select]')?.addEventListener('change', (e) => {
    if (e.target.value) actions.moveSelectionToLayer(e.target.value);
  });
  inspector.querySelectorAll('[data-action]').forEach(b => b.addEventListener('click', () => actions[b.dataset.action]()));
  inspector.querySelector('[data-front]')?.addEventListener('click', () => actions.reorder('front'));
  inspector.querySelector('[data-back]')?.addEventListener('click', () => actions.reorder('back'));
  inspector.querySelector('[data-zoom]')?.addEventListener('click', () => canvas.zoomToSelection());
}

/** Which entity the selection is in, with Add / Remove buttons. */
function entityRow() {
  const g = app.context ? groupById(app.context) : null;
  return `<div class="kv ent-kv"><label>Entity</label><div class="ent-row">
      <span class="${g ? '' : 'muted'}">${g ? esc(g.name) : 'none'}</span>
      ${g ? '<button class="link-btn" data-action="removeFromEntity" title="Take the selection out of this entity">Remove</button>' : ''}
      <button class="link-btn" data-action="addToEntity" title="Put the selection into an entity">Add to…</button></div></div>`;
}

function layerSelect(current) {
  return `<select data-layer-select>${current ? '' : '<option value="">(mixed)</option>'}${app.doc.layers.map(l =>
    `<option ${l.name === current ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>`;
}

function buttons() {
  return `<div class="btn-row">
    <button class="btn" data-action="duplicate">Duplicate</button>
    <button class="btn" data-zoom>Zoom to</button>
    <button class="btn" data-front>Bring to front</button>
    <button class="btn" data-back>Send to back</button>
    <button class="btn danger" data-action="deleteSelection" style="grid-column: span 2">Delete</button>
  </div>`;
}

function previewSvg(els) {
  return docToSvg(app.doc, { background: false, ids: new Set(els.map(e => e.id)) })
    .replace('<svg ', '<svg preserveAspectRatio="xMidYMid meet" data-fit-preview ');
}

/** Fit each preview to its own content (works even while the 2D canvas is hidden). */
function fitPreviews() {
  for (const svgEl of inspector.querySelectorAll('svg[data-fit-preview]')) {
    let b;
    try { b = svgEl.getBBox(); } catch (_) { continue; }
    if (!b || (!b.width && !b.height)) continue;
    const pad = Math.max(b.width, b.height) * 0.08 + 1;
    svgEl.setAttribute('viewBox', `${b.x - pad} ${b.y - pad} ${b.width + 2 * pad} ${b.height + 2 * pad}`);
    svgEl.removeAttribute('width'); svgEl.removeAttribute('height');
    const out = inspector.querySelector('[data-bounds]');
    if (out && out.dataset.bounds === 'auto') out.textContent = `${fmt(b.width)} × ${fmt(b.height)} mm`;
  }
}

function bindShapeFields(el) {
  inspector.querySelectorAll('[data-attr]').forEach(input => {
    input.addEventListener('input', () => {
      const a = input.dataset.attr;
      let v = input.value.trim();
      if (input.type === 'number' && (v === '' || isNaN(+v))) return;
      const attrs = a === 'diameter' ? { r: +v / 2 } : { [a]: v };
      api.ops([{ op: 'update_element', id: el.id, attrs }], `Edit ${a}`);
    });
  });
  inspector.querySelector('[data-name]')?.addEventListener('input', (e) =>
    api.ops([{ op: 'update_element', id: el.id, name: e.target.value }], 'Rename shape'));
  inspector.querySelector('[data-text]')?.addEventListener('input', (e) =>
    api.ops([{ op: 'update_element', id: el.id, text: e.target.value }], 'Edit text'));
  const fillOn = inspector.querySelector('[data-fill-on]'), fillColor = inspector.querySelector('[data-fill]');
  fillOn?.addEventListener('change', () => {
    fillColor.disabled = !fillOn.checked;
    api.ops([{ op: 'update_element', id: el.id, attrs: { fill: fillOn.checked ? fillColor.value : 'none' } }], 'Fill');
  });
  fillColor?.addEventListener('change', () => api.ops([{ op: 'update_element', id: el.id, attrs: { fill: fillColor.value } }], 'Fill'));
}

function renderDocumentInfo() {
  const doc = app.doc, s = app.server;
  const m = doc.material || {};
  const counts = doc.layers.map(l => [l, doc.elements.filter(e => e.layer === l.name).length]);
  const active = doc.layers.find(l => l.name === app.activeLayer);
  inspector.innerHTML = `<h2>Document</h2>
    <div class="kv" style="margin-top:8px">
      <label>Project</label><input type="text" data-title value="${esc(s.tabs.find(t => t.id === s.active)?.title || '')}" placeholder="${esc(s.name)}" title="Project name: shown on the tab and saved in the file. The file name doesn't change.">
      <label>File</label><span class="val">${s.file ? esc(s.file) : '<span class="muted">not saved yet</span>'}${s.dirty ? ' •' : ''}</span>
      <label>Size</label><span class="val">${fmt(doc.width)} × ${fmt(doc.height)} mm</span>
      <label>Elements</label><span class="val">${doc.elements.length}</span>
    </div>
    <div class="btn-row"><button class="btn" data-doc-size>Change size…</button><button class="btn" data-fit>Fit to window</button></div>
    ${active ? `<h3>Active layer: ${esc(active.name)}</h3><p class="hint">${esc(active.description) || 'No description. Open the layer details (▸) to add one.'}</p>` : ''}
    <h3>CNC export</h3>
    <p class="hint">${counts.filter(([l]) => l.export).map(([l, n]) => `${esc(l.name)} (${n})`).join(', ') || 'nothing'} will be exported (hidden layers too — visibility only affects the view).
      ${counts.filter(([l]) => !l.export).length ? `Not exported: ${counts.filter(([l]) => !l.export).map(([l]) => esc(l.name)).join(', ')}.` : ''}</p>
    <h3>Material &amp; stock</h3>
    <div class="kv">
      <label>Preset</label><select data-m-preset><option value="">— choose —</option>${PRESETS.map((p, i) =>
        `<option value="${i}">${esc(p.name)}</option>`).join('')}</select>
      <label>Material</label><input type="text" data-m="name" value="${esc(m.name)}">
      <label>Type</label><select data-m="type">${MATERIAL_TYPES.map(t => `<option ${t === m.type ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <label>Thickness</label><span class="unit" data-unit="mm"><input type="number" step="any" min="0.1" data-m="thickness" value="${m.thickness}"></span>
      <label>Colour</label><div class="fill-row"><input type="color" data-m="color" value="${m.color || '#e3c592'}"><span class="hint">3D preview</span></div>
      <label>Sheet</label><div class="pair"><span class="unit" data-unit="mm"><input type="number" step="any" data-m="sheet_width" value="${m.sheet_width}"></span>
        <span class="unit" data-unit="mm"><input type="number" step="any" data-m="sheet_height" value="${m.sheet_height}"></span></div>
      <label>Tool Ø</label><span class="unit" data-unit="mm"><input type="number" step="any" data-m="tool_diameter" value="${m.tool_diameter}"></span>
      <label>Notes</label><textarea data-m="notes" placeholder="Supplier, grain direction, feeds…">${esc(m.notes || '')}</textarea>
    </div>
    <h3>3D sliders</h3>
    <p class="hint">Parameters of this project for the 3D preview (e.g. desk height, lid opening). Parts move with one via their 3D placement.</p>
    <div class="params-edit">${(doc.params || []).map((p, i) => `<div class="param-row" data-pi="${i}">
        <input type="text" data-p="label" value="${esc(p.label)}" title="Label">
        <input type="number" step="any" data-p="min" value="${p.min}" title="Min (mm)">
        <input type="number" step="any" data-p="max" value="${p.max}" title="Max (mm)">
        <input type="number" step="any" data-p="step" value="${p.step}" title="Step">
        <input type="number" step="any" data-p="display_offset" value="${p.display_offset}" title="Shown value = slider + this">
        <button class="icon-btn" data-p-del title="Remove">×</button></div>`).join('')}
      <div class="param-head"><span>label</span><span>min</span><span>max</span><span>step</span><span>+shown</span><span></span></div>
      <div class="btn-row"><button class="btn" data-p-add>Add slider</button></div>
    </div>
    ${doc.background ? `<h3>Reference image</h3><div class="kv"><label>Opacity</label><input type="range" min="0" max="1" step="0.05" value="${doc.background.opacity}" data-bg-opacity></div>
      <div class="btn-row"><button class="btn danger" data-bg-remove>Remove image</button></div>` : ''}
    <h3>Tips</h3>
    <p class="hint">Click a shape to select it. Drag on empty space to box-select: left→right selects shapes fully inside, right→left selects anything touched. Shift adds. Arrows nudge (Shift ×10). Space-drag pans, ⌘-scroll zooms.</p>`;
  inspector.querySelector('[data-doc-size]').addEventListener('click', actions.documentSize);
  inspector.querySelector('[data-title]').addEventListener('change', (e) =>
    api.ops([{ op: 'set_title', title: e.target.value.trim() }], 'Rename project'));
  inspector.querySelector('[data-fit]').addEventListener('click', canvas.zoomFit);
  const setMat = (fields, label = 'Material') => api.ops([{ op: 'set_material', material: fields }], label);
  const setParams = (params, label = '3D sliders') => api.ops([{ op: 'set_params', params }], label);
  inspector.querySelectorAll('[data-pi] [data-p]').forEach(inp => inp.addEventListener('change', () => {
    const i = +inp.closest('[data-pi]').dataset.pi, k = inp.dataset.p;
    const params = JSON.parse(JSON.stringify(doc.params || []));
    params[i][k] = inp.type === 'number' ? +inp.value : inp.value;
    setParams(params);
  }));
  inspector.querySelectorAll('[data-p-del]').forEach(b => b.addEventListener('click', () => {
    const i = +b.closest('[data-pi]').dataset.pi;
    setParams((doc.params || []).filter((_, j) => j !== i), 'Remove slider');
  }));
  inspector.querySelector('[data-p-add]').addEventListener('click', async () => {
    let v = null;
    const ok = await modal({
      title: 'New 3D slider',
      html: `<div class="kv"><label>Name</label><input name="name" class="field" value="param${(doc.params || []).length + 1}" title="letters, digits, _">
        <label>Label</label><input name="label" class="field" value="Opening">
        <label>Min</label><input name="min" type="number" step="any" class="field" value="0">
        <label>Max</label><input name="max" type="number" step="any" class="field" value="300">
        <label>Step</label><input name="step" type="number" step="any" class="field" value="10"></div>
        <p class="hint" style="margin-top:8px">Then pick it in an entity's 3D placement (“Moves with”) to make that part slide.</p>`,
      buttons: [{ label: 'Cancel', value: false }, { label: 'Add', value: true, kind: 'primary' }],
      onSubmit: (form) => { v = { name: form.name.value.trim(), label: form.label.value.trim(), min: +form.min.value,
                                  max: +form.max.value, step: +form.step.value, display_offset: 0, unit: 'mm' }; return !!v.name; },
    });
    if (ok) setParams([...(doc.params || []), v], 'Add slider');
  });
  inspector.querySelectorAll('[data-m]').forEach(inp => inp.addEventListener('change', () => {
    const k = inp.dataset.m;
    setMat({ [k]: inp.type === 'number' ? +inp.value : inp.value });
  }));
  inspector.querySelector('[data-m-preset]').addEventListener('change', (e) => {
    const p = PRESETS[+e.target.value];
    if (p) setMat({ name: p.name.replace(/ \d+.*$/, ''), type: p.type, thickness: p.thickness, color: p.color }, 'Material preset');
  });
  inspector.querySelector('[data-bg-remove]')?.addEventListener('click', actions.removeBackground);
  inspector.querySelector('[data-bg-opacity]')?.addEventListener('change', (e) =>
    api.ops([{ op: 'set_background_opacity', opacity: +e.target.value }], 'Background opacity'));
}

// Re-render the inspector when state changes, but never while the user is typing in it
let inspectorQueued = false;
export function refreshInspector() {
  if (inspector.contains(document.activeElement) && document.activeElement.matches('input:not([type=checkbox]):not([type=range]):not([type=color]), textarea')) {
    inspectorQueued = true;
    return;
  }
  inspectorQueued = false;
  renderInspector();
}
inspector.addEventListener('focusout', () => setTimeout(() => { if (inspectorQueued) refreshInspector(); }, 0));

document.getElementById('layer-add').innerHTML = icons.plus;
document.getElementById('layer-add').addEventListener('click', addLayer);
on('selection', refreshInspector);
// Selecting shapes makes their layer the active one (for an entity spanning layers, keep the
// active layer if it's one of them, otherwise take the first); all their layers get marked.
on('selection', () => {
  const layers = [...new Set(selectedElements().map(e => e.layer))];
  if (layers.length && !layers.includes(app.activeLayer)) app.activeLayer = layers[0];
  renderLayers();
});


// ── Entities panel ─────────────────────────────────────────

const entitiesBox = document.getElementById('entities');

export function renderEntities() {
  const doc = app.doc;
  if (!doc) return;
  const groups = doc.groups || [];
  const sel = new Set(selectedItems());
  const counts = new Map(groups.map(g => [g.id, descendants(g.id).length]));
  const loose = doc.elements.filter(e => !e.group).length;
  const rows = [];
  const walk = (parent, depth) => {
    for (const g of groups.filter(g => (g.parent || null) === parent)) {
      rows.push(`<div class="entity ${sel.has(g.id) ? 'selected' : ''}" data-gid="${esc(g.id)}" draggable="true" style="padding-left:${6 + depth * 14}px"
        title="Click: select · double-click: enter (edit inside) · drag onto another entity to nest it">
        <span class="ent-name">${esc(g.name)}</span>
        ${g.assembly ? '<span class="ent-3d" title="Placed in the 3D preview">3D</span>' : ''}
        <span class="ent-meta">×${g.qty} · ${counts.get(g.id)}</span></div>`);
      walk(g.id, depth + 1);
    }
  };
  walk(null, 0);
  entitiesBox.innerHTML = rows.length
    ? rows.join('') + (loose ? `<p class="entities-empty" style="margin-top:6px">${loose} shape(s) not in any entity</p>` : '')
    : '<p class="entities-empty">No entities yet. Select the shapes of one part (outline + holes) and press ⌘G. Entities become separate part files and 3D parts.</p>';
}

entitiesBox.addEventListener('click', (e) => {
  const row = e.target.closest('[data-gid]');
  if (!row) return;
  const g = groupById(row.dataset.gid);
  if (!g) return;
  if ((g.parent || null) !== app.context) setContext(g.parent || null);
  canvas.render();
  selectItems([g.id]);
});
// Drag an entity onto another to nest it; onto empty space to move it to the top level
entitiesBox.addEventListener('dragstart', (e) => {
  const row = e.target.closest('[data-gid]');
  if (!row) return;
  e.dataTransfer.setData('text/x-kerf-entity', row.dataset.gid);
  e.dataTransfer.effectAllowed = 'move';
});
entitiesBox.addEventListener('dragover', (e) => {
  if (!e.dataTransfer.types.includes('text/x-kerf-entity')) return;
  e.preventDefault();
  entitiesBox.querySelectorAll('.drop-into').forEach(n => n.classList.remove('drop-into'));
  (e.target.closest('[data-gid]') || entitiesBox).classList.add('drop-into');
});
entitiesBox.addEventListener('dragleave', (e) => {
  if (!entitiesBox.contains(e.relatedTarget)) entitiesBox.querySelectorAll('.drop-into').forEach(n => n.classList.remove('drop-into'));
  if (!entitiesBox.contains(e.relatedTarget)) entitiesBox.classList.remove('drop-into');
});
entitiesBox.addEventListener('drop', async (e) => {
  const gid = e.dataTransfer.getData('text/x-kerf-entity');
  entitiesBox.querySelectorAll('.drop-into').forEach(n => n.classList.remove('drop-into'));
  entitiesBox.classList.remove('drop-into');
  if (!gid) return;
  e.preventDefault();
  const target = e.target.closest('[data-gid]')?.dataset.gid || null;
  if (target === gid || (groupById(gid)?.parent || null) === target) return;
  const s = await api.ops([{ op: 'set_group', items: [gid], group: target }], target ? 'Nest entity' : 'Move entity to top');
  if (s) toast(target ? `Moved into “${groupById(target)?.name}”` : 'Moved to the top level', 'ok');
});
entitiesBox.addEventListener('dblclick', (e) => {
  const row = e.target.closest('[data-gid]');
  if (row) canvas.enterGroup(row.dataset.gid);
});
document.getElementById('entity-add').innerHTML = icons.plus;
document.getElementById('entity-add').addEventListener('click', actions.group);
on('selection', renderEntities);

// ── Inspector: entity ──────────────────────────────────────

function renderGroupInspector(g, sel) {
  const box = canvas.selectionBox();
  const layers = [...new Set(sel.map(e => e.layer))];
  const a = g.assembly;
  const num = (v, d = 0) => (v === undefined || v === null ? d : v);
  const params = app.doc.params || [];
  inspector.innerHTML = `<h2>Entity <span class="tag-pill">${esc(g.id)}</span></h2>
    <div class="preview" style="margin-top:8px">${previewSvg(sel)}</div>
    <div class="kv">
      <label>Name</label><input type="text" data-g="name" value="${esc(g.name)}">
      <label>Quantity</label><input type="number" min="1" step="1" data-g="qty" value="${g.qty}">
      <label>Contains</label><span class="val">${sel.length} shapes · ${layers.map(esc).join(', ')}</span>
      <label>Bounds</label><span class="val" data-bounds="auto">${box && box.width ? `${fmt(box.width)} × ${fmt(box.height)} mm` : '—'}</span>
    </div>
    <h3>Contents (${contents(g).length})</h3>
    <div class="ent-contents">${contents(g).map(contentRow).join('') || '<p class="hint">Empty</p>'}</div>
    <p class="hint" style="margin-top:6px">Click a row to select it on the canvas · × takes it out of “${esc(g.name)}”.</p>
    <h3>3D placement</h3>
    ${a ? `<div class="kv">
      <label>Thickness</label><span class="unit" data-unit="mm"><input type="number" step="any" min="0.1" data-a="thickness" value="${a.thickness ?? ''}" placeholder="${app.doc.material?.thickness || 18} (material)" title="Empty = follow the material thickness"></span>
      <label>Position</label><div class="pair" style="grid-template-columns:1fr 1fr 1fr">${[0, 1, 2].map(i => `<input type="number" step="any" data-a="position.${i}" value="${num(a.position?.[i])}" title="${'xyz'[i]} (mm)">`).join('')}</div>
      <label>Rotation °</label><div class="pair" style="grid-template-columns:1fr 1fr 1fr">${[0, 1, 2].map(i => `<input type="number" step="any" data-a="rotation.${i}" value="${num(a.rotation?.[i])}" title="about ${'xyz'[i]}">`).join('')}</div>
      <label>Moves with</label><select data-a="move"><option value="">— fixed —</option>${params.map(p =>
        `<option value="${esc(p.name)}" ${a.move?.param === p.name ? 'selected' : ''}>${esc(p.label || p.name)}</option>`).join('')}</select>
    </div>
    <p class="hint" style="margin-top:6px">World: X = width, Y = up, Z = toward you. The part's outline is extruded by its thickness (empty = the material's).</p>
    <div class="btn-row"><button class="btn" data-open3d>Open 3D preview</button><button class="btn danger" data-a-clear>Remove from 3D</button></div>`
    : `<p class="hint">Not placed in 3D yet: the preview lays it flat where it is on the sheet.</p>
       <div class="btn-row"><button class="btn" data-a-init>Place in 3D…</button><button class="btn" data-open3d>Open 3D preview</button></div>`}
    <div class="btn-row">
      <button class="btn" data-enter>Enter (edit inside)</button>
      <button class="btn" data-ungroup>Ungroup</button>
      <button class="btn" data-action="addToEntity" title="Nest this entity inside another one">Put inside…</button>
      ${g.parent ? `<button class="btn" data-action="removeFromEntity" title="Move it up one level">Take out of “${esc(groupById(g.parent)?.name || '')}”</button>` : '<span></span>'}
      <button class="btn" data-action="duplicate">Duplicate</button>
      <button class="btn" data-zoom>Zoom to</button>
      <button class="btn danger" data-action="deleteSelection" style="grid-column: span 2">Delete entity</button>
    </div>`;
  const upd = (fields, label) => api.ops([{ op: 'update_group', id: g.id, ...fields }], label);
  inspector.querySelector('[data-g="name"]').addEventListener('change', e => upd({ name: e.target.value }, 'Rename entity'));
  inspector.querySelector('[data-g="qty"]').addEventListener('change', e => upd({ qty: +e.target.value || 1 }, 'Quantity'));
  inspector.querySelectorAll('[data-a]').forEach(inp => inp.addEventListener('change', () => {
    const next = JSON.parse(JSON.stringify(g.assembly || {}));
    const key = inp.dataset.a;
    if (key === 'move') {
      if (inp.value) next.move = { param: inp.value, axis: next.move?.axis || [0, 1, 0] };
      else delete next.move;
    } else if (key.includes('.')) {
      const [k, i] = key.split('.');
      next[k] = next[k] || [0, 0, 0];
      next[k][+i] = +inp.value || 0;
    } else if (key === 'thickness' && !(+inp.value > 0)) delete next.thickness;   // follow the material
    else next[key] = +inp.value || 0;
    upd({ assembly: next }, '3D placement');
  }));
  inspector.querySelector('[data-a-clear]')?.addEventListener('click', () => upd({ assembly: null }, 'Remove from 3D'));
  inspector.querySelector('[data-a-init]')?.addEventListener('click', () => {
    // Start as a flat board lying where it is on the sheet: sheet (x, y) → world (x, 0, y)
    const b = box || { x: 0, y: 0, width: 0, height: 0 };
    upd({ assembly: { matrix: [1, 0, 0, -1, -b.x, b.y + b.height],
                      position: [b.x, 0, b.y + b.height], rotation: [-90, 0, 0] } }, 'Place in 3D');
  });
  inspector.querySelector('[data-open3d]')?.addEventListener('click', () => actions.open3d());
  inspector.querySelector('[data-enter]').addEventListener('click', () => canvas.enterGroup(g.id));
  inspector.querySelector('[data-ungroup]').addEventListener('click', actions.ungroup);
  inspector.querySelectorAll('[data-action]').forEach(b => b.addEventListener('click', () => actions[b.dataset.action]()));
  inspector.querySelector('[data-zoom]').addEventListener('click', () => canvas.zoomToSelection());
  const box2 = inspector.querySelector('.ent-contents');
  box2?.addEventListener('click', async (e) => {
    const row = e.target.closest('[data-item]');
    if (!row) return;
    const item = row.dataset.item;
    if (e.target.closest('[data-take-out]')) {
      await api.ops([{ op: 'set_group', items: [item], group: g.parent || null }], 'Remove from entity');
      if (groupById(g.id)) selectItems([g.id]);            // stay on the entity (unless it's now empty)
      return;
    }
    setContext(g.id);                                        // go inside and select just that item
    canvas.render();
    selectItems([item]);
  });
  box2?.addEventListener('mouseover', (e) => {
    const item = e.target.closest('[data-item]')?.dataset.item;
    canvas.highlight(item ? elementsOf(item) : []);
  });
  box2?.addEventListener("mouseleave", () => canvas.highlight([]));
}

/** Direct children of an entity: sub-entities first, then its own shapes. */
function contents(g) {
  const doc = app.doc;
  return [...(doc.groups || []).filter(c => c.parent === g.id).map(c => c.id),
          ...doc.elements.filter(e => e.group === g.id).map(e => e.id)];
}

function contentRow(item) {
  const doc = app.doc;
  const x = '<button class="icon-btn take-out" data-take-out title="Take it out of this entity">×</button>';
  if (item.startsWith('g-')) {
    const c = groupById(item);
    return `<div class="ent-item" data-item="${esc(item)}"><span class="ent-sw ent-sw-group">▣</span>
      <span class="ent-what"><b>${esc(c.name)}</b></span><span class="ent-dim">${descendants(item).length} shape${descendants(item).length === 1 ? '' : 's'}</span>${x}</div>`;
  }
  const e = doc.elements.find(el => el.id === item);
  const layer = doc.layers.find(l => l.name === e.layer);
  const a = e.attrs, n = (v) => fmt(+v || 0);
  const dim = e.tag === 'circle' ? `Ø${n(2 * a.r)}` : e.tag === 'rect' ? `${n(a.width)} × ${n(a.height)}`
    : e.tag === 'ellipse' ? `${n(2 * a.rx)} × ${n(2 * a.ry)}` : e.tag === 'line' ? `${n(Math.hypot(a.x2 - a.x1, a.y2 - a.y1))} long`
    : e.tag === 'text' ? `“${esc((e.text || '').slice(0, 18))}”` : '';
  return `<div class="ent-item" data-item="${esc(item)}"><span class="ent-sw" style="background:${esc(layer?.color || '#999')}"></span>
    <span class="ent-what">${e.name ? `<b>${esc(e.name)}</b>` : esc(e.tag)}</span><span class="ent-dim">${dim}</span>
    <span class="ent-layer">${esc(e.layer)}</span>${x}</div>`;
}
