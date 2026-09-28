// Procedural textures for the 3D preview: grain, plies, speckle and brushing drawn on canvases,
// chosen by the material type. They're greyscale around white, so the part's colour (material or
// assembly.color) tints them. UVs are in mm: faces use part-local (x, y); cut edges run along
// the edge (u) and up the thickness (v = z), so plywood plies sit at their real heights.

import { MATERIAL_TYPES } from './materials.js';

const FACE_MM = 400;            // one face tile covers 400 × 400 mm
const PLY_MM = 1.5;             // birch plywood: about one ply per 1.5 mm
const cache = new Map();        // textures, shared by every part of the same kind

function rng(seed) {
  let s = seed % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const grey = (v, a = 1) => `rgba(${v | 0},${v | 0},${v | 0},${a})`;

// Wavy grain lines along u. Whole sine periods across the tile, so it repeats without a seam.
function grain(g, w, h, r, { lines = 110, dark = 150, wave = 8, alpha = 0.25, base = 246, width = 2.5 } = {}) {
  g.fillStyle = grey(base); g.fillRect(0, 0, w, h);
  for (let i = 0; i < lines; i++) {
    const y0 = r() * h, amp = wave * (0.3 + r()), k = (1 + (r() * 3 | 0)) * 2 * Math.PI / w, ph = r() * 6.3;
    g.strokeStyle = grey(dark + r() * 60, alpha * (0.4 + r()));
    g.lineWidth = 0.4 + r() * width;
    for (const dy of [-h, 0, h]) {
      g.beginPath();
      for (let x = 0; x <= w; x += 8) {
        const y = y0 + dy + amp * Math.sin(k * x + ph);
        x ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    }
  }
}

function speckle(g, w, h, r, { n = 5000, alpha = 0.15, base = 240, size = 2 } = {}) {
  g.fillStyle = grey(base); g.fillRect(0, 0, w, h);
  for (let i = 0; i < n; i++) {
    g.fillStyle = grey(r() < 0.5 ? 120 + r() * 60 : 255, alpha * (0.3 + r()));
    g.fillRect(r() * w, r() * h, size * (0.5 + r()), size * (0.5 + r()));
  }
}

function brushed(g, w, h, r) {
  g.fillStyle = grey(236); g.fillRect(0, 0, w, h);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = grey(r() < 0.5 ? 190 : 255, 0.12 + r() * 0.12);
    g.fillRect(0, r() * h, w, 0.6 + r());
  }
}

// Cut edge of plywood: alternating light / darker plies with thin glue lines
function plies(count) {
  return (g, w, h, r) => {
    const ph = h / count;
    for (let i = 0; i < count; i++) {
      g.fillStyle = grey(i % 2 ? 214 : 250); g.fillRect(0, i * ph, w, ph);
      for (let k = 0; k < 120; k++) {           // end grain / long grain flecks
        g.fillStyle = grey(150 + r() * 60, 0.25);
        g.fillRect(r() * w, i * ph + r() * ph, i % 2 ? 1 : 6 + r() * 20, 1);
      }
      g.fillStyle = grey(140, 0.6); g.fillRect(0, i * ph, w, Math.max(1, h / 256));
    }
  };
}

const flat = (g, w, h) => { g.fillStyle = grey(250); g.fillRect(0, 0, w, h); };

const LOOKS = {
  plywood: { roughness: 0.8, metalness: 0, bump: 0.25, face: (g, w, h, r) => grain(g, w, h, r, { lines: 150, dark: 165, alpha: 0.13, width: 1.2 }), edge: 'plies' },
  wood:    { roughness: 0.7, metalness: 0, bump: 0.8,
             face: (g, w, h, r) => grain(g, w, h, r, { lines: 170, dark: 110, alpha: 0.35, wave: 4 }),
             edge: (g, w, h, r) => grain(g, w, h, r, { lines: 120, dark: 110, alpha: 0.3, wave: 1, base: 232 }) },
  board:   { roughness: 0.95, metalness: 0, bump: 0.3,
             face: (g, w, h, r) => speckle(g, w, h, r, { n: 6000, alpha: 0.1 }),
             edge: (g, w, h, r) => speckle(g, w, h, r, { n: 9000, alpha: 0.25, base: 222 }) },
  plastic: { roughness: 0.15, metalness: 0, bump: 0, face: flat, edge: flat },
  metal:   { roughness: 0.35, metalness: 1, bump: 0.15, face: brushed, edge: brushed },
  foam:    { roughness: 1, metalness: 0, bump: 1, face: (g, w, h, r) => speckle(g, w, h, r, { n: 12000, alpha: 0.3, size: 3 }) },
  other:   { roughness: 0.85, metalness: 0, bump: 0.3, face: (g, w, h, r) => speckle(g, w, h, r, { n: 3000, alpha: 0.08 }) },
};

function texture(THREE, key, w, h, draw, mmU, mmV) {
  if (cache.has(key)) return cache.get(key);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h, rng([...key].reduce((a, ch) => a * 31 + ch.charCodeAt(0) | 0, 7) >>> 0));
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1 / mmU, 1 / mmV);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  cache.set(key, t);
  return t;
}

/** Materials for one part: [faces, cut edges], or one plain material when textures are off. */
export function partMaterials(THREE, material, color, thickness, textured) {
  if (!textured) return new THREE.MeshStandardMaterial({ color, roughness: 0.85, side: THREE.DoubleSide });
  const type = MATERIAL_TYPES.includes(material.type) ? material.type : 'other';
  const look = LOOKS[type];
  const t = Math.max(0.5, +thickness || 18);
  const face = texture(THREE, `${type}:face`, 512, 512, look.face, FACE_MM, FACE_MM);
  const edgeDraw = look.edge === 'plies' ? plies(Math.max(3, Math.round(t / PLY_MM) | 1)) : look.edge || look.face;
  const edge = texture(THREE, `${type}:edge:${t}`, 512, 256, edgeDraw, FACE_MM, t);
  const clear = type === 'plastic' && /clear/i.test(material.name || '');
  const make = (map) => clear
    ? new THREE.MeshPhysicalMaterial({ color, map, roughness: 0.05, transmission: 0.9, thickness: t,
                                       transparent: true, side: THREE.DoubleSide })
    : new THREE.MeshStandardMaterial({ color, map, bumpMap: look.bump ? map : null, bumpScale: look.bump,
                                       roughness: look.roughness, metalness: look.metalness, side: THREE.DoubleSide });
  return [make(face), make(edge)];
}

/** A part geometry (already in part-local mm, z = thickness) → non-indexed copy with mm UVs and
 *  two material groups: 0 = faces (top, bottom, pocket floors), 1 = cut edges. */
export function faceEdgeUV(THREE, geo) {
  const src = geo.index ? geo.toNonIndexed() : geo;
  const P = src.attributes.position.array, n = src.attributes.position.count;
  const caps = [], walls = [];
  for (let t = 0; t < n; t += 3) {
    const o = t * 3;
    const ux = P[o + 3] - P[o], uy = P[o + 4] - P[o + 1], uz = P[o + 5] - P[o + 2];
    const vx = P[o + 6] - P[o], vy = P[o + 7] - P[o + 1], vz = P[o + 8] - P[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    (Math.abs(nz) >= Math.max(Math.abs(nx), Math.abs(ny)) ? caps : walls).push([t, Math.abs(nx) > Math.abs(ny)]);
  }
  const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let k = 0;
  for (const list of [caps, walls]) {
    for (const [t, alongY] of list) {
      for (let j = 0; j < 3; j++, k++) {
        const x = P[(t + j) * 3], y = P[(t + j) * 3 + 1], z = P[(t + j) * 3 + 2];
        pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
        uv[k * 2] = list === caps ? x : alongY ? y : x;
        uv[k * 2 + 1] = list === caps ? y : z;
      }
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.addGroup(0, caps.length * 3, 0);
  out.addGroup(caps.length * 3, walls.length * 3, 1);
  out.computeVertexNormals();
  if (src !== geo) src.dispose();
  return out;
}
