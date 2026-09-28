"""Document model: layers + elements, SVG file (de)serialization.

Units: 1 document unit = 1 mm. Files are written as SVG with width/height in mm and a
viewBox, and layers as Inkscape layers (<g inkscape:groupmode="layer">), so a saved file
opens correctly in Inkscape and CAM software and can be cut as-is (minus non-export layers).

Stroke colour and line style belong to the layer (CNC colour convention); element
attributes never carry them in the model — they are applied when rendering/serializing.
"""
from __future__ import annotations

import copy
import json
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field, asdict
from xml.sax.saxutils import escape, quoteattr

SVG_NS = "http://www.w3.org/2000/svg"
INKSCAPE_NS = "http://www.inkscape.org/namespaces/inkscape"
SHAPE_TAGS = ("line", "rect", "circle", "ellipse", "text", "path", "polygon", "polyline")
# Attributes owned by the layer or by the model itself
LAYER_OWNED = {"stroke", "stroke-dasharray", "stroke-linecap", "id", "data-layer", "data-group", "data-name", "style"}

LINE_STYLES = {"solid": "", "dashed": "6 3", "dotted": "0.5 2.5"}
HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


class DocError(ValueError):
    """User-facing validation error."""


@dataclass
class Layer:
    name: str
    color: str = "#000000"
    line_style: str = "solid"      # solid | dashed | dotted | custom dasharray "a b"
    visible: bool = True
    locked: bool = False
    export: bool = True            # included in CNC export
    description: str = ""
    depth: float | None = None     # partial-depth cut from the top face (pockets), mm; None = through

    def dasharray(self) -> str:
        return LINE_STYLES.get(self.line_style, self.line_style)


@dataclass
class Element:
    id: str
    tag: str
    layer: str
    attrs: dict[str, str] = field(default_factory=dict)
    text: str = ""
    group: str | None = None       # id of the group ("entity") it belongs to
    name: str = ""                 # optional label (UI, lists); not exported to CNC


@dataclass
class Group:
    """A named entity (e.g. one part: outline + holes, possibly on several layers).
    Groups can contain groups (parent). `qty` is for nesting/exports; `assembly` places the
    part in 3D: {"matrix": [a,b,c,d,e,f] doc→part 2D, "thickness", "position": [x,y,z],
    "rotation": [rx,ry,rz] degrees, "color", "move": {"param", "axis"}}."""
    id: str
    name: str
    parent: str | None = None
    qty: int = 1
    assembly: dict | None = None


DEFAULT_LAYER_DESCRIPTIONS = {
    "CUT_OUTSIDE": "Through-cut along the OUTSIDE of the line: part outlines. CAM offsets the tool "
                   "outward by its radius so the part keeps its drawn size. Cut these last (use tabs).",
    "CUT_INSIDE": "Through-cut along the INSIDE of the line: holes, slots, windows. CAM offsets the "
                  "tool inward so the hole keeps its drawn size. Cut these before the outlines.",
    "ENGRAVE": "Partial-depth work ON the line (no offset): marks, labels, drill points, pockets. "
               "Set the depth in CAM; text must be converted to paths.",
    "NOTES": "Reference only: dimensions, labels, sheet outlines. Never cut; left out of CNC export.",
}


DEFAULT_MATERIAL = {
    "name": "Birch plywood",
    "type": "plywood",         # plywood | wood | board | plastic | metal | foam | other
    "color": "#e3c592",        # used by the 3D preview
    "thickness": 18,           # mm — default part thickness (3D preview, CAM notes)
    "sheet_width": 2440,       # stock sheet size, mm
    "sheet_height": 1220,
    "tool_diameter": 6,        # end mill, mm (for CAM notes / minimum inside radius)
    "notes": "",
}
MATERIAL_NUMBERS = ("thickness", "sheet_width", "sheet_height", "tool_diameter")


def clean_title(t) -> str:
    """Project name: one line of plain text (may be empty = use the file name)."""
    return " ".join(str(t).split())[:120] if isinstance(t, str) else ""


def clean_material(m: dict | None, base: dict | None = None) -> dict:
    out = dict(base or DEFAULT_MATERIAL)
    for k, v in (m or {}).items():
        if k in MATERIAL_NUMBERS:
            try:
                v = float(v)
            except (TypeError, ValueError):
                raise DocError(f"Material {k} must be a number")
            if not 0 < v <= 100000:
                raise DocError(f"Material {k} must be greater than 0")
            out[k] = num(v)
        elif k in ("name", "notes", "type"):
            out[k] = str(v)[:500]
        elif k == "color":
            if not HEX_COLOR.match(str(v)):
                raise DocError("Material color must be #rrggbb")
            out[k] = str(v)
    return out


def default_layers() -> list[Layer]:
    d = DEFAULT_LAYER_DESCRIPTIONS
    return [
        Layer("CUT_OUTSIDE", "#e74c3c", "solid", description=d["CUT_OUTSIDE"]),
        Layer("CUT_INSIDE", "#e74c3c", "dashed", description=d["CUT_INSIDE"]),
        Layer("ENGRAVE", "#3498db", "solid", description=d["ENGRAVE"]),
        Layer("NOTES", "#2ecc71", "solid", export=False, description=d["NOTES"]),
    ]


def _numbers(v, n):
    if not isinstance(v, (list, tuple)) or len(v) != n:
        raise DocError(f"expected a list of {n} numbers")
    out = []
    for x in v:
        x = float(x)
        if x != x or abs(x) > 1e7:
            raise DocError("number out of range")
        out.append(num(x))
    return out


def clean_assembly(a, strict=False):
    """Validated 3D placement (see Group). strict: raise on bad input, else drop it."""
    if a is None:
        return None
    try:
        if not isinstance(a, dict):
            raise DocError("assembly must be an object")
        out = {}
        if "matrix" in a: out["matrix"] = _numbers(a["matrix"], 6)
        if "position" in a: out["position"] = _numbers(a["position"], 3)
        if "rotation" in a: out["rotation"] = _numbers(a["rotation"], 3)
        if a.get("thickness") not in (None, ""):
            t = float(a["thickness"])
            if not 0 < t <= 100000:
                raise DocError("thickness must be > 0")
            out["thickness"] = num(t)
        if a.get("color"):
            if not HEX_COLOR.match(str(a["color"])):
                raise DocError("color must be #rrggbb")
            out["color"] = a["color"]
        if a.get("move"):
            m = a["move"]
            if not isinstance(m, dict) or not re.fullmatch(r"[A-Za-z_]\w{0,39}", str(m.get("param", ""))):
                raise DocError("move must be {param, axis}")
            out["move"] = {"param": m["param"], "axis": _numbers(m.get("axis", [0, 1, 0]), 3)}
        return out
    except (DocError, TypeError, ValueError) as e:
        if strict:
            raise DocError(f"Invalid assembly: {e}")
        return None


def clean_params(params) -> list[dict]:
    """3D preview sliders: [{name, label, min, max, step, display_offset, unit}]."""
    out = []
    for p in params if isinstance(params, list) else []:
        if not isinstance(p, dict) or not re.fullmatch(r"[A-Za-z_]\w{0,39}", str(p.get("name", ""))):
            continue
        q = {"name": p["name"], "label": str(p.get("label") or p["name"])[:60], "unit": str(p.get("unit") or "")[:10]}
        try:
            for k, d in (("min", 0), ("max", 100), ("step", 1), ("display_offset", 0)):
                q[k] = num(float(p.get(k, d)))
        except (TypeError, ValueError):
            continue
        if q["max"] <= q["min"] or q["step"] <= 0:
            continue
        out.append(q)
    return out


def check_depth(depth):
    if depth in (None, "", 0):
        return None
    try:
        d = float(depth)
    except (TypeError, ValueError):
        raise DocError("Layer depth must be a number of mm (or empty for through-cuts)")
    if not 0 < d <= 1000:
        raise DocError("Layer depth must be greater than 0 mm")
    return num(d)


def validate_layer_fields(color=None, line_style=None, name=None):
    if name is not None and not re.fullmatch(r"[A-Za-z0-9 _\-.]{1,40}", name):
        raise DocError(f"Invalid layer name {name!r}: use 1-40 letters, digits, space, _ - .")
    if color is not None and not HEX_COLOR.match(color):
        raise DocError(f"Invalid color {color!r}: use #rrggbb")
    if line_style is not None and line_style not in LINE_STYLES and not re.fullmatch(r"[\d.]+([ ,]+[\d.]+)*", line_style):
        raise DocError(f"Invalid line style {line_style!r}: solid, dashed, dotted or a dasharray like '4 2'")


@dataclass
class Document:
    width: float = 800
    height: float = 600
    layers: list[Layer] = field(default_factory=default_layers)
    elements: list[Element] = field(default_factory=list)
    background: dict | None = None          # {"href": data-uri, "opacity": float}
    next_id: int = 1
    groups: list[Group] = field(default_factory=list)
    params: list[dict] = field(default_factory=list)   # 3D preview sliders, e.g. desk height
    material: dict = field(default_factory=lambda: dict(DEFAULT_MATERIAL))
    title: str = ""                         # project name, independent of the file name

    # ── lookup ─────────────────────────────────────────────
    def layer(self, name: str) -> Layer:
        for l in self.layers:
            if l.name == name:
                return l
        raise DocError(f"Layer '{name}' not found")

    def has_layer(self, name: str) -> bool:
        return any(l.name == name for l in self.layers)

    def element(self, eid: str) -> Element:
        for e in self.elements:
            if e.id == eid:
                return e
        raise DocError(f"Element '{eid}' not found")

    def new_id(self) -> str:
        eid = f"el-{self.next_id}"
        self.next_id += 1
        return eid

    # ── elements ───────────────────────────────────────────
    def add_element(self, tag: str, attrs: dict, text: str = "", layer: str | None = None,
                    group: str | None = None, name: str = "") -> Element:
        check_attr_names(attrs)
        if tag not in SHAPE_TAGS:
            raise DocError(f"Unsupported tag '{tag}'. Use one of: {', '.join(SHAPE_TAGS)}")
        layer = layer or self.layers[0].name
        self.layer(layer)
        if group:
            self.group_by_id(group)
        el = Element(self.new_id(), tag, layer, clean_attrs(attrs), text or "", group or None, clean_name(name))
        self.elements.append(el)
        return el

    def update_element(self, eid: str, attrs: dict | None = None, text: str | None = None,
                       layer: str | None = None, name: str | None = None) -> Element:
        el = self.element(eid)
        if attrs is not None and not isinstance(attrs, dict):
            raise DocError("attrs must be an object")
        check_attr_names(attrs)
        for k, v in (attrs or {}).items():
            if k in LAYER_OWNED:
                continue
            if v is None or v == "":
                el.attrs.pop(k, None)
            else:
                el.attrs[k] = str(v)
        if text is not None:
            el.text = text
        if name is not None:
            el.name = clean_name(name)
        if layer:
            self.layer(layer)
            el.layer = layer
        return el

    def remove_elements(self, ids: list[str]) -> int:
        ids = set(ids)
        missing = ids - {e.id for e in self.elements}
        if missing:
            raise DocError(f"Element(s) not found: {', '.join(sorted(missing))}")
        self.elements = [e for e in self.elements if e.id not in ids]
        self.prune_groups()
        return len(ids)

    # ── groups ("entities") ────────────────────────────────
    def group_by_id(self, gid: str) -> Group:
        for g in self.groups:
            if g.id == gid:
                return g
        raise DocError(f"Group '{gid}' not found")

    def parent_of(self, item: str) -> str | None:
        return self.group_by_id(item).parent if item.startswith("g-") else self.element(item).group

    def descendants(self, gid: str) -> list[str]:
        """Element ids inside a group, at any depth."""
        kids = {gid}
        changed = True
        while changed:
            changed = False
            for g in self.groups:
                if g.parent in kids and g.id not in kids:
                    kids.add(g.id); changed = True
        return [e.id for e in self.elements if e.group in kids]

    def ancestors(self, gid: str | None) -> list[str]:
        out = []
        while gid:
            out.append(gid)
            gid = self.group_by_id(gid).parent
        return out

    def new_group_id(self) -> str:
        n = max([int(g.id[2:]) for g in self.groups if re.fullmatch(r"g-\d+", g.id)] + [0])
        return f"g-{n + 1}"

    def group(self, items: list[str], name: str | None = None, parent: str | None = None) -> Group:
        """Group elements and/or groups that share the same parent (the current drill-down level)."""
        items = list(dict.fromkeys(items or []))
        if not items:
            raise DocError("Nothing to group")
        parents = {self.parent_of(i) for i in items}
        if len(parents) != 1:
            raise DocError("Items to group must be at the same level (same parent group)")
        parent = parents.pop() if parent is None else parent
        if parent:
            self.group_by_id(parent)
        g = Group(self.new_group_id(), (name or "").strip()[:80] or f"Entity {len(self.groups) + 1}", parent)
        self.groups.append(g)
        for i in items:
            if i.startswith("g-"):
                if i in self.ancestors(parent):
                    raise DocError("Cannot put a group inside itself")
                self.group_by_id(i).parent = g.id
            else:
                self.element(i).group = g.id
        return g

    def move_to_group(self, items: list[str], gid: str | None) -> int:
        """Put elements and/or entities into entity `gid` (None = the top level). Entities left
        empty are removed. An entity can't go inside itself or one of its own sub-entities."""
        items = list(dict.fromkeys(items or []))
        if not items:
            raise DocError("Nothing to move")
        if gid:
            self.group_by_id(gid)
            inside = self.ancestors(gid)
        for i in items:
            if i.startswith("g-"):
                g = self.group_by_id(i)
                if gid and i in inside:
                    raise DocError(f"Can't put '{g.name}' inside itself")
                g.parent = gid
            else:
                self.element(i).group = gid
        self.prune_groups()
        return len(items)

    def ungroup(self, gid: str) -> int:
        g = self.group_by_id(gid)
        n = 0
        for e in self.elements:
            if e.group == gid:
                e.group = g.parent; n += 1
        for c in self.groups:
            if c.parent == gid:
                c.parent = g.parent; n += 1
        self.groups.remove(g)
        return n

    def update_group(self, gid: str, name: str | None = None, qty: int | None = None,
                     assembly=...) -> Group:
        """assembly: ... = unchanged, None = remove, dict = validated placement."""
        g = self.group_by_id(gid)
        if name is not None:
            if not name.strip():
                raise DocError("Entity name is empty")
            g.name = name.strip()[:80]
        if qty is not None:
            if int(qty) < 1:
                raise DocError("Quantity must be at least 1")
            g.qty = int(qty)
        if assembly is not ...:
            if assembly is not None and not isinstance(assembly, dict):
                raise DocError("assembly must be an object or null")
            g.assembly = clean_assembly(assembly, strict=True)
        return g

    def prune_groups(self):
        """Drop groups left without any elements (after deletes)."""
        while True:
            used = {e.group for e in self.elements} | {g.parent for g in self.groups}
            empty = [g for g in self.groups if g.id not in used]
            if not empty:
                return
            self.groups = [g for g in self.groups if g not in empty]

    def reorder_element(self, eid: str, where: str):
        el = self.element(eid)
        self.elements.remove(el)
        if where == "front":
            self.elements.append(el)
        elif where == "back":
            self.elements.insert(0, el)
        else:
            raise DocError("where must be 'front' or 'back'")

    # ── layers ─────────────────────────────────────────────
    def add_layer(self, name: str, color: str = "#000000", line_style: str = "solid",
                  export: bool = True, visible: bool = True, locked: bool = False,
                  description: str = "", depth: float | None = None) -> Layer:
        validate_layer_fields(color, line_style, name)
        if self.has_layer(name):
            raise DocError(f"Layer '{name}' already exists")
        layer = Layer(name, color, line_style, visible, locked, export, (description or "")[:500], check_depth(depth))
        self.layers.append(layer)
        return layer

    def update_layer(self, name: str, new_name: str | None = None, color: str | None = None,
                     line_style: str | None = None, visible: bool | None = None,
                     locked: bool | None = None, export: bool | None = None,
                     description: str | None = None, depth=...) -> Layer:
        layer = self.layer(name)
        validate_layer_fields(color, line_style, new_name)
        if new_name and new_name != name:
            if self.has_layer(new_name):
                raise DocError(f"Layer '{new_name}' already exists")
            layer.name = new_name
            for e in self.elements:
                if e.layer == name:
                    e.layer = new_name
        if color is not None: layer.color = color
        if line_style is not None: layer.line_style = line_style
        if visible is not None: layer.visible = bool(visible)
        if locked is not None: layer.locked = bool(locked)
        if export is not None: layer.export = bool(export)
        if description is not None: layer.description = description[:500]
        if depth is not ...: layer.depth = check_depth(depth)
        return layer

    def remove_layer(self, name: str, move_to: str | None = None) -> int:
        self.layer(name)
        if len(self.layers) == 1:
            raise DocError("Cannot remove the last layer")
        members = [e for e in self.elements if e.layer == name]
        if members:
            if not move_to:
                raise DocError(f"Layer '{name}' has {len(members)} element(s): pass move_to=<layer> "
                               f"to keep them, or delete them first")
            if move_to == "__delete__":
                self.elements = [e for e in self.elements if e.layer != name]
                self.prune_groups()
            else:
                self.layer(move_to)
                for e in members:
                    e.layer = move_to
        self.layers = [l for l in self.layers if l.name != name]
        return len(members)

    def move_layer(self, name: str, index: int):
        layer = self.layer(name)
        self.layers.remove(layer)
        self.layers.insert(max(0, min(index, len(self.layers))), layer)

    # ── size ───────────────────────────────────────────────
    def set_size(self, width: float, height: float):
        if not (0 < float(width) <= 100000 and 0 < float(height) <= 100000):
            raise DocError("Width and height must be between 0 and 100000 mm")
        self.width, self.height = num(width), num(height)

    # ── (de)serialization: JSON ────────────────────────────
    def to_json(self) -> dict:
        return {
            "width": self.width, "height": self.height,
            "layers": [asdict(l) for l in self.layers],
            "elements": [asdict(e) for e in self.elements],
            "background": self.background,
            "next_id": self.next_id,
            "groups": [asdict(g) for g in self.groups],
            "params": self.params,
            "material": self.material,
            "title": self.title,
        }

    @classmethod
    def from_json(cls, d: dict) -> "Document":
        """Load and validate (files and sessions are untrusted: everything is checked)."""
        layer_keys = set(Layer.__dataclass_fields__)
        el_keys, group_keys = set(Element.__dataclass_fields__), set(Group.__dataclass_fields__)
        doc = cls(width=d["width"], height=d["height"],
                  layers=[Layer(**{k: v for k, v in l.items() if k in layer_keys}) for l in d["layers"]],
                  elements=[Element(**{k: v for k, v in e.items() if k in el_keys}) for e in d["elements"]],
                  background=d.get("background"), next_id=d.get("next_id", 1),
                  groups=[Group(**{k: v for k, v in g.items() if k in group_keys}) for g in d.get("groups", [])],
                  params=d.get("params", []), material=clean_material(d.get("material")),
                  title=clean_title(d.get("title")))
        doc.sanitize()
        doc._fix_next_id()
        return doc

    def sanitize(self):
        """Make a loaded document safe and consistent: valid layer fields, ids, tags,
        attributes, entities, placements and parameters. Invalid bits are dropped or reset."""
        self.set_size(self.width, self.height)
        seen = set()
        layers = []
        for l in self.layers:
            name = sanitize_layer_name(str(l.name))
            if name in seen:
                continue
            seen.add(name)
            l.name = name
            l.color = l.color if HEX_COLOR.match(str(l.color)) else "#000000"
            try:
                validate_layer_fields(line_style=str(l.line_style))
            except DocError:
                l.line_style = "solid"
            l.visible, l.locked, l.export = bool(l.visible), bool(l.locked), bool(l.export)
            l.description = str(l.description or "")[:500]
            try:
                l.depth = check_depth(l.depth)
            except DocError:
                l.depth = None
            layers.append(l)
        self.layers = layers or default_layers()
        names = {l.name for l in self.layers}
        gids = {g.id for g in self.groups if isinstance(g.id, str) and re.fullmatch(r"g-\d+", g.id)}
        groups = []
        for g in self.groups:
            if g.id not in gids or any(x.id == g.id for x in groups):
                continue
            g.name = str(g.name or "Entity")[:80]
            g.parent = g.parent if g.parent in gids and g.parent != g.id else None
            try:
                g.qty = max(1, int(g.qty or 1))
            except (TypeError, ValueError):
                g.qty = 1
            g.assembly = clean_assembly(g.assembly)
            groups.append(g)
        self.groups = groups
        for g in self.groups:              # break parent cycles
            chain, cur = set(), g
            while cur and cur.parent:
                if cur.id in chain:
                    g.parent = None
                    break
                chain.add(cur.id)
                cur = next((x for x in self.groups if x.id == cur.parent), None)
        elements, ids = [], set()
        for e in self.elements:
            if e.tag not in SHAPE_TAGS:
                continue
            if not (isinstance(e.id, str) and re.fullmatch(r"el-\d+", e.id)) or e.id in ids:
                e.id = ""
            ids.add(e.id)
            e.layer = e.layer if e.layer in names else self.layers[0].name
            e.attrs = clean_attrs(e.attrs if isinstance(e.attrs, dict) else {})
            e.text = str(e.text or "")
            e.group = e.group if e.group in gids else None
            e.name = clean_name(e.name)
            elements.append(e)
        self.elements = elements
        self._fix_next_id()
        for e in self.elements:
            if not e.id:
                e.id = self.new_id()
        self.params = clean_params(self.params)
        if self.background and not (isinstance(self.background, dict)
                                    and str(self.background.get("href", "")).startswith("data:image/")):
            self.background = None

    def clone(self) -> "Document":
        return copy.deepcopy(self)

    def _fix_next_id(self):
        for e in self.elements:
            m = re.fullmatch(r"el-(\d+)", e.id)
            if m:
                self.next_id = max(self.next_id, int(m.group(1)) + 1)

    # ── (de)serialization: SVG ─────────────────────────────
    def to_svg(self, mode: str = "file") -> str:
        """mode: 'file' (all layers, Inkscape layers, background), 'cnc' (export+visible layers,
        no background, no ids), 'screen' (plain, for previews)."""
        w, h = fmt(self.width), fmt(self.height)
        head = [f'<svg xmlns="{SVG_NS}"']
        if mode == "file":
            head.append(f' xmlns:inkscape="{INKSCAPE_NS}"')
        head.append(f' width="{w}mm" height="{h}mm" viewBox="0 0 {w} {h}">')
        out = ["".join(head)]
        if mode == "file":
            meta = json.dumps({"groups": [asdict(g) for g in self.groups], "params": self.params,
                               "material": self.material, "title": self.title})
            out.append(f'  <metadata id="kerf" data-kerf={quoteattr(meta)}/>')
        if mode == "file" and self.background:
            out.append(f'  <image data-role="background" x="0" y="0" width="{w}" height="{h}" '
                       f'preserveAspectRatio="xMidYMid meet" opacity="{self.background.get("opacity", 0.3)}" '
                       f'href={quoteattr(self.background["href"])}/>')
        for i, layer in enumerate(self.layers):
            if mode == "cnc" and not layer.export:        # visibility is a view setting, not an export filter
                continue
            members = [e for e in self.elements if e.layer == layer.name]
            if mode == "cnc" and not members:
                continue
            g = f'  <g id="layer{i + 1}" inkscape:groupmode="layer" inkscape:label={quoteattr(layer.name)}' \
                if mode == "file" else f'  <g id={quoteattr(layer.name)}'
            if mode == "file":
                g += (f' data-color="{layer.color}" data-line-style={quoteattr(layer.line_style)}'
                      f' data-export="{str(layer.export).lower()}" data-locked="{str(layer.locked).lower()}"'
                      f' data-description={quoteattr(layer.description)}'
                      f'{"" if layer.depth is None else f" data-depth={quoteattr(str(layer.depth))}"}'
                      f'{"" if layer.visible else " style=" + quoteattr("display:none")}')
            out.append(g + ">")
            for e in members:
                out.append("    " + element_svg(e, layer, with_id=(mode != "cnc"), with_group=(mode == "file")))
            out.append("  </g>")
        out.append("</svg>")
        return "\n".join(out)

    @classmethod
    def from_svg(cls, markup: str, default_layer: str | None = None,
                 base: "Document | None" = None) -> "Document":
        """Parse an SVG file. Recognizes our/Inkscape layers, data-layer attributes and plain
        SVGs. With `base`, elements are appended to a copy of it (import) instead of a new doc."""
        body = re.sub(r"^\s*(<\?xml[^>]*\?>)?\s*(<!DOCTYPE[^>]*>)?\s*", "", markup or "")
        if not re.match(r"<(\w+:)?svg[\s>]", body):
            # Fragment (one or more elements): wrap in an <svg>
            body = f'<svg xmlns="{SVG_NS}">{body}</svg>'
        try:
            root = ET.fromstring(body)
        except ET.ParseError as e:
            raise DocError(f"Invalid SVG: {e}")

        doc = base.clone() if base else cls(layers=[])
        width_mm, height_mm, root_transform = root_geometry(root)
        if not base:
            doc.width, doc.height = width_mm, height_mm

        def ensure_layer(name, g=None):
            if doc.has_layer(name):
                return
            defaults = {l.name: l for l in default_layers()}
            layer = copy.copy(defaults.get(name, Layer(name, "#000000")))
            if g is not None:
                if HEX_COLOR.match(g.get("data-color") or ""): layer.color = g.get("data-color")
                if g.get("data-line-style"):
                    try:
                        validate_layer_fields(line_style=g.get("data-line-style"))
                        layer.line_style = g.get("data-line-style")
                    except DocError:
                        pass
                if g.get("data-export"): layer.export = g.get("data-export") == "true"
                if g.get("data-locked"): layer.locked = g.get("data-locked") == "true"
                if g.get("data-description") is not None: layer.description = g.get("data-description")
                if g.get("data-depth"):
                    try: layer.depth = check_depth(g.get("data-depth"))
                    except DocError: pass
                if "display:none" in (g.get("style") or "").replace(" ", ""): layer.visible = False
            doc.layers.append(layer)

        fallback = default_layer or (doc.layers[0].name if doc.layers else "CUT_OUTSIDE")
        found_real_layers = False
        used_ids = {e.id for e in doc.elements}

        # Groups ("entities") and 3D parameters from our metadata; ids are remapped on import
        group_map: dict[str, str] = {}
        meta = next((m for m in root.iter() if local(m.tag) == "metadata"
                     and (m.get("data-kerf") or m.get("data-svgcnc"))), None)
        if meta is not None:
            try:
                data = json.loads(meta.get("data-kerf") or meta.get("data-svgcnc"))
                incoming = [Group(**{k: g.get(k) for k in ("id", "name", "parent", "qty", "assembly") if k in g})
                            for g in data.get("groups", [])]
                incoming = [g for g in incoming if isinstance(g.id, str) and re.fullmatch(r"g-\d+", g.id)]
                for g in incoming:
                    group_map[g.id] = doc.new_group_id() if base else g.id
                    doc.groups.append(Group(group_map[g.id], str(g.name or "Entity")[:80], None,
                                            max(1, int(g.qty or 1)), clean_assembly(g.assembly)))
                for g in incoming:
                    if g.parent in group_map:
                        doc.group_by_id(group_map[g.id]).parent = group_map[g.parent]
                if not base and isinstance(data.get("params"), list):
                    doc.params = clean_params(data["params"])
                if not base and isinstance(data.get("material"), dict):
                    doc.material = clean_material(data["material"])
                if not base:
                    doc.title = clean_title(data.get("title"))
            except (ValueError, TypeError) as e:
                raise DocError(f"Invalid entity metadata: {e}")

        def walk(node, layer_name, transform):
            for child in node:
                tag = local(child.tag)
                if tag == "image" and child.get("data-role") == "background" and not base:
                    href = child.get("href") or child.get("{http://www.w3.org/1999/xlink}href")
                    if href:
                        doc.background = {"href": href, "opacity": float(child.get("opacity") or 0.3)}
                    continue
                if tag == "g":
                    label = child.get(f"{{{INKSCAPE_NS}}}label")
                    is_layer = child.get(f"{{{INKSCAPE_NS}}}groupmode") == "layer"
                    if is_hidden(child) and not (is_layer and label):
                        continue  # hidden group: never import (it would get cut)
                    name = layer_name
                    if is_layer and label:
                        nonlocal found_real_layers
                        found_real_layers = True
                        name = sanitize_layer_name(label)
                        ensure_layer(name, child)
                    t = " ".join(x for x in (transform, child.get("transform")) if x)
                    walk(child, name, t)
                    continue
                if tag not in SHAPE_TAGS or is_hidden(child):
                    continue
                name = sanitize_layer_name(child.get("data-layer")) if child.get("data-layer") else layer_name
                ensure_layer(name)
                attrs = {k: v for k, v in child.attrib.items() if "}" not in k}   # drop namespaced
                attrs.update(style_attrs(attrs.pop("style", "")))
                if transform:
                    attrs["transform"] = " ".join(x for x in (transform, attrs.get("transform")) if x)
                eid = attrs.get("id", "")
                if not re.fullmatch(r"el-\d+", eid) or eid in used_ids:
                    eid = ""
                used_ids.add(eid)
                gid = group_map.get(child.get("data-group") or "")
                label = clean_name(child.get("data-name"))
                lines = text_lines(child) if tag == "text" else None
                if lines:  # multi-line text (positioned <tspan>s): one text element per line
                    for i, (line_attrs, line) in enumerate(lines):
                        doc.elements.append(Element(eid if i == 0 else "", tag, name,
                                                    clean_attrs({**attrs, **line_attrs}), line, gid, label))
                    continue
                el = Element(eid, tag, name, clean_attrs(attrs), "".join(child.itertext()) if tag == "text" else "", gid,
                             label)
                doc.elements.append(el)

        walk(root, fallback, root_transform)
        if not base and not found_real_layers:
            # Plain SVG (layers only via data-layer, or none): standard CNC layers first, extras after
            extras = [l for l in doc.layers if l.name not in DEFAULT_LAYER_DESCRIPTIONS]
            doc.layers = default_layers() + extras
        doc._fix_next_id()
        for e in doc.elements:
            if not e.id:
                e.id = doc.new_id()
            if not doc.has_layer(e.layer):
                ensure_layer(e.layer)
        doc.prune_groups()
        return doc


# ── helpers ────────────────────────────────────────────────

def element_svg(e: Element, layer: Layer, with_id: bool = True, with_group: bool = False) -> str:
    attrs = dict(e.attrs)
    if with_group and e.group:
        attrs["data-group"] = e.group
    if with_group and e.name:
        attrs["data-name"] = e.name
    if e.tag == "text":
        attrs.setdefault("fill", layer.color)
        if attrs.get("fill") not in ("none",):
            attrs["fill"] = layer.color
    else:
        attrs["stroke"] = layer.color
        attrs.setdefault("fill", "none")
        attrs.setdefault("stroke-width", "1")
        dash = layer.dasharray()
        if dash:
            attrs["stroke-dasharray"] = dash
            if layer.line_style == "dotted":
                attrs["stroke-linecap"] = "round"
    a = (f'id="{e.id}" ' if with_id else "") + " ".join(f"{k}={quoteattr(str(v))}" for k, v in attrs.items())
    if e.tag == "text":
        return f"<text {a}>{escape(e.text)}</text>"
    return f"<{e.tag} {a}/>"


ATTR_NAME = re.compile(r"[A-Za-z_][\w.\-]*")


def valid_attr_name(k: str) -> bool:
    """Plain SVG attribute names only: no namespaces, no event handlers (on*)."""
    return bool(ATTR_NAME.fullmatch(k)) and not k.lower().startswith("on")


def check_attr_names(attrs: dict | None):
    if attrs is not None and not isinstance(attrs, dict):
        raise DocError("attrs must be an object")
    bad = [k for k in (attrs or {}) if not valid_attr_name(str(k))]
    if bad:
        raise DocError(f"Invalid attribute name(s): {', '.join(map(repr, bad))}")


def clean_name(name) -> str:
    """Element name: one line of plain text, up to 80 characters ("" = unnamed)."""
    return " ".join(str(name or "").split())[:80]


def clean_attrs(attrs: dict) -> dict:
    """Drop layer-owned, namespaced and unsafe attributes (used for imports too)."""
    out = {}
    for k, v in (attrs or {}).items():
        if k in LAYER_OWNED or v is None or not valid_attr_name(k):
            continue
        out[k] = str(v)
    return out


STYLE_KEEP = {"fill", "fill-rule", "fill-opacity", "opacity", "stroke-width", "font-size", "font-family",
              "font-weight", "font-style", "text-anchor", "dominant-baseline", "letter-spacing"}


def is_hidden(node) -> bool:
    style = (node.get("style") or "").replace(" ", "")
    return node.get("display") == "none" or "display:none" in style or node.get("visibility") == "hidden"


def style_attrs(style: str) -> dict:
    out = {}
    for part in (style or "").split(";"):
        if ":" in part:
            k, v = part.split(":", 1)
            k, v = k.strip(), v.strip()
            if k in STYLE_KEEP:
                out[k] = v
    return out


def local(tag: str) -> str:
    return tag.split("}", 1)[1] if "}" in tag else tag


def sanitize_layer_name(name: str) -> str:
    name = re.sub(r"[^A-Za-z0-9 _\-.]", "_", (name or "").strip())[:40]
    return name or "Layer"


UNIT_MM = {"mm": 1.0, "cm": 10.0, "in": 25.4, "pt": 25.4 / 72, "pc": 25.4 / 6, "px": 25.4 / 96,
           "": 1.0}  # unitless = this app's convention (1 unit = 1 mm)


def root_geometry(root) -> tuple[float, float, str]:
    """Document size in mm and the transform mapping the file's user units to mm."""
    def length(v):
        m = re.fullmatch(r"\s*([\d.]+(?:e-?\d+)?)\s*([a-z%]*)\s*", v or "")
        if not m or m.group(2) not in UNIT_MM:
            return None
        return float(m.group(1)) * UNIT_MM[m.group(2)]

    w, h = length(root.get("width")), length(root.get("height"))
    vb = (root.get("viewBox") or "").replace(",", " ").split()
    if len(vb) != 4:
        # No viewBox: user units are the unit of width/height (px→mm etc.)
        m = re.match(r"\s*[\d.]+\s*([a-z]*)", root.get("width") or "")
        k = UNIT_MM.get(m.group(1), 1.0) if m else 1.0
        return (num(w) if w else 800, num(h) if h else 600,
                f"scale({fmt(k)})" if abs(k - 1) > 1e-9 else "")
    minx, miny, vw, vh = (float(x) for x in vb)
    sx = w / vw if w and vw else 1.0
    sy = h / vh if h and vh else sx
    t = []
    if abs(sx - 1) > 1e-9 or abs(sy - 1) > 1e-9:
        t.append(f"scale({fmt(sx)})" if abs(sx - sy) < 1e-9 else f"scale({fmt(sx)}, {fmt(sy)})")
    if minx or miny:
        t.append(f"translate({fmt(-minx)}, {fmt(-miny)})")
    return num(vw * sx), num(vh * sy), " ".join(t)


def text_lines(node) -> list[tuple[dict, str]] | None:
    """Positioned <tspan> children (Inkscape multi-line text) as (attrs, text) lines."""
    spans = [c for c in node if local(c.tag) == "tspan" and (c.get("x") or c.get("y"))]
    if len(spans) < 2:
        return None
    out = []
    for sp in spans:
        a = {k: v for k, v in sp.attrib.items() if k in ("x", "y") }
        a.update(style_attrs(sp.get("style", "")))
        out.append((a, "".join(sp.itertext())))
    return out


def num(v) -> float:
    f = round(float(v), 4)
    return int(f) if f == int(f) else f


def fmt(v) -> str:
    f = round(float(v), 6)
    return str(int(f)) if f == int(f) else repr(f)


# ── Native project file (.kerf) ────────────────────────────
# Everything the editor knows (layers, entities, 3D placements, parameters, material,
# reference image) in one JSON file. SVG and DXF are exports.

NATIVE_FORMAT = "kerf"
LEGACY_FORMATS = ("svgcnc",)   # early name of the same format
NATIVE_VERSION = 1


def to_native(doc: Document) -> str:
    return json.dumps({"format": NATIVE_FORMAT, "version": NATIVE_VERSION, "document": doc.to_json()},
                      ensure_ascii=False, indent=1)


def from_native(text: str) -> Document:
    try:
        data = json.loads(text)
    except ValueError as e:
        raise DocError(f"Not a valid .kerf file: {e}")
    if not isinstance(data, dict) or data.get("format") not in (NATIVE_FORMAT, *LEGACY_FORMATS):
        raise DocError("Not a .kerf project file")
    if int(data.get("version", 0)) > NATIVE_VERSION:
        raise DocError("This file was saved by a newer version of the editor")
    try:
        doc = Document.from_json(data["document"])
    except (KeyError, TypeError) as e:
        raise DocError(f"Damaged .kerf file: {e}")
    doc.prune_groups()
    return doc
