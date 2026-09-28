// "Connect Claude": copy-paste setups for Claude Code / Claude Desktop (MCP) or a plain curl
// prompt, built from the addresses the server reports (works locally and when deployed).

import { modal, toast, esc, copyText } from './ui.js';

const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;   // shell single-quote

// What to say to Claude once it's connected (the design request goes in the blanks)
const ASK = `I want to design: ___ (what it is, overall size, who uses it).
Material: 18 mm birch plywood. Lay it out on full 2440 × 1220 sheets (or my CNC / stock size: ___ — optional).`;
const MCP_PROMPT = (editor) => `You're connected to my Kerf CNC editor (MCP server "kerf"); I watch every change live at ${editor}
First call get_guide and follow it (workflow, layers, 3D placement recipes, CNC rules).
${ASK}
Ask me anything essential before drawing. Build one part per apply_ops batch (or a kerf_script script for
bigger designs), arrange_parts onto the sheets, check with check_cnc and describe_assembly, then take_screenshot
(2d, 3d, 3d-exploded), save_document and give me the link.`;

function snippets({ editor_url, api_url, mcp_url, token }) {
  const auth = token ? `Bearer ${token}` : null;
  const curlAuth = token ? ` -H ${q('Authorization: ' + auth)}` : '';
  const json = (o) => JSON.stringify(o, null, 2);
  const server = { type: 'sse', url: mcp_url, ...(auth ? { headers: { Authorization: auth } } : {}) };
  return [
    {
      id: 'code', label: 'Claude Code',
      intro: 'Run this in a terminal once. Then start <code>claude</code> and check the connection with <code>/mcp</code>.',
      text: `claude mcp add --transport sse kerf ${mcp_url}${auth ? ` --header ${q('Authorization: ' + auth)}` : ''}`,
      prompt: MCP_PROMPT(editor_url),
    },
    {
      id: 'project', label: '.mcp.json',
      intro: 'Or save this as <code>.mcp.json</code> in a project folder, so everyone who runs Claude Code there gets the editor.',
      text: json({ mcpServers: { kerf: server } }),
      prompt: MCP_PROMPT(editor_url),
    },
    {
      id: 'desktop', label: 'Claude Desktop',
      intro: 'Claude Desktop → Settings → Developer → Edit Config (<code>claude_desktop_config.json</code>). Add this and restart it. It needs Node.js: <code>mcp-remote</code> bridges the SSE server.',
      text: json({ mcpServers: { kerf: { command: 'npx', args: ['-y', 'mcp-remote', mcp_url, ...(auth ? ['--header', `Authorization: ${auth}`] : [])] } } }),
      prompt: MCP_PROMPT(editor_url),
    },
    {
      id: 'curl', label: 'Prompt (curl, no MCP)',
      intro: 'No MCP set up? Paste this into Claude (any version that can run shell commands). It explains the HTTP API.',
      text: `${ASK}

You can drive my Kerf CNC editor over HTTP with curl. I watch every change live at ${editor_url}
Units: 1 = 1 mm. Every POST needs -H 'Content-Type: application/json'${token ? `, and every request needs${curlAuth}` : ''}.
FIRST read the design guide (workflow, layers, 3D placement recipes, CNC rules):
  curl -s${curlAuth} ${api_url}/guide

Read the active document (tabs, layers, elements, entities, material):
  curl -s${curlAuth} ${api_url}/state
Edit — a batch of ops is one undo step; "$0" means the id created by op 0 of the same batch:
  curl -s${curlAuth} -H 'Content-Type: application/json' -X POST ${api_url}/ops -d '{"label":"Add plate","ops":[
    {"op":"add_element","tag":"rect","layer":"CUT_OUTSIDE","attrs":{"x":10,"y":10,"width":200,"height":100,"rx":5,"fill":"none"}},
    {"op":"add_element","tag":"circle","layer":"CUT_INSIDE","attrs":{"cx":30,"cy":30,"r":4,"fill":"none"}},
    {"op":"group","items":["$0","$1"],"name":"Plate"}]}'
Ops: add_element{tag,attrs,layer,text?,group?,name?} · update_element{id,attrs?,text?,layer?,name?} · remove_elements{ids}
  · group{items,name} · ungroup{id} · update_group{id,name?,qty?,assembly?} · add_layer{name,color,line_style?,export?,depth?}
  · update_layer{name,...} · set_size{width,height} · set_material{material} · set_title{title}
  · set_params{params} · import_svg{svg,layer?} · clear
  · move{items,dx,dy} · transform{items,transform} · arrange{sheet_width?,sheet_height?,margin?,gap?,notes?}
  Name an op with "as":"side" and use "$side" in later items/id/ids/group/parent. update_group's assembly
  needs only {rotation, position}: the matrix is set from the drawing and follows moves/arranges.
Checks:                 curl -s${curlAuth} ${api_url}/check  ·  ${api_url}/assembly   (3D world boxes, clashes)
Undo / redo:            curl -s${curlAuth} -H 'Content-Type: application/json' -X POST ${api_url}/undo -d '{}'   (or /redo)
New tab:                ... -X POST ${api_url}/file/new -d '{"width":800,"height":600}'
Open / save (data dir): ... -X POST ${api_url}/file/open -d '{"file":"desk/desk.kerf"}'  ·  ${api_url}/file/save -d '{"file":"my-part"}'
List files:             curl -s${curlAuth} ${api_url}/files
Exports:                curl -s${curlAuth} ${api_url}/export/cnc (SVG in mm) · /export/cnc-dxf · /export/parts (zip) · /export/project (.kerf)

Rules: part outlines on CUT_OUTSIDE, holes/slots on CUT_INSIDE, pockets on a layer with a depth, labels on NOTES.
Use fill="none"; never set stroke colours (the layer decides). Group each part's outline + holes into an entity.
Don't discard my unsaved work or close my tabs without asking.`,
    },
  ];
}

// Minimal Markdown → HTML for the guide: headings, (nested) lists, tables, code, bold
function md(text) {
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  const out = [];
  let list = null, table = null, para = [], blank = false;
  const renderList = (l) => `<${l.tag}>${l.items.map(it => `<li>${inline(it.text)}${it.subs ? renderList(it.subs) : ''}${
    it.tail ? `<p>${inline(it.tail)}</p>` : ''}</li>`).join('')}</${l.tag}>`;
  const flush = () => {
    if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
    if (list) { out.push(renderList(list)); list = null; }
    if (table) {
      const [head, , ...rows] = table;
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      out.push(`<table><tr>${cells(head).map(c => `<th>${inline(c)}</th>`).join('')}</tr>${rows.map(r =>
        `<tr>${cells(r).map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</table>`);
      table = null;
    }
  };
  for (const line of text.split('\n')) {
    let m;
    const last = list?.items[list.items.length - 1];
    if (!line.trim()) { if (para.length || table) flush(); blank = true; continue; }
    if ((m = line.match(/^(#{1,3}) (.*)/))) { flush(); out.push(`<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`); }
    else if (line.startsWith('|')) { if (!table) { flush(); table = []; } table.push(line); }
    else if ((m = line.match(/^(\s*)(-|\d+\.) (.*)/))) {
      const tag = m[2] === '-' ? 'ul' : 'ol';
      if (m[1].length && last) {                                   // a sub-item of the last item
        last.subs = last.subs || { tag, items: [] };
        last.subs.items.push({ text: m[3] });
      } else {
        if (list && list.tag !== tag) flush();
        if (!list) { flush(); list = { tag, items: [] }; }
        list.items.push({ text: m[3] });
      }
    } else if (/^\s+\S/.test(line) && last) {                     // indented text continues the last item
      if (blank) last.tail = (last.tail ? last.tail + ' ' : '') + line.trim();
      else if (last.subs) last.subs.items[last.subs.items.length - 1].text += ' ' + line.trim();
      else last.text += ' ' + line.trim();
    } else { if (list || table) flush(); para.push(line); }
    blank = false;
  }
  flush();
  return out.join('');
}

/** Connect Claude: setup snippets, starter prompts and the guide. `start` = a tab id ('guide', 'curl', …). */
export async function connectDialog(start = null) {
  let info;
  try {
    const r = await fetch('/api/connect');
    info = await r.json();
    if (!r.ok) throw new Error(info.error || r.statusText);
  } catch (e) {
    return toast(`Couldn't read the server addresses: ${e.message}`, 'error');
  }
  const items = snippets(info);
  const guide = await fetch('/api/guide').then(r => (r.ok ? r.text() : '')).catch(() => '');
  if (guide) {
    items.push({ id: 'guide', label: 'Guide', text: guide, html: md(guide),
                 intro: 'What Claude reads before designing (it calls <code>get_guide</code>, or <code>curl …/api/guide</code> without MCP). The prompts point to it, so you don\u2019t need to paste it — but you can copy it for a chat that can\u2019t fetch it.' });
  }
  const local = /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(info.editor_url);
  let current = Math.max(0, items.findIndex(it => it.id === (typeof start === 'string' ? start : null)));
  await modal({
    title: 'Connect Claude',
    html: `<div class="connect">
      <div class="seg connect-tabs">${items.map((it, i) => `<button type="button" class="btn ${i === 0 ? 'on' : ''}" data-snip="${i}">${esc(it.label)}</button>`).join('')}</div>
      <p class="hint connect-intro"></p>
      <div class="connect-code" data-block="text"><pre></pre><div class="guide" hidden></div><button type="button" class="btn primary" data-copy="text">Copy</button></div>
      <div class="connect-prompt">
        <p class="hint"><b>2. Then paste this into Claude</b> — fill in the blanks (___) first:</p>
        <div class="connect-code" data-block="prompt"><pre></pre><button type="button" class="btn primary" data-copy="prompt">Copy</button></div>
      </div>
      <p class="hint">Editor: <code>${esc(info.editor_url)}</code> · MCP (SSE): <code>${esc(info.mcp_url)}</code>
        ${info.token ? '<br><b>These snippets contain your access token.</b> Only share them with people who may edit your files.' : ''}
        ${local ? '<br>This editor only answers on this computer. To use it from elsewhere, deploy it with <code>KERF_PUBLIC_URL</code> and <code>KERF_TOKEN</code> (see the README).' : ''}</p>
    </div>`,
    buttons: [{ label: 'Close', value: true, kind: 'primary' }],
    setup: (form) => {
      const show = (i) => {
        current = i;
        form.querySelectorAll('.connect-tabs button').forEach((b, j) => b.classList.toggle('on', j === i));
        form.querySelector('.connect-intro').innerHTML = (items[i].prompt ? '<b>1. Set up</b> — ' : '') + items[i].intro;
        form.querySelector('[data-block="text"] pre').textContent = items[i].html ? '' : items[i].text;
        form.querySelector('[data-block="text"] pre').hidden = !!items[i].html;
        const g = form.querySelector('[data-block="text"] .guide');
        g.hidden = !items[i].html;
        g.innerHTML = items[i].html || '';
        form.querySelector('[data-copy="text"]').textContent = items[i].html ? 'Copy (Markdown)' : 'Copy';
        form.querySelector('.connect-prompt').hidden = !items[i].prompt;
        form.querySelector('[data-block="prompt"] pre').textContent = items[i].prompt || '';
      };
      form.querySelector('.connect-tabs').addEventListener('click', (e) => {
        const b = e.target.closest("[data-snip]");
        if (b) show(+b.dataset.snip);
      });
      form.querySelectorAll('[data-copy]').forEach(btn => btn.addEventListener('click', async () => {
        const which = btn.dataset.copy;
        if (await copyText(items[current][which])) return toast(which === 'prompt' ? 'Prompt copied — fill in the blanks in Claude' : 'Copied', 'ok');
        const range = document.createRange();       // no clipboard: select the text instead
        range.selectNodeContents(form.querySelector(which === 'text' && items[current].html ? '[data-block="text"] .guide' : `[data-block="${which}"] pre`));
        getSelection().removeAllRanges(); getSelection().addRange(range);
        toast('Press ⌘C / Ctrl+C to copy the selected text');
      }));
      show(current);
    },
  });
}
