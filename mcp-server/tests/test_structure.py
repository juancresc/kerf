"""Weight, centre of mass and stability (describe_structure / structure.py)."""
import importlib
import json
import sys

import pytest

from test_layout import board


@pytest.fixture
def srv(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    sys.modules.pop("server", None)
    import server
    importlib.reload(server)
    return server


def j(s):
    return json.loads(s)


def table(srv, lift=False):
    """A 600 × 400 top at y = 700..718 on two 18 × 700 × 400 legs at x = ±300, centred on 0."""
    top = {"rotation": [-90, 0, 0], "position": [-300, 700, 200]}
    if lift:
        top["move"] = {"param": "lift", "axis": [0, 1, 0]}
        j(srv.set_params([{"name": "lift", "min": 0, "max": 300}]))
    ops = board("Top", 0, 0, 600, 400, top)
    ops += board("Leg A", 700, 0, 18, 700, {"position": [-300, 0, -200], "thickness": 400})
    ops += board("Leg B", 800, 0, 18, 700, {"position": [282, 0, -200], "thickness": 400})
    r = j(srv.apply_ops(ops))
    assert "error" not in r, r


def test_weight_center_of_mass_and_tipping(srv):
    table(srv)
    r = j(srv.describe_structure())
    kg = {p["name"]: p["kg"] for p in r["parts"]}
    assert kg["Top"] == pytest.approx(600 * 400 * 18 * 680e-9, abs=1e-3)      # birch plywood ≈ 680 kg/m³
    assert kg["Leg A"] == pytest.approx(18 * 700 * 400 * 680e-9, abs=1e-3)
    assert r["total_kg"] == pytest.approx(9.79, abs=0.01)
    x, y, z = r["center_of_mass"]
    assert (x, z) == (pytest.approx(0, abs=0.1), pytest.approx(0, abs=0.1))
    assert y == pytest.approx((2.9376 * 709 + 6.8544 * 350) / 9.792, abs=0.5)
    s = r["stability"]
    assert s["stable"] and s["floor_y"] == 0
    assert sorted(s["footprint"]) == [[-300, -200], [-300, 200], [300, -200], [300, 200]]
    assert s["weakest"]["margin"] == pytest.approx(200, abs=0.1)
    assert s["weakest"]["toward"] in ("front (+Z)", "back (−Z)")
    assert s["weakest"]["tip_force_kgf"] == pytest.approx(9.792 * 200 / 718, abs=0.05)


def test_loads_and_density(srv):
    table(srv)
    r = j(srv.describe_structure(loads=[{"at": [0, 718, 190], "kg": 50}]))
    assert r["stability"]["stable"] and r["stability"]["weakest"]["toward"] == "front (+Z)"
    assert r["stability"]["weakest"]["margin"] == pytest.approx(200 - 50 * 190 / 59.792, abs=0.3)
    r = j(srv.describe_structure(loads=[{"at": [0, 718, 400], "kg": 50}]))       # hanging off the front
    assert not r["stability"]["stable"] and "Tips over toward the front" in r["stability"]["message"]
    r = j(srv.describe_structure(loads=[{"part": "Top", "kg": 10}]))
    assert r["loads"][0]["at"] == [0, 718, 0] and r["total_kg"] == pytest.approx(19.79, abs=0.01)
    assert "error" in j(srv.describe_structure(loads=[{"part": "Nope", "kg": 1}]))
    j(srv.set_material(density=500))
    assert j(srv.describe_structure())["total_kg"] == pytest.approx(9.792 * 500 / 680, abs=0.01)
    srv.store.apply([{"op": "set_material", "material": {"density": ""}}])       # empty = guess again
    assert "density" not in srv.store.doc.material


def test_sliders_min_and_max(srv):
    table(srv, lift=True)
    r = j(srv.describe_structure())
    lo, hi = r["at_min"], r["at_max"]
    assert hi["center_of_mass"][1] - lo["center_of_mass"][1] == pytest.approx(2.9376 * 300 / 9.792, abs=0.5)
    assert hi["stability"]["weakest"]["tip_angle"] < lo["stability"]["weakest"]["tip_angle"]
    one = j(srv.describe_structure(params={"lift": 150}))
    assert one["params"] == {"lift": 150}
    assert "error" in j(srv.describe_structure(params={"nope": 1}))


def test_hardware_weight(srv):
    table(srv)
    srv.store.apply([{"op": "add_layer", "name": "HARDWARE", "color": "#888888", "export": False}])
    ops = [{"op": "add_element", "as": "b", "tag": "rect", "layer": "HARDWARE",
            "attrs": {"x": 900, "y": 0, "width": 300, "height": 300, "fill": "none"}},
           {"op": "group", "as": "Box", "items": ["$b"], "name": "Box"},
           {"op": "update_group", "id": "$Box", "assembly": {"rotation": [-90, 0, 0], "position": [-150, 718, 150],
                                                            "thickness": 300}}]
    gid = j(srv.apply_ops(ops))["results"][1]
    r = j(srv.describe_structure())
    assert r["unweighed_hardware"] == ["Box"] and r["total_kg"] == pytest.approx(9.79, abs=0.01)
    j(srv.update_group(gid, assembly={**srv.store.doc.group_by_id(gid).assembly, "mass": 5}))
    r = j(srv.describe_structure())
    assert r["total_kg"] == pytest.approx(14.79, abs=0.01) and "unweighed_hardware" not in r
    assert next(p for p in r["parts"] if p["name"] == "Box")["mass_given"]


def test_strength_of_a_shelf(srv):
    table(srv)
    st = j(srv.describe_structure())["strength"]
    top = next(r for r in st["panels"] if r["name"] == "Top")
    assert top["kind"] == "span" and top["span"] == 564 and top["width"] == 400 and top["thickness"] == 18
    assert top["status"] == "ok" and st["ok"]
    # birch ply: strength 50 N/mm²; Z = 400·18²/6; a point load P in the middle: M = P·L/4
    breaking = 50 * 400 * 18 ** 2 / 6 * 4 / 564 / 9.81
    assert top["breaking_load_kg"] == pytest.approx(breaking, rel=0.03)          # less its own weight
    st = j(srv.describe_structure(loads=[{"part": "Top", "kg": breaking * 0.6}]))["strength"]
    assert st["panels"][0]["status"] == "overloaded" and not st["ok"]
    st = j(srv.describe_structure(loads=[{"at": [0, 718, 0], "kg": 2000}]))["strength"]   # by position
    assert st["panels"][0]["status"] == "breaks" and "Top" in st["message"]
    assert st["panels"][0]["load_kg"] == 2000


def test_caster_rating(srv):
    table(srv)
    gid = srv.store.doc.groups[1].id                      # Leg A stands in for a caster
    j(srv.update_group(gid, assembly={**srv.store.doc.group_by_id(gid).assembly, "capacity": 5}))
    sup = j(srv.describe_structure())["strength"]["supports"]
    assert sup["count"] == 1 and sup["status"] == "overloaded"
