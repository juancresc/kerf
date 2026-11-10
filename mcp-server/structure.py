"""Structure: weight, centre of mass and stability of the 3D assembly, in numbers.

Every placed part is a solid: its outline minus holes, extruded to its thickness, minus its
pockets (cut from the top face). Volume × density = mass; the volume-weighted centre of the
solid, mapped to the world, is the part's centre of mass. Bought parts (HARDWARE) can carry a
real `assembly.mass` in kg instead.

Stability: the floor is the lowest point of the model. Whatever touches it (within 1 mm) makes
the footprint (its convex hull, seen from above). The model stands if the centre of mass is
inside the footprint; the margin to each edge gives the tip angle (how far it can lean before
it falls) and the sideways push at a given height that tips it over (m·g·d = F·h).

World axes as everywhere in Kerf: X = width, Y = up, Z = toward the viewer, mm.
"""
from __future__ import annotations

import math

from document import DocError, Document
from layout import Placed, _area, outline_polys, pocket_polys

G = 9.81
FLOOR_TOL = 1.0          # mm: points this close to the lowest point touch the floor

# kg/m³ by material type, when the material has no density of its own
DENSITY = {"plywood": 680, "wood": 650, "board": 750, "plastic": 1150, "metal": 2700, "foam": 60, "other": 700}
NAMED_DENSITY = (("steel", 7850), ("stainless", 7900), ("iron", 7200), ("brass", 8500), ("copper", 8900),
                 ("alumin", 2700), ("mdf", 750), ("hdf", 900), ("osb", 620), ("pine", 520), ("poplar", 480),
                 ("oak", 720), ("walnut", 640), ("acrylic", 1190), ("polycarbonate", 1200), ("hdpe", 960),
                 ("eva", 60), ("xps", 35), ("cork", 240))


def density_of(m: dict | None) -> float:
    """kg/m³ of a material dict: its own `density`, else guessed from the name, else from the type."""
    m = m or {}
    if m.get("density"):
        return float(m["density"])
    name = str(m.get("name") or "").lower()
    for key, d in NAMED_DENSITY:
        if key in name:
            return d
    return DENSITY.get(m.get("type"), 700)


def _centroid(p):
    """(signed area, cx, cy) of a polygon."""
    a = _area(p)
    if abs(a) < 1e-9:
        return 0.0, 0.0, 0.0
    cx = cy = 0.0
    for i in range(len(p)):
        x0, y0 = p[i - 1]
        x1, y1 = p[i]
        k = x0 * y1 - x1 * y0
        cx += (x0 + x1) * k
        cy += (y0 + y1) * k
    return a, cx / (6 * a), cy / (6 * a)


def _hull(pts):
    """Convex hull (counter-clockwise) of 2D points."""
    pts = sorted(set((round(x, 3), round(y, 3)) for x, y in pts))
    if len(pts) <= 2:
        return pts
    cross = lambda o, a, b: (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, hi = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
            lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(hi) >= 2 and cross(hi[-2], hi[-1], p) <= 0:
            hi.pop()
        hi.append(p)
    return lo[:-1] + hi[:-1]


def _direction(nx, nz):
    """A name for a horizontal direction (outward normal of a footprint edge)."""
    if abs(nx) >= abs(nz):
        return "right (+X)" if nx > 0 else "left (−X)"
    return "front (+Z)" if nz > 0 else "back (−Z)"


def placed_groups(doc: Document) -> list:
    """Parts the 3D preview shows (groups with an assembly), without the ones inside a placed
    entity (its solid already includes them)."""
    placed = {g.id for g in doc.groups if g.assembly}
    return [g for g in doc.groups if g.assembly and not any(a in placed for a in doc.ancestors(g.parent))]


def part_mass(doc: Document, g, thick: float) -> dict | None:
    """{volume_cm3, kg, density, local centre, Placed} of one placed part, or None if it has no shape."""
    outers, holes = outline_polys(doc, g.id)
    if not outers:
        return None
    pockets = pocket_polys(doc, g.id)
    p = Placed(g, thick, outers, holes, pockets)
    t = p.t
    v = mx = my = mz = 0.0
    for poly, sign in [(o, 1) for o in outers] + [(h, -1) for h in holes]:
        a, cx, cy = _centroid(poly)
        dv = sign * abs(a) * t
        v, mx, my, mz = v + dv, mx + dv * cx, my + dv * cy, mz + dv * t / 2
    for poly, dep in pockets:
        a, cx, cy = _centroid(poly)
        d = min(dep, t)
        dv = -abs(a) * d
        v, mx, my, mz = v + dv, mx + dv * cx, my + dv * cy, mz + dv * (t - d / 2)
    if v <= 0:
        return None
    a = g.assembly
    mat = {**doc.material, **a["material"]} if a.get("material") else doc.material
    dens = density_of(mat)
    # A bought part (nothing to cut) with no mass and no material of its own is probably a stand-in
    # block (a storage box, a caster): don't guess its weight from its volume
    unweighed = not a.get("mass") and not a.get("material") and _non_cut(doc, g.id)
    kg = float(a["mass"]) if a.get("mass") else 0.0 if unweighed else v * 1e-9 * dens
    return {"volume_cm3": v / 1000, "kg": kg, "density": dens, "given": bool(a.get("mass")), "unweighed": unweighed,
            "local": (mx / v, my / v, mz / v), "solid": p}


def _offset(g, params: dict):
    mv = (g.assembly or {}).get("move")
    if mv and mv.get("param") in params:
        s = params[mv["param"]]
        return tuple(c * s for c in mv.get("axis", (0, 1, 0)))
    return (0.0, 0.0, 0.0)


def structure_report(doc: Document, params: dict | None = None, loads=None, push_height=None) -> dict:
    """Weight per part, total, centre of mass and stability at the given slider values
    (default: each slider at its minimum, like the 3D preview opens)."""
    thick = float(doc.material.get("thickness") or 18)
    vals = {p["name"]: p["min"] for p in doc.params}
    for k, v in (params or {}).items():
        if k not in vals:
            raise DocError(f"No slider named '{k}' (sliders: {', '.join(vals) or 'none'})")
        vals[k] = float(v)
    parts, floor_pts, top = [], [], -math.inf
    total = sx = sy = sz = 0.0
    by_key, solids = {}, []
    for g in placed_groups(doc):
        m = part_mass(doc, g, thick)
        if not m:
            continue
        p, off = m["solid"], _offset(g, vals)
        w = [c + o for c, o in zip(p.world(*m["local"]), off)]
        lo, hi = [math.inf] * 3, [-math.inf] * 3
        for poly in p.outers:
            for x, y in poly:
                for z in (0, p.t):
                    q = [c + o for c, o in zip(p.world(x, y, z), off)]
                    floor_pts.append(q)
                    for i in range(3):
                        lo[i], hi[i] = min(lo[i], q[i]), max(hi[i], q[i])
        top = max(top, hi[1])
        total += m["kg"]
        sx, sy, sz = sx + m["kg"] * w[0], sy + m["kg"] * w[1], sz + m["kg"] * w[2]
        row = {"id": g.id, "name": g.name, "kg": round(m["kg"], 3), "qty": g.qty,
               "volume_cm3": round(m["volume_cm3"], 1), "density": m["density"],
               "center": [round(c, 1) for c in w]}
        if m["given"]:
            row["mass_given"] = True
        if m["unweighed"]:
            row["unweighed"] = True
        parts.append(row)
        by_key[g.id] = by_key[g.name] = (row, lo, hi)
        solids.append({"g": g, "p": p, "kg": m["kg"], "lo": lo, "hi": hi, "row": row})
    if not parts:
        return {"error": "No part is placed in 3D yet: nothing to weigh"}
    load_rows = []
    for ld in loads or []:
        if not isinstance(ld, dict):
            raise DocError("A load is {part, kg} or {at: [x, y, z], kg}")
        kg = float(ld.get("kg") or 0)
        if kg <= 0:
            raise DocError("A load needs kg > 0")
        if ld.get("at"):
            at = [float(c) for c in ld["at"]][:3]
            if len(at) != 3:
                raise DocError("load 'at' must be [x, y, z]")
            label = ld.get("label") or f"{kg:g} kg at {at}"
        else:
            hit = by_key.get(ld.get("part"))
            if not hit:
                raise DocError(f"No placed part '{ld.get('part')}' for the load")
            row, lo, hi = hit
            at = [(lo[0] + hi[0]) / 2, hi[1], (lo[2] + hi[2]) / 2]      # on top of the part, centred
            label = ld.get("label") or f"{kg:g} kg on {row['name']}"
        total += kg
        sx, sy, sz = sx + kg * at[0], sy + kg * at[1], sz + kg * at[2]
        load_rows.append({"label": label, "kg": kg, "at": [round(c, 1) for c in at],
                          **({"part": hit[0]["id"]} if not ld.get("at") else {})})
    com = (sx / total, sy / total, sz / total)
    floor = min(q[1] for q in floor_pts)
    contact = [(q[0], q[2]) for q in floor_pts if q[1] <= floor + FLOOR_TOL]
    hull = _hull(contact)
    cx, cz = com[0], com[2]
    h = com[1] - floor
    ph = (float(push_height) if push_height is not None else top) - floor
    stab = {"floor_y": round(floor, 1), "com_height": round(h, 1),
            "footprint": [[round(x, 1), round(z, 1)] for x, z in hull],
            "push_height": round(ph + floor, 1)}
    edges = []
    if len(hull) >= 3:
        for i in range(len(hull)):
            (x0, z0), (x1, z1) = hull[i], hull[(i + 1) % len(hull)]
            L = math.hypot(x1 - x0, z1 - z0)
            if L < 1e-6:
                continue
            # counter-clockwise in (x, z): the outward normal is (dz, −dx)
            nx, nz = (z1 - z0) / L, -(x1 - x0) / L
            d = (x0 - cx) * nx + (z0 - cz) * nz          # > 0: the CoM is inside this edge
            edges.append({"toward": _direction(nx, nz), "margin": round(d, 1),
                          "tip_angle": round(math.degrees(math.atan2(d, h)), 1) if h > 0 else None,
                          "tip_force_N": round(total * G * d / ph, 1) if ph > 0 and d > 0 else 0,
                          "tip_force_kgf": round(total * d / ph, 1) if ph > 0 and d > 0 else 0,
                          "edge": [[round(x0, 1), round(z0, 1)], [round(x1, 1), round(z1, 1)]]})
    if not edges:
        stab.update(stable=False, message="The model touches the floor along a line or at one point: "
                                          "it can't stand on its own")
    else:
        weakest = min(edges, key=lambda e: e["margin"])
        # Same direction twice (a many-sided footprint): keep the weakest edge per direction
        per_dir = {}
        for e in sorted(edges, key=lambda e: e["margin"]):
            per_dir.setdefault(e["toward"], e)
        stab["stable"] = weakest["margin"] > 0
        stab["weakest"] = weakest
        stab["by_direction"] = list(per_dir.values())
        if stab["stable"]:
            stab["message"] = (f"Stands. Easiest to tip toward the {weakest['toward']}: the centre of mass is "
                               f"{weakest['margin']:.0f} mm from that edge, it falls past {weakest['tip_angle']}° "
                               f"of lean, and a push of {weakest['tip_force_kgf']:.1f} kgf "
                               f"({weakest['tip_force_N']:.0f} N) at {ph + floor:.0f} mm high tips it")
        else:
            stab["message"] = (f"Tips over toward the {weakest['toward']}: the centre of mass is "
                               f"{-weakest['margin']:.0f} mm outside the footprint")
    parts.sort(key=lambda r: -r["kg"])
    cut_kg = sum(r["kg"] * r["qty"] for r in parts if not _non_cut(doc, r["id"]))
    out = {"units": "kg, mm; X = width, Y = up, Z = toward the viewer",
           "params": vals, "total_kg": round(total, 2),
           "parts_kg": round(total - sum(l["kg"] for l in load_rows), 2),
           "center_of_mass": [round(c, 1) for c in com], "stability": stab, "parts": parts}
    if any(r["qty"] > 1 for r in parts):
        out["cut_parts_kg"] = round(cut_kg, 2)
        out["note_qty"] = "parts_kg counts each placed part once; cut_parts_kg counts qty (sheet parts only)"
    if load_rows:
        out["loads"] = load_rows
    out["strength"] = strength_report(doc, solids, load_rows, floor, total)
    hw = [r["name"] for r in parts if r.get("unweighed")]
    est = [r["name"] for r in parts if not r.get("mass_given") and not r.get("unweighed") and _non_cut(doc, r["id"])]
    if hw:
        out["unweighed_hardware"] = hw
    if est:
        out["estimated_hardware"] = est
    if hw or est:
        out["hint"] = ("Bought parts (not cut): unweighed_hardware count as 0 kg, estimated_hardware are "
                       "volume × their material's density. Give them a real weight with assembly.mass (kg)")
    return out


def _non_cut(doc: Document, gid: str) -> bool:
    cut = {l.name for l in doc.layers if l.export}
    return not any(doc.element(i).layer in cut for i in doc.descendants(gid))


# ── Strength: shelves and other horizontal panels as beams ───────────────
#
# A horizontal panel (its thickness along world Y) is a beam between the parts that hold it up
# (parts reaching from below its bottom face up to it: sides, legs, rails, a panel under it).
# Clear span between supports, width = the panel across the span, depth = its thickness. Its own
# weight is spread over it; loads on it (and bought parts resting on it) are taken as one point
# load in the middle of the span, or at the tip of an overhang: the worst place. Plates held on
# all four sides are checked as a beam over the shorter span, which is on the safe side.

# E (N/mm², bending stiffness) and bending strength (N/mm², modulus of rupture), by type / name
MECH = {"plywood": (6500, 40), "wood": (9000, 60), "board": (3500, 30), "plastic": (2800, 60),
        "metal": (69000, 150), "foam": (15, 0.4), "other": (5000, 30)}
NAMED_MECH = (("steel", (200000, 250)), ("alumin", (69000, 150)), ("brass", (100000, 200)),
              ("mdf", (3500, 30)), ("osb", (4500, 20)), ("pine", (8500, 40)), ("poplar", (5500, 30)),
              ("birch", (8000, 50)), ("oak", (11000, 80)), ("acrylic", (3000, 70)), ("polycarbonate", (2300, 90)),
              ("hdpe", (1000, 25)), ("eva", (10, 0.5)), ("xps", (15, 0.3)))
SAFETY = 2.0            # a part is "overloaded" past half its breaking stress
SAG_LIMIT = 200         # sag more than span / 200 shows (books on a shelf: span / 200 is the usual limit)


def mech_of(m: dict | None):
    m = m or {}
    name = str(m.get("name") or "").lower()
    for key, v in NAMED_MECH:
        if key in name:
            return v
    return MECH.get(m.get("type"), MECH["other"])


def _horizontal(p) -> bool:
    return abs(p.R[1][2]) > 0.95          # local Z (the thickness) points along world Y


def _contact(a, b, tol=1.0):
    """Overlap of two world boxes in X and Z (with a tolerance), as (x0, x1, z0, z1), or None."""
    x0, x1 = max(a["lo"][0], b["lo"][0]), min(a["hi"][0], b["hi"][0])
    z0, z1 = max(a["lo"][2], b["lo"][2]), min(a["hi"][2], b["hi"][2])
    if x1 - x0 < -tol or z1 - z0 < -tol:
        return None
    return (min(x0, x1), max(x0, x1), min(z0, z1), max(z0, z1))


def _gaps(intervals, a, b):
    """(largest gap between supports, largest overhang at either end) over [a, b]."""
    iv = sorted((max(a, i0), min(b, i1)) for i0, i1 in intervals if i1 >= a - 1 and i0 <= b + 1)
    if not iv:
        return 0.0, 0.0
    merged = [list(iv[0])]
    for i0, i1 in iv[1:]:
        if i0 <= merged[-1][1] + 0.5:
            merged[-1][1] = max(merged[-1][1], i1)
        else:
            merged.append([i0, i1])
    inner = max((merged[k + 1][0] - merged[k][1] for k in range(len(merged) - 1)), default=0.0)
    over = max(merged[0][0] - a, b - merged[-1][1], 0.0)
    return inner, over


def strength_report(doc: Document, solids: list, loads: list, floor: float, total: float) -> dict:
    by_id = {s["g"].id: s for s in solids}
    panels = [s for s in solids if _horizontal(s["p"]) and not _non_cut(doc, s["g"].id)]
    point = {s["g"].id: [] for s in panels}          # gid → [(kg, label)]

    def panel_under(x, y, z):
        best = None
        for s in panels:
            if s["lo"][0] - 1 <= x <= s["hi"][0] + 1 and s["lo"][2] - 1 <= z <= s["hi"][2] + 1 \
                    and abs(s["hi"][1] - y) <= 3 and (best is None or s["hi"][1] > best["hi"][1]):
                best = s
        return best
    for ld in loads:
        s = by_id.get(ld.get("part")) if ld.get("part") in point else panel_under(*ld["at"])
        if s:
            point[s["g"].id].append((ld["kg"], ld["label"]))
    for s in solids:                                  # bought parts resting on a panel load it
        if s["kg"] > 0 and _non_cut(doc, s["g"].id):
            c = s["row"]["center"]
            under = panel_under(c[0], s["lo"][1], c[2])
            if under and under is not s:
                point[under["g"].id].append((s["kg"], s["g"].name))
    rows = []
    for s in panels:
        g, p = s["g"], s["p"]
        a = g.assembly
        mat = {**doc.material, **a["material"]} if a.get("material") else doc.material
        E, mor = mech_of(mat)
        t = s["hi"][1] - s["lo"][1]
        xs, zs = [], []                               # support lines across X / across Z
        for o in solids:
            if o is s or o["kg"] < 0:
                continue
            if not (o["lo"][1] <= s["lo"][1] + 1 and o["hi"][1] >= s["lo"][1] - 2):
                continue                              # doesn't reach the panel from below
            if _horizontal(o["p"]) and o["hi"][1] > s["lo"][1] + 1:
                continue                              # a panel beside it, not under it
            c = _contact(s, o)
            if not c:
                continue
            (xs if c[1] - c[0] <= c[3] - c[2] else zs).append(c)
        Lx, Ox = _gaps([(c[0], c[1]) for c in xs], s["lo"][0], s["hi"][0])
        Lz, Oz = _gaps([(c[2], c[3]) for c in zs], s["lo"][2], s["hi"][2])
        width_x, width_z = s["hi"][0] - s["lo"][0], s["hi"][2] - s["lo"][2]
        cases = []
        if len(xs) >= 2 and Lx > 0:
            cases.append(("span", Lx, width_z, width_x, "X"))
        if len(zs) >= 2 and Lz > 0:
            cases.append(("span", Lz, width_x, width_z, "Z"))
        if len(cases) == 2:
            cases = [min(cases, key=lambda c: c[1])]  # held on all sides: the shorter span carries it
        if not cases and (xs or zs):
            ox, oz = (Ox if xs else 0), (Oz if zs else 0)
            if max(ox, oz) > t:
                cases.append(("overhang", ox, width_z, width_x, "X") if ox >= oz
                             else ("overhang", oz, width_x, width_z, "Z"))
        kgs = sum(k for k, _ in point[g.id])
        row = {"id": g.id, "name": g.name, "load_kg": round(kgs, 1), "loads": [l for _, l in point[g.id]]}
        if not (xs or zs):
            row.update(status="unsupported", message=f"Nothing holds '{g.name}' up from below")
            rows.append(row)
            continue
        if not cases:
            row.update(status="ok", message="Fully supported")
            rows.append(row)
            continue
        kind, L, b, length, axis = cases[0]
        I, Z = b * t ** 3 / 12, b * t ** 2 / 6
        w = s["kg"] * G / max(length, 1)              # own weight, N/mm along the span
        P = kgs * G
        if kind == "span":
            M = P * L / 4 + w * L ** 2 / 8
            sag = P * L ** 3 / (48 * E * I) + 5 * w * L ** 4 / (384 * E * I)
            per_kg_M, per_kg_sag = G * L / 4, G * L ** 3 / (48 * E * I)
        else:
            M = P * L + w * L ** 2 / 2
            sag = P * L ** 3 / (3 * E * I) + w * L ** 4 / (8 * E * I)
            per_kg_M, per_kg_sag = G * L, G * L ** 3 / (3 * E * I)
        stress = M / Z
        limit = L / SAG_LIMIT if kind == "span" else L / (SAG_LIMIT / 2)
        # extra centre load before it gets overloaded (half the breaking stress) or sags past the limit
        safe = max(0.0, min((mor / SAFETY * Z - (M - P * per_kg_M / G)) / per_kg_M,
                            (limit - (sag - P * per_kg_sag / G)) / per_kg_sag))
        breaking = max(0.0, (mor * Z - (M - P * per_kg_M / G)) / per_kg_M)
        use = stress / mor
        status = ("breaks" if use >= 1 else "overloaded" if use > 1 / SAFETY
                  else "sags" if sag > limit else "ok")
        what = f"{kind} {L:.0f} mm along {axis}, {b:.0f} wide × {t:.0f} thick"
        msg = {"breaks": f"Breaks: {stress:.0f} N/mm² against a strength of {mor:.0f} ({use * 100:.0f}%)",
               "overloaded": f"Overloaded: {use * 100:.0f}% of its breaking stress (keep it under {100 / SAFETY:.0f}%)",
               "sags": f"Sags {sag:.1f} mm (more than {limit:.1f} mm, span/{SAG_LIMIT if kind == 'span' else SAG_LIMIT // 2})",
               "ok": f"OK: sags {sag:.1f} mm, {use * 100:.0f}% of its breaking stress"}[status]
        row.update(status=status, kind=kind, span=round(L), width=round(b), thickness=round(t, 1),
                   sag_mm=round(sag, 2), sag_limit_mm=round(limit, 1), stress_pct=round(use * 100),
                   safe_load_kg=round(safe), breaking_load_kg=round(breaking),
                   message=f"{msg} — {what}; takes about {safe:.0f} kg more in the middle safely, breaks near "
                           f"{breaking:.0f} kg")
        rows.append(row)
    order = {"breaks": 0, "unsupported": 1, "overloaded": 2, "sags": 3, "ok": 4}
    rows.sort(key=lambda r: (order[r["status"]], -r.get("stress_pct", 0)))
    out = {"panels": rows,
           "assumes": f"horizontal panels as beams; loads as one point in the middle of the span (worst case); "
                      f"E/strength from the material ({', '.join(f'{k} {v[0]}/{v[1]}' for k, v in MECH.items() if k in ('plywood', 'board', 'wood'))} N/mm²); "
                      f"overloaded past {100 / SAFETY:.0f}% of breaking stress. Joints, screws and inserts are not checked"}
    # Casters / feet with a rated load (assembly.capacity, kg): the weight shared evenly
    rated = [s for s in solids if (s["g"].assembly or {}).get("capacity")]
    if rated:
        each = total / len(rated)
        cap = min(float(s["g"].assembly["capacity"]) for s in rated)
        out["supports"] = {"count": len(rated), "kg_each": round(each, 1), "rated_kg": cap,
                           "status": "overloaded" if each > cap else "ok",
                           "message": f"{len(rated)} rated supports carry ~{each:.0f} kg each (rated {cap:g} kg)"
                                      + (": OVERLOADED" if each > cap else "")}
    bad = [r for r in rows if r["status"] in ("breaks", "unsupported", "overloaded")]
    if out.get("supports", {}).get("status") == "overloaded":
        bad.append({"name": "casters / feet"})
    out["ok"] = not bad
    out["message"] = ("No panel is overloaded" + ("" if rows else " (no horizontal panels)") if not bad else
                      "Overloaded: " + ", ".join(r["name"] for r in bad))
    return out
