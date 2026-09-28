"""Exact geometry for the shape ops: paths of lines and arcs in document coordinates.

slot, rounded rect and outline (a fillet radius per corner) make new paths; fillet / dog-bone
rebuild an existing shape (rect, polygon, polyline, path of lines and circular arcs), at corners
between two straight edges, keeping its other arcs. The maths
is kerf_script's build() / to_path(), shared with parametric scripts.
"""
from __future__ import annotations

import math
import re

import kerf_script as ks
from document import DocError, Element
from export import apply, parse_transform, svg_arc_center, tokenize_path

NUM = r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"
# Attributes that describe the old geometry: dropped when a shape becomes a path
GEOMETRY_ATTRS = ("x", "y", "width", "height", "rx", "ry", "points", "d", "x1", "y1", "x2", "y2", "cx", "cy", "r")


def num(v, name: str, positive: bool = False) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        raise DocError(f"{name} must be a number") from None
    if not math.isfinite(x):
        raise DocError(f"{name} must be a finite number")
    if positive and x <= 0:
        raise DocError(f"{name} must be > 0")
    return x


# ── new shapes ───────────────────────────────────────────────

def slot_d(x1, y1, x2, y2, width) -> str:
    """Straight slot with round ends along (x1, y1) → (x2, y2); zero length = a circle."""
    return ks.to_path(ks.slot(num(x1, "x1"), num(y1, "y1"), num(x2, "x2"), num(y2, "y2"),
                              num(width, "width", True)))


def rounded_rect_d(x, y, width, height, r) -> str:
    x, y = num(x, "x"), num(y, "y")
    w, h = num(width, "width", True), num(height, "height", True)
    return ks.to_path(ks.rounded_rect(x, y, x + w, y + h, max(0.0, num(r or 0, "r"))))


def outline_d(points) -> str:
    """Closed outline through points [[x, y] | [x, y, r], ...]; r rounds that corner."""
    if not isinstance(points, (list, tuple)):
        raise DocError("points must be a list of [x, y] or [x, y, r]")
    raw = []
    for k, p in enumerate(points):
        if not isinstance(p, (list, tuple)) or len(p) not in (2, 3):
            raise DocError(f"points[{k}] must be [x, y] or [x, y, r]")
        r = max(0.0, num(p[2], f"points[{k}] radius")) if len(p) == 3 else 0.0
        raw.append((num(p[0], f"points[{k}] x"), num(p[1], f"points[{k}] y"), r))
    pts3 = _dedupe(raw)
    if len(pts3) < 3:
        raise DocError("An outline needs at least 3 distinct points")
    pts = [p[:2] for p in pts3]
    return ks.to_path(ks.build(pts, _fit_fillets(pts, {i: p[2] for i, p in enumerate(pts3)})))


# ── editing an existing shape ────────────────────────────────

def vertices(el: Element) -> list[tuple[float, float]]:
    """Corners of an element, in its own coordinates (before its transform)."""
    return outline_of(el)[0]


def outline_of(el: Element):
    """(vertices, arcs) of an element in its own coordinates; arcs = {i: (centre, via)} for an
    edge from vertex i to vertex i + 1 (wrapping) that is a circular arc."""
    a = el.attrs
    arcs = {}
    if el.tag == "rect":
        if num(a.get("rx", 0), "rx") > 0 or num(a.get("ry", 0), "ry") > 0:
            raise DocError(f"{el.id} already has rounded corners")
        x, y = num(a.get("x", 0), "x"), num(a.get("y", 0), "y")
        w, h = num(a.get("width", 0), "width"), num(a.get("height", 0), "height")
        pts = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
    elif el.tag in ("polygon", "polyline"):
        v = [float(t) for t in re.findall(NUM, a.get("points", ""))]
        pts = [(v[i], v[i + 1]) for i in range(0, len(v) - 1, 2)]
    elif el.tag == "path":
        pts, arcs = _path_outline(el.id, a.get("d", ""))
    else:
        raise DocError(f"{el.id} is a <{el.tag}>: fillets and dog-bones work on rects, polygons "
                       "and paths")
    if not arcs:
        pts = _dedupe(pts)
    if len(pts) < 3:
        raise DocError(f"{el.id} needs at least 3 corners")
    return pts, arcs


def _straight(pts, arcs, i) -> bool:
    """Both edges at corner i are straight lines (a fillet/dog-bone can go there)."""
    return (i - 1) % len(pts) not in arcs and i not in arcs


def _with_arcs(pts, arcs):
    """Vertices with ("arc", centre, via) items, as kerf_script.build() takes them."""
    out = []
    for i, p in enumerate(pts):
        out.append(p)
        if i in arcs:
            out.append(("arc", *arcs[i]))
    return out


def fillet_attrs(el: Element, r, corners=None, tol: float = 5.0) -> dict:
    """New attrs (a path) for el with the chosen corners rounded to r (clamped to fit)."""
    r = num(r, "r", True)
    pts, arcs = outline_of(el)
    idx = _corner_indices(el, pts, arcs, corners, tol)
    spec = _fit_fillets(pts, {i: r for i in idx})
    if not spec:
        raise DocError(f"{el.id} has no sharp corner between two straight edges to round")
    return _rebuilt(el, ks.build(_with_arcs(pts, arcs), spec))


def dogbone_attrs(el: Element, tool_d, corners="auto", tol: float = 5.0) -> dict:
    """New attrs (a path) for el with a dog-bone of Ø tool_d at the chosen corners. "auto": every
    corner of a hole (CUT_INSIDE), otherwise every concave corner (tenon shoulders)."""
    rad = num(tool_d, "tool_d", True) / 2
    pts, arcs = outline_of(el)
    if corners in (None, "auto"):
        idx = range(len(pts)) if el.layer == "CUT_INSIDE" else _concave(pts)
        idx = [i for i in idx if _straight(pts, arcs, i)]
    else:
        idx = _corner_indices(el, pts, arcs, corners, tol)
    spec = {}
    for i in idx:
        th = _angle(pts, i)
        if th < 1e-6 or th > math.pi - 1e-6:
            continue
        need = 2 * rad * math.cos(th / 2)
        if need > min(math.dist(pts[i], pts[i - 1]), math.dist(pts[i], pts[(i + 1) % len(pts)])) + 1e-9:
            raise DocError(f"{el.id}: the edges at corner {i} are too short for a Ø{2 * rad:g} dog-bone")
        spec[i] = ("dog", rad)
    if not spec:
        raise DocError(f"{el.id} has no corner that needs a dog-bone")
    return _rebuilt(el, ks.build(_with_arcs(pts, arcs), spec))


# ── helpers ──────────────────────────────────────────────────

def _dedupe(pts):
    out = []
    for p in pts:
        if not out or math.dist(p[:2], out[-1][:2]) > 1e-6:
            out.append(p)
    if len(out) > 1 and math.dist(out[0][:2], out[-1][:2]) <= 1e-6:
        out.pop()
    return out


def _angle(pts, i) -> float:
    """Interior angle between the two edges at vertex i (π = straight)."""
    v, a, b = pts[i], pts[i - 1], pts[(i + 1) % len(pts)]
    u1, u2 = ks._unit(ks._add(a, v, -1)), ks._unit(ks._add(b, v, -1))
    return math.acos(max(-1.0, min(1.0, u1[0] * u2[0] + u1[1] * u2[1])))


def _fit_fillets(pts, radii: dict) -> dict:
    """{i: ("fillet", r)}, each r shrunk so its tangent points stay within half of each edge."""
    corners = {}
    for i, r in radii.items():
        if r <= 0:
            continue
        th = _angle(pts, i)
        if th < 1e-6 or th > math.pi - 1e-6:
            continue                                    # straight: nothing to round
        tmax = 0.5 * min(math.dist(pts[i], pts[i - 1]), math.dist(pts[i], pts[(i + 1) % len(pts)]))
        corners[i] = ("fillet", min(r, tmax * math.tan(th / 2)))
    return corners


def _concave(pts) -> list[int]:
    n = len(pts)
    area = sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1] for i in range(n))
    out = []
    for i in range(n):
        p, v, q = pts[i - 1], pts[i], pts[(i + 1) % n]
        if ((v[0] - p[0]) * (q[1] - v[1]) - (v[1] - p[1]) * (q[0] - v[0])) * area < 0:
            out.append(i)
    return out


def _corner_indices(el, pts, arcs, corners, tol) -> list[int]:
    """corners: None / "all" = every corner between straight edges; a list of vertex indices or
    [x, y] points in document coordinates (the nearest corner within tol mm)."""
    if corners in (None, "all"):
        return [i for i in range(len(pts)) if _straight(pts, arcs, i)]
    if not isinstance(corners, (list, tuple)) or not corners:
        raise DocError('corners must be "all" or a list of corner indices or [x, y] points')
    m = parse_transform(el.attrs.get("transform"))
    doc_pts = [apply(m, *p) for p in pts]
    out = []
    for c in corners:
        if isinstance(c, (list, tuple)) and len(c) == 2:
            x, y = num(c[0], "corner x"), num(c[1], "corner y")
            d, i = min((math.dist((x, y), q), i) for i, q in enumerate(doc_pts))
            if d > tol:
                raise DocError(f"{el.id} has no corner within {tol:g} mm of ({x:g}, {y:g})")
        else:
            try:
                i = int(c)
            except (TypeError, ValueError):
                raise DocError(f"corner {c!r} is not an index or an [x, y] point") from None
            if not 0 <= i < len(pts):
                raise DocError(f"{el.id} has corners 0–{len(pts) - 1}, not {i}")
        if not _straight(pts, arcs, i):
            raise DocError(f"{el.id}: corner {i} is on a curve; pick a corner between two straight edges")
        if i not in out:
            out.append(i)
    return out


def _rebuilt(el: Element, segs) -> dict:
    attrs = {k: v for k, v in el.attrs.items() if k not in GEOMETRY_ATTRS}
    attrs["d"] = ks.to_path(segs)
    attrs.setdefault("fill", "none")
    return attrs


def _path_outline(eid: str, d: str):
    """(vertices, arcs) of a single subpath of M/L/H/V/A/Z commands (absolute or relative)."""
    toks = tokenize_path(d)
    pts, arcs, i, cmd, x, y = [], {}, 0, None, 0.0, 0.0

    def add(p, arc=None):
        if pts and math.dist(p, pts[-1]) <= 1e-6:
            return                                  # zero-length segment
        if arc:
            arcs[len(pts) - 1] = arc
        pts.append(p)

    while i < len(toks):
        t = toks[i]
        if t.isalpha():
            cmd, i = t, i + 1
            if cmd in "Zz":
                if i < len(toks):
                    raise DocError(f"{eid} has several sub-paths: fillet or dog-bone one shape at a time")
                continue
            if cmd.upper() not in "MLHVA":
                raise DocError(f"{eid} has Bézier curves: fillets and dog-bones need lines and circular arcs")
            if cmd in "Mm" and pts:
                raise DocError(f"{eid} has several sub-paths: fillet or dog-bone one shape at a time")
            continue
        if cmd is None:
            raise DocError(f"{eid}: invalid path data")
        rel, c = cmd.islower(), cmd.upper()
        try:
            if c in "ML":
                dx, dy = float(toks[i]), float(toks[i + 1]); i += 2
                x, y = (x + dx, y + dy) if rel else (dx, dy)
                add((x, y))
                if c == "M":
                    cmd = "l" if rel else "L"       # implicit lineto after moveto
            elif c == "H":
                v = float(toks[i]); i += 1
                x = x + v if rel else v
                add((x, y))
            elif c == "V":
                v = float(toks[i]); i += 1
                y = y + v if rel else v
                add((x, y))
            else:
                rx, ry, phi, fa, fs, ex, ey = (float(v) for v in toks[i:i + 7]); i += 7
                ex, ey = (x + ex, y + ey) if rel else (ex, ey)
                if abs(abs(rx) - abs(ry)) > 1e-6 * max(abs(rx), 1):
                    raise DocError(f"{eid} has an elliptical arc: fillets and dog-bones need circular arcs")
                cx, cy, r, _, t1, dt = svg_arc_center(x, y, rx, ry, math.radians(phi), int(fa), int(fs), ex, ey)
                via = (cx + r * math.cos(t1 + dt / 2), cy + r * math.sin(t1 + dt / 2))
                if not pts:
                    pts.append((x, y))
                add((ex, ey), ((cx, cy), via))
                x, y = ex, ey
        except (IndexError, ValueError):
            raise DocError(f"{eid}: invalid path data") from None
    if len(pts) > 1 and math.dist(pts[0], pts[-1]) <= 1e-6:
        pts.pop()                                   # closed back onto the start
    return pts, arcs
