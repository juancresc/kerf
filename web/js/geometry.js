// Document → SVG rendering helpers and element geometry (moving, bounding boxes).
// Mirrors mcp-server/document.py: stroke colour and line style come from the layer.

export const NS = 'http://www.w3.org/2000/svg';
export const SHAPES = ['line', 'rect', 'circle', 'ellipse', 'text', 'path', 'polygon', 'polyline'];
const DASH = { solid: '', dashed: '6 3', dotted: '0.5 2.5' };

export function dashOf(layer) {
  return layer.line_style in DASH ? DASH[layer.line_style] : layer.line_style;
}

// Screen dash patterns (px), used with non-scaling strokes in the editor
const SCREEN_DASH = { solid: '', dashed: '7 4', dotted: '1 4' };
export function screenDashOf(layer) {
  return layer.line_style in SCREEN_DASH ? SCREEN_DASH[layer.line_style] : layer.line_style;
}

/** Attributes to render an element with, including layer styling. */
export function renderAttrs(el, layer, { screen = false } = {}) {
  const a = { ...el.attrs };
  if (el.tag === 'text') {
    if (a.fill !== 'none') a.fill = layer.color;
  } else {
    a.stroke = layer.color;
    if (!('fill' in a)) a.fill = 'none';
    if (!('stroke-width' in a)) a['stroke-width'] = '1';
    const dash = screen ? screenDashOf(layer) : dashOf(layer);
    if (dash) {
      a['stroke-dasharray'] = dash;
      if (layer.line_style === 'dotted') a['stroke-linecap'] = 'round';
    }
  }
  return a;
}

export function createNode(el, layer, opts) {
  const node = document.createElementNS(NS, el.tag);
  for (const [k, v] of Object.entries(renderAttrs(el, layer, opts))) node.setAttribute(k, v);
  if (el.tag === 'text') node.textContent = el.text;
  return node;
}

const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const escText = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Standalone SVG string of the document (visible layers), for PNG export / screenshots / previews. */
export function docToSvg(doc, { background = true, ids = null, viewBox = null, pxWidth = null } = {}) {
  const vb = viewBox || [0, 0, doc.width, doc.height];
  const w = pxWidth || vb[2];
  const h = pxWidth ? pxWidth * vb[3] / vb[2] : vb[3];
  const out = [`<svg xmlns="${NS}" width="${w}" height="${h}" viewBox="${vb.join(' ')}">`];
  if (background && doc.background?.href) {
    out.push(`<image href="${escAttr(doc.background.href)}" x="0" y="0" width="${doc.width}" height="${doc.height}" opacity="${doc.background.opacity}" preserveAspectRatio="xMidYMid meet"/>`);
  }
  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    for (const el of doc.elements) {
      if (el.layer !== layer.name || (ids && !ids.has(el.id))) continue;
      const a = Object.entries(renderAttrs(el, layer)).map(([k, v]) => `${k}="${escAttr(v)}"`).join(' ');
      out.push(el.tag === 'text' ? `<text ${a}>${escText(el.text)}</text>` : `<${el.tag} ${a}/>`);
    }
  }
  out.push('</svg>');
  return out.join('\n');
}

// ── Moving ─────────────────────────────────────────────────

const r3 = v => Math.round(v * 1000) / 1000;

/** Attribute patch that moves an element by (dx, dy) mm. */
export function moveAttrs(el, dx, dy) {
  const a = el.attrs;
  const num = k => parseFloat(a[k] || 0);
  if (a.transform || ['path', 'polygon', 'polyline'].includes(el.tag)) {
    return { transform: translateTransform(a.transform || '', dx, dy) };
  }
  switch (el.tag) {
    case 'line':
      return { x1: r3(num('x1') + dx), y1: r3(num('y1') + dy), x2: r3(num('x2') + dx), y2: r3(num('y2') + dy) };
    case 'rect':
    case 'text':
      return { x: r3(num('x') + dx), y: r3(num('y') + dy) };
    case 'circle':
    case 'ellipse':
      return { cx: r3(num('cx') + dx), cy: r3(num('cy') + dy) };
  }
  return {};
}

/** Prepend (or merge into a leading) translate(): moves the element in parent coordinates. */
export function translateTransform(t, dx, dy) {
  const m = t.match(/^\s*translate\(\s*([-\d.e]+)(?:[\s,]+([-\d.e]+))?\s*\)\s*/);
  if (m) {
    const x = r3(parseFloat(m[1]) + dx), y = r3(parseFloat(m[2] || 0) + dy);
    const rest = t.slice(m[0].length).trim();
    const tr = (x || y) ? `translate(${x}, ${y})` : '';
    return [tr, rest].filter(Boolean).join(' ');
  }
  return [`translate(${r3(dx)}, ${r3(dy)})`, t.trim()].filter(Boolean).join(' ');
}

// ── Bounding boxes ─────────────────────────────────────────

/** Bounding box of a rendered node in root (document) coordinates, transforms included. */
export function bboxOf(node, root) {
  let b;
  try { b = node.getBBox(); } catch (_) { return null; }
  const m = root.getScreenCTM().inverse().multiply(node.getScreenCTM());
  const pts = [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]]
    .map(([x, y]) => new DOMPoint(x, y).matrixTransform(m));
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

export function unionBox(boxes) {
  boxes = boxes.filter(Boolean);
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
  const x2 = Math.max(...boxes.map(b => b.x + b.width)), y2 = Math.max(...boxes.map(b => b.y + b.height));
  return { x, y, width: x2 - x, height: y2 - y };
}

export function boxInside(b, r) {
  return b.x >= r.x && b.y >= r.y && b.x + b.width <= r.x + r.width && b.y + b.height <= r.y + r.height;
}

export function boxTouches(b, r) {
  return b.x <= r.x + r.width && b.x + b.width >= r.x && b.y <= r.y + r.height && b.y + b.height >= r.y;
}

/** Render doc → PNG canvas at `scale` px per mm. */
export function svgToCanvas(svgString, width, height) {
  const url = URL.createObjectURL(new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = Math.round(width);
      c.height = Math.round(height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c);
    };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(new Error('Could not render SVG')); };
    img.src = url;
  });
}

export async function docToPng(doc, maxSide = 16000, pxPerMm = 4) {
  const scale = Math.min(pxPerMm, maxSide / Math.max(doc.width, doc.height));
  const w = doc.width * scale, h = doc.height * scale;
  return svgToCanvas(docToSvg(doc, { pxWidth: w }), w, h);
}

/** SVG path of a straight slot with round ends (same shape the server's add_slot makes). */
export function slotPath(x1, y1, x2, y2, w) {
  const r = w / 2, len = Math.hypot(x2 - x1, y2 - y1);
  if (!(r > 0)) return '';
  if (len < 1e-9) return `M ${x1 - r} ${y1} A ${r} ${r} 0 1 0 ${x1 + r} ${y1} A ${r} ${r} 0 1 0 ${x1 - r} ${y1} Z`;
  const nx = -(y2 - y1) / len * r, ny = (x2 - x1) / len * r;
  return `M ${x1 + nx} ${y1 + ny} L ${x2 + nx} ${y2 + ny} A ${r} ${r} 0 0 0 ${x2 - nx} ${y2 - ny} ` +
         `L ${x1 - nx} ${y1 - ny} A ${r} ${r} 0 0 0 ${x1 + nx} ${y1 + ny} Z`;
}
