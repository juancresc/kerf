// User actions shared by the menus, toolbar, keyboard shortcuts and panels.

import { app, emit, setSelection, selectedElements, elementById, selectedItems, selectItems, elementsOf,
         groupById, setContext, setTabView } from './state.js';
import { api } from './api.js';
import { modal, confirmDialog, toast, esc, download, pickFile, fmt, copyText } from './ui.js';
import { moveAttrs, docToPng } from './geometry.js';
import * as canvas from './canvas.js';
import { PRESETS as MATERIAL_PRESETS } from './materials.js';

// Files saved to / opened from the user's computer (File System Access API), per tab
const localHandles = new Map();

// ── Unsaved changes ────────────────────────────────────────

async function askSave(name, verb) {
  return modal({
    title: `Save changes to “${name}”?`,
    html: `<p>Your changes will be lost if you ${verb} without saving.</p>`,
    buttons: [
      { label: "Don't save", value: 'discard', kind: 'danger', left: true },
      { label: 'Cancel', value: null },
      { label: 'Save', value: 'save', kind: 'primary' },
    ],
  });
}

// ── Tabs ───────────────────────────────────────────────────

export async function closeTab(tabId = app.server.active) {
  delete app.tabViews[tabId];
  const tab = app.server.tabs.find(t => t.id === tabId);
  if (!tab) return;
  let discard = false;
  if (tab.dirty) {
    if (tabId !== app.server.active) await api.activate(tabId);
    const choice = await askSave(tab.name, 'close it');
    if (choice === null) return;
    if (choice === 'save' && !(await save())) return;
    discard = choice === 'discard';
  }
  localHandles.delete(tabId);
  await api.close(tabId, discard);
}

/** Show a document tab; `view` switches between its Drawing (2d) and 3D views. */
export async function switchTab(tabId, view) {
  if (view) setTabView(tabId, view);
  app.view = app.tabViews[tabId] || '2d';
  if (tabId !== app.server.active) await api.activate(tabId);
  emit('view-mode');
}

/** Open a data-folder file from a share link; a missing file just shows a message. */
export async function openShared(file, view) {
  const s = await api.open(file);
  if (!s) return;                           // api already showed the error (e.g. not found)
  if (view === '3d' || view === '2d') {
    setTabView(s.active, view);
    app.view = view;
    emit('view-mode');
  }
}

const shareUrl = (file, view) => `${location.origin}/?open=${file.split('/').map(encodeURIComponent).join('/')}${view === '3d' ? '&view=3d' : ''}`;

/** Copy a reference to a tab (and the selection) to paste into Claude. Saved tabs: their link —
 *  open_document accepts it and switches to the tab (paths are stable, tab ids aren't).
 *  Unsaved tabs: the tab id. No access token: Claude's MCP connection has its own. */
export async function copyTabRef(tabId = app.server.active) {
  const t = app.server.tabs.find(x => x.id === tabId);
  if (!t) return;
  let text = t.file
    ? `Kerf "${t.name}": ${shareUrl(t.file, app.tabViews[t.id])} (open_document with this link or "${t.file}")`
    : `Kerf tab ${t.id} "${t.name}" (not saved yet): switch_tab("${t.id}")`;
  if (tabId === app.server.active && app.selection.size) {
    const items = selectedItems().map(it => it.startsWith('g-') ? `entity "${groupById(it)?.name}" (${it})` : it);
    if (items.length) text += `. Selected: ${items.join(', ')}`;
  }
  if (await copyText(text)) toast('Copied — paste it into Claude', 'ok');
  else await modal({ title: 'Tab reference', html: `<input class="field" readonly value="${esc(text)}" style="width:100%">`,
                     setup: (form) => { const i = form.querySelector('input'); i.focus(); i.select(); } });
}

/** Copy a link that opens this project (and the current 2D/3D view) for whoever has the editor. */
export async function copyShareLink() {
  const file = app.server.file;
  if (!file) return toast('Save it to the data folder first (File → Save As) — links open saved projects', 'error');
  // Deployed with a token: put it in the link so whoever opens it is signed in straight away
  let token = null;
  try { token = (await (await fetch('/api/connect')).json()).token; } catch (_) { /* local: no token */ }
  const url = `${location.origin}/?${token ? `token=${encodeURIComponent(token)}&` : ''}`
    + `open=${file.split('/').map(encodeURIComponent).join('/')}${app.view === '3d' ? '&view=3d' : ''}`;
  const note = token ? ' (includes the access token: anyone with it can edit)' : '';
  try {
    await navigator.clipboard.writeText(url);
    toast(`Link copied${note}`, 'ok');
  } catch (_) {
    await modal({ title: 'Link to this project',
                  html: `<input class="field" readonly value="${esc(url)}" style="width:100%">`
                    + (token ? '<p class="muted">Includes the access token: anyone with this link can edit.</p>' : ''),
                  setup: (form) => { const i = form.querySelector('input'); i.focus(); i.select(); } });
  }
}

export function open3d(tabId = app.server.active) {
  switchTab(tabId, '3d');
}

export function toggle3d() {
  const tab = app.server.active;
  switchTab(tab, (app.tabViews[tab] || '2d') === '3d' ? '2d' : '3d');
}

// ── File ───────────────────────────────────────────────────

const PRESETS = [
  ['Sheet 2440 × 1220', 2440, 1220], ['Sheet 2500 × 1250', 2500, 1250], ['Half sheet 1220 × 1220', 1220, 1220],
  ['1220 × 610', 1220, 610], ['A3 420 × 297', 420, 297], ['A4 297 × 210', 297, 210],
];
const UNIT_MM = { mm: 1, cm: 10, in: 25.4 };

function sizeFields(w, h) {
  return `<div class="kv">
      <label>Width</label><input name="w" type="number" class="field" step="any" min="0.1" value="${w}" required>
      <label>Height</label><input name="h" type="number" class="field" step="any" min="0.1" value="${h}" required>
      <label>Units</label><select name="unit" class="field"><option>mm</option><option>cm</option><option>in</option></select>
    </div>
    <div class="presets">${PRESETS.map(([n, pw, ph]) => `<button type="button" class="btn" data-w="${pw}" data-h="${ph}">${n}</button>`).join('')}</div>`;
}

function bindPresets(form) {
  form.querySelectorAll('.presets .btn').forEach(b => b.addEventListener('click', () => {
    form.w.value = b.dataset.w; form.h.value = b.dataset.h; form.unit.value = 'mm';
  }));
}

function readSize(form) {
  const k = UNIT_MM[form.unit.value];
  const w = +form.w.value * k, h = +form.h.value * k;
  if (!(w > 0 && h > 0)) { toast('Enter a width and height', 'error'); return null; }
  return { w: Math.round(w * 1000) / 1000, h: Math.round(h * 1000) / 1000 };
}

export async function newDocument() {
  let size = null;
  const ok = await modal({
    title: 'New document',
    html: sizeFields(2440, 1220) + `<div class="kv" style="margin-top:10px"><label>Material</label>
        <select name="material" class="field">${MATERIAL_PRESETS.map((p, i) => `<option value="${i}">${esc(p.name)} mm</option>`).join('')}</select></div>
      <p class="hint" style="margin-top:10px">Opens in a new tab. 1 unit = 1 mm, with the default CNC layers. Material, thickness and sheet size can be changed later in the Inspector.</p>`,
    buttons: [{ label: 'Cancel', value: false }, { label: 'Create', value: true, kind: 'primary' }],
    setup: bindPresets,
    onSubmit: (form) => { size = readSize(form); if (size) size.material = MATERIAL_PRESETS[+form.material.value]; return !!size; },
  });
  if (!ok) return;
  if (await api.newDoc(size.w, size.h)) {
    const p = size.material;
    await api.ops([{ op: 'set_material', material: { name: p.name.replace(/ \d+.*$/, ''), type: p.type, thickness: p.thickness,
      color: p.color, sheet_width: size.w, sheet_height: size.h } }], 'Material');
    afterSwitch();
  }
}

function afterSwitch() {
  setSelection([]);
  setContext(null);
  app.view = app.tabViews[app.server.active] || '2d';
  emit('view-mode');
  requestAnimationFrame(canvas.zoomFit);
}

/**
 * File browser over the data folder. mode 'open' | 'save'. Resolves with
 * {file} (a data-folder path), {computer: true}, or null.
 */
async function browseDialog(mode, { suggestion = '', folder = '' } = {}) {
  let result = null;
  const state = { folder, selected: null };
  const title = mode === 'open' ? 'Open' : 'Save As';
  const render = async (root) => {
    let listing;
    try { listing = await api.browse(state.folder); } catch (e) { toast(e.message, 'error'); return; }
    state.folder = listing.folder;
    const parts = state.folder ? state.folder.split('/') : [];
    root.querySelector('.fb-crumbs').innerHTML = `<button type="button" data-folder="">data</button>` +
      parts.map((p, i) => `<span>/</span><button type="button" data-folder="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</button>`).join('');
    const rows = [
      ...(state.folder ? [`<button type="button" class="file-item" data-folder="${esc(parts.slice(0, -1).join('/'))}"><span class="ico">↰</span><span>..</span></button>`] : []),
      ...listing.dirs.map(d => `<button type="button" class="file-item" data-folder="${esc(d.path)}"><span class="ico">📁</span><span>${esc(d.name)}</span></button>`),
      ...listing.files.filter(f => mode === 'open' || (f.kind === 'kerf' || f.kind === 'svgcnc')).map(f => `<button type="button" class="file-item" data-file="${esc(f.file)}"><span class="ico" title="${f.kind}">${{ kerf: '📐', svgcnc: '📐', svg: '🖼', dxf: '📏' }[f.kind] || '📄'}</span><span>${esc(f.name)}</span>
        ${app.server.tabs.some(t => t.file === f.file) ? '<span class="current">open</span>' : ''}
        <span class="meta">${new Date(f.modified * 1000).toLocaleString()} · ${fmt(f.size / 1024, 1)} KB</span></button>`),
    ];
    root.querySelector('.file-list').innerHTML = rows.join('') || '<p class="muted" style="padding:10px">Empty folder</p>';
  };
  const choice = await modal({
    title,
    html: `<div class="fb-bar"><div class="fb-crumbs"></div>
        ${mode === 'save' ? '<button type="button" class="btn" data-mkdir>New folder</button>' : ''}</div>
      <div class="file-list"></div>
      ${mode === 'save' ? `<div class="fb-name"><label>File name</label><input name="name" class="field" value="${esc(suggestion)}"></div>` : ''}
      <p class="hint" style="margin-top:8px">${mode === 'save'
        ? 'Saved as a Kerf project (.kerf): layers, entities, 3D placements, material. SVG/DXF are in Export. “Download” saves a copy to your browser’s downloads folder.'
        : '📐 projects (.kerf) · 🖼 SVG and 📏 DXF open as new documents. “Open from computer…” opens files from anywhere on your machine.'}</p>`,
    buttons: [{ label: mode === 'save' ? 'Download .kerf' : 'Open from computer…', value: 'computer', left: true },
      { label: 'Cancel', value: null }, { label: mode === 'save' ? 'Save' : 'Open', value: 'ok', kind: 'primary' }],
    setup: (form, close) => {
      form.closest('dialog').classList.add('wide');
      render(form);
      form.addEventListener('click', async (e) => {
        const fbtn = e.target.closest('[data-folder]');
        if (fbtn) { state.folder = fbtn.dataset.folder; state.selected = null; await render(form); return; }
        const file = e.target.closest('[data-file]');
        if (file) {
          form.querySelectorAll('.file-item').forEach(x => x.classList.remove('selected'));
          file.classList.add('selected');
          state.selected = file.dataset.file;
          if (mode === 'save') form.name.value = file.dataset.file.split('/').pop().replace(/\.(kerf|svgcnc|svg|dxf)$/, '');
        }
        if (e.target.closest('[data-mkdir]')) {
          const name = prompt('New folder name');
          if (name && name.trim()) {
            const f = [state.folder, name.trim()].filter(Boolean).join('/');
            if (await api.mkdir(f)) { state.folder = f; await render(form); }
          }
        }
      });
      form.addEventListener('dblclick', (e) => {
        const file = e.target.closest('[data-file]');
        if (file && mode === 'open') { state.selected = file.dataset.file; close('ok'); }
      });
    },
    onSubmit: (form) => {
      if (mode === 'open') { if (!state.selected) { toast('Pick a file'); return false; } return; }
      const name = form.name.value.trim();
      if (!name) return false;
      result = [state.folder, name].filter(Boolean).join('/');
    },
  });
  if (choice === 'computer') return { computer: true };
  if (choice !== 'ok') return null;
  return { file: mode === 'open' ? state.selected : result };
}

export async function openDocument() {
  const r = await browseDialog('open');
  if (!r) return;
  if (r.computer) return openFromComputer();
  if (await api.open(r.file)) { afterSwitch(); toast(`Opened ${r.file}`, 'ok'); }
}

export async function openFromComputer() {
  let file, handle = null;
  if (window.showOpenFilePicker) {
    try {
      [handle] = await window.showOpenFilePicker({ types: [{ description: 'Project, SVG or DXF', accept: {
        'application/json': ['.kerf', '.svgcnc'], 'image/svg+xml': ['.svg'], 'application/dxf': ['.dxf'] } }] });
      file = await handle.getFile();
    } catch (_) { return; }   // cancelled
  } else {
    file = await pickFile('.kerf,.svgcnc,.svg,.dxf,image/svg+xml');
    if (!file) return;
  }
  const name = file.name.replace(/\.(kerf|svgcnc|svg|dxf)$/i, '');
  const kind = (file.name.match(/\.(kerf|svgcnc|svg|dxf)$/i) || [, 'svg'])[1].toLowerCase().replace('svgcnc', 'kerf');
  const isDxf = kind === 'dxf';
  const s = kind === 'kerf' ? await api.importProject(await file.text(), { name })
    : isDxf ? await api.importDxf(await toBase64(file), { new_tab: true, name })
    : await api.importSvg(await file.text(), { new_tab: true, name });
  if (!s) return;
  if (handle && kind === 'kerf') {   // a project opened from disk can be saved back in place
    localHandles.set(s.active, handle);
    await api.savedLocal(file.name);
  }
  afterSwitch();
  toast(`Opened ${file.name}${isDxf ? ' (converted from DXF)' : ''}`, 'ok');
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1]);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

export async function save() {
  const tab = app.server.tabs.find(t => t.id === app.server.active);
  if (app.server.file) {
    const s = await api.save();
    if (s) toast(`Saved ${s.file}`, 'ok');
    return !!s;
  }
  const handle = localHandles.get(app.server.active);
  if (handle) return writeToHandle(handle);
  return saveAs(fileSafe(tab?.name));
}

/** A project name → something usable as a file name (the server allows letters, digits, space - _ . , ( )). */
const fileSafe = (name) => (name || '').replace(/[^\p{L}\p{N} \-_.,()]+/gu, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '') || 'untitled';

export async function saveAs(initial) {
  const suggestion = fileSafe(initial || (app.server.file ? app.server.file.split('/').pop().replace(/\.(kerf|svgcnc)$/, '') : app.server.name));
  const folder = app.server.file && app.server.file.includes('/') ? app.server.file.split('/').slice(0, -1).join('/') : '';
  const r = await browseDialog('save', { suggestion, folder });
  if (!r) return false;
  if (r.computer) return saveToComputer();
  const file = r.file.replace(/\.(kerf|svgcnc|svg)$/, '') + '.kerf';
  let exists = false;
  try { exists = (await api.files()).files.some(f => f.file === file); } catch (_) {}
  if (exists && file !== app.server.file &&
      !await confirmDialog('Replace file?', `“${file}” already exists. Replace it?`, 'Replace', true)) {
    return saveAs(r.file.split('/').pop());
  }
  const s = await api.save(r.file);
  if (s) { localHandles.delete(app.server.active); toast(`Saved ${s.file}`, 'ok'); }
  return !!s;
}

async function writeToHandle(handle) {
  try {
    const svg = await api.exportText('project');
    const w = await handle.createWritable();
    await w.write(svg);
    await w.close();
    await api.savedLocal(handle.name);
    toast(`Saved ${handle.name} on your computer`, 'ok');
    return true;
  } catch (e) {
    toast(`Could not save: ${e.message}`, 'error');
    return false;
  }
}

/** Save to computer = a plain download of the .kerf (the browser puts it in its downloads folder). */
export async function saveToComputer() {
  const name = `${fileSafe(app.server.name)}.kerf`;
  const svg = await api.exportText('project');
  download(new Blob([svg], { type: 'application/json' }), name);
  await api.savedLocal(name);
  toast('Downloaded — your browser saves it to its downloads folder');
  return true;
}

export async function revert() {
  if (!app.server.file) return toast('This document has never been saved to the data folder', 'error');
  if (!await confirmDialog('Revert to saved?', `Reload “${app.server.file}” from disk? Your unsaved changes can still be undone afterwards.`, 'Revert')) return;
  await api.revert();
}

// ── Import ─────────────────────────────────────────────────

export async function importSvg() {
  const file = await pickFile('.svg,image/svg+xml');
  if (!file) return;
  const s = await api.importSvg(await file.text(), { layer: app.activeLayer });
  if (s) toast(`Imported ${s.result} element(s) from ${file.name}`, 'ok');
}

export async function importDxf(intoDocument = false) {
  const file = await pickFile('.dxf');
  if (!file) return;
  const name = file.name.replace(/\.dxf$/i, '');
  const s = await api.importDxf(await toBase64(file), { new_tab: !intoDocument, name, layer: app.activeLayer });
  if (!s) return;
  if (!intoDocument) afterSwitch();
  toast(`Imported ${s.result} element(s) from ${file.name}`, 'ok');
}

// ── Export ─────────────────────────────────────────────────

function exportNote() {
  const skipped = app.doc.layers.filter(l => !l.export).map(l => l.name);
  return `mm units${skipped.length ? `, without ${skipped.join(', ')}` : ''}`;
}

export function exportCnc() {
  window.location.href = '/api/export/cnc';
  toast(`CNC SVG: ${exportNote()}`);
}

export function exportDxf() {
  window.location.href = '/api/export/cnc-dxf';
  toast(`CNC DXF: ${exportNote()}`);
}

export async function exportParts() {
  const tops = (app.doc.groups || []).filter(g => !g.parent);
  if (!tops.length) {
    return modal({ title: 'No entities yet', html: '<p>Part files are made per entity. Select the shapes of one part (outline + holes) and press <b>⌘G</b> to group them, set the quantity in the inspector, then export again.</p>' });
  }
  window.location.href = '/api/export/parts';
  toast(`Parts: ${tops.map(g => `${g.name} ×${g.qty}`).join(', ')} — SVG + DXF each`);
}

export function downloadSvg() {
  window.location.href = '/api/export/file';
}

export async function export3d(format) {
  const { exportModel } = await import('./preview3d.js');
  const ok = await exportModel(format);
  if (ok) toast(format === 'png' ? '3D view saved as PNG' : `3D model exported as ${format.toUpperCase()}`, 'ok');
}

export async function exportPng() {
  const c = await docToPng(app.doc);
  c.toBlob(b => download(b, `${app.server.name}.png`), 'image/png');
}

/** The project's name (shown on its tab, saved inside the file) — separate from the file name. */
export async function renameProject() {
  const s = app.server;
  const tab = s.tabs.find(t => t.id === s.active);
  const fileName = s.file ? s.file.split('/').pop() : (tab?.local_name || 'not saved yet');
  let title = null;
  const ok = await modal({
    title: 'Rename project',
    html: `<div class="kv"><label>Project name</label><input name="title" class="field" value="${esc(tab?.title || '')}" placeholder="${esc(s.name)}"></div>
      <p class="hint" style="margin-top:8px">Shown on the tab and saved in the project. The file (${esc(fileName)}) keeps its name;
      use Save As to change that. Leave empty to show the file name.</p>`,
    buttons: [{ label: 'Cancel', value: false }, { label: 'Rename', value: true, kind: 'primary' }],
    onSubmit: (form) => { title = form.title.value.trim(); },
  });
  if (ok && title !== (tab?.title || '')) await api.ops([{ op: 'set_title', title }], 'Rename project');
}

export async function materialDialog() {
  const m = app.doc.material || {};
  let v = null;
  const TYPES = ['plywood', 'wood', 'board', 'plastic', 'metal', 'foam', 'other'];
  const ok = await modal({
    title: 'Material & stock',
    html: `<div class="kv">
      <label>Preset</label><select name="preset" class="field"><option value="">— keep current —</option>${MATERIAL_PRESETS.map((p, i) =>
        `<option value="${i}">${esc(p.name)} mm</option>`).join('')}</select>
      <label>Material</label><input name="name" class="field" value="${esc(m.name || '')}">
      <label>Type</label><select name="type" class="field">${TYPES.map(t => `<option ${t === m.type ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <label>Thickness</label><input name="thickness" type="number" step="any" min="0.1" class="field" value="${m.thickness ?? 18}">
      <label>Colour (3D)</label><input name="color" type="color" value="${esc(m.color || '#e3c592')}" style="width:60px;height:28px">
      <label>Sheet (mm)</label><div class="pair"><input name="sheet_width" type="number" step="any" class="field" value="${m.sheet_width ?? 2440}">
        <input name="sheet_height" type="number" step="any" class="field" value="${m.sheet_height ?? 1220}"></div>
      <label>Tool Ø (mm)</label><input name="tool_diameter" type="number" step="any" class="field" value="${m.tool_diameter ?? 6}">
      <label>Notes</label><textarea name="notes" class="field" placeholder="Supplier, grain direction, feeds…">${esc(m.notes || '')}</textarea>
    </div>
    <p class="hint" style="margin-top:8px">Saved in the project. Thickness and colour are used by the 3D preview; sheet size and tool Ø by the CNC checks.</p>`,
    buttons: [{ label: 'Cancel', value: false }, { label: 'Apply', value: true, kind: 'primary' }],
    setup: (form) => form.preset.addEventListener('change', () => {
      const p = MATERIAL_PRESETS[+form.preset.value];
      if (!p) return;
      form.name.value = p.name.replace(/ \d+.*$/, ''); form.type.value = p.type;
      form.thickness.value = p.thickness; form.color.value = p.color;
    }),
    onSubmit: (form) => {
      v = { name: form.name.value.trim(), type: form.type.value, thickness: +form.thickness.value, color: form.color.value,
            sheet_width: +form.sheet_width.value, sheet_height: +form.sheet_height.value,
            tool_diameter: +form.tool_diameter.value, notes: form.notes.value };
      return v.thickness > 0;
    },
  });
  if (ok) await api.ops([{ op: 'set_material', material: v }], 'Material');
}

export async function documentSize() {
  let size = null;
  const ok = await modal({
    title: 'Document size',
    html: sizeFields(app.doc.width, app.doc.height),
    buttons: [{ label: 'Cancel', value: false }, { label: 'Apply', value: true, kind: 'primary' }],
    setup: bindPresets,
    onSubmit: (form) => !!(size = readSize(form)),
  });
  if (ok) await api.ops([{ op: 'set_size', width: size.w, height: size.h }]);
}

export async function setBackground() {
  const file = await pickFile('image/*');
  if (!file) return;
  const href = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
  await api.ops([{ op: 'set_background', href, opacity: 0.3 }], 'Background image');
}

export const removeBackground = () => api.ops([{ op: 'set_background', href: null }], 'Remove background');

// ── Edit ───────────────────────────────────────────────────

export const undo = () => api.undo();
export const redo = () => api.redo();

function usableLayers() {
  return new Set(app.doc.layers.filter(l => l.visible && !l.locked).map(l => l.name));
}

function editableSelection() {
  const usable = usableLayers();
  return selectedElements().filter(e => usable.has(e.layer)).map(e => e.id);
}

export async function deleteSelection() {
  const ids = editableSelection();
  if (!ids.length) return;
  if (await api.ops([{ op: 'remove_elements', ids }], ids.length > 1 ? `Delete ${ids.length} elements` : 'Delete'))
    setSelection([]);
}

/** Duplicate the selection; a selected entity is copied as a new entity (one level). */
export async function duplicate() {
  const d = app.grid || 10;
  const usable = usableLayers();
  const items = selectedItems();
  if (!items.length) return;
  const ops = [], groupOps = [];
  for (const it of items) {
    const idx = [];
    for (const id of elementsOf(it)) {
      const e = elementById(id);
      if (!usable.has(e.layer)) continue;
      idx.push(ops.length);
      ops.push({ op: 'add_element', tag: e.tag, layer: e.layer, text: e.text, name: e.name || undefined, group: app.context || undefined,
                 attrs: { ...e.attrs, ...moveAttrs(e, d, d) } });
    }
    if (it.startsWith('g-') && idx.length)
      groupOps.push({ op: 'group', items: idx.map(i => '$' + i), name: `${groupById(it)?.name || 'Entity'} copy`, parent: app.context });
  }
  if (!ops.length) return;
  const n = ops.length;
  const s = await api.ops([...ops, ...groupOps], 'Duplicate');     // one undo step
  if (!s?.results) return;
  const grouped = new Set(groupOps.flatMap(g => g.items.map(x => +x.slice(1))));
  selectItems([...s.results.slice(n), ...s.results.slice(0, n).filter((_, i) => !grouped.has(i))]);
}

export function selectAll() {
  const usable = usableLayers();
  const inScope = app.context ? new Set(elementsOf(app.context)) : null;
  setSelection(app.doc.elements.filter(e => usable.has(e.layer) && (!inScope || inScope.has(e.id))).map(e => e.id));
}

export async function nudge(dx, dy) {
  const ids = editableSelection();
  if (!ids.length) return;
  await api.ops([{ op: 'move', items: ids, dx, dy, coalesce: 'nudge' }], 'Nudge');
}

export async function reorder(where) {
  const ids = editableSelection();
  const order = where === 'front' ? ids : [...ids].reverse();
  if (ids.length) await api.ops(order.map(id => ({ op: 'reorder_element', id, where })), where === 'front' ? 'Bring to front' : 'Send to back');
}

export async function moveSelectionToLayer(layer) {
  const ids = [...app.selection];
  if (ids.length) await api.ops(ids.map(id => ({ op: 'update_element', id, layer })), `Move to ${layer}`);
}

export async function clearAll() {
  const n = app.doc.elements.length;
  if (!n) return toast('Nothing to clear');
  if (!await confirmDialog('Clear all elements?', `This removes all ${n} elements and entities from every layer. You can undo it (⌘Z).`, 'Clear all', true)) return;
  if (await api.ops([{ op: 'clear' }], 'Clear all')) { setSelection([]); setContext(null); }
}

// ── Entities (groups) ──────────────────────────────────────

export async function group() {
  const items = selectedItems();
  if (!items.length) return toast('Select the shapes of one part first');
  if (items.length === 1 && items[0].startsWith('g-')) return toast('That is already one entity');
  let name = null;
  const ok = await modal({
    title: 'Group into entity',
    html: `<div class="kv"><label>Name</label><input name="name" class="field" value="Part ${(app.doc.groups || []).length + 1}"></div>
      <p class="hint" style="margin-top:8px">An entity is one part (e.g. outline + holes, even on different layers). Entities are exported as separate part files and placed in the 3D preview.</p>`,
    buttons: [{ label: 'Cancel', value: false }, { label: 'Group', value: true, kind: 'primary' }],
    onSubmit: (form) => !!(name = form.name.value.trim()),
  });
  if (!ok) return;
  const s = await api.ops([{ op: 'group', items, name, parent: app.context }], 'Group');
  if (s?.results) selectItems([s.results[0]]);
}

export async function ungroup() {
  const items = selectedItems().filter(it => it.startsWith('g-'));
  if (!items.length) return toast('Select an entity to ungroup');
  const els = items.flatMap(elementsOf);
  await api.ops(items.map(id => ({ op: 'ungroup', id })), 'Ungroup');
  setSelection(els);
}

/** Put the selected shapes/entities into an entity. With one entity + other things selected, the
 *  others go into that entity; otherwise pick the entity from a list. */
export async function addToEntity(target = null) {
  let items = selectedItems();
  if (!items.length) return toast('Select the shapes (or entities) to add first');
  const groups = app.doc.groups || [];
  const selGroups = items.filter(i => i.startsWith('g-'));
  if (!target && selGroups.length === 1 && items.length > 1) {
    target = selGroups[0];
    items = items.filter(i => i !== target);
  }
  if (!target) {
    // an entity can't go into itself or anything inside it
    const blocked = new Set(selGroups);
    let grew = true;
    while (grew) {
      grew = false;
      for (const g of groups) if (g.parent && blocked.has(g.parent) && !blocked.has(g.id)) { blocked.add(g.id); grew = true; }
    }
    const depth = (g) => { let n = 0; while (g.parent) { g = groupById(g.parent); n++; } return n; };
    const order = [];
    const walk = (parent) => groups.filter(g => (g.parent || null) === parent).forEach(g => { order.push(g); walk(g.id); });
    walk(null);
    const choices = order.filter(g => !blocked.has(g.id));
    if (!choices.length) return toast('No entity to add to yet — group some shapes first (⌘G)');
    const ok = await modal({
      title: `Add ${items.length === 1 ? 'it' : `${items.length} items`} to an entity`,
      html: `<div class="kv"><label>Entity</label><select name="target" class="field">${choices.map(g =>
        `<option value="${esc(g.id)}">${'\u00a0\u00a0'.repeat(depth(g))}${esc(g.name)}</option>`).join('')}</select></div>
        <p class="hint" style="margin-top:8px">Tip: select an entity together with loose shapes (Shift-click) and the shapes go straight into it.
        You can also drag entities onto each other in the Entities panel.</p>`,
      buttons: [{ label: 'Cancel', value: false }, { label: 'Add', value: true, kind: 'primary' }],
      onSubmit: (form) => { target = form.target.value; },
    });
    if (!ok || !target) return;
  }
  const s = await api.ops([{ op: 'set_group', items, group: target }], 'Add to entity');
  if (!s) return;
  setContext(groupById(target)?.parent || null);
  canvas.render();
  selectItems([target]);
  toast(`Added to “${groupById(target)?.name}”`, 'ok');
}

/** Take the selected shapes/entities out of the entity they're in (one level up). */
export async function removeFromEntity() {
  const items = selectedItems();
  if (!items.length) return toast('Select what to take out first');
  const from = app.context ? groupById(app.context) : null;
  if (!from) return toast('These aren’t inside an entity. Double-click an entity to go inside, then select shapes to take out.');
  const els = items.flatMap(elementsOf);
  const up = from.parent || null;
  const s = await api.ops([{ op: 'set_group', items, group: up }], 'Remove from entity');
  if (!s) return;
  setContext(up && groupById(up) ? up : null);
  canvas.render();
  setSelection(els);
  toast(`Taken out of “${from.name}”`, 'ok');
}

export function enterGroup() {
  const it = selectedItems().find(i => i.startsWith('g-'));
  if (it) canvas.enterGroup(it);
  else toast('Select an entity, then Enter (or double-click it)');
}

// ── Measure → dimension on NOTES ───────────────────────────

export async function addDimension() {
  const m = canvas.currentMeasure();
  if (!m) return toast('Measure something first (M, then drag)');
  const layer = app.doc.layers.find(l => l.name === 'NOTES') || app.doc.layers.find(l => !l.export) || app.doc.layers[0];
  const { a, b } = m;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len, nx = -uy, ny = ux;
  const t = 4, size = Math.max(4, Math.min(20, len / 12));
  const r = v => Math.round(v * 1000) / 1000;
  const ops = [
    { op: 'add_element', tag: 'line', layer: layer.name, attrs: { x1: r(a.x), y1: r(a.y), x2: r(b.x), y2: r(b.y) } },
    { op: 'add_element', tag: 'line', layer: layer.name, attrs: { x1: r(a.x - nx * t), y1: r(a.y - ny * t), x2: r(a.x + nx * t), y2: r(a.y + ny * t) } },
    { op: 'add_element', tag: 'line', layer: layer.name, attrs: { x1: r(b.x - nx * t), y1: r(b.y - ny * t), x2: r(b.x + nx * t), y2: r(b.y + ny * t) } },
    { op: 'add_element', tag: 'text', layer: layer.name, text: fmt(len),
      attrs: { x: r((a.x + b.x) / 2 - nx * (size * 0.6)), y: r((a.y + b.y) / 2 - ny * (size * 0.6)), 'font-size': r(size),
               'font-family': 'sans-serif', 'text-anchor': 'middle',
               ...(Math.abs(Math.atan2(uy, ux)) > 1e-3 ? { transform: `rotate(${r(normAngle(Math.atan2(uy, ux) * 180 / Math.PI))} ${r((a.x + b.x) / 2)} ${r((a.y + b.y) / 2)})` } : {}) } },
  ];
  ops.push({ op: 'group', items: ops.map((_, i) => '$' + i), name: `Dimension ${fmt(len)}` });
  const s = await api.ops(ops, 'Add dimension');                     // one undo step
  if (!s?.results) return;
  canvas.clearMeasure();
  toast(`Dimension ${fmt(len)} mm added to ${layer.name}`, 'ok');
}

const normAngle = a => (a > 90 ? a - 180 : a < -90 ? a + 180 : a);
