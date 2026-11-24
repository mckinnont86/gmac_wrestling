#!/usr/bin/env node
// Film list helper for the "Add video" / "Add event" forms (GitHub Issues).
//
//   node scripts/film.mjs sync-forms          rebuild the forms' "where" dropdowns from FILM
//   node scripts/film.mjs apply <event.json>  apply a submitted form (GitHub issue event)
//   node scripts/film.mjs check               validate FILM (exit 1 on problems)
//
// No dependencies. Edits index.html as text, so comments and layout in the
// FILM list are kept; every edit is re-parsed and validated before saving.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = path.join(ROOT, 'index.html');
const FORMS = path.join(ROOT, '.github', 'ISSUE_TEMPLATE');
const SEP = ' › ';

// ── locate the FILM list inside index.html ──
function filmBounds(html) {
  const start = html.indexOf('const FILM = {');
  if (start < 0) throw new Error('const FILM not found in index.html');
  const objStart = html.indexOf('{', start);
  const end = html.indexOf('</script>', objStart);
  return { start, objStart, end };
}

// ── tiny parser for the FILM object literal, keeping source positions ──
function parse(src, pos) {
  let i = pos;
  const ws = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src.startsWith('//', i)) { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (src.startsWith('/*', i)) { const e = src.indexOf('*/', i + 2); if (e < 0) throw new Error('unclosed comment'); i = e + 2; continue; }
      return;
    }
  };
  const str = () => {
    const q = src[i]; const s = i++; let out = '';
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\n') throw new Error('line break inside quotes near: ' + src.slice(s, s + 40));
      if (src[i] === '\\') {
        const e = src[i + 1];
        if (e === 'x') { out += String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16)); i += 4; continue; }
        if (e === 'u') { out += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)); i += 6; continue; }
        out += ({ n: '\n', t: '\t', r: '\r' })[e] ?? e; i += 2; continue;
      }
      out += src[i++];
    }
    if (src[i] !== q) throw new Error('missing closing quote near: ' + src.slice(s, s + 40));
    i++;
    return { type: 'str', value: out, start: s, end: i };
  };
  const value = () => {
    ws();
    const c = src[i];
    if (c === '{') {
      const node = { type: 'obj', start: i, props: {} }; i++;
      for (;;) {
        ws();
        if (src[i] === '}') { node.end = ++i; return node; }
        let key;
        if (src[i] === "'" || src[i] === '"') key = str().value;
        else { const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i)); if (!m) throw new Error('unexpected text near: ' + src.slice(i, i + 40)); key = m[0]; i += key.length; }
        ws(); if (src[i] !== ':') throw new Error('missing ":" after ' + key); i++;
        node.props[key] = value();
        ws(); if (src[i] === ',') i++; else { ws(); if (src[i] !== '}') throw new Error('missing comma after ' + key); }
      }
    }
    if (c === '[') {
      const node = { type: 'arr', start: i, items: [] }; i++;
      for (;;) {
        ws();
        if (src[i] === ']') { node.close = i; node.end = ++i; return node; }
        const v = value(); node.items.push(v);
        ws(); if (src[i] === ',') { v.comma = true; i++; } else if (src[i] !== ']') throw new Error('missing comma in list near: ' + src.slice(v.start, v.start + 40));
      }
    }
    if (c === "'" || c === '"') return str();
    const m = /^(true|false|null|-?\d+(\.\d+)?)/.exec(src.slice(i));
    if (!m) throw new Error('unexpected text near: ' + src.slice(i, i + 40));
    const s = i; i += m[0].length;
    return { type: 'lit', value: JSON.parse(m[0]), start: s, end: i };
  };
  const v = value();
  return v;
}

function load() {
  const html = fs.readFileSync(HTML, 'utf8');
  const b = filmBounds(html);
  const tree = parse(html, b.objStart);
  return { html, tree };
}

const plain = n => n.type === 'obj' ? Object.fromEntries(Object.entries(n.props).map(([k, v]) => [k, plain(v)]))
  : n.type === 'arr' ? n.items.map(plain) : n.value;

// Tab titles from the page (data-film host -> section h2)
function tabNames(html) {
  const names = {};
  for (const m of html.matchAll(/<div id="(\w+)" class="section">[\s\S]*?<h2 class="section-title">([^<]*)<\/h2>/g)) names[m[1]] = m[2].trim();
  return names;
}

// Every place a video or an event can be added
function targets(html, tree) {
  const names = tabNames(html);
  const vids = [], events = [];
  for (const [sec, list] of Object.entries(tree.props)) {
    const tab = names[sec] || sec;
    if (list.type !== 'arr') continue;
    for (const e of list.items) {
      if (e.type !== 'obj') continue;
      const P = plain(e);
      const label0 = P.flat ? tab : tab + SEP + P.title + (P.meta ? ' ' + P.meta : '');
      if (e.props.numbered) vids.push({ label: label0, node: e.props.numbered.props.vimeo, numbered: true, info: P });
      if (e.props.videos) vids.push({ label: label0, node: e.props.videos, info: P });
      if (e.props.events) {
        events.push({ label: label0, node: e.props.events });
        for (const ev of e.props.events.items) {
          if (ev.type !== 'obj' || !ev.props.videos) continue;
          const E = plain(ev);
          vids.push({ label: label0 + SEP + E.title + (E.date ? ' (' + E.date + ')' : ''), node: ev.props.videos, info: E });
        }
      }
    }
  }
  return { vids, events };
}

// ── link handling: same rules as the page's embedFor() ──
function videoId(url) {
  let m = String(url).match(/vimeo\.com\/(?:[^?#]*?\/)?(\d{6,})(?:\/([0-9a-f]{6,}))?(?=[/?#]|$)/);
  if (m) return 'vimeo:' + m[1];
  m = String(url).match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([A-Za-z0-9_-]{11})/);
  if (m) return 'yt:' + m[1];
  return null;
}
const cleanUrl = u => u.replace(/[?&]si=[^&]*$/, '').replace(/[?&]share=copy$/, '');
const q = s => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/</g, '\\x3c').replace(/[\r\n\u2028\u2029]+/g, ' ').trim() + "'";
const tidy = s => String(s || '').replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\s+/g, ' ').trim();

// "Match 3 https://vimeo.com/123 Semis" -> {title, url, note}
function parseVideoLines(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    let line = tidy(raw.replace(/^[-*•]\s*/, ''));
    if (!line || line === '_No response_') continue;
    line = line.replace(/\[([^\]]*)\]\((https?:[^)\s]+)\)/g, '$1 $2')   // [text](url) -> text url
               .replace(/<(https?:[^>\s]+)>/g, '$1');                     // <url> -> url
    const links = line.match(/https?:\/\/[^\s<>"'\]]+/g) || [];
    if (!links.length) throw new Error('No link found on this line: "' + line + '"');
    if (links.length > 1) throw new Error('Put one video per line. This line has ' + links.length + ' links: "' + line + '"');
    const m = line.match(/https?:\/\/[^\s<>"'\]]+/);
    const strip = s => tidy(s).replace(/^[\s|,:;–—-]+|[\s|,:;–—-]+$/g, '');
    out.push({ title: strip(line.slice(0, m.index)), url: m[0].replace(/[)\]}.,!;:]+$/, ''), note: strip(line.slice(m.index + m[0].length)) });
  }
  return out;
}

// insert text as new item(s) at the end of an array node, keeping indentation
function insertIntoArray(src, arr, itemText) {
  const lineStartOf = p => src.lastIndexOf('\n', p - 1) + 1;
  const indentOf = p => /^[ \t]*/.exec(src.slice(lineStartOf(p)))[0];
  let edits = [];
  const last = arr.items[arr.items.length - 1];
  if (last && !last.comma) edits.push([last.end, ',']);
  const closeLine = lineStartOf(arr.close);
  const onOwnLine = src.slice(closeLine, arr.close).trim() === '';
  let ind;
  if (arr.items.length) ind = indentOf(arr.items[0].start);
  else ind = (onOwnLine ? indentOf(arr.close) : indentOf(arr.start)) + '  ';
  const lines = itemText.split('\n').map(l => ind + l).join('\n');
  if (onOwnLine) edits.push([closeLine, lines + '\n']);
  else edits.push([arr.close, '\n' + lines + '\n' + indentOf(arr.start)]);
  edits.sort((a, b) => b[0] - a[0]);
  for (const [p, t] of edits) src = src.slice(0, p) + t + src.slice(p);
  return src;
}

function allIds(tree) {
  const ids = new Map();
  const walk = (n, where) => {
    if (n.type === 'obj') {
      if (n.props.url && n.props.url.type === 'str') { const id = videoId(n.props.url.value); if (id) ids.set(id, where); }
      for (const [k, v] of Object.entries(n.props)) walk(v, where + (n.props.title && k === 'videos' ? SEP + n.props.title.value : ''));
    } else if (n.type === 'arr') n.items.forEach(x => walk(x, where));
  };
  walk(tree, '');
  // numbered (Granby-style) ids
  for (const list of Object.values(tree.props)) for (const e of (list.items || [])) {
    const v = e.props && e.props.numbered && e.props.numbered.props.vimeo;
    if (v) v.items.forEach(x => ids.set('vimeo:' + x.value, plain(e).title));
  }
  return ids;
}

// full check of the list (used after every edit)
function check(html) {
  const tree = parse(html, filmBounds(html).objStart);
  const problems = [];
  const seen = new Map();
  const walkVideos = (arr, where) => arr.items.forEach(v => {
    const V = plain(v);
    if (!V || typeof V !== 'object' || typeof V.url !== 'string') { problems.push(where + ': a video has no url'); return; }
    const id = videoId(V.url);
    if (!id) problems.push(where + ': link not recognised: ' + V.url);
    else if (seen.has(id)) problems.push(where + ': same video as in ' + seen.get(id) + ': ' + V.url);
    else seen.set(id, where);
  });
  for (const [sec, list] of Object.entries(tree.props)) for (const e of list.items || []) {
    if (e.props.videos) walkVideos(e.props.videos, sec + SEP + plain(e).title);
    for (const ev of (e.props.events ? e.props.events.items : [])) if (ev.props.videos) walkVideos(ev.props.videos, sec + SEP + plain(ev).title);
  }
  // the page's own script must still parse
  const b = filmBounds(html);
  try { new Function(html.slice(b.start, b.end) + '\n;return FILM;')(); } catch (err) { problems.push('the list no longer parses: ' + err.message); }
  return { tree, problems };
}

// ── issue forms ──
function yamlStr(s) { return JSON.stringify(s); }
function syncForms() {
  const { html, tree } = load();
  const { vids, events } = targets(html, tree);
  fs.mkdirSync(FORMS, { recursive: true });
  const vidForm = `# Built automatically from the FILM list in index.html (scripts/film.mjs sync-forms).
# Don't edit by hand: changes are overwritten whenever the site changes.
name: Add video
description: Add one or more match videos to the site
title: "Add video"
labels: [add-video]
body:
  - type: dropdown
    id: where
    attributes:
      label: Where does it go?
      description: Newest events are at the bottom of each tab. Not listed? Use the "Add event" form first.
      options:
${vids.map(v => '        - ' + yamlStr(v.label)).join('\n')}
    validations:
      required: true
  - type: textarea
    id: videos
    attributes:
      label: Videos
      description: |
        One video per line: the title, then the Vimeo or YouTube link, then an optional note.
        Leave the title off and it's numbered for you (Match 1, Match 2...).
      placeholder: |
        Match 1 https://vimeo.com/123456789
        Match 2 https://vimeo.com/123456790 Semis
    validations:
      required: true
`;
  const evForm = `# Built automatically from the FILM list in index.html (scripts/film.mjs sync-forms).
# Don't edit by hand: changes are overwritten whenever the site changes.
name: Add event
description: Add a new tournament or event (videos optional; add them later with "Add video")
title: "Add event"
labels: [add-event]
body:
  - type: dropdown
    id: where
    attributes:
      label: Which tab and group?
      options:
${events.map(v => '        - ' + yamlStr(v.label)).join('\n')}
    validations:
      required: true
  - type: input
    id: name
    attributes:
      label: Event name
      placeholder: Blue Springs Invitational
    validations:
      required: true
  - type: input
    id: date
    attributes:
      label: Date
      placeholder: Dec 6, 2026  (or Dec 6–7, 2026)
    validations:
      required: true
  - type: textarea
    id: videos
    attributes:
      label: Videos (optional)
      description: One per line - title, link, optional note. Leave empty to show "Videos coming soon".
      placeholder: |
        Match 1 https://vimeo.com/123456789
`;
  let changed = false;
  for (const [f, t] of [['add-video.yml', vidForm], ['add-event.yml', evForm], ['config.yml', 'blank_issues_enabled: true\n']]) {
    const p = path.join(FORMS, f);
    if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== t) { fs.writeFileSync(p, t); changed = true; }
  }
  console.log(changed ? 'forms updated' : 'forms already up to date');
}

// "### Label\n\nvalue" sections of an issue-form body
function formFields(body) {
  const f = {};
  const parts = String(body || '').split(/^###\s+/m).slice(1);
  for (const p of parts) {
    const nl = p.indexOf('\n');
    const label = p.slice(0, nl).trim();
    const val = p.slice(nl + 1).trim();
    f[label] = val === '_No response_' ? '' : val;
  }
  return f;
}

function apply(eventPath) {
  const ev = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const issue = ev.issue;
  const labels = (issue.labels || []).map(l => l.name);
  const F = formFields(issue.body);
  let { html, tree } = load();
  const { vids, events } = targets(html, tree);
  const ids = allIds(tree);
  const msgs = [];

  const videoItems = (lines, startNum) => lines.map((v, k) => {
    if (!videoId(v.url)) throw new Error('This link is not a Vimeo or YouTube video link: ' + v.url);
    const id = videoId(v.url);
    if (ids.has(id)) throw new Error('This video is already on the site (' + (ids.get(id) || '').replace(/^ › /, '') + '): ' + v.url);
    ids.set(id, 'this form');
    const title = v.title || 'Match ' + (startNum + k);
    return { title, note: v.note, url: cleanUrl(v.url) };
  });
  const fmt = v => '{ title: ' + q(v.title) + (v.note ? ', note: ' + q(v.note) : '') + ', url: ' + q(v.url) + ' },';

  if (labels.includes('add-event')) {
    const where = F['Which tab and group?'];
    const t = events.find(e => e.label === where);
    if (!t) throw new Error('Unknown place "' + where + '". Pick one from the list.');
    const name = tidy(F['Event name']), date = tidy(F['Date']);
    if (!name) throw new Error('Event name is empty.');
    if (t.node.items.some(e => plain(e).title === name && (plain(e).date || '') === date)) throw new Error('That event already exists: ' + name + ' (' + date + ').');
    const items = videoItems(parseVideoLines(F['Videos (optional)']), 1);
    const block = ['{ title: ' + q(name) + ', date: ' + q(date) + ',', '  videos: [', ...items.map(v => '    ' + fmt(v)), '  ] },'].join('\n');
    html = insertIntoArray(html, t.node, block);
    msgs.push(`Added event **${name}** (${date}) to ${where}` + (items.length ? ` with ${items.length} video${items.length > 1 ? 's' : ''}.` : '. It shows "Videos coming soon" until you add videos.'));
    msgs.push('It is now in the **Add video** list too (give it about a minute).');
  } else if (labels.includes('add-video')) {
    const where = F['Where does it go?'];
    const t = vids.find(v => v.label === where);
    if (!t) throw new Error('Unknown place "' + where + '". Pick one from the list.');
    const lines = parseVideoLines(F['Videos']);
    if (!lines.length) throw new Error('No videos found. Put one per line: title, then the link.');
    const items = videoItems(lines, t.node.items.length + 1);
    if (t.numbered) items.forEach((v, k) => { v.title = t.info.numbered.prefix + ' ' + (t.node.items.length + 1 + k); v.note = ''; });
    if (t.numbered) {
      const nums = items.map(v => (v.url.match(/vimeo\.com\/(?:[^?#]*?\/)?(\d{6,})/) || [])[1]);
      if (nums.some(n => !n)) throw new Error(where + ' only takes Vimeo links.');
      html = insertIntoArray(html, t.node, nums.map(n => q(n) + ',').join('\n'));
    } else {
      html = insertIntoArray(html, t.node, items.map(fmt).join('\n'));
    }
    msgs.push(`Added ${items.length} video${items.length > 1 ? 's' : ''} to ${where}:`);
    items.forEach(v => msgs.push(`- ${v.title}${v.note ? ' (' + v.note + ')' : ''}`));
  } else {
    throw new Error('This issue is not an Add video / Add event form.');
  }

  const { problems } = check(html);
  if (problems.length) throw new Error('The edit did not pass the check, nothing was changed:\n- ' + problems.join('\n- '));
  fs.writeFileSync(HTML, html);
  return msgs.join('\n');
}

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === 'sync-forms') syncForms();
  else if (cmd === 'check') {
    const { problems } = check(fs.readFileSync(HTML, 'utf8'));
    if (problems.length) { console.log(problems.join('\n')); process.exit(1); }
    console.log('FILM list OK');
  } else if (cmd === 'apply') {
    const out = apply(arg);
    fs.writeFileSync(path.join(ROOT, '.film-result.md'), '✅ ' + out + '\n\nThe site updates in about a minute: https://mckinnont86.github.io/gmac_wrestling/\n');
    console.log(out);
  } else { console.log('usage: film.mjs sync-forms | check | apply <event.json>'); process.exit(2); }
} catch (err) {
  if (cmd === 'apply') fs.writeFileSync(path.join(ROOT, '.film-result.md'), '❌ Nothing was added.\n\n' + err.message + '\n\nFix it and submit the form again (this one stays open so you can see what you sent).\n');
  console.error(err.message);
  process.exit(1);
}
