# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Kerf** is a browser-based CAD-style editor for **CNC-ready cut drawings**, plus an MCP server so Claude can draw, edit and preview the same documents live with the user. 1 unit = 1 mm everywhere.

Projects are saved as **`.kerf`** (JSON: layers, elements, entities, 3D placements, parameters, material, reference image). **SVG, DXF, per-part files, PNG, GLB and STL are exports.** SVG and DXF files can also be opened or imported.

It is being used to design a plywood sit/stand desk. That project lives in `data/desk/`: `generate.py` (the parametric source, it also writes `desk.kerf`), `DESIGN.md` (the spec) and reference photos. `For CNC.dxf` there is **only for a final comparison, never a design source**.

## Running & testing

```bash
docker compose up -d --build        # editor at http://localhost:8765, MCP (SSE) on :8766
docker compose run --rm --no-deps -T --entrypoint python kerf -m pytest -q tests   # server + MCP tool tests
python3 data/desk/generate.py --push   # regenerate the desk and (re)open it in the editor
```

- `web/` and `data/` are bind-mounted: edit the UI and reload the page. Python changes need `--build`.
- Rebuilding restarts the server. Claude Code's MCP connection must then be reconnected (`/mcp`). Open tabs and unsaved work survive in `data/.session.json`.
- No build tools or JS dependencies. The UI is plain ES modules. The 3D preview loads three.js from cdn.jsdelivr.net.

## Architecture

**The server is the single source of truth.** The browser sends operations and renders the state the server returns, kept live by long-polling. It never pushes whole documents, because that caused reloads to overwrite work in the past.

```
mcp-server/
  document.py  Document model: Layer (colour, line style, lock, export, description, depth),
               Element (id, tag, layer, attrs, text, group), Group ("entity": name, parent, qty,
               assembly), params, material. SVG read/write ("file" / "cnc"), .kerf (to/from_native).
  store.py     Store: open documents as Tabs (file, dirty fingerprint, undo/redo, selection),
               apply(ops) = one atomic undo step, files in data/, session autosave, screenshots.
  layout.py    parts on the drawing: reposition() (move/transform keeping assembly matrices in sync),
               default_matrix, pieces(), arrange() (MaxRects onto SHEETS), layout_issues (overlap, too
               close, off sheet), assembly_report (world boxes, clashes by sampling part solids).
  shapes.py    exact shape geometry (lines + arcs) for the shape ops: slot, rounded rect, outline with a
               radius per corner, fillet / dog-bone of an existing shape (keeps its other arcs); uses
               kerf_script.build()/to_path().
  export.py    SVG geometry → DXF (ezdxf; LWPOLYLINE with arc bulges, CIRCLE), DXF → SVG import,
               per-entity part files + zip (nesting software), bounding boxes.
  server.py    MCP tools + HTTP API (aiohttp) — thin wrappers over Store.
  kerf_script.py  stdlib-only helpers for parametric generator scripts: Drawing (whole project as one
               batch: parts, 3D placement, expect() world-box checks, arrange, run() CLI), HTTP calls,
               outlines with fillets/dog-bones/arcs, place() → drawing mapping + matrix, world_box;
               served at GET /api/script so remote Claude sessions can use it. Local generators import it.
  guide.md     the design guide (get_guide, /api/guide); its Parametric scripts example is run by tests.
  tests/       pytest: test_store.py (model/store/exports), test_tools.py (MCP tools),
               test_script.py (kerf_script + the guide example), test_layout.py (moves keep 3D,
               named refs, arrange, layout checks, clashes)
web/js/
  state.js     client state, event bus, entity helpers (itemAt, descendants, selectItems, context)
  api.js       HTTP client; mutations serialized; long-poll sync; background image cache
  geometry.js  layer styling, doc→SVG/PNG, moveAttrs, bboxes
  canvas.js    render, zoom/grid/rulers, tools: select (entities, drill-down, marquee), pan, draw
               (drag or click–click + typed dimensions; rect radius, slot), outline (click corners),
               fillet / dog-bone (click a corner, Shift = all), text, measure (snaps); selection dims.
               Shape tools send the server's shape ops; the browser only previews.
  panels.js    Layers (depth, export, …), Entities tree, Inspector (shape / entity + 3D placement /
               document + Material & stock)
  actions.js   file (tabs, Open/Save As browser, computer files), import/export, edit, entities
  menu.js      menus (File/Edit/View/Layer/Export), toolbar, tool palette, shortcuts
  tabs.js      document tabs + 3D preview tabs
  preview3d.js three.js assembly: extrude entities (CUT_OUTSIDE outline, CUT_INSIDE holes,
               pockets from layers with depth), place with assembly, sliders, GLB/STL export
  materials.js material presets
  textures.js  procedural canvas textures by material type (grain, plywood plies on cut edges, MDF,
               brushed metal, clear acrylic), mm UVs, Textures toggle in the 3D panel
  main.js      wiring: state → views, status bar, code panel, side panel, selection sync, screenshots
data/          projects (*.kerf), imports (.svg/.dxf), exports/, .session.json (gitignored)
```

### Model rules
- **Stroke colour and line style belong to the layer** (CNC colour convention). Element attrs never carry `stroke`, `stroke-dasharray`, `data-layer`, `data-group`, `style` or `id`. Attribute names are validated (no namespaces, no `on*`).
- A layer with a **`depth`** is a partial-depth cut from the top face (a pocket). Without one it's a through-cut. **Only `export` decides what goes into CNC exports** (NOTES and HARDWARE don't); visibility is just a view setting.
- **Everything loaded is validated** (`Document.sanitize`, used by `.kerf`, sessions and SVG import): layer names/colours/line styles/depths, element ids/tags/attributes, entity ids/parents/assemblies (`clean_assembly`), parameters (`clean_params`). Keep new fields going through it — file data reaches the UI.
- **Entities** (groups) may span layers, so a part is its outline plus its holes. They nest through `parent`; the UI enters them with double-click, and Esc goes up. `qty` is used for part exports.
- **`assembly`** (per entity) places the part in 3D:
  - `matrix [a,b,c,d,e,f]` maps doc 2D → part-local 2D (y up). Omitted in update_group: kept, or for a new
    placement the drawing's bottom-left corner (`"auto"` recomputes). The `move`/`transform`/`arrange` ops
    compose it with the inverse move, so moving a part on the sheet never moves it in 3D. The browser's
    drag and nudge use the `move` op for that reason; don't move parts with raw update_element.
  - `thickness` is the extrusion along local +Z; the top face at z = thickness is the router face, where pockets are cut.
  - `rotation` is in degrees (Euler XYZ); `position` is in world mm (X width, Y up, Z toward the viewer).
  - optional `color`, and `move: {param, axis}` tied to a doc `params` slider.
  - Opposite-hand parts with pockets must be drawn mirrored (see the desk's lower frame B).
- Older `.svgcnc` files (the format's first name) still open; saving writes `.kerf`.
- `material` holds name, type, thickness, colour, sheet size, tool Ø and notes. It supplies the default thickness and colour in 3D.

### Store / sync
- All edits go through `Store.apply(ops)`: the browser always names its tab, and MCP tools use the active tab. Within a batch, `"$n"` in items/id/ids/group/parent refers to the result of op n, and `"$name"` to the op with `"as": "name"`, so a whole part (shapes + group) is one undo step. Errors say which op failed. Ops:
  - elements: `add_element, update_element, remove_elements, reorder_element`;
  - shapes: `add_slot, add_rounded_rect, add_outline` (new paths), `fillet, dogbone` (rebuild an element in place, same id);
  - layers: `add_layer, update_layer, set_layer_visibility, remove_layer, move_layer`;
  - document: `set_size, set_background(_opacity), clear, replace_svg, import_svg, set_material, set_params`;
  - entities: `group, ungroup, update_group, set_group` (move items into an entity or out of it);
  - layout: `move {items,dx,dy}`, `transform {items,transform}`, `arrange {sheet_width,sheet_height,margin,gap,rotate,notes}`;
  - `set_title` (the project name).
- Undo/redo and dirty tracking are per tab. Visibility is view state: not undoable, doesn't make the file dirty.
- `dirty` means the content fingerprint differs from the last save/open. Rapid single-field edits coalesce into one undo step.
- Each state response carries the active tab's doc. The reference image is only an id; the image itself comes from `GET /api/background`.
- `selection` per tab: the browser reports it (`POST /api/selection`). Claude sets it through MCP (`selection_seq`), and the browser then highlights and zooms to it.
- Files are resolved inside `data/` only.

### HTTP API (port 8765, this machine only)
The compose file publishes both ports on 127.0.0.1 only. The `local_only` middleware rejects other Host headers (DNS rebinding), foreign Origins and non-JSON POSTs (cross-site forms). The MCP SSE server has FastMCP DNS-rebinding protection turned on.

- **State:** `GET /api/state[?since=V&instance=I]` (long-poll).
- **Editing:** `POST /api/ops {ops,label}` · `POST /api/undo|redo`.
- **Files and tabs:** `POST /api/file/new|open|close|activate|revert|save|saved-local|mkdir|delete|import` (import takes `svg | dxf (base64) | project`) · `GET /api/files` · `GET /api/browse?folder=`.
- **Exports:** `GET /api/export/{cnc|cnc-dxf|parts|file|project}`.
- **Scripts:** `GET /api/script` (kerf_script.py) · `GET /api/check?tab=` (check_cnc for any tab) · `GET /api/assembly?tab=` (describe_assembly). `add_layer` takes `exist_ok` (update instead of failing) so generators can re-run.
- **Other:** `POST /api/selection` · `POST /api/screenshot` · `GET /api/background` · `GET /api/guide`.

## MCP tools (server `kerf`, SSE on :8766)

The server also sends workflow instructions to the client (`INSTRUCTIONS` in server.py).

- **Projects/tabs:** `get_document_info, list_documents, list_files, list_tabs, switch_tab, new_document, open_document, save_document, close_document, revert_document, set_project_name, set_canvas_size, set_material, undo, redo`
- **Guide:** `get_guide(topic)`: workflow, layers, 3D placement recipes, CNC rules (also `GET /api/guide`, Help → Kerf guide). Keep `mcp-server/guide.md` up to date when conventions change.
- **Shapes:** `add_slot, add_rounded_rect, add_outline, fillet_corners, add_dogbones` (exact arcs; corners by index or clicked [x, y])
- **Elements:** `list_elements, add_element, add_svg` (many shapes at once, one undo step), `update_element, remove_element, set_element_layer, move_elements, transform_elements, duplicate, reorder, clear_document, get_svg`
- **Entities/3D:** `list_groups, group_elements, ungroup, update_group` (name, qty, assembly), `move_to_entity`, `set_params`, `describe_assembly` (world boxes, clashes)
- **Sheets:** `arrange_parts` (pack pieces onto sheets, SHEETS layer, notes block; 3D unchanged)
- **Layers:** `list_layers, add_layer, update_layer, remove_layer, move_layer` (with `depth` for pockets)
- **Measure/selection:** `measure, add_dimension, get_selection, set_selection`
- **Import/export:** `import_dxf, export_cnc` (svg|dxf), `export_svg, export_parts`
- **Power tools:** `apply_ops` (any ops, one call, one undo step, `"as"`/`$name` references), `find_elements` (by layer/tag/entity/area), `describe_entity` (bounds, hole sizes, layers, world box), `check_cnc` (open contours, holes smaller than the tool, duplicates, text on cut layers, parts bigger than the sheet, overlapping/too close/off-sheet parts, warnings for parts not in 3D, …)
- Tool arguments take real JSON (objects, id lists); JSON strings and comma-separated ids still work.
- **Preview:** `take_screenshot(view="2d"|"3d"|"3d-exploded")` (async; needs the editor open in a browser), `set_background_image, remove_background_image`
- **Prompts:** `design_part(description)`, `prepare_for_cutting`

### Working with MCP
1. `get_document_info` / `list_tabs`. Never discard the user's unsaved work or close their tabs without asking.
2. Use layers, not colours: outlines → CUT_OUTSIDE, holes/slots → CUT_INSIDE, pockets → a layer with `depth`, labels/dimensions → NOTES, bought parts → a non-export layer.
3. Build each part with one `apply_ops` batch (shapes + `group` via `"as"`/`$name`, `fill="none"`, then `update_group` with `qty` and `assembly {rotation, position}`), so part exports and the 3D preview work. Big or parametric designs: a kerf_script `Drawing` script.
4. `arrange_parts` onto the sheets.
5. `check_cnc` and `describe_assembly`, then `take_screenshot` (2d and 3d). `save_document` writes the .kerf. Use `export_cnc(format="dxf")` / `export_parts` for the shop.

## SVG/DXF for CNC guidelines
- 1 unit = 1 mm; exports carry mm units. Don't scale in CAM.
- Draw nominal geometry; kerf and tool offsets are CAM's job (CUT_OUTSIDE = outside offset, CUT_INSIDE = inside offset, pockets = pocket operation at the layer depth).
- Inside corners get the tool radius; add dog-bones where a square part must fit.
- Closed shapes with no gaps, no duplicate overlapping lines, text converted to paths before engraving, no gradients/clips/effects.
