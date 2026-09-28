// 3D preview (three.js): each entity is extruded from its outline (CUT_OUTSIDE) with its
// cut-outs (CUT_INSIDE) as holes, then placed with its `assembly` (matrix → thickness →
// rotation → position). Document params become sliders that move parts ("move").
// Entities without an assembly are laid flat where they are on the sheet.

import { app, on, descendants, selectItems, setContext } from './state.js';
import { renderAttrs } from './geometry.js';
import { esc, toast, download } from './ui.js';
import { partMaterials, faceEdgeUV } from './textures.js';

const host = document.getElementById('view3d-canvas');
const panel = document.getElementById('view3d-panel');

let THREE, OrbitControls, SVGLoader, GLTFExporter, STLExporter, mergeGeometries;
let renderer, scene, camera, controls, partsRoot;
let parts = [];              // {mesh, base: Vector3, move}
let built = null;            // doc version the scene was built from
const values = {};           // current param values
let explode = 0;             // 0 = assembled … 1 = fully exploded (assembly view)
let navMode = 'rotate';      // left-drag: 'rotate' or 'move' (pan)
let seeThrough = false;      // semi-transparent parts to see hidden pockets, pins, joints
let textured = (() => { try { return localStorage.getItem('kerf.p3Textures') !== '0'; } catch (_) { return true; } })();

const mats = mesh => Array.isArray(mesh.material) ? mesh.material : [mesh.material];

function applySeeThrough() {
  for (const p of parts) {
    for (const m of mats(p.mesh)) {
      m.transparent = seeThrough || !!m.transmission;     // clear acrylic stays transparent
      m.opacity = seeThrough ? 0.35 : 1;
      m.depthWrite = !seeThrough;
      m.needsUpdate = true;
    }
  }
}

function setNavMode(mode) {
  navMode = mode;
  if (!controls) return;
  const { ROTATE, PAN, DOLLY } = THREE.MOUSE;
  controls.mouseButtons = mode === 'move'
    ? { LEFT: PAN, MIDDLE: DOLLY, RIGHT: ROTATE }
    : { LEFT: ROTATE, MIDDLE: DOLLY, RIGHT: PAN };
  panel.querySelectorAll('[data-nav]').forEach(b => b.classList.toggle('on', b.dataset.nav === mode));
}

async function loadThree() {
  if (THREE) return true;
  try {
    THREE = await import('three');
    ({ OrbitControls } = await import('three/addons/controls/OrbitControls.js'));
    ({ SVGLoader } = await import('three/addons/loaders/SVGLoader.js'));
    ({ GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js'));
    ({ STLExporter } = await import('three/addons/exporters/STLExporter.js'));
    ({ mergeGeometries } = await import('three/addons/utils/BufferGeometryUtils.js'));
    return true;
  } catch (e) {
    panel.innerHTML = `<h3>3D preview</h3><p class="note">Couldn't load three.js from cdn.jsdelivr.net (${esc(e.message)}). The 3D preview needs internet access the first time.</p>`;
    return false;
  }
}

function setup() {
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(devicePixelRatio);
  host.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  scene.background = new THREE.Color('#eef0f3');
  camera = new THREE.PerspectiveCamera(40, 1, 5, 50000);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.screenSpacePanning = true;       // pan moves the view up/down/sideways, like a CAD viewer
  controls.zoomToCursor = true;             // scroll zooms toward the pointer
  // Arrow keys pan — but OrbitControls swallows them wherever they're pressed, so it only gets
  // copies of the keys pressed while the 3D view is showing and nobody is typing or in a dialog
  const keyProxy = new EventTarget();
  controls.listenToKeyEvents(keyProxy);
  window.addEventListener('keydown', (e) => {
    if (document.getElementById('view3d').hidden || document.querySelector('dialog[open]')) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    const copy = new KeyboardEvent('keydown', { key: e.key, code: e.code, shiftKey: e.shiftKey,
                                                ctrlKey: e.ctrlKey, metaKey: e.metaKey, cancelable: true });
    keyProxy.dispatchEvent(copy);
    if (copy.defaultPrevented) e.preventDefault();
  });
  controls.keyPanSpeed = 25;
  setNavMode(navMode);
  scene.add(new THREE.HemisphereLight('#ffffff', '#b9b2a4', 1.1));
  const sun = new THREE.DirectionalLight('#ffffff', 1.4);
  sun.position.set(1500, 2500, 2000);
  scene.add(sun);
  const fill = new THREE.DirectionalLight('#ffffff', 0.4);
  fill.position.set(-2000, 800, -1500);
  scene.add(fill);
  partsRoot = new THREE.Group();
  scene.add(partsRoot);
  new ResizeObserver(resize).observe(host);
  const loop = () => {
    requestAnimationFrame(loop);
    if (!document.getElementById('view3d').hidden) { controls.update(); renderer.render(scene, camera); }
  };
  loop();
}

function resize() {
  if (!renderer) return;
  const w = host.clientWidth, h = host.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// ── Building parts from the document ───────────────────────

const escA = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
function elementShapes(doc, el) {
  const layer = doc.layers.find(l => l.name === el.layer) || { color: '#000', line_style: 'solid' };
  const a = Object.entries(renderAttrs(el, layer)).map(([k, v]) => `${k}="${escA(v)}"`).join(' ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><${el.tag} ${a}/></svg>`;
  const data = new SVGLoader().parse(svg);
  const shapes = [];
  for (const p of data.paths) shapes.push(...SVGLoader.createShapes(p));
  // Open shapes (lines) can't be extruded
  return shapes.filter(s => s.getPoints().length > 2);
}

function inside(pt, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < a.x + (pt.y - a.y) * (b.x - a.x) / (b.y - a.y)) c = !c;
  }
  return c;
}

/** {outers: Shape[], pockets: [{depth, shapes}]} — pockets are layers with a depth. */
function partGeometry(doc, elementIds) {
  // Cut layers make the part; an entity with nothing to cut (e.g. HARDWARE) uses its other shapes
  const depthOf = new Map(doc.layers.map(l => [l.name, l.depth || null]));
  const pocketEls = doc.elements.filter(e => elementIds.has(e.id) && depthOf.get(e.layer));
  const cutLayers = new Set(doc.layers.filter(l => l.export && !l.depth).map(l => l.name));
  let els = doc.elements.filter(e => elementIds.has(e.id) && cutLayers.has(e.layer));
  if (!els.length) els = doc.elements.filter(e => elementIds.has(e.id) && e.layer !== 'NOTES' && e.tag !== 'text');
  const outerLayer = els.some(e => e.layer === 'CUT_OUTSIDE') ? 'CUT_OUTSIDE' : null;
  let outers = [], holes = [];
  for (const e of els) {
    const shapes = elementShapes(doc, e);
    if (outerLayer ? e.layer === outerLayer : true) outers.push(...shapes);
    else holes.push(...shapes);
  }
  if (!outerLayer && outers.length) {       // no CUT_OUTSIDE: the biggest shape is the outline
    outers.sort((a, b) => area(b) - area(a));
    holes = outers.slice(1); outers = outers.slice(0, 1);
  }
  const outerPts = outers.map(s => s.getPoints());
  const holePaths = outers.map(() => []);
  for (const h of holes) {
    const hp = h.getPoints();
    const i = outerPts.findIndex(op => inside(hp[0], op));
    if (i >= 0) holePaths[i].push(new THREE.Path(hp));
  }
  const pockets = [];
  for (const e of pocketEls) {
    for (const sh of elementShapes(doc, e)) {
      const pp = sh.getPoints();
      const i = outerPts.findIndex(op => inside(pp[0], op));
      if (i >= 0) pockets.push({ i, depth: depthOf.get(e.layer), path: new THREE.Path(pp) });
    }
  }
  return { outers, holePaths, pockets };
}

/** Extrusion with pockets: split the thickness into slabs; a pocket removes material in its top slabs. */
function extrudePart(geo, thickness) {
  const { outers, holePaths, pockets } = geo;
  const cuts = [...new Set(pockets.map(p => Math.min(p.depth, thickness)))].sort((a, b) => a - b);
  const levels = [0, ...cuts.map(d => thickness - d).filter(z => z > 0).sort((a, b) => a - b), thickness];
  const parts = [];
  for (let k = 0; k < levels.length - 1; k++) {
    const z0 = levels[k], z1 = levels[k + 1];
    if (z1 - z0 < 1e-6) continue;
    const shapes = outers.map((o, i) => {
      const s = new THREE.Shape(o.getPoints());
      s.holes = [...holePaths[i], ...pockets.filter(p => p.i === i && thickness - p.depth <= z0 + 1e-6).map(p => p.path)];
      return s;
    });
    const g = new THREE.ExtrudeGeometry(shapes, { depth: z1 - z0, bevelEnabled: false, curveSegments: 24 });
    g.translate(0, 0, z0);
    parts.push(g);
  }
  return parts;
}

const area = s => Math.abs(THREE.ShapeUtils.area(s.getPoints()));

function flatAssembly() {
  // Lay flat where it is on the sheet: sheet (x, y) → world (x, 0, y)
  return { matrix: [1, 0, 0, -1, 0, 0], position: [0, 0, 0], rotation: [-90, 0, 0] };
}

let builtKey = null;
function contentKey(doc) {
  // What the 3D model depends on (not selection, visibility or the view)
  return JSON.stringify([doc.elements, doc.groups, doc.material, doc.params, doc.layers.map(l => [l.name, l.export, l.depth])]);
}

function disposeParts() {
  partsRoot.traverse(o => {
    o.geometry?.dispose?.();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose?.());
  });
  partsRoot.clear();
}

function buildScene() {
  const doc = app.doc;
  const key = contentKey(doc);
  built = app.server.version;
  if (key === builtKey && parts.length) { highlightSelection(); return; }
  builtKey = key;
  parts = [];
  disposeParts();
  const groups = doc.groups || [];
  const placed = groups.filter(g => g.assembly);
  const mode = placed.length ? 'assembly' : 'flat';
  let list;
  if (mode === 'assembly') {
    list = placed.map(g => ({ g, ids: new Set(descendants(g.id)), a: g.assembly }));
  } else {
    const tops = groups.filter(g => !g.parent);
    list = tops.map(g => ({ g, ids: new Set(descendants(g.id)), a: flatAssembly() }));
    const loose = new Set(doc.elements.filter(e => !e.group).map(e => e.id));
    if (loose.size) list.push({ g: { name: 'Loose shapes' }, ids: loose, a: flatAssembly() });
  }
  const mat = doc.material || {};
  let count = 0;
  for (const { g, ids, a } of list) {
    const pg = partGeometry(doc, ids);
    if (!pg.outers.length) continue;
    const thickness = a.thickness || mat.thickness || 18;
    const slabs = extrudePart(pg, thickness);
    let geo = slabs.length === 1 ? slabs[0] : mergeGeometries(slabs);
    const [ma, mb, mc, md, me, mf] = a.matrix || [1, 0, 0, 1, 0, 0];
    geo.applyMatrix4(new THREE.Matrix4().set(ma, mc, 0, me, mb, md, 0, mf, 0, 0, 1, 0, 0, 0, 0, 1));
    const raw = geo;
    geo = faceEdgeUV(THREE, raw);           // mm UVs; group 0 = faces, 1 = cut edges
    raw.dispose();
    const color = a.color || mat.color || '#e3c592';
    const mesh = new THREE.Mesh(geo, partMaterials(THREE, mat, color, thickness, textured));
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25),
                                         new THREE.LineBasicMaterial({ color: '#8a6a35', transparent: true, opacity: 0.55 }));
    mesh.add(edges);
    const r = (a.rotation || [0, 0, 0]).map(v => THREE.MathUtils.degToRad(v));
    mesh.rotation.set(r[0], r[1], r[2], 'XYZ');
    const base = new THREE.Vector3(...(a.position || [0, 0, 0]));
    mesh.position.copy(base);
    mesh.name = g.name;
    mesh.userData.name = g.name;
    mesh.userData.gid = g.id || null;
    mesh.userData.ids = ids;
    mesh.userData.material = { mat, color, thickness };
    partsRoot.add(mesh);
    parts.push({ mesh, base, move: a.move });
    count++;
  }
  computeExplodeDirections();
  applyParams();
  highlightSelection();
  applySeeThrough();
  renderPanel(mode, count);
  built = app.server.version;
}

let explodeScale = 0;

/** Each part moves away from the model's centre along the line through its own centre. */
function computeExplodeDirections() {
  for (const p of parts) p.mesh.position.copy(p.base);
  const all = new THREE.Box3().setFromObject(partsRoot);
  if (all.isEmpty()) return;
  const center = all.getCenter(new THREE.Vector3());
  explodeScale = all.getSize(new THREE.Vector3()).length() * 0.45;
  for (const p of parts) {
    const c = new THREE.Box3().setFromObject(p.mesh).getCenter(new THREE.Vector3());
    const d = c.sub(center);
    d.y *= 1.6;                                   // favour vertical separation (reads like a manual)
    p.explodeDir = d.lengthSq() > 1e-6 ? d.normalize() : new THREE.Vector3(0, 1, 0);
  }
}

function applyParams() {
  for (const p of parts) {
    const pos = p.base.clone();
    if (p.move && values[p.move.param] !== undefined) {
      const ax = p.move.axis || [0, 1, 0];
      pos.add(new THREE.Vector3(ax[0], ax[1], ax[2]).multiplyScalar(values[p.move.param]));
    }
    if (explode && p.explodeDir) pos.add(p.explodeDir.clone().multiplyScalar(explode * explodeScale));
    // Moving parts (the ones a slider drives) also lift off the fixed base as one assembly, so
    // mechanisms hidden between them — like a sawtooth on an inner face — come into view
    if (explode && p.move) pos.y += explode * explodeScale * 0.9;
    p.mesh.position.copy(pos);
  }
}

export function setExplode(v) {
  explode = Math.max(0, Math.min(1, v));
  if (parts.length) applyParams();
}

let panelCollapsed = (() => { try { return !!localStorage.getItem('kerf.p3Collapsed'); } catch (_) { return false; } })();

function renderPanel(mode, count) {
  const params = app.doc.params || [];
  for (const p of params) if (values[p.name] === undefined) values[p.name] = p.min ?? 0;
  const m = app.doc.material || {};
  const moving = parts.filter(p => p.move).length;
  panel.classList.toggle('collapsed', panelCollapsed);
  panel.innerHTML = `<h3 class="p3-head"><button class="p3-toggle" data-collapse title="${panelCollapsed ? 'Show' : 'Hide'} the panel">${panelCollapsed ? '▸' : '▾'}</button>
      <span class="p3-title" data-collapse>3D preview — ${esc(app.server.name)}</span>
      <button class="link-btn" data-edit="rename-project" title="Rename the project (not the file)">Rename</button></h3>
    <div class="p3-body">
    <div class="p3-line"><span>${mode === 'assembly' ? `${count} part(s), assembled` : `${count} piece(s) shown lying flat`}
      · ${esc(m.name || 'material')} ${m.thickness || 18} mm</span>
      <button class="link-btn" data-edit="material-dialog" title="Material, thickness and colour: every part is extruded to this thickness">Material…</button></div>
    ${params.map(p => `<div class="param" title="A slider of this project. Parts whose 3D placement “moves with” it slide along their axis. Only changes the preview, not the drawing."><label><span>${esc(p.label || p.name)}</span>
      <b data-val="${esc(p.name)}">${fmtParam(p, values[p.name])}</b></label>
      <input type="range" min="${p.min ?? 0}" max="${p.max ?? 100}" step="${p.step ?? 1}" value="${values[p.name]}" data-param="${esc(p.name)}"></div>`).join('')}
    ${params.length ? `<p class="note">${params.length > 1 ? 'Sliders move' : 'The slider moves'} ${moving} linked part(s) — preview only, the drawing is unchanged.</p>` : ''}
    <div class="row"><button class="btn" data-edit="edit-sliders" title="Add, rename or change the range of the sliders (Inspector → 3D sliders)">${params.length ? 'Edit sliders…' : 'Add a slider…'}</button></div>
    ${count > 1 ? `<div class="param" title="Pulls the parts apart, like an assembly manual. Parts that a slider moves also lift off the fixed base, so hidden joints show."><label><span>Assembly view (explode)</span><b data-val="__explode">${Math.round(explode * 100)}%</b></label>
      <input type="range" min="0" max="1" step="0.01" value="${explode}" data-explode></div>` : ''}
    <div class="row nav-row"><span class="seg"><button class="btn ${navMode === 'rotate' ? 'on' : ''}" data-nav="rotate" title="Left-drag rotates">Rotate</button><button
        class="btn ${navMode === 'move' ? 'on' : ''}" data-nav="move" title="Left-drag moves (pans) the view">Move</button></span>
      <button class="btn" data-fit>Reset view</button>
      <button class="btn ${seeThrough ? 'on' : ''}" data-see title="Semi-transparent parts: see pockets, pins and joints inside">See-through</button>
      <button class="btn ${textured ? 'on' : ''}" data-tex title="Wood grain, plywood plies and finishes from the material type (off: plain colour)">Textures</button></div>
    ${mode === 'flat' ? `<p class="note">No part has a 3D position yet, so everything is shown flat, as on the sheet, at the material thickness.
      To assemble: group each part (select its shapes → ⌘G), then “Place in 3D…” in the Inspector — or ask Claude to place them.</p>` : ''}
    <p class="note">${navMode === 'move' ? 'Drag: move' : 'Drag: rotate'} · Shift+drag or right-drag: ${navMode === 'move' ? 'rotate' : 'move'} · scroll: zoom to pointer ·
      arrows: move · double-click a part: centre on it</p>
    </div>`;
}

const fmtParam = (p, v) => `${+(v + (p.display_offset || 0)).toFixed(2)}${p.unit ? ' ' + p.unit : ''}`;

panel.addEventListener('input', (e) => {
  if (e.target.dataset.explode !== undefined) {
    setExplode(+e.target.value);
    panel.querySelector('[data-val="__explode"]').textContent = Math.round(explode * 100) + '%';
    return;
  }
  const name = e.target.dataset.param;
  if (!name) return;
  values[name] = +e.target.value;
  const p = (app.doc.params || []).find(q => q.name === name);
  panel.querySelector(`[data-val="${CSS.escape(name)}"]`).textContent = fmtParam(p, values[name]);
  applyParams();
});
panel.addEventListener('click', (e) => {
  if (e.target.closest('[data-collapse]')) {
    panelCollapsed = !panelCollapsed;
    try { localStorage.setItem('kerf.p3Collapsed', panelCollapsed ? '1' : ''); } catch (_) {}
    const t = panel.querySelector('.p3-toggle');
    panel.classList.toggle('collapsed', panelCollapsed);
    t.textContent = panelCollapsed ? '▸' : '▾';
    t.title = `${panelCollapsed ? 'Show' : 'Hide'} the panel`;
    return;
  }
  const ed = e.target.closest('[data-edit]')?.dataset.edit;
  if (ed) { document.dispatchEvent(new Event(ed)); return; }
  if (e.target.closest('[data-fit]')) fitView();
  const see = e.target.closest('[data-see]');
  if (see) { seeThrough = !seeThrough; see.classList.toggle('on', seeThrough); applySeeThrough(); }
  const tex = e.target.closest('[data-tex]');
  if (tex) {
    textured = !textured;
    tex.classList.toggle('on', textured);
    try { localStorage.setItem('kerf.p3Textures', textured ? '1' : '0'); } catch (_) { /* private mode */ }
    for (const p of parts) {
      const t = p.mesh.userData.material;
      mats(p.mesh).forEach(m => m.dispose());
      p.mesh.material = partMaterials(THREE, t.mat, t.color, t.thickness, textured);
    }
    applySeeThrough();
    highlightSelection();
  }
  const nav = e.target.closest('[data-nav]');
  if (nav) { setNavMode(nav.dataset.nav); renderPanelNote(); }

});

function fitView() {
  const box = new THREE.Box3().setFromObject(partsRoot);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const r = size.length() / 2;
  const dist = r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.9;
  camera.position.copy(center).add(new THREE.Vector3(0.9, 0.55, 1.1).normalize().multiplyScalar(dist));
  camera.near = dist / 100; camera.far = dist * 20;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

// ── Public ─────────────────────────────────────────────────

export async function show() {
  if (!await loadThree()) return;
  if (!renderer) {
    try { setup(); } catch (e) {
      renderer = null;
      panel.innerHTML = `<h3>3D preview</h3><p class="note">This browser can't start WebGL (${esc(e.message)}). Enable hardware acceleration in the browser settings and reload.</p>`;
      return;
    }
  }
  resize();
  const first = built === null;
  if (built !== app.server.version) buildScene();
  if (first) fitView();
}

/** PNG of the assembled model; works while the 3D tab is hidden (renders off-screen).
 *  fit: frame the whole model (the user's camera is restored afterwards); false = the current view. */
export async function capture(width = 1600, height = 1000, explodeOverride = null, fit = true) {
  if (!await loadThree()) return null;
  if (!renderer) { try { setup(); } catch (_) { return null; } }
  const fresh = built === null;
  if (built !== app.server.version) buildScene();
  const visible = !document.getElementById('view3d').hidden && host.clientWidth > 0;
  if (!visible) {
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  const saved = explode;
  if (explodeOverride !== null) setExplode(explodeOverride);
  const view = { pos: camera.position.clone(), target: controls.target.clone() };
  if (fresh || fit || !visible) fitView();
  controls.update();
  renderer.render(scene, camera);
  const data = renderer.domElement.toDataURL('image/png');
  if (explodeOverride !== null) setExplode(saved);
  if (!fresh) { camera.position.copy(view.pos); controls.target.copy(view.target); controls.update(); }
  if (visible) return data;
  resize();
  return data;
}

/** Export the assembled model (current slider positions): 'glb' (glTF binary, colours) or 'stl'. */
export async function exportModel(format) {
  if (format === 'png') {                      // the 3D view as an image
    const data = await capture(2400, 1500, null, false);
    if (!data) return false;
    const b = await (await fetch(data)).blob();
    download(b, `${app.server.name}-3d.png`);
    return true;
  }
  if (!await loadThree()) return false;
  if (!renderer) { try { setup(); } catch (e) { toast('3D is not available in this browser', 'error'); return false; } }
  if (built !== app.server.version) buildScene();
  if (!parts.length) { toast('Nothing to export in 3D', 'error'); return false; }
  // Export in metres-free mm, Y up; one mesh per part without the edge lines
  const root = new THREE.Group();
  for (const p of parts) {
    const m = p.mesh.clone(false);
    m.geometry = p.mesh.geometry;
    m.material = new THREE.MeshStandardMaterial({ color: mats(p.mesh)[0].color, roughness: 0.85 });  // base colour only
    root.add(m);
  }
  const name = app.server.name || 'model';
  if (format === 'stl') {
    const data = new STLExporter().parse(root, { binary: true });
    download(new Blob([data], { type: 'model/stl' }), `${name}.stl`);
    return true;
  }
  const glb = await new GLTFExporter().parseAsync(root, { binary: true });
  download(new Blob([glb], { type: 'model/gltf-binary' }), `${name}.glb`);
  return true;
}

// ── Selection ↔ 3D ─────────────────────────────────────────

function highlightSelection() {
  for (const p of parts) {
    const sel = [...p.mesh.userData.ids].some(id => app.selection.has(id));
    for (const m of mats(p.mesh)) {
      m.emissive?.set(sel ? '#2563eb' : '#000000');
      m.emissiveIntensity = sel ? 0.45 : 0;
    }
  }
}
on('selection', () => { if (parts.length) highlightSelection(); });

function renderPanelNote() {
  const note = [...panel.querySelectorAll('.note')].pop();
  if (note) note.innerHTML = `${navMode === 'move' ? 'Drag: move' : 'Drag: rotate'} · Shift+drag or right-drag: ${navMode === 'move' ? 'rotate' : 'move'} · scroll: zoom to pointer · arrows: move · double-click a part: centre on it`;
}

// Double-click a part: orbit around it (camera keeps its direction and distance)
host.addEventListener('dblclick', (e) => {
  if (!renderer) return;
  const r = renderer.domElement.getBoundingClientRect();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = ray.intersectObjects(parts.map(p => p.mesh), false)[0];
  if (!hit) return;
  const c = new THREE.Box3().setFromObject(hit.object).getCenter(new THREE.Vector3());
  camera.position.add(c.clone().sub(controls.target));
  controls.target.copy(c);
  controls.update();
});

// Click (not drag) on a part selects its entity
let downAt = null;
host.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
host.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4 || !renderer) return;
  const r = renderer.domElement.getBoundingClientRect();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = ray.intersectObjects(parts.map(p => p.mesh), false)[0];
  if (!hit) { selectItems([]); return; }
  const gid = hit.object.userData.gid;
  setContext(null);
  if (gid) selectItems([gid]);
  else selectItems([...hit.object.userData.ids]);
});

let rebuildTimer = null;
on('doc', () => {
  if (app.view !== '3d' || !renderer) return;
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => { if (built !== app.server.version) buildScene(); }, 150);
});
on('tab-changed', () => { built = null; builtKey = null; });
