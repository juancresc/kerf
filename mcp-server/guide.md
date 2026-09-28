# Kerf guide — designing CNC parts with Claude

Kerf is a CAD-style editor for CNC-cut parts: flat parts cut from sheet material (plywood, MDF, plastic, aluminium), grouped into an assembly with a live 3D preview. The user watches every change live in their browser. **1 unit = 1 mm, everywhere.**

## Workflow

1. **Ask first** if it isn't clear:
   - what the object is, its overall size, and who uses it (children? load?);
   - the material and thickness (default: 18 mm birch plywood);
   - **the stock / machine: default to full 2440 × 1220 sheets** unless the user gives something else. If they name a machine or stock size, use it; common ones: 6090 = 600 × 900, quarter sheet = 1220 × 610, Shapeoko XXL = 838 × 838, 1212 = 1200 × 1200, 1325 = 1300 × 2500 (full sheets). Don't hold up the design to ask about it.
2. **Set up the project:**
   - `new_document` (or reuse an empty tab);
   - `set_project_name` with a readable name;
   - `set_material` for name, thickness, colour, sheet size and tool Ø;
   - add the layers you need (see Layers).
3. **Work the numbers out first**, before drawing: part sizes, joints, hole positions and clearances. **More than ~5 parts, or anything you'll tweak: write a script** (see Parametric scripts). It's re-runnable and far fewer calls.
4. **Draw each part as one `apply_ops` batch:** its shapes (`fill: "none"`), a `group` of them, and an `update_group` with `qty` and the 3D placement. Name ops with `"as"` and refer to them as `"$name"`:

   ```json
   [{"op": "add_element", "as": "outline", "tag": "rect", "layer": "CUT_OUTSIDE",
     "attrs": {"x": 0, "y": 0, "width": 400, "height": 260, "rx": 6, "fill": "none"}},
    {"op": "add_element", "as": "hole", "tag": "circle", "layer": "CUT_INSIDE",
     "attrs": {"cx": 30, "cy": 30, "r": 4, "fill": "none"}},
    {"op": "group", "as": "shelf", "items": ["$outline", "$hole"], "name": "Shelf"},
    {"op": "update_group", "id": "$shelf", "qty": 1,
     "assembly": {"rotation": [-90, 0, 0], "position": [-200, 300, 130]}}]
   ```

   Where you draw it doesn't matter yet. **Leave out `matrix`**: the part's local origin becomes the bottom-left corner of its drawing (y up), which is what the placement recipes below assume. Draw the part the way its recipe says (e.g. a shelf as width × depth with the front edge at the bottom).
5. **`arrange_parts`** packs every part onto sheets (the material's sheet size, 2440 × 1220 by default; pass the user's machine bed if they gave one). It draws the sheets on the SHEETS layer, turns parts 90° when that fits better, and puts parts bigger than a sheet in a row underneath (plain rectangles can be cut with a saw: say so). **Moving, turning or arranging parts never changes their 3D placement.** Hand-nest odd shapes afterwards with `move_elements` / `transform_elements` if you can save a sheet.
6. **Check with numbers, then look:**
   - `check_cnc`: open contours, small holes, parts overlapping or closer than the tool, parts off the sheets, parts left out of 3D;
   - `describe_assembly`: every part's world box in mm. Compare it with where the part should be (e.g. a shelf at Y 300–318). Most 3D mistakes are a wrong rotation or position, and they show up here;
   - `take_screenshot` with `view="2d"`, then `"3d"` and `"3d-exploded"` (needs the editor open in a browser).
7. **Finish:**
   - notes: `arrange_parts(notes=[...])` writes the cut order, hardware list and assembly/safety notes under the sheets;
   - `save_document` with a file name;
   - tell the user the share link, `<editor>/?open=<file>` (add `&view=3d` for the 3D view).

When the user pastes a Kerf link (`…/?open=<file>`), call `open_document` with it: that switches to the tab (or opens it).

Never discard the user's unsaved work or close their tabs without asking. Tools act on the active tab: `list_tabs` / `switch_tab`.

## Layers

The layer decides the colour, the line style and whether a shape is cut. Never set `stroke` on elements.

- `CUT_OUTSIDE`: part outlines. CAM cuts outside the line.
- `CUT_INSIDE`: holes, slots and windows through the part. CAM cuts inside the line.
- **Pockets** are partial-depth cuts: add a layer with a `depth`, e.g. `add_layer("HINGE_CUPS", depth=12.5)`. Pockets are cut **from the top face**, so make sure that face ends up where the pocket belongs (see Mirrored parts).
- `ENGRAVE`: shallow marking.
- `NOTES`: labels, dimensions and notes. Never cut; not exported.
- `SHEETS`: the stock sheets, drawn by `arrange_parts`. Never cut; redrawn on every arrange.
- **HARDWARE**: bought parts (dowels, rods, pins). Add it with `add_layer("HARDWARE", export=false)`. Draw each part's cross-section there so it shows in 3D. It is never cut.

## 3D placement (assembly)

World axes: **X = width (left → right), Y = up, Z = toward the viewer (front)**. Put the model's centre near X = 0.

Each entity's `assembly` has these fields:
- **`matrix [a,b,c,d,e,f]`** maps drawing coordinates to the part's own 2D coordinates (x right, y up): `local = (a·x + c·y + e, b·x + d·y + f)`. **Usually leave it out:** a new placement gets `[1, 0, 0, -1, -ox, oy + h]` (origin at the drawing's bottom-left corner), an updated one keeps its matrix, and `"matrix": "auto"` recomputes it from the drawing now. It follows the part when it's moved or turned on the sheet.
- **`thickness`**: the extrusion along local +z. **Leave it out for parts cut from the sheet** so they follow the material thickness (`set_material`); set it only for other stock (rods, hardware). The **top face** is at z = thickness; it's the router face, where pockets are cut.
- **`rotation`** in degrees (Euler XYZ), then **`position`**: where the local origin goes, in world mm.
- Optional: `color`, and `move: {param, axis}` to slide the part with a `set_params` slider.

**Recipes** (local x/y below means after the default matrix: x right from the drawing's left edge, y up from its bottom edge):

| Part | Draw it as | rotation | position (local origin →) | top face faces |
|---|---|---|---|---|
| Board standing, facing front (back panel, rail, drawer front) | x = width, y = height | `[0, 0, 0]` | [left X, bottom Y, back-face Z] | +Z (front) |
| Door with hinge cups inside | x = 0 at the door's **right** edge (world), y = height; cups near whichever edge has the hinges | `[0, 180, 0]` | [right-edge X, bottom Y, front-face Z] | −Z (inside) |
| Side panel, profile in depth × height | x = depth from the front, y = height | `[0, 90, 0]` | [its left-face X, bottom Y, front Z] | +X |
| Opposite side whose pockets face −X | drawn **mirrored** (front on the right); matrix `[1,0,0,-1,-(ox+w), oy+h]` (origin at the bottom-right) | `[0, -90, 0]` | [its right-face X, bottom Y, front Z] | −X |
| Flat board (shelf, top, bottom, desktop) | x = width, y = depth with the **front edge at the bottom** of the drawing | `[-90, 0, 0]` | [left X, underside Y, front Z] | +Y (up) |
| Part turned on the sheet to fit | draw it upright, place it, then turn it (`transform_elements`, `arrange_parts`): the matrix follows | as its recipe | as its recipe | as its recipe |
| Rod / dowel through side panels | its circle on HARDWARE, matrix mapping the circle centre to the panel's local (depth, height) | same as the panels | [start X, 0, front Z], thickness = rod length | — |

**Moving parts:** `set_params([{name: "lift", label: "Height", min: 0, max: 450, step: 37.5, unit: "mm"}])`, then add `"move": {"param": "lift", "axis": [0, 1, 0]}` to each part that slides.

**Nested entities:** group a drawer's 5 part-entities into one "Drawer 1" entity (the `group` op accepts entity ids). Quantities (`qty`) are used by `export_parts`.

**Fixing entities:** `move_to_entity(ids, entity)` (op `set_group {items, group}`) adds shapes or entities to an entity, or takes them out when `entity` is empty. Entities left empty disappear.

**Naming shapes:** single shapes can carry a `name` too ("hinge hole", "cable slot"): `add_element{…, name}`, `update_element{id, name}` (`""` clears it), `find_elements(name=…)`. Names are labels for the editor and for you, never exported to CNC.

## CNC rules of thumb (18 mm plywood)

- Inside corners get the tool radius (3 mm for a 6 mm end mill). Add dog-bones where a square part must fit in.
- Keep at least 12 mm of wood around holes; 20 mm between parts; 15 mm from the bed edge.
- **Bolting into a board's edge:**
  - a cross-dowel (barrel nut) joint: an Ø8.5 hole in the face panel, an Ø10 cross hole 25 mm from the end of the other board;
  - the face hole sits 9 mm from the panel edge (the middle of an 18 mm board);
  - inset the board about 10 mm from the panel's edge so there's wood left around the hole.
- Closed outlines, no duplicate lines, no text on cut layers, no parts bigger than the sheet or bed.
- **Opposite-hand parts with pockets must be drawn mirrored**, so both pockets end up on their inner faces.

## Shapes (slots, rounded corners, dog-bones)

Don't write arc path data by hand; these make exact lines + arcs (DXF arcs, true circles):

| feature | tool / op | notes |
|---|---|---|
| bolt track, knob slot | `add_slot` / `{"op": "add_slot", x1, y1, x2, y2, width}` | centre line + width; zero length = round hole; default layer CUT_INSIDE |
| window, panel with round corners | `add_rounded_rect` / `{"op": "add_rounded_rect", x, y, width, height, r}` | r clamped to half the shorter side |
| leg, frame, any outline with mixed radii | `add_outline` / `{"op": "add_outline", points: [[x, y], [x, y, r], ...]}` | r per corner, clamped to fit |
| round some corners of an existing shape | `fillet_corners` / `{"op": "fillet", id, r, corners}` | rect, polygon or path of straight lines; keeps the id |
| square part into a routed hole / tenon shoulders | `add_dogbones` / `{"op": "dogbone", id, tool_d?, corners}` | "auto": every corner of a CUT_INSIDE hole, else the concave corners; Ø = material tool |

`corners` is `"all"`, corner indices in drawing order, or `[x, y]` points in document mm (nearest corner within 5 mm). In scripts use `k.slot(x1, y1, x2, y2, w)`, `k.rounded_rect(x0, y0, x1, y1, r)` and `k.build(..., corners)`.

## SVG gotchas

- **Arc flags:** `A rx ry 0 large sweep x y`. large = 1 only when the arc spans **more than 180°**. A circular segment whose centre lies beyond the chord (e.g. an arch whose circle centre is below the floor) spans less than 180°, so large = 0. A wrong flag bulges the shape out: always check the 2D screenshot or `describe_entity` bounds.
- In the drawing y points **down**; in part-local coordinates y points **up**, and the matrix flips it.

## Furniture for children

- Anti-tip: every tall piece gets holes for a wall strap. Put it in the notes.
- Round over every edge (3–6 mm), sand to 180–240, and use a child-safe finish.
- **Finger slots or holes instead of handles**, placed at the child's height (about 50–65 cm for toddlers).
- Soft-close hinges, drawer stops, and no gaps that pinch fingers.
- Hanging rails at about 80–85 cm are reachable by 2–5 year olds.

## Without MCP (HTTP API)

Every tool has an HTTP equivalent on the editor's address:
- `GET /api/state`: the active document;
- `POST /api/ops {ops, label, tab?}`: the same ops as `apply_ops` (including `move`, `transform` and `arrange`);
- `GET /api/check?tab=`: `check_cnc`; `GET /api/assembly?tab=`: `describe_assembly`;
- `POST /api/file/new|open|save`;
- `GET /api/export/cnc|cnc-dxf|parts|project`.

Send `Content-Type: application/json` on POSTs. When the server has a token, add `Authorization: Bearer <token>` to every request.

For big or parametric designs, a script that computes the geometry and posts one ops batch is often easier than hundreds of calls: see Parametric scripts.

## Parametric scripts

For anything with more than a few parts, write a Python script: it computes the geometry, sends the whole project as one undo step, and can be re-run after every change. Get the helpers from the editor (standard library only; set `KERF_URL` and, if the server has one, `KERF_TOKEN`):

```bash
curl -s <editor>/api/script -o kerf_script.py      # add -H 'Authorization: Bearer <token>' if needed
```

```python
import kerf_script as k
T = 18
d = k.Drawing("Shelf", thickness=T)            # 2440 × 1220 sheets and a Ø6 tool unless you pass others

# Side panel in its own coordinates: x = depth from the front, y = height (y UP)
side = k.build(k.rect(0, 0, 300, 700), {2: ("fillet", 40), 3: ("fillet", 40)})
slot = k.build(k.rect(40, 300, 260, 300 + T + 0.4), {i: ("dog", 3.2) for i in range(4)})
strap = [((270, 650), 8)]                      # Ø8 hole for the anti-tip wall strap
d.part("Side L", side, holes=[slot], circles=strap, rotation=(0, 90, 0), position=(-209, 0, 150))
d.part("Side R", side, holes=[slot], circles=strap, rotation=(0, 90, 0), position=(191, 0, 150))
# Shelf: flat board, x = width, y = depth with the front at y = 0; runs through both slots
d.part("Shelf", k.build(k.rect(0, 0, 418, 220), {0: ("fillet", 3), 1: ("fillet", 3)}),
       rotation=(-90, 0, 0), position=(-209, 300.2, 110))

d.expect("Side L", (-209, 0, -150, -191, 700, 150))     # world boxes, checked before anything is sent
d.expect("Shelf", (-209, 300.2, -110, 209, 318.2, 110))
d.arrange(notes=["SHELF — 18 mm birch plywood",
                 "Cut order: holes and slots, then outlines (tabs). Slide the shelf through the slots; strap to the wall."])
tab = d.run()      # python3 shelf.py [tab] [--dry] [--save shelf/shelf]
```

- **`Drawing`** collects the ops: `layer(...)` (safe to re-run), `part(...)` (outline, `holes`, `pockets={layer: [...]}`, `circles=[((x, y), Ø[, layer])]`, a name label, `qty`, and the 3D placement from `rotation` / `position`, plus `thickness`, `color`, `move`), `op({...})` for anything else, `arrange(notes, sheet=(w, h))`.
- **`run()`** is the command line: no argument = a new tab (the user's active tab stays active); a tab id (`t3`) = rebuild that tab in place, as one undo step; `--dry` = local checks only; `--save file` = save the .kerf. It prints the sheets and `check_cnc`.
- **Keep every change in the script** (holes, engravings, tweaks). An edit made only in the editor is lost the next time the script runs. Cache the output of optional tools (e.g. fontTools glyph outlines for engraved text) next to the script, so it still runs without them.
- **Draw parts in their own coordinates, y up**, the way the 3D recipe expects (side panel = depth × height, flat board = width × depth with the front at y = 0). Their spot on the drawing doesn't matter: `arrange()` packs them and the 3D placement follows. `at=(X, Y), turn=90` places a part by hand instead.
- **Outlines:** `build(vertices, corners)`: `("fillet", r)` rounds a corner, `("dog", r)` adds a dog-bone, `auto_dog=r` dog-bones every concave corner (tenon shoulders), and an `("arc", centre, via)` item between two vertices makes that edge an arc. `circle(cx, cy, r)` is a round outline, `slot(x1, y1, x2, y2, width)` a round-ended slot, `rounded_rect(x0, y0, x1, y1, r)` a rectangle with round corners. Arc flags are computed for you; never write them by hand. Corner indices count vertices only, not arc items.
- **Check before you look:** `k.bounds(outline)` must match the size you meant (an off-by-one corner index or a wrong arc shows up here). `d.expect(name, box)` / `d.world_box(name)` confirm each part's world X/Y/Z range before anything is sent. Then `check_cnc`, `describe_assembly` and screenshots.
- Lower level, for special cases: `place(box, X, Y, turn)` → (drawing mapping, matrix), `to_path(outline, f)`, `part(name, pieces, qty, assembly)` → ops, `post(ops, label, tab)`, `new_tab()`, `check(tab)`, `save(file, tab)`, `world_box(assembly, points)`.
