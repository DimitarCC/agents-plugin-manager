/* Agent Plugin Manager - webview UI. Pure DOM, no dependencies. The extension host owns all state and logic. */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const SEP = '\u0001';
  const KIND_LABEL = {
    skill: 'Skills', mcp: 'MCP servers', agent: 'Agents', prompt: 'Prompts / commands', hook: 'Hooks & other (not installable)',
  };
  const KIND_TAG = { skill: 'SKILL', mcp: 'MCP', agent: 'AGENT', prompt: 'PROMPT', hook: 'HOOK' };

  /** @type {any} latest state from the extension host */
  let S = null;
  const sel = new Set();          // selected components: pkg SEP kind SEP name
  let current = null;             // package shown in the detail pane
  let previewKey = null;          // component shown in the preview
  const previews = new Map();     // cached preview texts
  let dialog = null;              // state of the add/edit source dialog

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const key = (p, c) => p + SEP + c.kind + SEP + c.name;
  const post = m => vscode.postMessage(m);

  // ───────── derived data ─────────

  function installable(p) { return p.components.filter(c => c.installable); }

  /** true = all installable items selected, null = some, false = none */
  function pkgState(p) {
    const inst = installable(p);
    const n = inst.filter(c => sel.has(key(p.name, c))).length;
    if (n === 0) { return false; }
    return n === inst.length ? true : null;
  }

  function filteredPackages() {
    if (!S) { return []; }
    const q = $('search').value.trim().toLowerCase();
    if (!q) { return S.packages; }
    return S.packages.filter(p =>
      p.name.toLowerCase().includes(q) ||
      (p.description || '').toLowerCase().includes(q) ||
      p.keywords.some(k => k.toLowerCase().includes(q)) ||
      p.components.some(c => c.name.toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q)));
  }

  function selectedCount() {
    let n = 0;
    for (const p of S.packages) { n += installable(p).filter(c => sel.has(key(p.name, c))).length; }
    return n;
  }

  // ───────── rendering ─────────

  function renderAll() {
    renderSource();
    const list = filteredPackages();
    if (!current || !S.packages.some(p => p.name === current)) { current = list.length ? list[0].name : null; }
    renderList();
    renderDetail();
    renderInstall();
  }

  function renderSource() {
    const sourceSel = $('source');
    const has = S.sources.length > 0;
    sourceSel.innerHTML = has
      ? S.sources.map(s => `<option value="${esc(s.id)}"${s.id === S.currentSourceId ? ' selected' : ''}>${esc(s.name)}</option>`).join('')
      : '<option value="">(no sources)</option>';
    sourceSel.disabled = !has;
    $('btnEdit').disabled = $('btnRemove').disabled = !has;
    $('btnRefresh').disabled = !has || S.busy;
    $('busy').classList.toggle('hidden', !S.busy);
    $('status').textContent = S.status || '';
    $('auto').checked = !!S.autoUpdate;
    const ua = $('btnUpdateAll');
    ua.classList.toggle('hidden', !(S.updateCount > 0));
    ua.textContent = 'Update all (' + S.updateCount + ')';
  }

  function renderList() {
    const list = filteredPackages();
    const box = $('pkgList');
    const top = box.scrollTop;
    box.innerHTML = list.length === 0
      ? `<div class="empty">${S.packages.length === 0 ? 'No packages loaded.' : 'No packages match your search.'}</div>`
      : list.map(p => {
        const st = pkgState(p);
        return `<div class="pkg${p.name === current ? ' selected' : ''}" data-pkg="${esc(p.name)}">
          <label class="check" title="Select every item of this package"><input type="checkbox" class="pc" data-pkg="${esc(p.name)}"${st === true ? ' checked' : ''}${st === null ? ' data-ind="1"' : ''}><span class="box"></span></label>
          <div class="pbody">
            <div class="prow"><b>${esc(p.name)}</b><span class="muted">${p.version ? 'v' + esc(p.version) : ''}</span></div>
            <div class="pdesc">${esc(p.description || 'No description provided.')}</div>
            <div class="psum">${esc(p.summary)}</div>
            ${p.installedSummary ? `<div class="pinst">${esc(p.installedSummary)}</div>` : ''}
            ${p.hasUpdate ? `<span class="tag big">Update: ${esc(p.updateText)}</span>` : ''}
          </div></div>`;
      }).join('');
    box.querySelectorAll('input[data-ind="1"]').forEach(i => { i.indeterminate = true; });
    box.scrollTop = top;

    $('pkgCount').textContent = list.length === S.packages.length ? S.packages.length + ' packages' : list.length + ' of ' + S.packages.length;
    const all = $('selAll');
    all.disabled = list.length === 0;
    const states = list.map(pkgState);
    all.indeterminate = false;
    if (states.length > 0 && states.every(s => s === true)) { all.checked = true; }
    else if (states.length === 0 || states.every(s => s === false)) { all.checked = false; }
    else { all.checked = false; all.indeterminate = true; }
  }

  function renderDetail() {
    const d = $('detail');
    const p = S.packages.find(x => x.name === current);
    if (!p) {
      d.innerHTML = `<div class="empty">${S.packages.length ? 'Select a package.' : ''}</div>`;
      return;
    }
    const prevComps = $('compList');
    const compTop = prevComps ? prevComps.scrollTop : 0;

    const chips = [];
    if (p.author) { chips.push('by ' + p.author); }
    if (p.license) { chips.push(p.license); }
    p.keywords.forEach(k => chips.push(k));

    let comps = '';
    let lastKind = null;
    for (const c of p.components) {
      if (c.kind !== lastKind) { comps += `<div class="label group">${esc(KIND_LABEL[c.kind] || c.kind).toUpperCase()}</div>`; lastKind = c.kind; }
      const k = key(p.name, c);
      comps += `<div class="comp${k === previewKey ? ' selected' : ''}" data-kind="${esc(c.kind)}" data-name="${esc(c.name)}">
        <label class="check"><input type="checkbox" class="cc"${sel.has(k) ? ' checked' : ''}${c.installable ? '' : ' disabled'}><span class="box"></span></label>
        <div class="cbody">
          <div class="crow"><b>${esc(c.name)}</b><span class="tag">${KIND_TAG[c.kind] || ''}</span>${c.installedHere ? '<span class="tag">INSTALLED</span>' : ''}</div>
          <div class="cdesc">${esc(c.description)}</div>
        </div>
        ${c.installedHere ? '<button class="tiny" data-a="uninstallItem" title="Remove this item from the selected destination">Uninstall</button>' : ''}
      </div>`;
    }

    const pvText = previewKey && previews.has(previewKey) ? previews.get(previewKey) : '';
    const pvTitle = previewKey ? 'PREVIEW  —  ' + previewKey.split(SEP).slice(2).join('') : 'PREVIEW  —  select an item to see its content';

    d.innerHTML = `
      <div class="detail-head">
        <div class="title"><h2>${esc(p.name)}</h2><span class="tag big">${p.version ? 'v' + esc(p.version) : 'no version'}</span></div>
        ${chips.length ? `<div class="chips">${chips.map(c => `<span class="chip">${esc(c)}</span>`).join('')}</div>` : ''}
        <p class="desc${p.description ? '' : ' none'}">${esc(p.description || 'No description provided.')}</p>
        ${/^https?:\/\//i.test(p.homepage) ? `<a class="link" data-a="openLink">${esc(p.homepage)}</a>` : ''}
        ${p.warnings.length ? `<div class="warnings">${esc(p.warnings.join('\n'))}</div>` : ''}
        ${p.hasUpdate ? `<div class="banner update"><div><b>Update available  ${esc(p.updateText)}</b><div class="muted">${esc(p.installedSummary)}</div></div><button class="accent" data-a="updatePkg">Update</button></div>` : ''}
        ${p.installedHere ? `<div class="banner"><div>Installed at this destination (${esc(p.installedHere.where)})${p.installedHere.version ? '  ·  v' + esc(p.installedHere.version) : ''}  ·  ${p.installedHere.count} item(s)</div><button data-a="uninstallPkg">Uninstall package</button></div>` : ''}
        <div class="inside-head"><span class="label">WHAT'S INSIDE</span>
          <div class="btns"><button class="tiny" data-a="selAllItems">Select all</button><button class="tiny" data-a="selNoneItems">Select none</button></div></div>
      </div>
      <div class="comps scroll" id="compList">${comps}</div>
      <div class="preview"><div class="label" id="pvTitle">${esc(pvTitle)}</div><pre id="pvText" class="mono">${esc(pvText)}</pre></div>`;
    const cl = $('compList');
    if (cl) { cl.scrollTop = compTop; }
  }

  function renderInstall() {
    document.querySelectorAll('#scope button').forEach(b => b.classList.toggle('active', b.dataset.scope === S.scope));
    $('layout').value = S.layout;
    $('destination').textContent = (S.destination || []).join('\n');
    const n = selectedCount();
    const b = $('btnInstall');
    b.textContent = n === 0 ? 'Install' : 'Install ' + n + ' selected';
    b.disabled = n === 0 || S.busy;
  }

  function showLog(text) {
    const l = $('log');
    l.textContent = text;
    l.classList.remove('hidden');
  }

  // ───────── selection helpers ─────────

  function setPackage(p, on) {
    for (const c of installable(p)) { on ? sel.add(key(p.name, c)) : sel.delete(key(p.name, c)); }
  }

  function afterSelectionChange(redrawDetail) {
    renderList();
    if (redrawDetail) { renderDetail(); }
    renderInstall();
  }

  // ───────── events ─────────

  document.addEventListener('click', e => {
    const t = /** @type {HTMLElement} */ (e.target);
    const btn = t.closest('[data-a]');
    if (btn) { return void onAction(btn.dataset.a, btn, e); }

    const seg = t.closest('#scope button');
    if (seg) { return post({ type: 'setTarget', scope: seg.dataset.scope, layout: S.layout }); }

    // package row (ignore clicks on the checkbox itself; it has its own change handler)
    const pkgEl = t.closest('.pkg');
    if (pkgEl && !t.closest('.check')) {
      current = pkgEl.dataset.pkg;
      previewKey = null;
      renderList();
      renderDetail();
      return;
    }

    const compEl = t.closest('.comp');
    if (compEl && !t.closest('.check') && !t.closest('button')) {
      const k = current + SEP + compEl.dataset.kind + SEP + compEl.dataset.name;
      previewKey = k;
      if (!previews.has(k)) { post({ type: 'preview', pkg: current, kind: compEl.dataset.kind, name: compEl.dataset.name }); }
      renderDetail();
    }
  });

  document.addEventListener('change', e => {
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (t.classList.contains('pc')) {
      const p = S.packages.find(x => x.name === t.dataset.pkg);
      if (p) { setPackage(p, t.checked); afterSelectionChange(p.name === current); }
    } else if (t.classList.contains('cc')) {
      const row = t.closest('.comp');
      sel_toggle(current + SEP + row.dataset.kind + SEP + row.dataset.name, t.checked);
      afterSelectionChange(false);
    } else if (t.id === 'selAll') {
      for (const p of filteredPackages()) { setPackage(p, t.checked); }
      afterSelectionChange(true);
    } else if (t.id === 'auto') {
      post({ type: 'setAutoUpdate', value: t.checked });
    } else if (t.id === 'layout') {
      post({ type: 'setTarget', scope: S.scope, layout: t.value });
    } else if (t.id === 'source') {
      if (t.value) { post({ type: 'selectSource', id: t.value }); }
    }
  });

  function sel_toggle(k, on) { on ? sel.add(k) : sel.delete(k); }

  $('search').addEventListener('input', () => {
    if (!S) { return; }
    const list = filteredPackages();
    if (!list.some(p => p.name === current)) { current = list.length ? list[0].name : null; renderDetail(); }
    renderList();
  });

  function onAction(a, el) {
    const p = S && S.packages.find(x => x.name === current);
    switch (a) {
      case 'addSource': return openDialog(null);
      case 'editSource': return openDialog(S.sources.find(s => s.id === S.currentSourceId) || null);
      case 'removeSource': return post({ type: 'removeSource', id: S.currentSourceId });
      case 'refresh': return post({ type: 'refresh' });
      case 'updateAll': return post({ type: 'updateAll' });
      case 'updatePkg': return p && post({ type: 'update', pkg: p.name });
      case 'uninstallPkg': return p && post({ type: 'uninstall', pkg: p.name, items: 'all' });
      case 'uninstallItem': {
        const row = el.closest('.comp');
        return p && post({ type: 'uninstall', pkg: p.name, items: [{ kind: row.dataset.kind, name: row.dataset.name }] });
      }
      case 'openLink': return p && post({ type: 'openLink', pkg: p.name });
      case 'selAllItems': if (p) { setPackage(p, true); afterSelectionChange(true); } return;
      case 'selNoneItems': if (p) { setPackage(p, false); afterSelectionChange(true); } return;
      case 'install': {
        const items = [];
        for (const pk of S.packages) {
          const comps = installable(pk).filter(c => sel.has(key(pk.name, c))).map(c => ({ kind: c.kind, name: c.name }));
          if (comps.length) { items.push({ pkg: pk.name, components: comps }); }
        }
        return post({ type: 'install', items, overwrite: $('overwrite').checked });
      }
    }
  }

  // ───────── add / edit source dialog ─────────

  const AUTH_HINTS = {
    sso: "Location: https URL or GitHub 'owner/repo'. Git opens your organization's sign-in (Entra ID, GitHub Enterprise / SAML SSO, Azure DevOps) through Git Credential Manager, which remembers the result.",
    vscode: "Uses the GitHub or Microsoft account signed in to VS Code (github.com and Azure DevOps). For SAML-protected GitHub orgs, authorize VS Code for the organization when asked.",
    pat: 'For SAML-protected GitHub organizations, authorize the token for SSO first (Settings › Developer settings › Tokens › Configure SSO). Azure DevOps PATs also work. The token is stored in VS Code secret storage.',
    none: "Location: https URL or GitHub 'owner/repo' of a public repository.",
  };

  function openDialog(src) {
    dialog = { id: src ? src.id : undefined, hasToken: !!(src && src.hasToken), tokenChanged: false };
    const m = $('modal');
    m.innerHTML = `<div class="dialog" role="dialog" aria-modal="true">
      <h3>${src ? 'Edit plugin source' : 'Add plugin source'}</h3>
      <label class="field"><span>Name</span><input id="dName" type="text" value="${esc(src ? src.name : '')}"></label>
      <label class="field"><span>Type</span><select id="dKind"><option value="git">Git repository</option><option value="local">Local folder</option></select></label>
      <label class="field"><span>Location</span><div class="inline"><input id="dLoc" type="text" value="${esc(src ? src.location : '')}" placeholder="https://github.com/owner/repo  or  owner/repo"><button id="dBrowse" class="hidden">Browse…</button></div></label>
      <label class="field git"><span>Branch / tag / commit</span><input id="dRef" type="text" value="${esc(src ? src.ref : '')}"></label>
      <label class="field git"><span>Authentication</span><select id="dAuth">
        <option value="sso">Single sign-on (Git Credential Manager — browser / Entra ID / SAML)</option>
        <option value="vscode">Sign in with VS Code (GitHub / Microsoft account)</option>
        <option value="pat">Personal access token (SSO-authorized)</option>
        <option value="none">None (public repository)</option></select></label>
      <label class="field tok"><span>Access token</span><input id="dTok" type="password" autocomplete="off"></label>
      <p class="hint" id="dHint"></p>
      <div class="result" id="dResult"></div>
      <div class="dbtns"><button id="dTest">Test connection</button><button id="dSave" class="accent">Save</button><button id="dCancel">Cancel</button></div>
    </div>`;
    m.classList.remove('hidden');
    $('dKind').value = src ? src.kind : 'git';
    $('dAuth').value = src ? src.auth : 'sso';
    if (dialog.hasToken) { $('dTok').value = '••••••••'; }
    $('dTok').addEventListener('input', () => { dialog.tokenChanged = true; });
    $('dKind').addEventListener('change', dialogVisibility);
    $('dAuth').addEventListener('change', dialogVisibility);
    $('dBrowse').addEventListener('click', () => post({ type: 'browseFolder' }));
    $('dCancel').addEventListener('click', closeDialog);
    $('dTest').addEventListener('click', () => dialogSend('testSource'));
    $('dSave').addEventListener('click', () => dialogSend('saveSource'));
    dialogVisibility();
    $('dLoc').focus();
  }

  function dialogVisibility() {
    const git = $('dKind').value === 'git';
    const auth = $('dAuth').value;
    document.querySelectorAll('#modal .git').forEach(e => e.classList.toggle('hidden', !git));
    document.querySelectorAll('#modal .tok').forEach(e => e.classList.toggle('hidden', !(git && auth === 'pat')));
    $('dBrowse').classList.toggle('hidden', git);
    $('dHint').textContent = git ? AUTH_HINTS[auth] : 'A folder containing one or more plugin packages (each with a plugin.json), or a single plugin folder.';
  }

  function dialogSend(type) {
    const source = {
      id: dialog.id, name: $('dName').value, kind: $('dKind').value, location: $('dLoc').value, ref: $('dRef').value, auth: $('dAuth').value,
    };
    const token = source.kind === 'git' && source.auth === 'pat' && dialog.tokenChanged ? $('dTok').value : undefined;
    if (!source.location.trim()) { return dialogResult(false, 'Location is required.'); }
    if (type === 'saveSource' && source.auth === 'pat' && source.kind === 'git' && token === undefined && !dialog.hasToken) {
      return dialogResult(false, 'Enter an access token.');
    }
    dialogResult(null, type === 'testSource' ? (source.kind === 'git' ? 'Connecting… (a sign-in window may appear)' : 'Checking…') : 'Saving…');
    post({ type, source, token });
  }

  function dialogResult(ok, text) {
    const r = $('dResult');
    if (!r) { return; }
    r.className = 'result' + (ok === true ? ' ok' : ok === false ? ' err' : '');
    r.textContent = text || '';
  }

  function closeDialog() {
    dialog = null;
    $('modal').classList.add('hidden');
    $('modal').innerHTML = '';
  }

  document.addEventListener('keydown', e => { if (e.key === 'Escape' && dialog) { closeDialog(); } });

  // ───────── messages from the extension host ─────────

  window.addEventListener('message', ev => {
    const m = ev.data;
    switch (m.type) {
      case 'state':
        S = m.state;
        // drop selections that no longer exist
        const valid = new Set();
        for (const p of S.packages) { for (const c of p.components) { valid.add(key(p.name, c)); } }
        for (const k of Array.from(sel)) { if (!valid.has(k)) { sel.delete(k); } }
        renderAll();
        break;
      case 'log': showLog(m.text); break;
      case 'preview': {
        const k = m.pkg + SEP + m.kind + SEP + m.name;
        previews.set(k, m.text);
        if (k === previewKey && $('pvText')) { $('pvText').textContent = m.text; $('pvTitle').textContent = 'PREVIEW  —  ' + m.name; }
        break;
      }
      case 'dialogResult':
        if (m.ok) { closeDialog(); } else { dialogResult(false, m.error); }
        break;
      case 'testResult': dialogResult(m.ok, m.message); break;
      case 'folder': if (m.path && $('dLoc')) { $('dLoc').value = m.path; } break;
    }
  });

  post({ type: 'ready' });
})();
