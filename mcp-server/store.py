"""The single source of truth: open documents (tabs), their files, undo history, persistence.

Both the MCP tools and the browser (HTTP) go through `Store.apply()` / file methods, so
every change is validated once, versioned, undoable and autosaved. The browser never
pushes whole documents; it sends operations and renders what the store returns.

Several documents can be open at once (tabs). Operations target the *active* tab unless
a tab id is given; the browser and Claude share the same active tab.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from pathlib import Path

from document import Document, DocError, to_native, from_native, clean_material, clean_title
import layout
import shapes

NATIVE_EXT = ".kerf"
LEGACY_EXT = ".svgcnc"      # early name of the project format; still opens

HISTORY_LIMIT = 200
COALESCE_SECONDS = 1.0


class Tab:
    """One open document: content, file, undo history, unsaved-change tracking."""

    def __init__(self, tab_id: str, doc: Document, file: str | None = None, dirty: bool = False):
        self.id = tab_id
        self.doc = doc
        self.file = file                      # path relative to data_dir, e.g. "desk/desk.svg"
        self.dirty = dirty
        self.saved_fingerprint = None if dirty else fingerprint(doc)
        self.undo_stack: list[tuple[Document, str]] = []
        self.redo_stack: list[tuple[Document, str]] = []
        self.last_coalesce: tuple[str, float] | None = None
        self.local_name: str | None = None    # saved to the user's computer (not the data folder)
        self.selection: list[str] = []         # what the user has selected in the editor
        self.selection_seq = 0                 # bumped when Claude sets the selection
        self.suggested_name: str | None = None

    @property
    def name(self) -> str:
        if self.doc.title:
            return self.doc.title
        if self.file:
            return Path(self.file).stem
        return Path(self.local_name or self.suggested_name or "Untitled").stem

    def refresh_dirty(self):
        self.dirty = fingerprint(self.doc) != self.saved_fingerprint

    def pristine(self) -> bool:
        """An untouched empty Untitled tab: opening a file may reuse it."""
        return not self.file and not self.dirty and not self.doc.elements and not self.undo_stack

    def summary(self) -> dict:
        return {"id": self.id, "name": self.name, "title": self.doc.title, "file": self.file, "dirty": self.dirty,
                "local_name": self.local_name}

    def to_session(self) -> dict:
        return {"id": self.id, "file": self.file, "dirty": self.dirty, "local_name": self.local_name,
                "suggested_name": self.suggested_name,
                "saved_fingerprint": self.saved_fingerprint, "doc": self.doc.to_json()}

    @classmethod
    def from_session(cls, d: dict) -> "Tab":
        t = cls(d["id"], Document.from_json(d["doc"]), d.get("file"), bool(d.get("dirty")))
        t.saved_fingerprint = d.get("saved_fingerprint")
        t.local_name, t.suggested_name = d.get("local_name"), d.get("suggested_name")
        return t


class Store:
    def __init__(self, data_dir: str | Path):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.session_file = self.data_dir / ".session.json"
        self.lock = threading.RLock()
        self.changed = threading.Condition(self.lock)
        self.tabs: dict[str, Tab] = {}
        self.active_id: str | None = None
        self._next_tab = 1
        self.version = 0
        self._session_timer: threading.Timer | None = None
        # Screenshot handshake with the browser
        self.screenshot_requested = False
        self.screenshot_view = "2d"
        self.screenshot_png: bytes | None = None
        self._restore_session()
        if not self.tabs:
            self._add_tab(Document())

    # ── tabs ───────────────────────────────────────────────
    @property
    def tab(self) -> Tab:
        return self.tabs[self.active_id]

    @property
    def doc(self) -> Document:
        return self.tab.doc

    @property
    def file(self) -> str | None:
        return self.tab.file

    @property
    def dirty(self) -> bool:
        return self.tab.dirty

    def get_tab(self, tab_id: str | None) -> Tab:
        if tab_id is None:
            return self.tab
        if tab_id not in self.tabs:
            raise DocError(f"Tab '{tab_id}' is not open")
        return self.tabs[tab_id]

    def _add_tab(self, doc: Document, file: str | None = None, dirty: bool = False) -> Tab:
        # Reuse an untouched empty tab instead of piling up "Untitled" tabs
        if self.active_id and self.tab.pristine():
            del self.tabs[self.active_id]
        tab = Tab(f"t{self._next_tab}", doc, file, dirty)
        self._next_tab += 1
        self.tabs[tab.id] = tab
        self.active_id = tab.id
        return tab

    def activate(self, tab_id: str):
        with self.lock:
            self.get_tab(tab_id)
            self.active_id = tab_id
            self._bump()

    def close(self, tab_id: str | None = None, discard: bool = False) -> str:
        with self.lock:
            tab = self.get_tab(tab_id)
            if tab.dirty and not discard:
                raise DocError(f"'{tab.name}' has unsaved changes. Save it first, or pass "
                               f"discard_changes=true to drop them.")
            order = list(self.tabs)
            idx = order.index(tab.id)
            del self.tabs[tab.id]
            if not self.tabs:
                self.active_id = None          # nothing left to reuse: start a fresh tab
                self._add_tab(Document())
            elif self.active_id == tab.id:
                rest = list(self.tabs)
                self.active_id = rest[min(idx, len(rest) - 1)]
            self._bump()
            return tab.id

    def report_selection(self, ids: list[str], tab_id: str | None = None):
        """The browser tells us what the user selected (view state: no version bump)."""
        with self.lock:
            t = self.get_tab(tab_id)
            t.selection = [i for i in ids if isinstance(i, str)][:5000]

    def set_selection(self, ids: list[str], tab_id: str | None = None):
        """Claude selects/highlights elements for the user."""
        with self.lock:
            t = self.get_tab(tab_id)
            known = {e.id for e in t.doc.elements}
            expanded = []
            for i in ids:
                if i.startswith("g-"):
                    expanded += t.doc.descendants(i)
                elif i in known:
                    expanded.append(i)
                else:
                    raise DocError(f"Element '{i}' not found")
            t.selection = list(dict.fromkeys(expanded))
            t.selection_seq += 1
            self._bump(persist=False)
            return t.selection

    def list_tabs(self) -> list[dict]:
        return [{**t.summary(), "active": t.id == self.active_id} for t in self.tabs.values()]

    # ── state for clients ──────────────────────────────────
    def state(self, include_doc: bool = True, consume_screenshot: bool = False) -> dict:
        """Client state for the active tab (+ the list of tabs). The reference image is sent
        separately (GET /api/background) and only identified here by a hash.
        consume_screenshot: this response delivers a pending screenshot request to a browser."""
        with self.lock:
            t = self.tab
            s = {
                "version": self.version,
                "tabs": [t2.summary() for t2 in self.tabs.values()],
                "active": t.id,
                "file": t.file,
                "name": t.name,
                "dirty": t.dirty,
                "can_undo": bool(t.undo_stack),
                "can_redo": bool(t.redo_stack),
                "undo_label": t.undo_stack[-1][1] if t.undo_stack else None,
                "redo_label": t.redo_stack[-1][1] if t.redo_stack else None,
                "screenshot_requested": self.screenshot_requested,
                "screenshot_view": self.screenshot_view,
                "selection": t.selection,
                "selection_seq": t.selection_seq,
            }
            if consume_screenshot:
                self.screenshot_requested = False
            if include_doc:
                doc = t.doc.to_json()
                if doc["background"]:
                    bg = doc["background"]
                    doc["background"] = {"opacity": bg.get("opacity", 0.3),
                                         "id": hashlib.sha1(bg["href"].encode()).hexdigest()[:16]}
                s["doc"] = doc
            return s

    def display_name(self) -> str:
        return self.tab.name

    def wait_for_change(self, since: int, timeout: float) -> bool:
        """Block until version != since or a screenshot is requested. Returns True on change."""
        deadline = time.time() + timeout
        with self.changed:
            while self.version == since and not self.screenshot_requested:
                remaining = deadline - time.time()
                if remaining <= 0:
                    return False
                self.changed.wait(remaining)
            return True

    def _bump(self, persist: bool = True):
        self.version += 1
        self.changed.notify_all()
        if persist:
            self._schedule_session_save()

    def _schedule_session_save(self, delay: float = 0.5):
        """Autosave at most every `delay` seconds (typing/nudging produce many ops)."""
        if self._session_timer is None:
            self._session_timer = threading.Timer(delay, self.flush_session)
            self._session_timer.daemon = True
            self._session_timer.start()

    def flush_session(self):
        with self.lock:
            self._session_timer = None
            self._save_session()

    # ── mutations ──────────────────────────────────────────
    def apply(self, ops: list[dict], label: str | None = None, tab_id: str | None = None) -> list:
        """Apply a batch of operations atomically, as one undo step. Returns per-op results."""
        if not isinstance(ops, list) or not ops or not all(isinstance(op, dict) for op in ops):
            raise DocError("ops must be a non-empty list of objects")
        with self.lock:
            t = self.get_tab(tab_id)
            before = t.doc                  # never mutated: every change happens on a copy
            work = t.doc.clone()
            results, names = [], {}
            for n, op in enumerate(ops):    # "$n" = result of op n of this batch; "$name" = of the op with "as": "name"
                try:
                    results.append(apply_op(work, resolve_refs(op, results, names)))
                except DocError as e:
                    raise DocError(f"op {n} ({op.get('op')}): {e}" if len(ops) > 1 else str(e)) from None
                if op.get("as") is not None:
                    names[str(op["as"])] = results[-1]
            if any(op.get("op") not in NO_HISTORY_OPS for op in ops):
                label = label or describe(ops)
                key = coalesce_key(ops)
                now = time.time()
                if key and t.last_coalesce and t.last_coalesce[0] == key \
                        and now - t.last_coalesce[1] < COALESCE_SECONDS and t.undo_stack:
                    pass  # merge into the previous undo step (e.g. typing in a property field)
                else:
                    t.undo_stack.append((before, label))
                    del t.undo_stack[:-HISTORY_LIMIT]
                t.last_coalesce = (key, now) if key else None
                t.redo_stack.clear()
            t.doc = work
            t.refresh_dirty()
            self._bump()
            return results

    def undo(self, tab_id: str | None = None) -> str:
        with self.lock:
            t = self.get_tab(tab_id)
            if not t.undo_stack:
                raise DocError("Nothing to undo")
            doc, label = t.undo_stack.pop()
            t.redo_stack.append((t.doc, label))
            t.doc = keep_view_state(doc, t.doc)
            t.refresh_dirty()
            t.last_coalesce = None
            self._bump()
            return label

    def redo(self, tab_id: str | None = None) -> str:
        with self.lock:
            t = self.get_tab(tab_id)
            if not t.redo_stack:
                raise DocError("Nothing to redo")
            doc, label = t.redo_stack.pop()
            t.undo_stack.append((t.doc, label))
            t.doc = keep_view_state(doc, t.doc)
            t.refresh_dirty()
            t.last_coalesce = None
            self._bump()
            return label

    # ── files ──────────────────────────────────────────────
    def resolve(self, name: str, ext: str = ".svg") -> Path:
        """Map a user-supplied name to a path inside data_dir (subfolders allowed)."""
        name = (name or "").strip().replace("\\", "/")
        if not name:
            raise DocError("File name is empty")
        if name.startswith("/"):
            raise DocError("Use a path relative to the data folder, e.g. 'desk/v2'")
        if ext and not name.lower().endswith(ext):
            name += ext
        parts = name.split("/")
        if any(p in ("", ".", "..") or p.startswith(".") or not re.fullmatch(r"[\w \-.,()]+", p) for p in parts):
            raise DocError(f"Invalid file name '{name}': use letters, digits, spaces and - _ . , ( )")
        path = (self.data_dir / name).resolve()
        if self.data_dir.resolve() not in path.parents:
            raise DocError(f"Invalid file name '{name}'")
        return path

    def rel(self, path: Path) -> str:
        return path.resolve().relative_to(self.data_dir.resolve()).as_posix()

    OPENABLE = (NATIVE_EXT, LEGACY_EXT, ".svg", ".dxf")

    def list_files(self) -> list[dict]:
        """Projects (.kerf) and importable drawings (.svg, .dxf) in the data folder."""
        out = []
        for p in sorted(self.data_dir.rglob("*")):
            rel = p.relative_to(self.data_dir)
            if not p.is_file() or p.suffix.lower() not in self.OPENABLE or any(x.startswith(".") for x in rel.parts):
                continue
            if rel.parts[0] == "exports":
                continue
            st = p.stat()
            out.append({"file": self.rel(p), "kind": p.suffix.lower()[1:], "size": st.st_size, "modified": st.st_mtime})
        return out

    def browse(self, folder: str = "") -> dict:
        """Folders and .svg files directly inside `folder` (relative to data_dir)."""
        base = self.data_dir if not folder else self.resolve(folder, ext="")
        if not base.is_dir():
            raise DocError(f"Folder '{folder}' not found")
        dirs, files = [], []
        for p in sorted(base.iterdir(), key=lambda p: p.name.lower()):
            if p.name.startswith("."):
                continue
            if p.is_dir():
                dirs.append({"name": p.name, "path": self.rel(p)})
            elif p.suffix.lower() in self.OPENABLE:
                st = p.stat()
                files.append({"name": p.name, "file": self.rel(p), "kind": p.suffix.lower()[1:],
                              "size": st.st_size, "modified": st.st_mtime})
        return {"folder": "" if base == self.data_dir else self.rel(base), "dirs": dirs, "files": files}

    def make_folder(self, folder: str) -> str:
        path = self.resolve(folder, ext="")
        path.mkdir(parents=True, exist_ok=True)
        return self.rel(path)

    def new(self, width: float = 800, height: float = 600) -> str:
        """Open a new, empty document in a new tab."""
        with self.lock:
            doc = Document()
            doc.set_size(width, height)
            tab = self._add_tab(doc)
            self._bump()
            return tab.id

    def find(self, name: str) -> Path:
        """A project by name: 'desk/desk' → desk/desk.kerf (or the exact file if given)."""
        low = (name or "").lower()
        if low.endswith(self.OPENABLE):
            return self.resolve(name, ext="")
        native = self.resolve(name, ext=NATIVE_EXT)
        if native.exists():
            return native
        legacy = self.resolve(name, ext=LEGACY_EXT)
        if legacy.exists():
            return legacy
        svg = self.resolve(name, ext=".svg")
        return svg if svg.exists() else native

    def open(self, name: str) -> str:
        """Open a project (.kerf) in a new tab, or switch to its tab if it's already open.
        .svg and .dxf files are imported into a new, unsaved tab (Save makes a .kerf)."""
        with self.lock:
            path = self.find(name)
            if not path.exists():
                raise DocError(f"File '{self.rel(path)}' not found")
            rel = self.rel(path)
            for t in self.tabs.values():
                if t.file == rel:
                    self.active_id = t.id
                    self._bump()
                    return t.id
            ext = path.suffix.lower()
            if ext in (NATIVE_EXT, LEGACY_EXT):
                tab = self._add_tab(from_native(path.read_text(encoding="utf-8")), rel)
            else:
                if ext == ".dxf":
                    from export import dxf_to_svg
                    doc = Document.from_svg(dxf_to_svg(path.read_bytes()))
                else:
                    doc = Document.from_svg(path.read_text(encoding="utf-8"))
                tab = self._add_tab(doc)
                tab.suggested_name = self.rel(path)[: -len(ext)]
                tab.saved_fingerprint = fingerprint(doc)   # nothing to save yet unless edited
                tab.refresh_dirty()
            self._bump()
            return tab.id

    def revert(self, tab_id: str | None = None):
        """Reload the tab's file from disk, dropping unsaved changes."""
        with self.lock:
            t = self.get_tab(tab_id)
            if not t.file:
                raise DocError("This document has never been saved")
            before = t.doc.clone()
            t.doc = from_native(self.resolve(t.file, ext="").read_text(encoding="utf-8"))
            t.undo_stack.append((before, "Revert"))
            t.redo_stack.clear()
            t.last_coalesce = None
            t.saved_fingerprint = fingerprint(t.doc)
            t.refresh_dirty()
            self._bump()

    def save(self, name: str | None = None, tab_id: str | None = None) -> str:
        with self.lock:
            t = self.get_tab(tab_id)
            target = name or t.file
            if not target:
                raise DocError("Document has no file name yet: pass a name (Save As)")
            target = re.sub(r"\.(kerf|svgcnc|svg|dxf)$", "", target, flags=re.I)   # projects are .kerf
            path = self.resolve(target, ext=NATIVE_EXT)
            rel = self.rel(path)
            if any(o.file == rel and o is not t for o in self.tabs.values()):
                raise DocError(f"'{rel}' is open in another tab")
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(path.name + ".tmp")
            tmp.write_text(to_native(t.doc), encoding="utf-8")
            os.replace(tmp, path)
            t.file, t.dirty, t.local_name = rel, False, None
            t.saved_fingerprint = fingerprint(t.doc)
            self._bump()
            return t.file

    def mark_saved_elsewhere(self, name: str, tab_id: str | None = None):
        """The browser saved the tab to a file on the user's computer: clean, named, no data-folder file."""
        with self.lock:
            t = self.get_tab(tab_id)
            t.file = None
            t.saved_fingerprint = fingerprint(t.doc)
            t.refresh_dirty()
            t.local_name = name
            self._bump()

    def delete_file(self, name: str):
        with self.lock:
            path = self.find(name)
            if not path.exists():
                raise DocError(f"File '{self.rel(path)}' not found")
            if any(t.file == self.rel(path) for t in self.tabs.values()):
                raise DocError("Close the file's tab before deleting it")
            path.unlink()

    def import_svg(self, markup: str, layer: str | None = None, new_tab: bool = False,
                   name: str | None = None) -> int:
        """Add elements from SVG markup to the active document (one undo step), or open the
        markup as a new unsaved document in its own tab."""
        with self.lock:
            if new_tab:
                doc = Document.from_svg(markup)
                tab = self._add_tab(doc, None, True)
                tab.suggested_name = name
                self._bump()
                return len(doc.elements)
            before = len(self.doc.elements)
            self.apply([{"op": "import_svg", "svg": markup, "layer": layer}], label="Import SVG")
            return len(self.doc.elements) - before

    def export_svg(self, name: str | None = None) -> str:
        """Full SVG (all layers, entities as metadata) into data/exports/."""
        with self.lock:
            from export import safe_name
            path = self.resolve(f"exports/{name or safe_name(self.display_name())}", ext=".svg")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(self.doc.to_svg("file"), encoding="utf-8")
            return self.rel(path)

    def export_cnc(self, name: str | None = None, fmt: str = "svg") -> str:
        from export import cnc_dxf
        with self.lock:
            from export import safe_name
            stem = name or f"{safe_name(self.display_name())}-cnc"
            path = self.resolve(f"exports/{stem}", ext=f".{fmt}")
            path.parent.mkdir(parents=True, exist_ok=True)
            if fmt == "dxf":
                path.write_bytes(cnc_dxf(self.doc))
            else:
                path.write_text(self.doc.to_svg("cnc"), encoding="utf-8")
            return self.rel(path)

    # ── session persistence (survives server restarts) ─────
    def _save_session(self):
        data = {"version": 2, "active": self.active_id, "next_tab": self._next_tab,
                "tabs": [t.to_session() for t in self.tabs.values()]}
        tmp = self.session_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(data), encoding="utf-8")
        os.replace(tmp, self.session_file)

    def _restore_session(self):
        try:
            data = json.loads(self.session_file.read_text(encoding="utf-8"))
            if "tabs" in data:
                for d in data["tabs"]:
                    t = Tab.from_session(d)
                    self.tabs[t.id] = t
                self._next_tab = data.get("next_tab", len(self.tabs) + 1)
                self.active_id = data.get("active") if data.get("active") in self.tabs else next(iter(self.tabs), None)
            else:  # v1 session: a single document
                t = Tab("t1", Document.from_json(data["doc"]), data.get("file"), bool(data.get("dirty")))
                t.saved_fingerprint = data.get("saved_fingerprint")
                self.tabs, self.active_id, self._next_tab = {"t1": t}, "t1", 2
        except FileNotFoundError:
            pass
        except Exception as e:  # corrupt session: start clean but keep the file for inspection
            os.replace(self.session_file, self.session_file.with_suffix(".corrupt"))
            print(f"session restore failed: {e}")


# ── operations ─────────────────────────────────────────────

# View-state changes: applied and synced, but not undo steps and don't mark the file dirty
NO_HISTORY_OPS = {"set_layer_visibility"}


def apply_op(doc: Document, op: dict):
    kind = op.get("op")
    if kind == "add_element":
        return doc.add_element(op["tag"], op.get("attrs") or {}, op.get("text", ""), op.get("layer"),
                               op.get("group"), op.get("name", "")).id
    if kind in ("add_slot", "add_rounded_rect", "add_outline"):
        d = (shapes.slot_d(op.get("x1"), op.get("y1"), op.get("x2"), op.get("y2"), op.get("width"))
             if kind == "add_slot" else
             shapes.rounded_rect_d(op.get("x"), op.get("y"), op.get("width"), op.get("height"), op.get("r", 0))
             if kind == "add_rounded_rect" else shapes.outline_d(op.get("points")))
        return doc.add_element("path", {"d": d, "fill": "none"}, "", op.get("layer"), op.get("group")).id
    if kind in ("fillet", "dogbone"):         # rebuilt in place: same id, becomes a path
        el = doc.element(op["id"])
        tol = shapes.num(op.get("tol", 5), "tol", True)
        if kind == "fillet":
            attrs = shapes.fillet_attrs(el, op.get("r"), op.get("corners"), tol)
        else:
            tool_d = op.get("tool_d") or (doc.material or {}).get("tool_diameter") or 6
            attrs = shapes.dogbone_attrs(el, tool_d, op.get("corners", "auto"), tol)
        el.tag, el.attrs = "path", attrs
        return el.id
    if kind == "update_element":
        return doc.update_element(op["id"], op.get("attrs"), op.get("text"), op.get("layer"), op.get("name")).id
    if kind == "remove_elements":
        return doc.remove_elements(op["ids"])
    if kind == "reorder_element":
        return doc.reorder_element(op["id"], op["where"])
    if kind == "add_layer":
        if op.get("exist_ok") and doc.has_layer(op["name"]):   # scripts re-run: update it instead
            return doc.update_layer(op["name"], None, op.get("color"), op.get("line_style"), None, None,
                                    op.get("export"), op.get("description"),
                                    op["depth"] if "depth" in op else ...).name
        return doc.add_layer(op["name"], op.get("color", "#000000"), op.get("line_style", "solid"),
                             op.get("export", True), op.get("visible", True), op.get("locked", False),
                             op.get("description", ""), op.get("depth")).name
    if kind == "update_layer":
        return doc.update_layer(op["name"], op.get("new_name"), op.get("color"), op.get("line_style"),
                                op.get("visible"), op.get("locked"), op.get("export"),
                                op.get("description"), op["depth"] if "depth" in op else ...).name
    if kind == "set_layer_visibility":
        return doc.update_layer(op["name"], visible=op["visible"]).name
    if kind == "remove_layer":
        return doc.remove_layer(op["name"], op.get("move_to"))
    if kind == "move_layer":
        return doc.move_layer(op["name"], int(op["index"]))
    if kind == "set_size":
        return doc.set_size(op["width"], op["height"])
    if kind == "set_background":
        href = op.get("href")
        doc.background = {"href": href, "opacity": float(op.get("opacity", 0.3))} if href else None
        return None
    if kind == "set_background_opacity":
        if doc.background:
            doc.background["opacity"] = max(0.0, min(1.0, float(op["opacity"])))
        return None
    if kind == "clear":
        n = len(doc.elements)
        doc.elements = []
        doc.groups = []
        return n
    if kind == "replace_svg":
        new = Document.from_svg(op["svg"])
        doc.width, doc.height, doc.layers, doc.elements = new.width, new.height, new.layers, new.elements
        doc.groups, doc.params, doc.material = new.groups, new.params, new.material
        doc.background = new.background
        doc.next_id = max(doc.next_id, new.next_id)
        return len(doc.elements)
    if kind == "import_svg":
        new = Document.from_svg(op["svg"], default_layer=op.get("layer"), base=doc)
        doc.layers, doc.elements, doc.groups, doc.next_id = new.layers, new.elements, new.groups, new.next_id
        return None
    # groups ("entities")
    if kind == "group":
        return doc.group(op["items"], op.get("name"), op.get("parent")).id
    if kind == "set_group":
        return doc.move_to_group(op["items"], op.get("group") or None)
    if kind == "ungroup":
        return doc.ungroup(op["id"])
    if kind == "update_group":
        asm = op.get("assembly", ...)
        if isinstance(asm, dict) and asm.get("matrix") in (None, "auto"):
            # No matrix: keep the part's current one, else its drawing's bottom-left corner, y up
            old = doc.group_by_id(op["id"]).assembly or {}
            keep = old.get("matrix") if asm.get("matrix") is None else None
            asm = {**asm, "matrix": keep or layout.default_matrix(doc, op["id"])}
        return doc.update_group(op["id"], op.get("name"), op.get("qty"), asm).id
    # moving parts on the drawing (their 3D placement follows)
    if kind == "move":
        return layout.reposition(doc, op["items"], op.get("dx", 0), op.get("dy", 0))
    if kind == "transform":
        return layout.reposition(doc, op["items"], transform=str(op["transform"]))
    if kind == "arrange":
        return layout.arrange(doc, op)
    if kind == "set_title":
        doc.title = clean_title(op.get("title"))
        return None
    if kind == "set_material":
        doc.material = clean_material(op.get("material"), doc.material)
        return None
    if kind == "set_params":
        from document import clean_params
        doc.params = clean_params(op["params"])
        if len(doc.params) != len(op["params"]):
            raise DocError("Invalid parameter: each needs a name (letters/digits/_), min < max, step > 0")
        return None
    raise DocError(f"Unknown op '{kind}'")


def resolve_refs(op: dict, results: list, names: dict | None = None):
    def res(v):
        if isinstance(v, str) and re.fullmatch(r"\$\d+", v):
            i = int(v[1:])
            if i >= len(results):
                raise DocError(f"{v} refers to an operation that hasn't run yet")
            return results[i]
        if isinstance(v, str) and len(v) > 1 and v[0] == "$":       # ids never start with "$"
            if v[1:] not in (names or {}):
                raise DocError(f'{v}: no earlier op in this batch has "as": "{v[1:]}"')
            return names[v[1:]]
        if isinstance(v, list):
            return [res(x) for x in v]
        return v
    return {k: res(v) if k in ("items", "id", "ids", "group", "parent") else v for k, v in op.items()}


def describe(ops: list[dict]) -> str:
    names = {"add_element": "Add", "add_slot": "Add slot", "add_rounded_rect": "Add rounded rectangle",
             "add_outline": "Add outline", "fillet": "Fillet", "dogbone": "Dog-bones", "update_element": "Edit", "remove_elements": "Delete",
             "reorder_element": "Reorder", "add_layer": "Add layer", "update_layer": "Edit layer",
             "remove_layer": "Delete layer", "move_layer": "Move layer", "set_size": "Resize document",
             "set_background": "Background", "set_background_opacity": "Background opacity",
             "clear": "Clear", "replace_svg": "Edit code", "import_svg": "Import SVG",
             "group": "Group", "ungroup": "Ungroup", "set_group": "Move to entity", "update_group": "Edit entity", "set_params": "Parameters",
             "set_material": "Material", "set_title": "Rename project", "move": "Move",
             "transform": "Transform", "arrange": "Arrange on sheets"}
    kinds = {op.get("op") for op in ops}
    if len(kinds) == 1:
        k = kinds.pop()
        if k == "update_element" and len(ops) > 1:
            return f"Move {len(ops)} elements"
        return names.get(k, k)
    return "Edit"


def coalesce_key(ops: list[dict]) -> str | None:
    """Rapid repeated edits of the same thing (typing in a field) merge into one undo step."""
    if len(ops) == 1 and ops[0].get("op") == "move" and ops[0].get("coalesce"):
        return f'move:{",".join(sorted(map(str, ops[0].get("items") or [])))}:{ops[0]["coalesce"]}'
    if len(ops) == 1 and ops[0].get("op") in ("update_element", "update_layer", "update_group",
                                             "set_background_opacity", "set_material"):
        op = ops[0]
        return f'{op["op"]}:{op.get("id") or op.get("name")}:{",".join(sorted((op.get("attrs") or {}).keys()))}' \
               f':{op.get("text") is not None}:{op["op"] == "update_element" and op.get("name") is not None}' \
               f':{op.get("coalesce", "")}'
    return None


def fingerprint(doc: Document) -> str:
    """Content hash for unsaved-change tracking; layer visibility is view state, not content."""
    d = doc.to_json()
    d.pop("next_id", None)
    for l in d["layers"]:
        l.pop("visible", None)
    return hashlib.sha1(json.dumps(d, sort_keys=True).encode()).hexdigest()


def keep_view_state(doc: Document, current: Document) -> Document:
    """Undo/redo restore content, not what the user is currently looking at (visibility)."""
    vis = {l.name: l.visible for l in current.layers}
    for l in doc.layers:
        if l.name in vis:
            l.visible = vis[l.name]
    return doc
