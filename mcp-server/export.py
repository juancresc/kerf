"""Exports: DXF (CNC), per-entity part files for nesting software, one file per sheet, geometry helpers.

SVG geometry (paths with lines/arcs/curves, basic shapes, transforms) is converted to
absolute outlines in document mm. DXF output uses Y up (DXF convention), mm units, one DXF
layer per document layer with its colour, closed LWPOLYLINEs with true arcs (bulges) and
CIRCLE entities for full circles — what CAM software handles best.
"""
from __future__ import annotations

import io
import math
import re
import zipfile

from document import Document, DocError, element_svg

# ── Affine transforms ([a, b, c, d, e, f] like SVG matrix()) ────────────

IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def mul(m, n):
    a, b, c, d, e, f = m
    a2, b2, c2, d2, e2, f2 = n
    return (a * a2 + c * b2, b * a2 + d * b2, a * c2 + c * d2, b * c2 + d * d2,
            a * e2 + c * f2 + e, b * e2 + d * f2 + f)


def apply(m, x, y):
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


def parse_transform(t: str | None):
    m = IDENTITY
    for name, args in re.findall(r"(\w+)\s*\(([^)]*)\)", t or ""):
        v = [float(x) for x in re.split(r"[\s,]+", args.strip()) if x]
        if name == "translate":
            n = (1, 0, 0, 1, v[0], v[1] if len(v) > 1 else 0)
        elif name == "scale":
            n = (v[0], 0, 0, v[1] if len(v) > 1 else v[0], 0, 0)
        elif name == "rotate":
            r = math.radians(v[0])
            n = (math.cos(r), math.sin(r), -math.sin(r), math.cos(r), 0, 0)
            if len(v) == 3:
                n = mul(mul((1, 0, 0, 1, v[1], v[2]), n), (1, 0, 0, 1, -v[1], -v[2]))
        elif name == "matrix" and len(v) == 6:
            n = tuple(v)
        elif name == "skewX":
            n = (1, 0, math.tan(math.radians(v[0])), 1, 0, 0)
        elif name == "skewY":
            n = (1, math.tan(math.radians(v[0])), 0, 1, 0, 0)
        else:
            continue
        m = mul(m, n)
    return m


def is_similarity(m) -> bool:
    """Uniform scale + rotation (+ mirror): circles stay circles."""
    a, b, c, d, _, _ = m
    return abs(a * a + b * b - (c * c + d * d)) < 1e-9 and abs(a * c + b * d) < 1e-9


def scale_of(m) -> float:
    return math.sqrt(abs(m[0] * m[3] - m[1] * m[2]))


# ── Outlines ────────────────────────────────────────────────────────────
# A contour is a list of vertices [(x, y, bulge)], bulge = tan(angle/4) of the arc to the next
# vertex (DXF convention, positive = counter-clockwise in a Y-up system), plus a closed flag.

class Contour:
    def __init__(self, pts, closed):
        self.pts, self.closed = pts, closed

    def points(self, step=2.0):
        """Flattened points (arcs sampled), for bounding boxes."""
        out = []
        n = len(self.pts)
        for i, (x, y, b) in enumerate(self.pts):
            out.append((x, y))
            if b and (i < n - 1 or self.closed):
                x2, y2, _ = self.pts[(i + 1) % n]
                out += arc_points(x, y, x2, y2, b, step)
        return out


def arc_points(x1, y1, x2, y2, bulge, step):
    """Points along a bulge arc (positive bulge = increasing angle in these coordinates)."""
    theta = 4 * math.atan(bulge)
    chord = math.hypot(x2 - x1, y2 - y1)
    if chord == 0 or theta == 0:
        return []
    r = chord / (2 * math.sin(abs(theta) / 2))
    d = (chord / 2) / math.tan(theta / 2)          # signed distance chord midpoint → centre
    ux, uy = (x2 - x1) / chord, (y2 - y1) / chord
    cx, cy = (x1 + x2) / 2 - uy * d, (y1 + y2) / 2 + ux * d
    a1 = math.atan2(y1 - cy, x1 - cx)
    n = max(2, int(abs(theta) * r / step))
    return [(cx + r * math.cos(a1 + theta * i / n), cy + r * math.sin(a1 + theta * i / n)) for i in range(1, n)]


def svg_arc_center(x1, y1, rx, ry, phi, fa, fs, x2, y2):
    """SVG arc endpoint → centre parameterisation. Returns (cx, cy, rx, ry, theta1, dtheta)."""
    cp, sp = math.cos(phi), math.sin(phi)
    dx, dy = (x1 - x2) / 2, (y1 - y2) / 2
    x1p, y1p = cp * dx + sp * dy, -sp * dx + cp * dy
    rx, ry = abs(rx), abs(ry)
    lam = (x1p ** 2) / (rx ** 2) + (y1p ** 2) / (ry ** 2)
    if lam > 1:
        rx, ry = rx * math.sqrt(lam), ry * math.sqrt(lam)
    num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
    den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    co = math.sqrt(max(0, num / den)) if den else 0
    if fa == fs:
        co = -co
    cxp, cyp = co * rx * y1p / ry, -co * ry * x1p / rx
    cx = cp * cxp - sp * cyp + (x1 + x2) / 2
    cy = sp * cxp + cp * cyp + (y1 + y2) / 2
    ang = lambda ux, uy, vx, vy: math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
    t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if not fs and dt > 0:
        dt -= 2 * math.pi
    elif fs and dt < 0:
        dt += 2 * math.pi
    return cx, cy, rx, ry, t1, dt


PATH_TOKEN = re.compile(r"[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")
NUM_RE = re.compile(r"\s*,?\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)")
FLAG_RE = re.compile(r"\s*,?\s*([01])")


def tokenize_path(d: str) -> list[str]:
    """SVG path tokens; arc flags are single characters, so compact forms like
    'a5 5 0 1010 0' (flags 1,0 then x=10) parse correctly."""
    out, i, cmd, argn = [], 0, None, 0
    d = d or ""
    while i < len(d):
        c = d[i]
        if c.isspace() or c == ",":
            i += 1
            continue
        if c.isalpha():
            if c not in "MmLlHhVvCcSsQqTtAaZz":
                raise DocError(f"Unsupported path command '{c}'")
            out.append(c); cmd, argn, i = c, 0, i + 1
            continue
        if cmd and cmd.upper() == "A" and argn % 7 in (3, 4):
            m = FLAG_RE.match(d, i)
        else:
            m = NUM_RE.match(d, i)
        if not m:
            raise DocError(f"Invalid path data near '{d[i:i + 12]}'")
        out.append(m.group(1)); argn += 1; i = m.end()
    return out


def path_contours(d: str, m, flip_h: float | None, flatten_step=1.0) -> list[Contour]:
    """Parse an SVG path into contours in output coordinates.
    m: element transform (doc coords); flip_h: document height to flip Y (DXF), or None."""
    toks = tokenize_path(d)
    i, cmd = 0, None
    x = y = sx = sy = 0.0
    last_ctrl = None
    contours, cur = [], []
    sim = is_similarity(m)
    det_sign = 1 if (m[0] * m[3] - m[1] * m[2]) >= 0 else -1
    yflip = -1 if flip_h is not None else 1

    def out(px, py):
        X, Y = apply(m, px, py)
        return (X, flip_h - Y) if flip_h is not None else (X, Y)

    def start(px, py):
        nonlocal cur
        if len(cur) > 1:
            contours.append(Contour(cur, False))
        cur = [[*out(px, py), 0.0]]

    def line_to(px, py):
        cur.append([*out(px, py), 0.0])

    def flat_to(points):
        for px, py in points:
            line_to(px, py)

    def num():
        nonlocal i
        if i >= len(toks) or re.fullmatch(r"[A-Za-z]", toks[i]):
            raise DocError("Path data ends early (missing numbers)")
        v = float(toks[i]); i += 1
        return v

    while i < len(toks):
        if re.fullmatch(r"[A-Za-z]", toks[i]):
            cmd = toks[i]; i += 1
            if cmd in "Zz":
                if cur:
                    if len(cur) > 1 and math.dist(cur[0][:2], cur[-1][:2]) < 1e-6:
                        cur.pop()  # closing vertex duplicates the start (keep its bulge on the previous)
                        # the bulge of the segment into the start lives on the now-last vertex already
                    contours.append(Contour(cur, True))
                    cur = []
                x, y = sx, sy
                last_ctrl = None
                continue
        if cmd is None:
            raise DocError("Invalid path data")
        rel = cmd.islower()
        c = cmd.upper()
        if c == "M":
            nx, ny = num(), num()
            if rel: nx, ny = x + nx, y + ny
            x, y, sx, sy = nx, ny, nx, ny
            start(x, y)
            cmd = "l" if rel else "L"
            last_ctrl = None
        elif c in "LHV":
            if c == "L":
                nx, ny = num(), num()
                if rel: nx, ny = x + nx, y + ny
            elif c == "H":
                nx, ny = num() + (x if rel else 0), y
            else:
                nx, ny = x, num() + (y if rel else 0)
            if not cur: start(x, y)
            line_to(nx, ny)
            x, y = nx, ny
            last_ctrl = None
        elif c in "CSQT":
            if not cur: start(x, y)
            if c == "C":
                c1 = (num(), num()); c2 = (num(), num()); e = (num(), num())
            elif c == "S":
                c1 = (2 * x - last_ctrl[0], 2 * y - last_ctrl[1]) if last_ctrl else None
                c2 = (num(), num()); e = (num(), num())
            elif c == "Q":
                q = (num(), num()); e = (num(), num())
            else:
                q = (2 * x - last_ctrl[0], 2 * y - last_ctrl[1]) if last_ctrl else (x, y)
                e = (num(), num())
            if rel:
                if c in "CS":
                    if c == "C": c1 = (x + c1[0], y + c1[1])
                    c2 = (x + c2[0], y + c2[1])
                if c == "Q": q = (x + q[0], y + q[1])
                e = (x + e[0], y + e[1])
            if c == "S" and c1 is None:
                c1 = (x, y)
            if c in "QT":  # quadratic → cubic
                c1 = (x + 2 / 3 * (q[0] - x), y + 2 / 3 * (q[1] - y))
                c2 = (e[0] + 2 / 3 * (q[0] - e[0]), e[1] + 2 / 3 * (q[1] - e[1]))
                last_ctrl = q
            else:
                last_ctrl = c2
            n = 16
            pts = []
            for k in range(1, n + 1):
                t = k / n
                pts.append(((1 - t) ** 3 * x + 3 * (1 - t) ** 2 * t * c1[0] + 3 * (1 - t) * t * t * c2[0] + t ** 3 * e[0],
                            (1 - t) ** 3 * y + 3 * (1 - t) ** 2 * t * c1[1] + 3 * (1 - t) * t * t * c2[1] + t ** 3 * e[1]))
            flat_to(pts)
            x, y = e
        elif c == "A":
            rx, ry, rot, fa, fs = num(), num(), num(), num(), num()
            nx, ny = num(), num()
            if rel: nx, ny = x + nx, y + ny
            if not cur: start(x, y)
            if rx == 0 or ry == 0 or (nx == x and ny == y):
                line_to(nx, ny)
            else:
                cx, cy, rx2, ry2, t1, dt = svg_arc_center(x, y, rx, ry, math.radians(rot), int(fa), int(fs), nx, ny)
                if abs(rx2 - ry2) < 1e-9 and sim:
                    # circular arc: exact bulge. SVG y-down + DXF flip + mirroring transforms decide the sign
                    bulge = math.tan(dt / 4) * yflip * det_sign
                    cur[-1][2] = bulge
                    line_to(nx, ny)
                else:  # elliptical or skewed: flatten
                    n = max(4, int(abs(dt) * max(rx2, ry2) * scale_of(m) / flatten_step))
                    phi = math.radians(rot)
                    pts = []
                    for k in range(1, n + 1):
                        a = t1 + dt * k / n
                        px, py = rx2 * math.cos(a), ry2 * math.sin(a)
                        pts.append((cx + px * math.cos(phi) - py * math.sin(phi), cy + px * math.sin(phi) + py * math.cos(phi)))
                    flat_to(pts)
            x, y = nx, ny
            last_ctrl = None
        else:
            raise DocError(f"Unsupported path command '{cmd}'")
    if len(cur) > 1:
        contours.append(Contour(cur, False))
    return contours


def f_(a, k, default=0.0):
    try:
        return float(a.get(k, default))
    except (TypeError, ValueError):
        return default


def element_shapes(e, flip_h: float | None):
    """[('circle', cx, cy, r) | ('contour', Contour) | ('text', x, y, h, s)] in output coords."""
    a = e.attrs
    m = parse_transform(a.get("transform"))
    out = lambda px, py: (lambda X, Y: (X, flip_h - Y) if flip_h is not None else (X, Y))(*apply(m, px, py))
    tag = e.tag
    if tag == "circle":
        r = f_(a, "r")
        if is_similarity(m):
            cx, cy = out(f_(a, "cx"), f_(a, "cy"))
            return [("circle", cx, cy, r * scale_of(m))]
        cx0, cy0 = f_(a, "cx"), f_(a, "cy")
        d = f"M {cx0 - r} {cy0} A {r} {r} 0 1 0 {cx0 + r} {cy0} A {r} {r} 0 1 0 {cx0 - r} {cy0} Z"
        return [("contour", c) for c in path_contours(d, m, flip_h)]
    if tag == "ellipse":
        cx, cy, rx, ry = f_(a, "cx"), f_(a, "cy"), f_(a, "rx"), f_(a, "ry")
        d = f"M {cx - rx} {cy} A {rx} {ry} 0 1 0 {cx + rx} {cy} A {rx} {ry} 0 1 0 {cx - rx} {cy} Z"
        return [("contour", c) for c in path_contours(d, m, flip_h)]
    if tag == "line":
        return [("contour", Contour([[*out(f_(a, "x1"), f_(a, "y1")), 0], [*out(f_(a, "x2"), f_(a, "y2")), 0]], False))]
    if tag == "rect":
        x, y, w, h = f_(a, "x"), f_(a, "y"), f_(a, "width"), f_(a, "height")
        rx = f_(a, "rx", f_(a, "ry", 0)); ry = f_(a, "ry", rx)
        rx, ry = min(rx, w / 2), min(ry, h / 2)
        if rx > 0 and ry > 0:
            d = (f"M {x + rx} {y} H {x + w - rx} A {rx} {ry} 0 0 1 {x + w} {y + ry} V {y + h - ry} "
                 f"A {rx} {ry} 0 0 1 {x + w - rx} {y + h} H {x + rx} A {rx} {ry} 0 0 1 {x} {y + h - ry} "
                 f"V {y + ry} A {rx} {ry} 0 0 1 {x + rx} {y} Z")
        else:
            d = f"M {x} {y} H {x + w} V {y + h} H {x} Z"
        return [("contour", c) for c in path_contours(d, m, flip_h)]
    if tag in ("polygon", "polyline"):
        nums = [float(v) for v in re.findall(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?", a.get("points", ""))]
        pts = [[*out(nums[k], nums[k + 1]), 0] for k in range(0, len(nums) - 1, 2)]
        return [("contour", Contour(pts, tag == "polygon"))] if len(pts) > 1 else []
    if tag == "path":
        shapes = []
        for c in path_contours(a.get("d", ""), m, flip_h):
            circ = as_circle(c)
            shapes.append(("circle", *circ) if circ else ("contour", c))
        return shapes
    if tag == "text":
        X, Y = out(f_(a, "x"), f_(a, "y"))
        return [("text", X, Y, f_(a, "font-size", 10) * scale_of(m), e.text)]
    return []


def as_circle(c: Contour):
    """A closed contour of two semicircles (how circles are drawn as paths) → (cx, cy, r)."""
    if c.closed and len(c.pts) == 2 and all(abs(abs(p[2]) - 1) < 1e-6 for p in c.pts):
        (x1, y1, _), (x2, y2, _) = c.pts
        return ((x1 + x2) / 2, (y1 + y2) / 2, math.dist((x1, y1), (x2, y2)) / 2)
    return None


def shape_points(shape):
    if shape[0] == "circle":
        _, cx, cy, r = shape
        return [(cx - r, cy - r), (cx + r, cy + r)]
    if shape[0] == "contour":
        return shape[1].points()
    return [(shape[1], shape[2])]


def bbox(elements, flip_h=None):
    pts = [p for e in elements for s in element_shapes(e, flip_h) for p in shape_points(s)]
    if not pts:
        return None
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


# ── DXF ─────────────────────────────────────────────────────────────────

def dxf_bytes(doc: Document, elements, width: float, height: float, offset=(0.0, 0.0)) -> bytes:
    """DXF (R2010, mm) of `elements` using the document's layers. offset shifts in doc coords."""
    import ezdxf

    out = ezdxf.new("R2010", setup=True)
    out.units = ezdxf.units.MM
    out.header["$INSUNITS"] = 4
    out.header["$MEASUREMENT"] = 1
    msp = out.modelspace()
    ox, oy = offset
    for layer in doc.layers:
        if any(e.layer == layer.name for e in elements):
            dl = out.layers.add(layer.name)
            rgb = tuple(int(layer.color[i:i + 2], 16) for i in (1, 3, 5))
            dl.rgb = rgb
            if layer.description:
                dl.description = layer.description[:255]
    for e in elements:
        attribs = {"layer": e.layer}
        for s in element_shapes(e, height):
            if s[0] == "circle":
                msp.add_circle((s[1] - ox, s[2] + oy), s[3], dxfattribs=attribs)
            elif s[0] == "contour":
                c = s[1]
                pts = [(x - ox, y + oy, 0, 0, b) for x, y, b in c.pts]
                msp.add_lwpolyline(pts, format="xyseb", close=c.closed, dxfattribs=attribs)
            elif s[0] == "text" and s[4].strip():
                msp.add_text(s[4], height=max(s[3] * 0.7, 0.5),
                             dxfattribs={**attribs, "insert": (s[1] - ox, s[2] + oy)})
    buf = io.StringIO()
    out.write(buf)
    return buf.getvalue().encode("utf-8")


def cnc_elements(doc: Document, ids=None):
    """Elements on layers marked for export (visibility is only a view setting)."""
    usable = {l.name for l in doc.layers if l.export}
    return [e for e in doc.elements if e.layer in usable and (ids is None or e.id in ids)]


def cnc_dxf(doc: Document) -> bytes:
    return dxf_bytes(doc, cnc_elements(doc), doc.width, doc.height)


# ── Entities → part files (for nesting software) ────────────────────────

def safe_name(s: str) -> str:
    return re.sub(r"[^\w\-]+", "-", s.strip()).strip("-").lower() or "part"


def part_files(doc: Document) -> list[tuple[str, bytes]]:
    """For each top-level entity: '<name>_x<qty>.svg' and '.dxf', cut layers only, moved to
    the origin. Loose elements (not in any entity) are skipped."""
    files, used = [], set()
    tops = [g for g in doc.groups if not g.parent]
    if not tops:
        raise DocError("No entities: group each part first (select its shapes → Group)")
    for g in tops:
        ids = set(doc.descendants(g.id))
        els = cnc_elements(doc, ids)
        if not els:
            continue
        x0, y0, x1, y1 = bbox(els)
        w, h = x1 - x0, y1 - y0
        stem = f"{safe_name(g.name)}_x{g.qty}"   # safe for any file system
        while stem in used:
            stem += "-2"
        used.add(stem)
        layers = {l.name: l for l in doc.layers}
        body = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w:.3f}mm" height="{h:.3f}mm" '
                f'viewBox="0 0 {w:.3f} {h:.3f}">', f'<g transform="translate({-x0:.3f}, {-y0:.3f})">']
        body += [element_svg(e, layers[e.layer], with_id=False) for e in els]
        body += ["</g>", "</svg>"]
        files.append((f"{stem}.svg", "\n".join(body).encode("utf-8")))
        # DXF: flip about the part's own box so it sits at the origin
        files.append((f"{stem}.dxf", dxf_bytes(doc, els, w, doc.height, offset=(x0, -(doc.height - y1)))))
    return files


def parts_zip(doc: Document) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        names = []
        for name, data in part_files(doc):
            z.writestr(name, data)
            names.append(name)
        z.writestr("README.txt", "One file per part (SVG and DXF, mm, cut layers only).\n"
                   "The _xN suffix is the quantity to cut. Load them into nesting software\n"
                   "(e.g. Deepnest, SVGnest) to pack them on your sheets.\n\n" + "\n".join(names))
    return buf.getvalue()


# ── Sheets → one file per sheet (what goes on the machine as one job) ─────

SHEETS_LAYER = "SHEETS"


def sheet_rects(doc: Document) -> list[tuple[float, float, float, float]]:
    """The stock sheets: rects on the SHEETS layer (arrange_parts draws them), in drawing order."""
    out = []
    for e in doc.elements:
        if e.layer == SHEETS_LAYER and e.tag == "rect":
            x0, y0, x1, y1 = bbox([e])
            out.append((x0, y0, x1 - x0, y1 - y0))
    return out


def sheet_files(doc: Document) -> tuple[list[tuple[str, bytes]], list[dict]]:
    """For each sheet: 'sheet-<n>_<w>x<h>.svg' and '.dxf' holding the cut shapes that lie on it,
    with the sheet's corner at 0,0 (SVG: top-left; DXF: bottom-left, y up). Returns the files and
    a summary per sheet (file stem, size, part names). Shapes on no sheet are listed as 'off_sheet'."""
    rects = sheet_rects(doc)
    if not rects:
        raise DocError("No sheets: run arrange_parts, or draw the stock as rectangles on the SHEETS layer")
    layers = {l.name: l for l in doc.layers}
    groups = {g.id: g for g in doc.groups}

    def part_name(e):
        g = groups.get(e.group)
        while g and g.parent in groups:
            g = groups[g.parent]
        return g.name if g else "loose shapes"

    placed, files, sheets = set(), [], []
    els = cnc_elements(doc)
    for n, (sx, sy, sw, sh) in enumerate(rects, 1):
        on = []
        for e in els:
            b = bbox([e])
            if b and b[0] >= sx - 0.01 and b[1] >= sy - 0.01 and b[2] <= sx + sw + 0.01 and b[3] <= sy + sh + 0.01:
                on.append(e)
        placed.update(e.id for e in on)
        stem = f"sheet-{n}_{sw:g}x{sh:g}"
        sheets.append({"sheet": n, "file": stem, "size": [round(sw, 3), round(sh, 3)],
                       "parts": list(dict.fromkeys(part_name(e) for e in on))})
        if not on:
            continue
        body = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{sw:.3f}mm" height="{sh:.3f}mm" '
                f'viewBox="0 0 {sw:.3f} {sh:.3f}">', f'<g transform="translate({-sx:.3f}, {-sy:.3f})">']
        body += [element_svg(e, layers[e.layer], with_id=False) for e in on]
        body += ["</g>", "</svg>"]
        files.append((f"{stem}.svg", "\n".join(body).encode("utf-8")))
        files.append((f"{stem}.dxf", dxf_bytes(doc, on, sw, doc.height, offset=(sx, -(doc.height - (sy + sh))))))
    off = [e for e in els if e.id not in placed]
    if off:
        sheets.append({"off_sheet": list(dict.fromkeys(part_name(e) for e in off))})
    return files, sheets


def sheets_zip(doc: Document) -> bytes:
    files, sheets = sheet_files(doc)
    lines = []
    for s in sheets:
        if "off_sheet" in s:
            lines.append("NOT ON ANY SHEET (not exported): " + ", ".join(s["off_sheet"]))
        else:
            w, h = s["size"]
            lines.append(f"{s['file']}  ({w:g} x {h:g} mm): " + (", ".join(s["parts"]) or "empty, no file"))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files:
            z.writestr(name, data)
        z.writestr("README.txt", "One file per sheet (SVG and DXF, mm, cut layers only): one job on the machine.\n"
                   "0,0 is the sheet's corner (DXF: bottom-left). Layers: POCKET/pockets first, then\n"
                   "CUT_INSIDE (inside the line), then CUT_OUTSIDE (outside the line, with tabs).\n\n"
                   + "\n".join(lines) + "\n")
    return buf.getvalue()


# ── DXF import ──────────────────────────────────────────────────────────

DXF_UNITS_MM = {0: 1.0, 1: 25.4, 2: 304.8, 3: 1609344.0, 4: 1.0, 5: 10.0, 6: 1000.0, 7: 1000000.0,
                8: 2.54e-5, 9: 0.0254, 10: 914.4, 11: 1e-7, 12: 1e-6, 13: 1e-3, 14: 100.0}


def dxf_to_svg(data: bytes) -> str:
    """Convert a 2D DXF into an SVG in this editor's file format (mm, one layer per DXF layer,
    layer colours kept). Y is flipped; the drawing is moved to 10 mm from the origin."""
    import ezdxf
    from ezdxf import colors, recover
    try:
        src, auditor = recover.read(io.BytesIO(data))
    except Exception as e:
        raise DocError(f"Not a readable DXF file: {e}")
    k = DXF_UNITS_MM.get(src.header.get("$INSUNITS", 0), 1.0)

    items = []   # (layer, kind, payload) in DXF coords (Y up, drawing units)

    def mirrored_ocs(entity):
        ex = entity.dxf.get("extrusion", None)
        return ex is not None and abs(ex[2] + 1) < 1e-9

    def collect(entity, depth=0):
        t = entity.dxftype()
        layer = entity.dxf.get("layer", "0")
        try:
            if t in ("ARC", "CIRCLE", "LWPOLYLINE", "ELLIPSE") and mirrored_ocs(entity):
                # Entities in a mirrored coordinate system (e.g. from mirrored blocks): let ezdxf
                # convert them to world coordinates as a polyline
                from ezdxf import path as ezpath
                pts = [(v.x, v.y, 0) for v in ezpath.make_path(entity).flattening(0.02)]
                closed = len(pts) > 2 and math.dist(pts[0][:2], pts[-1][:2]) < 1e-6
                if closed:
                    pts = pts[:-1]
                if len(pts) > 1:
                    items.append((layer, "poly", (pts, closed)))
            elif t == "INSERT" and depth < 8:
                for v in entity.virtual_entities():
                    collect(v, depth + 1)
            elif t == "LINE":
                s_, e_ = entity.dxf.start, entity.dxf.end
                items.append((layer, "poly", ([(s_.x, s_.y, 0), (e_.x, e_.y, 0)], False)))
            elif t == "LWPOLYLINE":
                pts = [(x, y, b) for x, y, b in entity.get_points("xyb")]
                if len(pts) > 1:
                    items.append((layer, "poly", (pts, entity.closed)))
            elif t == "POLYLINE" and not entity.is_3d_polyline and not entity.is_poly_face_mesh:
                pts = [(v.dxf.location.x, v.dxf.location.y, v.dxf.get("bulge", 0)) for v in entity.vertices]
                if len(pts) > 1:
                    items.append((layer, "poly", (pts, entity.is_closed)))
            elif t == "CIRCLE":
                c = entity.dxf.center
                items.append((layer, "circle", (c.x, c.y, entity.dxf.radius)))
            elif t == "ARC":
                c, r = entity.dxf.center, entity.dxf.radius
                a0, a1 = math.radians(entity.dxf.start_angle), math.radians(entity.dxf.end_angle)
                sweep = (a1 - a0) % (2 * math.pi) or 2 * math.pi
                p0 = (c.x + r * math.cos(a0), c.y + r * math.sin(a0))
                p1 = (c.x + r * math.cos(a0 + sweep), c.y + r * math.sin(a0 + sweep))
                items.append((layer, "arc", (p0, p1, r, sweep)))
            elif t in ("TEXT", "MTEXT"):
                ins = entity.dxf.insert
                text = entity.plain_text() if t == "MTEXT" else entity.dxf.text
                h = entity.dxf.get("char_height" if t == "MTEXT" else "height", 2.5)
                items.append((layer, "text", (ins.x, ins.y, h, text)))
            elif t in ("ELLIPSE", "SPLINE", "HATCH", "SOLID", "3DFACE") or hasattr(entity, "flattening"):
                if t == "HATCH":
                    return
                pts = [(v.x, v.y, 0) for v in entity.flattening(0.05)]
                closed = len(pts) > 2 and math.dist(pts[0][:2], pts[-1][:2]) < 1e-6
                if closed:
                    pts = pts[:-1]
                if len(pts) > 1:
                    items.append((layer, "poly", (pts, closed)))
        except Exception:
            pass  # skip entities ezdxf can't interpret rather than failing the whole import

    for entity in src.modelspace():
        collect(entity)
    if not items:
        raise DocError("The DXF has no 2D geometry this editor can import")

    # bounds (drawing units)
    xs, ys = [], []
    for _, kind, p in items:
        if kind == "poly":
            pts, closed = p
            n = len(pts)
            for i, (x, y, b) in enumerate(pts):
                xs.append(x); ys.append(y)
                if b and (i < n - 1 or closed):       # include arc bulges in the bounds
                    x2, y2, _ = pts[(i + 1) % n]
                    for ax, ay in arc_points(x, y, x2, y2, b, 1.0):
                        xs.append(ax); ys.append(ay)
        elif kind == "circle":
            xs += [p[0] - p[2], p[0] + p[2]]; ys += [p[1] - p[2], p[1] + p[2]]
        elif kind == "arc":
            (x0, y0), (x1, y1), r, sweep = p
            xs += [x0, x1]; ys += [y0, y1]
            b = math.tan(sweep / 4)
            for ax, ay in arc_points(x0, y0, x1, y1, b, 1.0):
                xs.append(ax); ys.append(ay)
        else:
            xs.append(p[0]); ys.append(p[1])
    minx, maxy = min(xs), max(ys)
    margin = 10.0
    W = (max(xs) - minx) * k + 2 * margin
    H = (maxy - min(ys)) * k + 2 * margin
    X = lambda x: (x - minx) * k + margin
    Y = lambda y: (maxy - y) * k + margin
    r3 = lambda v: f"{v:.4f}".rstrip("0").rstrip(".")

    def arc_cmd(x1, y1, x2, y2, bulge):
        theta = 4 * math.atan(bulge)
        chord = math.hypot(x2 - x1, y2 - y1)
        r = chord / (2 * math.sin(abs(theta) / 2)) * k
        # DXF Y-up counter-clockwise (positive bulge) becomes clockwise on screen: sweep 1
        return f"A {r3(r)} {r3(r)} 0 {1 if abs(theta) > math.pi else 0} {1 if theta > 0 else 0} {r3(X(x2))} {r3(Y(y2))}"

    by_layer: dict[str, list[str]] = {}
    for layer, kind, p in items:
        out = by_layer.setdefault(layer, [])
        if kind == "poly":
            pts, closed = p
            d = [f"M {r3(X(pts[0][0]))} {r3(Y(pts[0][1]))}"]
            n = len(pts)
            for i in range(n if closed else n - 1):
                x1, y1, b = pts[i]
                x2, y2, _ = pts[(i + 1) % n]
                d.append(arc_cmd(x1, y1, x2, y2, b) if b else f"L {r3(X(x2))} {r3(Y(y2))}")
            out.append(f'<path d="{" ".join(d)}{" Z" if closed else ""}" fill="none"/>')
        elif kind == "circle":
            out.append(f'<circle cx="{r3(X(p[0]))}" cy="{r3(Y(p[1]))}" r="{r3(p[2] * k)}" fill="none"/>')
        elif kind == "arc":
            (x0, y0), (x1, y1), r, sweep = p
            out.append(f'<path d="M {r3(X(x0))} {r3(Y(y0))} A {r3(r * k)} {r3(r * k)} 0 {1 if sweep > math.pi else 0} 1 '
                       f'{r3(X(x1))} {r3(Y(y1))}" fill="none"/>')
        else:
            x, y, h, text = p
            if text.strip():
                from xml.sax.saxutils import escape
                out.append(f'<text x="{r3(X(x))}" y="{r3(Y(y))}" font-size="{r3(h * k)}" font-family="sans-serif">{escape(text)}</text>')

    from xml.sax.saxutils import quoteattr
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" '
             f'width="{r3(W)}mm" height="{r3(H)}mm" viewBox="0 0 {r3(W)} {r3(H)}">']
    for i, (name, shapes) in enumerate(by_layer.items(), 1):
        color = "#000000"
        if name in src.layers:
            dl = src.layers.get(name)
            rgb = dl.rgb if dl.rgb else colors.aci2rgb(abs(dl.color) or 7)
            if rgb and tuple(rgb) != (255, 255, 255):
                color = "#%02x%02x%02x" % tuple(rgb)
        parts.append(f'<g inkscape:groupmode="layer" inkscape:label={quoteattr(name)} data-color="{color}">')
        parts += shapes
        parts.append("</g>")
    parts.append("</svg>")
    return "\n".join(parts)
