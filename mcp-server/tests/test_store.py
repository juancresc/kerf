import io
import json
import re

import pytest

from document import Document, DocError
from store import Store


@pytest.fixture
def store(tmp_path):
    return Store(tmp_path)


def add_rect(store, layer=None, **attrs):
    a = {"x": 10, "y": 10, "width": 100, "height": 50, **attrs}
    return store.apply([{"op": "add_element", "tag": "rect", "attrs": a, "layer": layer}])[0]


def test_add_update_remove_and_undo_redo(store):
    eid = add_rect(store)
    assert store.dirty and store.doc.element(eid).attrs["x"] == "10"
    store.apply([{"op": "update_element", "id": eid, "attrs": {"x": 50}}])
    assert store.doc.element(eid).attrs["x"] == "50"
    store.undo()
    assert store.doc.element(eid).attrs["x"] == "10"
    store.redo()
    assert store.doc.element(eid).attrs["x"] == "50"
    store.apply([{"op": "remove_elements", "ids": [eid]}])
    assert not store.doc.elements
    store.undo()
    assert store.doc.element(eid)


def test_failed_batch_changes_nothing(store):
    eid = add_rect(store)
    v = store.version
    with pytest.raises(DocError):
        store.apply([{"op": "update_element", "id": eid, "attrs": {"x": 1}},
                     {"op": "update_element", "id": "el-999", "attrs": {"x": 2}}])
    assert store.doc.element(eid).attrs["x"] == "10" and store.version == v


def test_typing_coalesces_into_one_undo_step(store):
    eid = add_rect(store)
    for x in (1, 12, 123):
        store.apply([{"op": "update_element", "id": eid, "attrs": {"x": x}}])
    store.undo()
    assert store.doc.element(eid).attrs["x"] == "10"


def test_layer_crud(store):
    store.apply([{"op": "add_layer", "name": "POCKET", "color": "#123456", "line_style": "dotted",
                  "description": "6 mm deep"}])
    eid = add_rect(store, layer="POCKET")
    store.apply([{"op": "update_layer", "name": "POCKET", "new_name": "POCKET_6", "color": "#654321"}])
    assert store.doc.element(eid).layer == "POCKET_6"
    assert store.doc.layer("POCKET_6").color == "#654321"
    with pytest.raises(DocError):  # has elements, no target
        store.apply([{"op": "remove_layer", "name": "POCKET_6"}])
    store.apply([{"op": "remove_layer", "name": "POCKET_6", "move_to": "ENGRAVE"}])
    assert store.doc.element(eid).layer == "ENGRAVE"
    with pytest.raises(DocError):
        store.apply([{"op": "add_layer", "name": "bad/name"}])
    with pytest.raises(DocError):
        store.apply([{"op": "update_layer", "name": "ENGRAVE", "color": "red"}])


def test_visibility_is_not_an_undo_step_and_not_dirty(store):
    store.save("a")
    store.apply([{"op": "set_layer_visibility", "name": "NOTES", "visible": False}])
    assert not store.dirty and not store.tab.undo_stack
    assert not store.doc.layer("NOTES").visible


def test_default_layers_have_descriptions(store):
    assert all(l.description for l in store.doc.layers)
    assert store.doc.layer("NOTES").export is False


def test_save_open_roundtrip(store, tmp_path):
    store.apply([{"op": "set_size", "width": 2440, "height": 1220},
                 {"op": "add_layer", "name": "DRILL", "color": "#0000ff", "line_style": "4 2",
                  "export": False, "description": "hand drill"},
                 {"op": "set_layer_visibility", "name": "NOTES", "visible": False}])
    eid = add_rect(store, layer="DRILL")
    store.apply([{"op": "add_element", "tag": "text", "attrs": {"x": 5, "y": 5}, "text": "A & <B>",
                  "layer": "NOTES"}])
    saved = store.save("sub/part one")
    assert saved == "sub/part one.kerf" and not store.dirty
    assert json.loads((tmp_path / saved).read_text())["format"] == "kerf"
    svg = store.doc.to_svg("file")                      # the SVG export
    assert 'width="2440mm"' in svg and 'viewBox="0 0 2440 1220"' in svg
    assert 'inkscape:groupmode="layer"' in svg and 'stroke="#0000ff"' in svg
    store.import_svg(svg, new_tab=True)                # and SVG exports read back the same
    assert store.doc.layer("DRILL").description == "hand drill"
    store.close(discard=True)

    store.new()
    store.open("sub/part one")
    d = store.doc
    assert (d.width, d.height) == (2440, 1220)
    drill = d.layer("DRILL")
    assert (drill.color, drill.line_style, drill.export, drill.description) == ("#0000ff", "4 2", False, "hand drill")
    assert not d.layer("NOTES").visible
    assert d.element(eid).layer == "DRILL" and "stroke" not in d.element(eid).attrs
    assert [e.text for e in d.elements if e.tag == "text"] == ["A & <B>"]
    assert d.next_id > int(eid.split("-")[1])


def test_cnc_export_uses_the_export_flag_not_visibility(store):
    add_rect(store, layer="CUT_OUTSIDE")
    add_rect(store, layer="NOTES")
    add_rect(store, layer="ENGRAVE")
    store.apply([{"op": "set_layer_visibility", "name": "ENGRAVE", "visible": False}])
    svg = store.doc.to_svg("cnc")          # hidden ENGRAVE is still cut; NOTES never is
    assert svg.count("<rect") == 2 and 'width="800mm"' in svg and "inkscape" not in svg


def test_tabs_open_switch_close(store):
    first = store.active_id
    store.save("one")
    add_rect(store)                       # "one" now has unsaved changes
    store.new()                           # new tab; "one" keeps its changes
    assert len(store.tabs) == 2 and store.active_id != first and not store.doc.elements
    store.open("one")                     # already open → switches to it
    assert store.active_id == first and store.dirty
    with pytest.raises(DocError, match="unsaved"):
        store.close()
    store.close(discard=True)
    assert len(store.tabs) == 1 and first not in store.tabs


def test_pristine_untitled_tab_is_reused(store):
    store.save("a")
    store.new()
    t = store.active_id
    store.open("a")                       # "a" is open already: switch, keep the empty tab
    assert t in store.tabs
    store.activate(t)
    store.new()                           # replaces the untouched empty tab
    assert t not in store.tabs


@pytest.mark.parametrize("name", ["../x", "/etc/passwd", ".hidden", "a/../../b", ""])
def test_file_names_stay_inside_data_dir(store, name):
    with pytest.raises(DocError):
        store.save(name)


def test_import_plain_and_legacy_svg(store):
    legacy = ('<svg xmlns="http://www.w3.org/2000/svg" width="500" height="400">'
              '<rect id="el-7" x="1" y="2" width="3" height="4" stroke="#e74c3c" data-layer="CUT_INSIDE"/>'
              '<g transform="translate(10,0)"><circle cx="5" cy="5" r="2" style="fill:none;stroke:red"/></g>'
              '</svg>')
    store.import_svg(legacy, new_tab=True)
    d = store.doc
    assert (d.width, d.height) == (500, 400)
    assert d.element("el-7").layer == "CUT_INSIDE"
    circle = [e for e in d.elements if e.tag == "circle"][0]
    assert circle.attrs["transform"] == "translate(10,0)" and circle.attrs["fill"] == "none"
    # fragment import adds to the current document as one undo step
    n = store.import_svg('<line x1="0" y1="0" x2="5" y2="5"/><line x1="1" y1="1" x2="2" y2="2"/>', "NOTES")
    assert n == 2 and len(d.elements) == 2  # `d` is the pre-import snapshot
    store.undo()
    assert len(store.doc.elements) == 2


def test_session_survives_restart(tmp_path):
    s1 = Store(tmp_path)
    add_rect(s1)
    s1.new()
    s1.flush_session()
    s2 = Store(tmp_path)
    assert len(s2.tabs) == 2 and s2.active_id == s1.active_id
    first = next(iter(s2.tabs.values()))
    assert len(first.doc.elements) == 1 and first.dirty


def test_wait_for_change_times_out(store):
    assert store.wait_for_change(store.version, 0.05) is False


def test_json_roundtrip():
    d = Document()
    d.add_element("circle", {"cx": 1, "cy": 2, "r": 3}, layer="CUT_INSIDE")
    d2 = Document.from_json(json.loads(json.dumps(d.to_json())))
    assert d2.to_json() == d.to_json()


def test_plain_svg_gets_standard_layers_in_order(store):
    store.import_svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
                     '<rect data-layer="NOTES" width="1" height="1"/><rect data-layer="DRILL" width="1" height="1"/></svg>',
                     new_tab=True)
    assert [l.name for l in store.doc.layers] == ["CUT_OUTSIDE", "CUT_INSIDE", "ENGRAVE", "NOTES", "DRILL"]
    assert store.doc.layer("CUT_INSIDE").description


def test_undo_back_to_saved_state_is_clean(store):
    store.save("clean")
    eid = add_rect(store)
    assert store.dirty
    store.undo()
    assert not store.dirty
    store.redo()
    assert store.dirty
    store.apply([{"op": "remove_elements", "ids": [eid]}])
    assert not store.dirty


def test_bad_attribute_names_are_rejected(store):
    for bad in ({"xlink:href": "#a"}, {"a b": "1"}, {"onclick": "alert(1)"}):
        with pytest.raises(DocError, match="attribute"):
            store.apply([{"op": "add_element", "tag": "rect", "attrs": bad}])
    eid = add_rect(store)
    with pytest.raises(DocError):
        store.apply([{"op": "update_element", "id": eid, "attrs": {"onmouseover": "x"}}])
    with pytest.raises(DocError):
        store.apply(["not an op"])


def test_import_scales_physical_units_to_mm(store):
    store.import_svg('<svg xmlns="http://www.w3.org/2000/svg" width="4in" height="2in" viewBox="0 0 384 192">'
                     '<rect x="0" y="0" width="96" height="96"/></svg>', new_tab=True)
    d = store.doc
    assert (d.width, d.height) == (101.6, 50.8)
    assert d.elements[0].attrs["transform"].startswith("scale(0.264583")
    store.import_svg('<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="10 10 100 50">'
                     '<circle cx="20" cy="20" r="5"/></svg>', new_tab=True)
    assert store.doc.elements[0].attrs["transform"] == "translate(-10, -10)"


def test_import_drops_hidden_unsafe_and_namespaced(store):
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" viewBox="0 0 100 100">'
           '<rect width="1" height="1" style="display:none"/>'
           '<g style="display:none"><circle r="3"/></g>'
           '<path d="M0 0 L5 5" sodipodi:type="arc" onmouseover="alert(1)"/>'
           '<text x="1" y="2" style="text-anchor:middle;font-weight:bold"><tspan x="1" y="2">Line1</tspan><tspan x="1" y="8">Line2</tspan></text>'
           '</svg>')
    store.import_svg(svg, new_tab=True)
    els = store.doc.elements
    assert [e.tag for e in els] == ["path", "text", "text"]
    assert els[0].attrs == {"d": "M0 0 L5 5"}
    assert [e.text for e in els[1:]] == ["Line1", "Line2"]
    assert els[2].attrs["y"] == "8" and els[1].attrs["text-anchor"] == "middle"


def test_state_hides_background_data_and_consumes_screenshot(store):
    store.apply([{"op": "set_background", "href": "data:image/png;base64,AAAA", "opacity": 0.5}])
    bg = store.state()["doc"]["background"]
    assert "href" not in bg and bg["opacity"] == 0.5 and bg["id"]
    store.screenshot_requested = True
    assert store.state(consume_screenshot=True)["screenshot_requested"] is True
    assert store.screenshot_requested is False


def test_groups_nest_ungroup_prune_and_roundtrip(store, tmp_path):
    a, b, c = add_rect(store), add_rect(store, layer="CUT_INSIDE"), add_rect(store)
    [g1] = store.apply([{"op": "group", "items": [a, b], "name": "Part A"}])
    [g2] = store.apply([{"op": "group", "items": [g1, c], "name": "Assembly"}])
    d = store.doc
    assert set(d.descendants(g2)) == {a, b, c} and d.group_by_id(g1).parent == g2
    with pytest.raises(DocError, match="same level"):
        store.apply([{"op": "group", "items": [a, c]}])
    store.apply([{"op": "update_group", "id": g1, "qty": 2,
                  "assembly": {"thickness": 18, "position": [0, 0, 0], "rotation": [0, 90, 0]}}])
    store.apply([{"op": "set_params", "params": [{"name": "lift", "min": 0, "max": 450}]}])
    store.save("grouped")
    store.new()
    store.open("grouped")
    d = store.doc
    names = {g.name: g for g in d.groups}
    assert names["Part A"].parent == names["Assembly"].id and names["Part A"].qty == 2
    assert names["Part A"].assembly["rotation"] == [0, 90, 0] and d.params[0]["name"] == "lift"
    assert d.element(a).group == names["Part A"].id
    # importing the same file into it remaps group ids (no clashes)
    store.import_svg(store.doc.to_svg("file"))
    assert len(store.doc.groups) == 4 and len({g.id for g in store.doc.groups}) == 4
    store.undo()
    store.apply([{"op": "ungroup", "id": names["Assembly"].id}])
    assert store.doc.group_by_id(names["Part A"].id).parent is None
    store.apply([{"op": "remove_elements", "ids": [a, b]}])      # empties Part A → pruned
    assert not any(g.name == "Part A" for g in store.doc.groups)


def test_dxf_export_and_import_roundtrip(store):
    from export import cnc_dxf, dxf_to_svg
    store.apply([{"op": "set_size", "width": 300, "height": 200},
                 {"op": "add_element", "tag": "path", "layer": "CUT_OUTSIDE",
                  "attrs": {"d": "M 10 10 L 110 10 A 20 20 0 0 1 130 30 L 130 90 L 10 90 Z"}},
                 {"op": "add_element", "tag": "path", "layer": "CUT_INSIDE",
                  "attrs": {"d": "M 40 50 A 6 6 0 1 0 52 50 A 6 6 0 1 0 40 50 Z"}},
                 {"op": "add_element", "tag": "circle", "layer": "CUT_INSIDE", "attrs": {"cx": 80, "cy": 50, "r": 4}},
                 {"op": "add_element", "tag": "rect", "layer": "NOTES", "attrs": {"x": 0, "y": 0, "width": 5, "height": 5}}])
    data = cnc_dxf(store.doc)
    import ezdxf, io
    dx = ezdxf.read(io.StringIO(data.decode()))
    ents = [(e.dxftype(), e.dxf.layer) for e in dx.modelspace()]
    assert sorted(ents) == [("CIRCLE", "CUT_INSIDE"), ("CIRCLE", "CUT_INSIDE"), ("LWPOLYLINE", "CUT_OUTSIDE")]
    poly = next(e for e in dx.modelspace() if e.dxftype() == "LWPOLYLINE")
    assert poly.closed and any(abs(b) > 0.1 for *_, b in poly.get_points("xyb"))      # the R20 arc
    circles = sorted(round(e.dxf.radius, 3) for e in dx.modelspace() if e.dxftype() == "CIRCLE")
    assert circles == [4, 6]
    assert dx.header["$INSUNITS"] == 4
    # and back: import produces the same geometry size
    store.import_svg(dxf_to_svg(data), new_tab=True)
    d = store.doc
    assert {l.name for l in d.layers} >= {"CUT_OUTSIDE", "CUT_INSIDE"}
    assert len(d.elements) == 3 and round(d.width, 1) == 120 + 20 and round(d.height, 1) == 80 + 20


def test_parts_export_per_entity(store):
    from export import part_files
    a = store.apply([{"op": "add_element", "tag": "rect", "layer": "CUT_OUTSIDE",
                      "attrs": {"x": 500, "y": 300, "width": 100, "height": 40}}])[0]
    b = store.apply([{"op": "add_element", "tag": "circle", "layer": "CUT_INSIDE",
                      "attrs": {"cx": 520, "cy": 320, "r": 5}}])[0]
    n = store.apply([{"op": "add_element", "tag": "text", "layer": "NOTES", "text": "label",
                      "attrs": {"x": 500, "y": 300}}])[0]
    with pytest.raises(DocError, match="No entities"):
        part_files(store.doc)
    [g] = store.apply([{"op": "group", "items": [a, b, n], "name": "Rail"}])
    store.apply([{"op": "update_group", "id": g, "qty": 4}])
    files = dict(part_files(store.doc))
    assert set(files) == {"rail_x4.svg", "rail_x4.dxf"}
    svg = files["rail_x4.svg"].decode()
    assert 'width="100.000mm"' in svg and "translate(-500.000, -300.000)" in svg and "label" not in svg


def test_sheet_export_one_file_per_sheet(store):
    from export import sheet_files, sheets_zip
    import ezdxf, ezdxf.bbox, zipfile
    parts = []
    for i, w in enumerate((300, 260)):
        a, b = store.apply([{"op": "add_element", "tag": "rect", "layer": "CUT_OUTSIDE",
                             "attrs": {"x": 50 + 400 * i, "y": 50, "width": w, "height": 150}},
                            {"op": "add_element", "tag": "circle", "layer": "CUT_INSIDE",
                             "attrs": {"cx": 100 + 400 * i, "cy": 100, "r": 5}}])
        parts += store.apply([{"op": "group", "items": [a, b], "name": f"Part {i + 1}"}])
    with pytest.raises(DocError, match="No sheets"):
        sheet_files(store.doc)
    store.apply([{"op": "arrange", "sheet_width": 400, "sheet_height": 300, "margin": 10, "gap": 10}])
    files, sheets = sheet_files(store.doc)
    assert [s["file"] for s in sheets] == ["sheet-1_400x300", "sheet-2_400x300"]
    assert [s["parts"] for s in sheets] == [["Part 1"], ["Part 2"]]          # one part per sheet
    names = {n for n, _ in files}
    assert names == {"sheet-1_400x300.svg", "sheet-1_400x300.dxf", "sheet-2_400x300.svg", "sheet-2_400x300.dxf"}
    svg = dict(files)["sheet-1_400x300.svg"].decode()
    assert 'width="400.000mm"' in svg and 'viewBox="0 0 400.000 300.000"' in svg and "SHEET" not in svg
    # DXF: the sheet's bottom-left corner is 0,0 and every shape lies on the sheet
    dx = ezdxf.read(io.StringIO(dict(files)["sheet-1_400x300.dxf"].decode()))
    ext = ezdxf.bbox.extents(dx.modelspace())
    assert ext.extmin.x >= 0 and ext.extmin.y >= 0 and ext.extmax.x <= 400 and ext.extmax.y <= 300
    assert {e.dxf.layer for e in dx.modelspace()} == {"CUT_OUTSIDE", "CUT_INSIDE"}
    readme = zipfile.ZipFile(io.BytesIO(sheets_zip(store.doc))).read("README.txt").decode()
    assert "sheet-2_400x300" in readme and "Part 2" in readme


def test_native_project_keeps_everything_and_svg_opens_as_new_tab(store, tmp_path):
    store.apply([{"op": "set_material", "material": {"name": "MDF", "thickness": 12, "sheet_width": 1220}},
                 {"op": "set_background", "href": "data:image/png;base64,AAAA", "opacity": 0.4}])
    add_rect(store)
    store.save("proj")
    store.new()
    store.open("proj")
    d = store.doc
    assert d.material["name"] == "MDF" and d.material["thickness"] == 12 and d.material["sheet_height"] == 1220
    assert d.background["opacity"] == 0.4 and store.file == "proj.kerf"
    with pytest.raises(DocError):
        store.apply([{"op": "set_material", "material": {"thickness": -1}}])
    (tmp_path / "drawing.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="3" height="3"/></svg>')
    store.open("drawing.svg")
    assert store.file is None and not store.dirty and store.tab.name == "drawing"
    assert store.save("drawing") == "drawing.kerf"   # saving makes it a project
    kinds = {f["file"]: f["kind"] for f in store.list_files()}
    assert kinds == {"proj.kerf": "kerf", "drawing.svg": "svg", "drawing.kerf": "kerf"}


def test_layer_depth_roundtrip(store):
    store.apply([{"op": "add_layer", "name": "POCKET", "color": "#8e44ad", "depth": 9}])
    assert store.doc.layer("POCKET").depth == 9
    svg = store.doc.to_svg("file")
    assert 'data-depth="9"' in svg
    store.import_svg(svg, new_tab=True)
    assert store.doc.layer("POCKET").depth == 9
    store.apply([{"op": "update_layer", "name": "POCKET", "depth": None}])
    assert store.doc.layer("POCKET").depth is None
    with pytest.raises(DocError):
        store.apply([{"op": "update_layer", "name": "POCKET", "depth": -3}])


def test_legacy_svgcnc_projects_open_and_save_as_kerf(store, tmp_path):
    from document import to_native
    doc_json = json.loads(to_native(store.doc))
    doc_json["format"] = "svgcnc"
    (tmp_path / "old.svgcnc").write_text(json.dumps(doc_json))
    store.open("old")
    assert store.file == "old.svgcnc"
    add_rect(store)
    assert store.save() == "old.kerf"


def test_closing_the_last_tab_opens_a_fresh_one(store):
    only = store.active_id
    store.close()
    assert len(store.tabs) == 1 and store.active_id != only and store.state()["name"] == "Untitled"


def test_loaded_files_are_sanitized(store):
    from document import to_native
    from xml.sax.saxutils import quoteattr
    meta = json.dumps({"groups": [{"id": 'g-1"><img src=x onerror=alert(1)>', "name": "x"}, {"id": "g-2", "name": "ok"}]})
    evil = ('<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" viewBox="0 0 100 100">'
            f'<metadata data-kerf={quoteattr(meta)}/>'
            f'<g inkscape:groupmode="layer" inkscape:label="A" data-line-style={quoteattr(chr(34) + "/><img src=x onerror=1>")} data-color="red">'
            '<rect width="1" height="1" data-group="g-2"/></g></svg>')
    store.import_svg(evil, new_tab=True)
    d = store.doc
    assert d.layer("A").line_style == "solid" and d.layer("A").color == "#000000"
    assert [g.id for g in d.groups] == ["g-2"]
    # a hand-edited .kerf with a script tag, bad ids and a bad assembly
    j = json.loads(to_native(d))
    j["document"]["elements"].append({"id": "x\"<b>", "tag": "script", "layer": "A", "attrs": {"onload": "1"}})
    j["document"]["elements"].append({"id": "el-1", "tag": "rect", "layer": "nope", "attrs": {"onclick": "1", "x": "2"}})
    j["document"]["groups"][0]["assembly"] = {"matrix": "evil", "color": "red"}
    from document import from_native
    d2 = from_native(json.dumps(j))
    assert all(e.tag != "script" for e in d2.elements)
    assert all(re.fullmatch(r"el-\d+", e.id) for e in d2.elements) and len({e.id for e in d2.elements}) == len(d2.elements)
    assert all("onclick" not in e.attrs for e in d2.elements) and d2.groups[0].assembly is None


def test_batch_references_make_one_undo_step(store):
    res = store.apply([{"op": "add_element", "tag": "rect", "attrs": {"width": 5, "height": 5}},
                       {"op": "add_element", "tag": "circle", "layer": "CUT_INSIDE", "attrs": {"r": 1}},
                       {"op": "group", "items": ["$0", "$1"], "name": "P"}])
    assert store.doc.group_by_id(res[2]).name == "P"
    store.undo()
    assert not store.doc.elements and not store.doc.groups
    with pytest.raises(DocError):
        store.apply([{"op": "group", "items": ["$5"]}])


def test_revert_clears_redo_and_delete_layer_prunes_entities(store):
    eid = add_rect(store, layer="ENGRAVE")
    store.apply([{"op": "group", "items": [eid], "name": "E"}])
    store.save("r")
    store.apply([{"op": "remove_layer", "name": "ENGRAVE", "move_to": "__delete__"}])
    assert not store.doc.groups
    store.undo()
    store.revert()
    assert not store.tab.redo_stack


def test_compact_arc_flags_and_bad_paths():
    from export import path_contours, IDENTITY
    [c] = path_contours("M0 0a5 5 0 1010 0a5 5 0 10-10 0z", IDENTITY, None)
    assert c.closed and len(c.pts) == 2 and all(abs(abs(p[2]) - 1) < 1e-9 for p in c.pts)
    with pytest.raises(DocError):
        path_contours("M0 0 L 5", IDENTITY, None)


def test_dxf_import_mirrored_arc_and_units():
    import ezdxf, io
    from export import dxf_to_svg
    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = 5                    # centimetres
    msp = doc.modelspace()
    msp.add_arc((0, 0), 1.5, 0, 180, dxfattribs={"extrusion": (0, 0, -1)})   # mirrored OCS
    msp.add_line((0, 0), (10, 0))
    buf = io.StringIO(); doc.write(buf)
    svg = dxf_to_svg(buf.getvalue().encode())
    from document import Document
    d = Document.from_svg(svg)
    assert d.width == pytest.approx(10 * 10 + 20 + 15, abs=0.5)   # -1.5..10 cm → 115 mm + margins


def test_project_title_is_separate_from_file(tmp_path):
    from document import Document, to_native, from_native
    s = Store(tmp_path)
    s.apply([{"op": "set_title", "title": "  My   desk\n v4 "}])
    assert s.doc.title == "My desk v4"
    assert s.tab.name == "My desk v4"
    s.save("desks/desk-final")
    assert s.file.endswith("desk-final.kerf") and s.tab.name == "My desk v4"
    doc = from_native(to_native(s.doc))
    assert doc.title == "My desk v4"
    assert Document.from_svg(s.doc.to_svg("file")).title == "My desk v4"
    s.apply([{"op": "set_title", "title": ""}])
    assert s.tab.name == "desk-final"


def test_save_accepts_commas_and_parentheses(tmp_path):
    s = Store(tmp_path)
    s.save("Standing desk (Jaswig-style, v4)")
    assert s.file == "Standing desk (Jaswig-style, v4).kerf"
    with pytest.raises(DocError, match="use letters"):
        s.save("bad:name")


def test_move_to_group(tmp_path):
    s = Store(tmp_path)
    r = s.apply([{"op": "add_element", "tag": "rect", "attrs": {"x": 0, "y": 0, "width": 10, "height": 10}},
                 {"op": "add_element", "tag": "circle", "attrs": {"cx": 5, "cy": 5, "r": 2}},
                 {"op": "add_element", "tag": "circle", "attrs": {"cx": 8, "cy": 8, "r": 1}},
                 {"op": "group", "items": ["$0", "$1"], "name": "Plate"},
                 {"op": "group", "items": ["$3"], "name": "Assembly"}])
    el3, plate, asm = r[2], r[3], r[4]
    s.apply([{"op": "set_group", "items": [el3], "group": plate}])            # add a hole
    assert s.doc.element(el3).group == plate
    s.apply([{"op": "set_group", "items": [el3], "group": None}])             # take it out again
    assert s.doc.element(el3).group is None
    with pytest.raises(DocError, match="inside itself"):
        s.apply([{"op": "set_group", "items": [asm], "group": plate}])
    s.apply([{"op": "set_group", "items": [r[0], r[1]], "group": None}])      # empty → pruned
    assert not s.doc.groups
    s.undo()
    assert {g.name for g in s.doc.groups} == {"Plate", "Assembly"}


def test_element_name_roundtrip(store):
    eid = store.apply([{"op": "add_element", "tag": "rect", "attrs": {"x": 0, "y": 0, "width": 5, "height": 5},
                        "name": "  hinge\n hole "}])[0]
    assert store.doc.element(eid).name == "hinge hole"          # one line, trimmed
    store.apply([{"op": "update_element", "id": eid, "name": "cable slot"}])
    store.apply([{"op": "update_element", "id": eid, "name": "cable slot 2"}])
    assert store.doc.element(eid).name == "cable slot 2"
    store.undo()                                                  # rapid renames coalesce into one step
    assert store.doc.element(eid).name == "hinge hole"
    store.redo()
    store.apply([{"op": "update_element", "id": eid, "attrs": {"x": 3}}])
    assert store.doc.element(eid).name == "cable slot 2"         # other edits keep the name
    store.save("named")
    store.new()
    store.open("named")
    assert store.doc.element(eid).name == "cable slot 2"
    svg = store.doc.to_svg("file")
    assert 'data-name="cable slot 2"' in svg and "data-name" not in store.doc.to_svg("cnc")
    store.import_svg(svg, new_tab=True)
    e = store.doc.element(eid)
    assert e.name == "cable slot 2" and "data-name" not in e.attrs
    store.apply([{"op": "update_element", "id": eid, "name": ""}])
    assert store.doc.element(eid).name == ""
    d = Document.from_json({**store.doc.to_json(), "elements": [
        {"id": "el-1", "tag": "rect", "layer": "CUT_OUTSIDE", "attrs": {}, "name": ["bad"] * 100}]})
    d.sanitize()
    assert len(d.elements[0].name) <= 80
