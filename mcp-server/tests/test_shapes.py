"""shapes.py: slots, rounded rects, outlines, fillets and dog-bones as exact paths."""
import math

import pytest

import shapes
from document import DocError, Element
from export import IDENTITY, as_circle, path_contours


def contours(d):
    return path_contours(d, IDENTITY, None)


def box(d):
    pts = [p for c in contours(d) for p in c.points(0.5)]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return tuple(round(v, 1) for v in (min(xs), min(ys), max(xs), max(ys)))


def arcs(d):
    return sum(1 for c in contours(d) for p in c.pts if abs(p[2]) > 1e-9)


def el(tag, layer="CUT_OUTSIDE", **attrs):
    return Element("el-1", tag, layer, {k: str(v) for k, v in attrs.items()})


def test_slot_extent_and_closed():
    d = shapes.slot_d(10, 20, 110, 20, 12)
    (c,) = contours(d)
    assert c.closed and arcs(d) == 2
    assert box(d) == (4, 14, 116, 26)


def test_slot_diagonal_and_zero_length():
    d = shapes.slot_d(0, 0, 30, 40, 10)
    assert box(d) == (-5, -5, 35, 45)
    (c,) = contours(shapes.slot_d(7, 8, 7, 8, 10))
    assert as_circle(c) == pytest.approx((7, 8, 5))


def test_rounded_rect_and_clamp():
    assert box(shapes.rounded_rect_d(0, 0, 100, 40, 10)) == (0, 0, 100, 40)
    assert arcs(shapes.rounded_rect_d(0, 0, 100, 40, 10)) == 4
    assert arcs(shapes.rounded_rect_d(0, 0, 100, 40, 0)) == 0
    d = shapes.rounded_rect_d(0, 0, 100, 40, 500)          # clamped to 20: stadium
    assert box(d) == (0, 0, 100, 40) and "A 20.000 20.000" in d


def test_outline_per_corner_radius():
    d = shapes.outline_d([[0, 0], [200, 0, 30], [200, 100], [0, 100, 10]])
    assert box(d) == (0, 0, 200, 100) and arcs(d) == 2
    # a duplicate closing point is ignored
    d = shapes.outline_d([[0, 0], [50, 0], [50, 50], [0, 0]])
    assert shapes.vertices(el("path", d=d)) == [(0, 0), (50, 0), (50, 50)]


def test_outline_errors():
    with pytest.raises(DocError, match="at least 3"):
        shapes.outline_d([[0, 0], [1, 1]])
    with pytest.raises(DocError, match="points\\[1\\]"):
        shapes.outline_d([[0, 0], "x", [1, 1]])
    with pytest.raises(DocError, match="width must be > 0"):
        shapes.slot_d(0, 0, 10, 0, 0)


def test_fillet_rect_some_and_all():
    r = el("rect", x=0, y=0, width=100, height=50, transform="translate(5 5)")
    a = shapes.fillet_attrs(r, 10, [1])
    assert arcs(a["d"]) == 1 and a["transform"] == "translate(5 5)" and "width" not in a
    assert arcs(shapes.fillet_attrs(r, 10)["d"]) == 4
    # a clicked point in document coords picks the nearest corner (transform applied)
    a = shapes.fillet_attrs(r, 10, [[106, 56]])
    (c,) = contours(a["d"])
    assert any(abs(p[2]) > 0 for p in c.pts)
    assert box(a["d"]) == (0, 0, 100, 50)
    with pytest.raises(DocError, match="no corner within"):
        shapes.fillet_attrs(r, 10, [[50, 25]])


def test_fillet_polygon_and_path_of_lines():
    p = el("polygon", points="0,0 100,0 100,100")
    assert arcs(shapes.fillet_attrs(p, 5)["d"]) == 3
    q = el("path", d="M 0 0 h 100 v 60 H 0 Z")
    assert box(shapes.fillet_attrs(q, 500)["d"]) == (0, 0, 100, 60)   # radius clamped
    with pytest.raises(DocError, match="no sharp corner"):
        shapes.fillet_attrs(el("path", d=shapes.slot_d(0, 0, 10, 0, 4)), 1)
    with pytest.raises(DocError, match="Bézier"):
        shapes.fillet_attrs(el("path", d="M 0 0 L 10 0 C 10 5 5 10 0 10 Z"), 1)
    with pytest.raises(DocError, match="<circle>"):
        shapes.fillet_attrs(el("circle", cx=0, cy=0, r=5), 1)


def test_dogbone_hole_all_corners_pass_through_corner():
    h = el("rect", layer="CUT_INSIDE", x=0, y=0, width=40, height=18)
    d = shapes.dogbone_attrs(h, 6)["d"]
    assert arcs(d) == 4
    x0, y0, x1, y1 = box(d)
    # each relief is a Ø6 circle through the corner, centred on the diagonal: it bulges out
    assert x0 < 0 and y0 < 0 and x1 > 40 and y1 > 18
    assert -x0 == round(3 * (1 - 1 / math.sqrt(2)), 1)


def test_dogbone_auto_outline_only_concave():
    # tenon: two concave shoulders
    t = el("polygon", points="0,0 100,0 100,30 130,30 130,70 100,70 100,100 0,100")
    d = shapes.dogbone_attrs(t, 6)["d"]
    assert arcs(d) == 2
    with pytest.raises(DocError, match="no corner"):
        shapes.dogbone_attrs(el("rect", x=0, y=0, width=10, height=10), 6)
    with pytest.raises(DocError, match="too short"):
        shapes.dogbone_attrs(el("rect", layer="CUT_INSIDE", x=0, y=0, width=4, height=4), 6)


def test_edits_keep_earlier_arcs():
    """Fillet one corner, then another, then dog-bone a third: each keeps what came before."""
    r = el("rect", layer="CUT_INSIDE", x=0, y=0, width=100, height=60)
    r = el("path", layer="CUT_INSIDE", **shapes.fillet_attrs(r, 10, [0]))
    r = el("path", layer="CUT_INSIDE", **shapes.fillet_attrs(r, 5, [[100, 0]]))
    assert arcs(r.attrs["d"]) == 2 and box(r.attrs["d"]) == (0, 0, 100, 60)
    with pytest.raises(DocError, match="on a curve"):
        shapes.fillet_attrs(r, 5, [0])                 # a tangent point of the first fillet
    d = shapes.dogbone_attrs(r, 6)["d"]                # auto: only the two remaining sharp corners
    assert arcs(d) == 4
    (c,) = contours(d)
    assert c.closed
    x0, y0, x1, y1 = box(d)
    assert y0 == 0 and x0 < 0 and x1 > 100 and y1 > 60   # reliefs bulge at the bottom corners only
