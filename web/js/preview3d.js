// 3D preview (three.js): each entity is extruded from its outline (CUT_OUTSIDE) with its
// cut-outs (CUT_INSIDE) as holes, then placed with its `assembly` (matrix → thickness →
// rotation → position). Document params become sliders that move parts ("move").
// Entities without an assembly are laid flat where they are on the sheet.

import { app, on, descendants, selectItems, setContext } from './state.js';
import { renderAttrs } from './geometry.js';
import { esc, toast, download, icons } from './ui.js';
import { partMaterials, faceEdgeUV } from './textures.js';
import { api } from './api.js';

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
let structureOn = (() => { try { return localStorage.getItem('kerf.p3Structure') === '1'; } catch (_) { return false; } })();
let structRoot = null;       // overlay: footprint, centre of mass, loads
let structData = null;       // last describe_structure result for this view
const loadsByTab = {};       // tab id → [{part (id), name, kg}] (preview only, not saved)
let textured = (() => { try { return localStorage.getItem('kerf.p3Textures') !== '0'; } catch (_) { return true; } })();
// Realistic: image-based light, soft shadows on a floor, filmic tone mapping, no CAD edge lines
let realistic = (() => { try { return localStorage.getItem('kerf.p3Realistic') !== '0'; } catch (_) { return true; } })();
let RoomEnvironment, lights = {}, ground, envMap;

const mats = mesh => Array.isArray(mesh.material) ? mesh.material : [mesh.material];

function applySeeThrough() {
  for (const p of parts) {
    for (const m of mats(p.mesh)) {
      m.transparent = seeThrough || !!m.transmission;     // clear acrylic stays transparent
      m.opacity = seeThrough ? 0.35 : 1;
      m.depthWrite = !seeThrough;
      m.envMapIntensity = 0.4;                              // room reflections: subtle, the sun shapes it
      m.needsUpdate = true;
    }
  }
}

// Floating tool bar on the 3D view: arrow = rotate, hand = move (pan), reset, print
const bar = document.createElement('div');
bar.className = 'view3d-tools';
bar.innerHTML = `<button class="tool" data-nav="rotate" title="Rotate (V): drag to turn the model">${icons.select}</button>
  <button class="tool" data-nav="move" title="Move (H): drag to slide the view">${icons.pan}</button>
  <span class="sep"></span>
  <button class="tool" data-fit title="Reset view">${icons.fit}</button>
  <button class="tool" data-print title="Print this view (⌘P): just the picture, for the carpenter">${icons.print}</button>`;
host.appendChild(bar);
bar.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.nav) { setNavMode(b.dataset.nav); renderPanelNote(); }
  else if (b.dataset.fit !== undefined) { if (controls) fitView(); }
  else if (b.dataset.print !== undefined) document.dispatchEvent(new Event('print-view'));
});
setNavMode(navMode);

export function setNavMode(mode) {
  navMode = mode;
  bar.querySelectorAll('[data-nav]').forEach(b => b.classList.toggle('on', b.dataset.nav === mode));
  host.classList.toggle('nav-move', mode === 'move');
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
    ({ RoomEnvironment } = await import('three/addons/environments/RoomEnvironment.js'));
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
  lights.hemi = new THREE.HemisphereLight('#ffffff', '#b9b2a4', 1.1);
  scene.add(lights.hemi);
  const sun = lights.sun = new THREE.DirectionalLight('#fff4e5', 1.4);
  sun.position.set(1500, 2500, 2000);
  sun.shadow.mapSize.set(4096, 4096);
  scene.add(sun, sun.target);
  const fill = lights.fill = new THREE.DirectionalLight('#ffffff', 0.4);
  fill.position.set(-2000, 800, -1500);
  scene.add(fill);
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const pmrem = new THREE.PMREMGenerator(renderer);
  envMap = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
  pmrem.dispose();
  // Floor that only shows the shadows (realistic look)
  ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ color: '#3a3020', opacity: 0.28 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  partsRoot = new THREE.Group();
  scene.add(partsRoot);
  structRoot = new THREE.Group();
  scene.add(structRoot);
  applyLook();
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
    const look = a.material ? { ...mat, ...a.material } : mat;      // a part may have its own material
    const mesh = new THREE.Mesh(geo, partMaterials(THREE, look, color, thickness, textured));
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25),
                                         new THREE.LineBasicMaterial({ color: '#8a6a35', transparent: true, opacity: 0.55 }));
    edges.name = 'edges';
    edges.visible = !realistic;
    mesh.add(edges);
    mesh.castShadow = mesh.receiveShadow = true;
    const r = (a.rotation || [0, 0, 0]).map(v => THREE.MathUtils.degToRad(v));
    mesh.rotation.set(r[0], r[1], r[2], 'XYZ');
    const base = new THREE.Vector3(...(a.position || [0, 0, 0]));
    mesh.position.copy(base);
    mesh.name = g.name;
    mesh.userData.name = g.name;
    mesh.userData.gid = g.id || null;
    mesh.userData.ids = ids;
    mesh.userData.material = { mat: look, color, thickness };
    partsRoot.add(mesh);
    parts.push({ mesh, base, move: a.move });
    count++;
  }
  computeExplodeDirections();
  applyParams();
  highlightSelection();
  applySeeThrough();
  fitStage();
  renderPanel(mode, count);
  built = app.server.version;
  refreshStructure();
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
  if (structRoot) structRoot.visible = !explode;
  fitStage();
}

/** Lighting, tone mapping and edge lines for the current look (realistic or plain CAD). */
function applyLook() {
  renderer.toneMapping = realistic ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
  renderer.toneMappingExposure = realistic ? 0.8 : 1;
  renderer.shadowMap.enabled = realistic;
  scene.environment = realistic ? envMap : null;
  scene.background = new THREE.Color(realistic ? '#e7e4df' : '#eef0f3');
  lights.hemi.intensity = realistic ? 0.25 : 1.1;
  lights.sun.intensity = realistic ? 2.8 : 1.4;
  lights.sun.castShadow = realistic;
  lights.fill.intensity = realistic ? 0.15 : 0.4;
  ground.visible = realistic;
  scene.traverse(o => {
    if (o.name === 'edges') o.visible = !realistic;
    if (o.material) mats(o).forEach(m => { m.needsUpdate = true; });   // tone mapping is compiled into shaders
  });
  fitStage();
}

/** Floor under the model and a shadow camera that just covers it (sharp shadows at any size). */
function fitStage() {
  if (!ground || !parts.length) return;
  const box = new THREE.Box3().setFromObject(partsRoot);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const r = size.length() / 2 || 100;
  ground.position.set(c.x, box.min.y - 0.5, c.z);
  ground.scale.set(r * 8, r * 8, 1);
  const sun = lights.sun, cam = sun.shadow.camera;
  sun.target.position.copy(c);
  sun.position.copy(c).add(new THREE.Vector3(0.45, 1, 0.6).normalize().multiplyScalar(r * 3));
  cam.left = cam.bottom = -r * 1.6; cam.right = cam.top = r * 1.6;
  cam.near = r * 0.5; cam.far = r * 6;
  cam.updateProjectionMatrix();
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = r / 1500;
  sun.shadow.radius = 4;
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
    <div class="row nav-row"><button class="btn" data-fit>Reset view</button>
      <button class="btn ${seeThrough ? 'on' : ''}" data-see title="Semi-transparent parts: see pockets, pins and joints inside">See-through</button>
      <button class="btn ${textured ? 'on' : ''}" data-tex title="Wood grain, plywood plies and finishes from the material type (off: plain colour)">Textures</button>
      <button class="btn ${realistic ? 'on' : ''}" data-real title="Realistic light: soft shadows on a floor, reflections, no outline edges (off: flat CAD look with edges)">Realistic</button>
      ${mode === 'assembly' ? `<button class="btn ${structureOn ? 'on' : ''}" data-structure title="Weight, centre of mass and stability: will it tip over, and how hard a push does it take">Structure</button>` : ''}</div>
    <div class="p3-structure" ${structureOn && mode === 'assembly' ? '' : 'hidden'}></div>
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
  refreshStructure(250);
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
  const st = e.target.closest('[data-structure]');
  if (st) {
    structureOn = !structureOn;
    st.classList.toggle('on', structureOn);
    try { localStorage.setItem('kerf.p3Structure', structureOn ? '1' : '0'); } catch (_) {}
    refreshStructure();
    return;
  }
  const rm = e.target.closest('[data-load-rm]');
  if (rm) { tabLoads().splice(+rm.dataset.loadRm, 1); refreshStructure(); return; }
  if (e.target.closest('[data-load-add]')) { addLoad(); return; }
  const pick = e.target.closest('[data-part-pick]');
  if (pick) { e.preventDefault(); selectPart(pick.dataset.partPick); return; }
  const real = e.target.closest('[data-real]');
  if (real) {
    realistic = !realistic;
    real.classList.toggle('on', realistic);
    try { localStorage.setItem('kerf.p3Realistic', realistic ? '1' : '0'); } catch (_) { /* private mode */ }
    applyLook();
  }
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

/** The current 3D view for printing: high resolution, white background, no selection highlight. */
export async function printImage() {
  if (!await loadThree()) return null;
  if (!renderer) { try { setup(); } catch (_) { return null; } }
  const fresh = built === null;
  if (built !== app.server.version) buildScene();
  if (!parts.length) return null;
  const visible = !document.getElementById('view3d').hidden && host.clientWidth > 0;
  const w = visible ? host.clientWidth : 1600, h = visible ? host.clientHeight : 1000;
  const k = 3200 / Math.max(w, h);
  const bg = scene.background, ratio = renderer.getPixelRatio();
  scene.background = new THREE.Color('#ffffff');
  for (const p of parts) for (const m of mats(p.mesh)) { m.emissive?.set('#000000'); m.emissiveIntensity = 0; }
  renderer.setPixelRatio(1);
  renderer.setSize(Math.round(w * k), Math.round(h * k), false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (fresh || !visible) fitView();
  controls.update();
  renderer.render(scene, camera);
  const data = renderer.domElement.toDataURL('image/png');
  scene.background = bg;
  renderer.setPixelRatio(ratio);
  highlightSelection();
  resize();
  return { data, landscape: w >= h };
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

const TINT = { breaks: '#dc2626', unsupported: '#dc2626', overloaded: '#f97316', sags: '#eab308' };
function highlightSelection() {
  const status = {};
  if (structureOn && structData?.strength) for (const r of structData.strength.panels) status[r.id] = r.status;
  for (const p of parts) {
    const sel = [...p.mesh.userData.ids].some(id => app.selection.has(id));
    const tint = TINT[status[p.mesh.userData.gid]];
    for (const m of mats(p.mesh)) {
      m.emissive?.set(sel ? '#2563eb' : tint || '#000000');
      m.emissiveIntensity = sel ? 0.45 : tint ? 0.55 : 0;
    }
  }
}
on('selection', () => { if (parts.length) highlightSelection(); renderLoadPicker(); });

// ── Structure overlay: weight, centre of mass, footprint, tip-over ───────

const tabLoads = () => (loadsByTab[app.server?.active] ||= []);

/** The placed part the user has selected (its entity id), if exactly one is selected. */
function selectedPart() {
  const hit = parts.filter(p => p.mesh.userData.gid && [...p.mesh.userData.ids].some(id => app.selection.has(id)));
  return hit.length === 1 ? hit[0].mesh.userData : null;
}

function selectPart(gid) {
  const p = parts.find(q => q.mesh.userData.gid === gid);
  if (p) selectItems([gid]);
}

function addLoad() {
  const input = panel.querySelector('[data-load-kg]');
  const kg = +input?.value;
  const part = selectedPart();
  if (!part) { toast('Select one part in the 3D view (click it) to put the load on', 'error'); return; }
  if (!(kg > 0)) { toast('Enter the load in kg', 'error'); input?.focus(); return; }
  tabLoads().push({ part: part.gid, name: part.name, kg });
  refreshStructure();
}

function renderLoadPicker() {
  const el = panel.querySelector('[data-load-target]');
  if (!el) return;
  const part = selectedPart();
  el.textContent = part ? `on “${part.name}”` : 'select a part first';
}

let structTimer = null, structSeq = 0;
function refreshStructure(delay = 0) {
  clearTimeout(structTimer);
  if (!structureOn || !parts.some(p => p.mesh.userData.gid)) { clearStructure(); return; }
  structTimer = setTimeout(async () => {
    const seq = ++structSeq;
    const loads = tabLoads().filter(l => parts.some(p => p.mesh.userData.gid === l.part))
      .map(l => ({ part: l.part, kg: l.kg, label: `${l.kg} kg on ${l.name}` }));
    const params = {};
    for (const p of app.doc.params || []) if (values[p.name] !== undefined) params[p.name] = values[p.name];
    let data;
    try { data = await api.structure({ params, loads }); } catch (e) { data = { error: e.message }; }
    if (seq !== structSeq || !structureOn) return;
    structData = data;
    drawStructure(data);
    renderStructurePanel(data);
    highlightSelection();
  }, delay);
}

function clearStructure() {
  const had = !!structData;
  structData = null;
  if (had) highlightSelection();
  if (structRoot) {
    structRoot.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    structRoot.clear();
  }
  const box = panel.querySelector('.p3-structure');
  if (box) box.hidden = true;
}

function drawStructure(d) {
  structRoot.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
  structRoot.clear();
  if (!d || d.error) return;
  const s = d.stability, ok = !!s.stable;
  const color = ok ? '#16a34a' : '#dc2626';
  const y = s.floor_y + 0.8;
  const all = new THREE.Box3().setFromObject(partsRoot);
  const size = all.isEmpty() ? 1000 : all.getSize(new THREE.Vector3()).length();
  const fp = s.footprint || [];
  if (fp.length >= 3) {
    // ShapeGeometry is in XY; turned −90° about X, (x, −z) lands on the floor at (x, z)
    const shape = new THREE.Shape(fp.map(([x, z]) => new THREE.Vector2(x, -z)));
    const fill = new THREE.Mesh(new THREE.ShapeGeometry(shape),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }));
    fill.rotation.x = -Math.PI / 2;
    fill.position.y = y;
    structRoot.add(fill);
    const ring = fp.map(([x, z]) => new THREE.Vector3(x, y, z));
    structRoot.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(ring),
                                      new THREE.LineBasicMaterial({ color })));
  }
  if (s.weakest?.edge) {
    const [[x0, z0], [x1, z1]] = s.weakest.edge;
    const w = Math.max(size * 0.006, 4);
    const len = Math.hypot(x1 - x0, z1 - z0);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(len, w * 0.4, w),
                               new THREE.MeshBasicMaterial({ color: ok ? '#f59e0b' : '#dc2626' }));
    bar.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
    bar.rotation.y = -Math.atan2(z1 - z0, x1 - x0);
    structRoot.add(bar);
  }
  // Centre of mass: a ball, a dashed drop line and its shadow on the floor
  const [cx, cy, cz] = d.center_of_mass;
  const r = Math.max(size * 0.012, 6);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16),
                              new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }));
  ball.position.set(cx, cy, cz);
  ball.renderOrder = 10;
  structRoot.add(ball);
  const drop = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(cx, cy, cz), new THREE.Vector3(cx, y, cz)]),
                              new THREE.LineDashedMaterial({ color, dashSize: r, gapSize: r * 0.7, depthTest: false, transparent: true }));
  drop.computeLineDistances();
  drop.renderOrder = 10;
  structRoot.add(drop);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(r * 0.8, 24),
                             new THREE.MeshBasicMaterial({ color, depthWrite: false }));
  dot.rotation.x = -Math.PI / 2;
  dot.position.set(cx, y + 0.3, cz);
  structRoot.add(dot);
  for (const l of d.loads || []) {
    const len = Math.max(size * 0.08, 60);
    const at = new THREE.Vector3(...l.at);
    structRoot.add(new THREE.ArrowHelper(new THREE.Vector3(0, -1, 0), at.clone().add(new THREE.Vector3(0, len, 0)),
                                         len, '#2563eb', len * 0.3, len * 0.18));
  }
  structRoot.visible = !explode;
}

const kg = v => v >= 10 ? v.toFixed(1) : v.toFixed(2);

const STATUS_LABEL = { breaks: 'breaks', unsupported: 'not held', overloaded: 'overloaded', sags: 'sags', ok: 'ok' };
function strengthHtml(st) {
  if (!st) return '';
  const rows = st.panels.filter(r => r.kind);
  const sup = st.supports;
  return `<div class="st-strength"><div class="st-sub">Strength <span class="st-verdict-sm ${st.ok ? 'ok' : 'bad'}">${st.ok ? '✓ nothing overloaded' : '✗ ' + esc(st.message)}</span></div>
    ${rows.length ? `<table class="st-table"><tr><th>Panel</th><th>load</th><th>sag</th><th>stress</th><th>safe +</th></tr>
      ${rows.map(r => `<tr class="st-${r.status}" title="${esc(r.message)}"><td><a href="#" data-part-pick="${esc(r.id)}">${esc(r.name)}</a>
        ${r.status !== 'ok' ? `<span class="st-tag">${STATUS_LABEL[r.status]}</span>` : ''}</td><td>${r.load_kg ? r.load_kg + ' kg' : '–'}</td>
        <td>${r.sag_mm} mm</td><td>${r.stress_pct}%</td><td>${r.safe_load_kg} kg</td></tr>`).join('')}</table>` : ''}
    ${st.panels.filter(r => r.status === 'unsupported').map(r => `<p class="st-bad">${esc(r.message)}</p>`).join('')}
    ${sup ? `<p class="${sup.status === 'ok' ? '' : 'st-bad'}">${esc(sup.message)}</p>` : ''}
    <p class="note">Shelves and other flat panels as beams, each load as one weight in the middle (worst case). Over 50% stress = overloaded (safety ×2). “safe +” = how much more fits in the middle. Joints and screws aren't checked. Hover a row for details.</p></div>`;
}
let partsOpen = false;        // "Weight per part" stays open across refreshes

function renderStructurePanel(d) {
  const box = panel.querySelector('.p3-structure');
  if (!box) return;
  box.hidden = false;
  if (!d || d.error) { box.innerHTML = `<p class="note">${esc(d?.error || 'No data')}</p>`; return; }
  const s = d.stability;
  const loads = tabLoads();
  const dirs = (s.by_direction || []).slice().sort((a, b) => a.margin - b.margin);
  const unweighed = d.unweighed_hardware || [];
  box.innerHTML = `
    <div class="st-verdict ${s.stable ? 'ok' : 'bad'}">${s.stable ? '✓ Stands' : '✗ Tips over'}</div>
    <p class="st-msg">${esc(s.message)}</p>
    <div class="st-stats">
      <div><b>${kg(d.parts_kg)} kg</b><span>parts</span></div>
      ${d.loads ? `<div><b>${kg(d.total_kg)} kg</b><span>with loads</span></div>` : ''}
      <div><b>${Math.round(s.com_height)} mm</b><span>centre of mass high</span></div>
    </div>
    ${dirs.length ? `<table class="st-table"><tr><th>Tips toward</th><th>margin</th><th>lean</th><th>push at ${Math.round(s.push_height)}</th></tr>
      ${dirs.map(e => `<tr class="${e.margin <= 0 ? 'bad' : e === s.weakest ? 'weak' : ''}"><td>${esc(e.toward)}</td><td>${Math.round(e.margin)} mm</td>
        <td>${e.tip_angle ?? '–'}°</td><td>${e.tip_force_kgf} kgf</td></tr>`).join('')}</table>` : ''}
    ${strengthHtml(d.strength)}
    <div class="st-loads"><div class="st-sub">Loads <span class="muted">(preview only)</span></div>
      ${loads.map((l, i) => `<div class="st-load"><span>${l.kg} kg on ${esc(l.name)}</span><button class="link-btn" data-load-rm="${i}" title="Remove">×</button></div>`).join('')}
      <div class="row"><input type="number" min="0" step="1" placeholder="kg" data-load-kg>
        <button class="btn" data-load-add>Add load</button> <span class="muted" data-load-target></span></div></div>
    <details class="st-parts" ${partsOpen ? 'open' : ''}><summary>Weight per part (${d.parts.length})</summary>
      <table class="st-table">${d.parts.filter(p => !p.unweighed).map(p => `<tr><td><a href="#" data-part-pick="${esc(p.id)}">${esc(p.name)}</a>${p.mass_given ? ' <span class="muted">(given)</span>' : ''}</td><td>${kg(p.kg)} kg</td></tr>`).join('')}</table>
      ${unweighed.length ? `<p class="note">${unweighed.length} bought part(s) have no weight and count as 0 kg: ${esc(unweighed.slice(0, 6).join(', '))}${unweighed.length > 6 ? '…' : ''}. Set “Weight” in the Inspector (3D placement).</p>` : ''}
    </details>
    <p class="note">Ball = centre of mass, shaded area = footprint on the floor, ${s.stable ? 'orange' : 'red'} bar = the edge it tips over first. Parts in red break, orange are overloaded, yellow sag too much.</p>`;
  box.querySelector('.st-parts').addEventListener('toggle', e => { partsOpen = e.target.open; });
  renderLoadPicker();
}

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
