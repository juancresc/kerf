// Small UI helpers: icons, toasts, modal dialogs, HTML escaping.

const P = (d, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;

export const icons = {
  select: P('<path d="M5 3l14 8-6 1.5L10 19z"/>'),
  pan: P('<path d="M8 13V5.5a1.5 1.5 0 013 0V11m0-1.5V4.5a1.5 1.5 0 013 0V11m0-4.5a1.5 1.5 0 013 0V14a7 7 0 01-7 7h-.5a6 6 0 01-4.9-2.5L3.3 14.7a1.6 1.6 0 012.4-2.1L8 15"/>'),
  line: P('<path d="M5 19L19 5"/><circle cx="5" cy="19" r="1.5"/><circle cx="19" cy="5" r="1.5"/>'),
  rect: P('<rect x="4" y="6" width="16" height="12" rx="1"/>'),
  circle: P('<circle cx="12" cy="12" r="8"/>'),
  ellipse: P('<ellipse cx="12" cy="12" rx="9" ry="6"/>'),
  slot: P('<path d="M8 8h8a4 4 0 010 8H8a4 4 0 010-8z"/>'),
  outline: P('<path d="M4 20V9l6-5h6a4 4 0 014 4v12z"/><circle cx="4" cy="20" r="1.3"/><circle cx="10" cy="4" r="1.3"/>'),
  fillet: P('<path d="M4 20V12a8 8 0 018-8h8"/><path d="M4 4h4M4 4v4" opacity=".5"/>'),
  dogbone: P('<path d="M5 19V9a4 4 0 014-4h10"/><circle cx="7.5" cy="7.5" r="3.2"/>'),
  text: P('<path d="M5 6V4h14v2M12 4v16M9 20h6"/>'),
  new: P('<path d="M14 3H6a1 1 0 00-1 1v16a1 1 0 001 1h12a1 1 0 001-1V8z"/><path d="M14 3v5h5M12 11v6M9 14h6"/>'),
  open: P('<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>'),
  save: P('<path d="M5 3h11l3 3v13a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z"/><path d="M7 3v5h8V3M7 21v-7h10v7"/>'),
  undo: P('<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 010 10h-3"/>'),
  redo: P('<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 000 10h3"/>'),
  duplicate: P('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/>'),
  trash: P('<path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 002 2h8a2 2 0 002-2l1-12M9 7V4h6v3"/>'),
  zoomIn: P('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/>'),
  zoomOut: P('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/>'),
  fit: P('<path d="M4 9V5a1 1 0 011-1h4M15 4h4a1 1 0 011 1v4M20 15v4a1 1 0 01-1 1h-4M9 20H5a1 1 0 01-1-1v-4"/>'),
  grid: P('<path d="M3 9h18M3 15h18M9 3v18M15 3v18"/><rect x="3" y="3" width="18" height="18" rx="2"/>'),
  magnet: P('<path d="M6 3v8a6 6 0 0012 0V3M6 7h4M14 7h4M10 3v8a2 2 0 004 0V3"/>'),
  export: P('<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 15v4a2 2 0 002 2h10a2 2 0 002-2v-4"/>'),
  image: P('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>'),
  code: P('<path d="M9 8l-5 4 5 4M15 8l5 4-5 4"/>'),
  plus: P('<path d="M12 5v14M5 12h14"/>'),
  eye: P('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: P('<path d="M3 3l18 18M10.6 10.6a3 3 0 004.2 4.2M9.9 5.1A10.4 10.4 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3.2 4M6.6 6.6A17.4 17.4 0 002 12s3.5 7 10 7a9.7 9.7 0 005.4-1.6"/>'),
  lock: P('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>'),
  unlock: P('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 017.9-1"/>'),
  chevron: P('<path d="M9 6l6 6-6 6"/>'),
  chevronDown: P('<path d="M6 9l6 6 6-6"/>'),
  up: P('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  down: P('<path d="M12 5v14M6 13l6 6 6-6"/>'),
  front: P('<rect x="9" y="9" width="11" height="11" rx="1" fill="currentColor" fill-opacity=".25"/><path d="M15 9V5a1 1 0 00-1-1H5a1 1 0 00-1 1v9a1 1 0 001 1h4"/>'),
  back: P('<rect x="4" y="4" width="11" height="11" rx="1" fill="currentColor" fill-opacity=".25"/><path d="M9 15v4a1 1 0 001 1h9a1 1 0 001-1v-9a1 1 0 00-1-1h-4"/>'),
  group: P('<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/><path d="M2 2h20v20H2z" stroke-dasharray="2 2"/>'),
  ungroup: P('<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>'),
  dims: P('<path d="M3 7h18M3 4v6M21 4v6M7 21V11M4 11h6M4 21h6"/>'),
  cube: P('<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M12 12l9-5M12 12v10M12 12L3 7"/>'),
  side: P('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>'),
  measure: P('<path d="M3 17L17 3l4 4L7 21z"/><path d="M7 13l2 2M10 10l2 2M13 7l2 2"/>'),
};

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function toast(message, kind = '') {
  const box = document.getElementById('toasts');
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = message;
  box.appendChild(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 2800);
}

const dialog = document.getElementById('dialog');
const isPrimary = (b) => (b.kind || '').split(' ').includes('primary');

/**
 * Show a modal. `html` is the body; buttons: [{label, value, kind, left}].
 * `setup(root, close)` can bind extra behaviour. Resolves with the clicked value
 * (or null on Escape). Enter triggers the first 'primary' button.
 */
export function modal({ title, html = '', buttons = [{ label: 'OK', value: true, kind: 'primary' }], setup, onSubmit }) {
  return new Promise(resolve => {
    dialog.innerHTML = `<form class="dlg" method="dialog">
      <h2>${esc(title)}</h2>
      <div class="dlg-body">${html}</div>
      <div class="dlg-actions">${buttons.map((b, i) =>
        `<button class="btn ${b.kind || ''} ${b.left ? 'left' : ''}" data-i="${i}" type="${isPrimary(b) ? 'submit' : 'button'}">${esc(b.label)}</button>`).join('')}
      </div></form>`;
    const form = dialog.querySelector('form');
    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      dialog.close();
      resolve(value);
    };
    form.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-i]');
      if (!btn) return;
      e.preventDefault();
      const b = buttons[+btn.dataset.i];
      if (isPrimary(b) && onSubmit) {
        const ok = await onSubmit(form, b.value);
        if (ok === false) return;
      }
      close(b.value);
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const primary = buttons.find(isPrimary);
      if (!primary) return;
      if (onSubmit && (await onSubmit(form, primary.value)) === false) return;
      close(primary.value);
    });
    dialog.addEventListener('cancel', () => close(null), { once: true });
    setup?.(form, close);
    dialog.showModal();
    // Focus the first field, else the primary button — never a destructive one by accident
    const first = form.querySelector('input:not([type=hidden]), textarea, select');
    if (first) { first.focus(); first.select?.(); }
    else {
      const primary = form.querySelector('.dlg-actions .primary');
      // Destructive confirmations (Clear all, Delete layer) default to Cancel
      (primary?.classList.contains('danger-solid') ? form.querySelector('.dlg-actions button:not(.primary)') : primary)?.focus();
    }
  });
}

export function confirmDialog(title, message, okLabel = 'OK', danger = false) {
  return modal({
    title, html: `<p>${esc(message)}</p>`,
    buttons: [{ label: 'Cancel', value: false }, { label: okLabel, value: true, kind: danger ? 'primary danger-solid' : 'primary' }],
  }).then(v => v === true);
}

export function fmt(n, digits = 2) {
  if (n === undefined || n === null || n === '' || isNaN(n)) return '';
  return String(+(+n).toFixed(digits));
}

export function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function pickFile(accept) {
  const input = document.getElementById('file-input');
  input.accept = accept;
  input.value = '';
  return new Promise(resolve => {
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

/** Clipboard API, or the old select + execCommand way (works on plain http too). */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (_) { /* fall through */ }
  const ta = Object.assign(document.createElement('textarea'), { value: text });
  ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
  (document.querySelector('dialog[open]') || document.body).append(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  return ok;
}
