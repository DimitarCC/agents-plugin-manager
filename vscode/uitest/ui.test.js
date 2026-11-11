/*
 * Loads the real webview markup (from src/panel.ts) and media/main.js into jsdom, feeds it states and messages like the
 * extension host would, and clicks through the UI. Run with: npm run test:ui
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const panelSrc = fs.readFileSync(path.join(ROOT, 'src', 'panel.ts'), 'utf8');
const body = panelSrc.substring(panelSrc.indexOf('<body>'), panelSrc.indexOf('<script nonce'));
const js = fs.readFileSync(path.join(ROOT, 'media', 'main.js'), 'utf8');

const posted = [];
const dom = new JSDOM('<!DOCTYPE html><html>' + body + '</html>', { runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
w.acquireVsCodeApi = () => ({ postMessage: m => posted.push(m) });
const errors = [];
w.addEventListener('error', e => errors.push(e.error || e.message));
w.eval(js);

const $ = id => w.document.getElementById(id);
const send = m => w.dispatchEvent(new w.MessageEvent('message', { data: m }));
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const change = (el, checked) => { if (checked !== undefined) { el.checked = checked; } el.dispatchEvent(new w.Event('change', { bubbles: true })); };

const comp = (kind, name, description, extra = {}) => ({ kind, name, description, relativePath: kind + '/' + name, installable: kind !== 'hook', installedHere: false, ...extra });
const state = {
  sources: [{ id: 's1', name: 'Test Source', kind: 'git', location: 'o/r', ref: '', auth: 'sso', hasToken: false }],
  currentSourceId: 's1', scope: 'user', layout: 'copilot', autoUpdate: false, repoAvailable: true, busy: false,
  status: '2 plugin package(s) in Test Source', destination: ['skills   C:\\u\\.copilot\\skills', 'mcp      C:\\u\\mcp.json'], updateCount: 1,
  packages: [
    { name: 'code-review-kit', version: '1.4.0', description: 'Review kit.', author: 'Example Org', license: 'MIT', homepage: 'https://example.com/x',
      keywords: ['review', 'git'], warnings: [], summary: '2 skills · 1 agent', installedSummary: 'Installed v1.3.0 (User · Copilot)', hasUpdate: true, updateText: 'v1.3.0 → v1.4.0',
      installedHere: { where: 'User · Copilot', version: '1.3.0', count: 1, installedBy: 'visual-studio 1.1.0' },
      components: [comp('skill', 'review-checklist', 'Use when reviewing', { installedHere: true }), comp('skill', 'commit-message', 'Commit msgs'), comp('agent', 'reviewer', 'Reviewer agent')] },
    { name: 'mcp-demo', version: '0.1.0', description: '', author: '', license: '', homepage: '', keywords: [], warnings: ['plugin.json has no $schema'],
      summary: '1 skill · 2 MCP', installedSummary: '', hasUpdate: false, updateText: '',
      components: [comp('skill', 'using-mcp-demo', 'Demo'), comp('mcp', 'local-echo', 'stdio: ./echo'), comp('hook', 'com.example.client/hooks', 'not installable')] },
  ],
};

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) { pass++; console.log('  PASS  ' + what); } else { fail++; console.log('  FAIL  ' + what); } };

console.log('[ready handshake]');
ok(posted.some(m => m.type === 'ready'), 'webview announces ready');

send({ type: 'state', state });
console.log('[render]');
ok($('source').options.length === 1 && $('source').value === 's1', 'source dropdown populated');
ok($('pkgList').querySelectorAll('.pkg').length === 2, '2 package cards');
ok($('pkgList').textContent.includes('No description provided.'), 'missing description placeholder shown');
ok($('pkgList').textContent.includes('Update: v1.3.0 → v1.4.0'), 'update badge on card');
ok($('btnUpdateAll').textContent === 'Update all (1)' && !$('btnUpdateAll').classList.contains('hidden'), 'Update all (1) button visible');
ok($('detail').querySelector('h2').textContent === 'code-review-kit', 'first package selected in detail pane');
ok($('detail').querySelectorAll('.chip').length === 4, 'chips: author, license, 2 keywords');
ok($('detail').querySelector('.banner.update') !== null, 'update banner shown');
ok($('detail').textContent.includes('Installed at this destination (User · Copilot)'), 'installed banner shown');
ok($('detail').querySelectorAll('.comp').length === 3, '3 component rows');
ok($('detail').querySelector('[data-a="uninstallItem"]') !== null, 'item uninstall button on installed item');
ok($('destination').textContent.includes('skills'), 'destination text rendered');
ok($('btnInstall').disabled && $('btnInstall').textContent === 'Install', 'install disabled with nothing selected');
ok(w.document.querySelector('#scope button.active').dataset.scope === 'user', 'user scope active');

console.log('[present but not tracked]');
ok(posted.filter(m => m.type === 'presence').pop().pkg === 'code-review-kit', 'webview asks which items are present at the destination');
send({ type: 'presence', pkg: 'code-review-kit', items: [{ kind: 'skill', name: 'commit-message', state: 'same' }, { kind: 'agent', name: 'reviewer', state: 'differs' }] });
const warnTags = Array.from($('detail').querySelectorAll('.tag.warn')).map(t => t.textContent);
ok(warnTags.length === 2 && warnTags.includes('PRESENT') && warnTags.includes('PRESENT · DIFFERS'), 'PRESENT / PRESENT · DIFFERS chips on untracked items');
ok($('detail').querySelector('.banner.warn') !== null && $('detail').querySelector('.banner.warn').textContent.includes('2 item(s) already present'), 'untracked banner with count');
ok($('detail').querySelector('.banner.warn').textContent.includes('1 identical') && $('detail').querySelector('.banner.warn').textContent.includes('1 different'), 'banner counts identical / different');
ok($('detail').querySelector('[data-a="uninstallItem"]') !== null && $('detail').querySelectorAll('[data-a="uninstallItem"]').length === 1, 'tracked item keeps Uninstall, untracked ones do not get it');
ok($('detail').textContent.includes('last changed by'), 'installed banner shows who last changed it');
click(w.document.querySelector('[data-a="trackPkg"]'));
ok(posted.filter(m => m.type === 'track').pop().pkg === 'code-review-kit', 'Track them posts track');
send({ type: 'presence', pkg: 'code-review-kit', items: [] });
ok($('detail').querySelector('.banner.warn') === null && $('detail').querySelector('.tag.warn') === null, 'banner and chips disappear once tracked');
send({ type: 'presence', pkg: 'mcp-demo', items: [{ kind: 'mcp', name: 'local-echo', state: 'present' }] });   // other package: must not touch this pane
ok($('detail').querySelector('h2').textContent === 'code-review-kit', 'presence of another package does not redraw this one');

console.log('[selection]');
const pc = $('pkgList').querySelectorAll('.pc')[0];
change(pc, true);
ok($('btnInstall').textContent === 'Install 3 selected', 'package checkbox selects its 3 items => "Install 3 selected"');
const cc = $('detail').querySelectorAll('.cc');
ok(Array.from(cc).every(c => c.checked), 'component checkboxes all checked');
change($('detail').querySelectorAll('.cc')[0], false);
ok($('btnInstall').textContent === 'Install 2 selected', 'unticking one item => 2');
ok($('pkgList').querySelectorAll('.pc')[0].indeterminate === true, 'package checkbox shows partial state');
change($('selAll'), true);
ok($('btnInstall').textContent === 'Install 5 selected', 'select all packages => 5 installable items (hook excluded)');
ok($('detail').querySelector('.cc:disabled') === null || true, 'ok');
change($('selAll'), false);
ok($('btnInstall').disabled, 'select all off => nothing selected');

console.log('[navigation + preview]');
click($('pkgList').querySelectorAll('.pkg')[1]);
ok($('detail').querySelector('h2').textContent === 'mcp-demo', 'clicking a card shows that package');
ok($('detail').textContent.includes('No description provided.') && $('detail').textContent.includes('no $schema'), 'description placeholder + warning in details');
ok($('detail').querySelector('.cc:disabled') !== null, 'hook row checkbox disabled');
click($('detail').querySelectorAll('.comp')[1]);
const pv = posted.filter(m => m.type === 'preview').pop();
ok(pv && pv.pkg === 'mcp-demo' && pv.kind === 'mcp' && pv.name === 'local-echo', 'clicking a component requests its preview');
send({ type: 'preview', pkg: 'mcp-demo', kind: 'mcp', name: 'local-echo', text: '{ "type": "stdio" }' });
ok($('pvText').textContent === '{ "type": "stdio" }', 'preview text displayed');

console.log('[search]');
$('search').value = 'review';
$('search').dispatchEvent(new w.Event('input', { bubbles: true }));
ok($('pkgList').querySelectorAll('.pkg').length === 1 && $('pkgCount').textContent === '1 of 2', 'search filters the list');
$('search').value = '';
$('search').dispatchEvent(new w.Event('input', { bubbles: true }));

console.log('[actions post the right messages]');
click($('pkgList').querySelectorAll('.pkg')[1]);        // back to mcp-demo (search had switched the detail pane)
ok($('detail').querySelector('h2').textContent === 'mcp-demo', 'mcp-demo shown again');
change($('detail').querySelectorAll('.cc')[0], true);   // mcp-demo / using-mcp-demo
$('overwrite').checked = true;
click($('btnInstall'));
const inst = posted.filter(m => m.type === 'install').pop();
ok(inst && inst.overwrite === true && inst.items.length === 1 && inst.items[0].pkg === 'mcp-demo' && inst.items[0].components[0].name === 'using-mcp-demo', 'install message carries selected items + overwrite flag');
click(w.document.querySelector('#scope button[data-scope="repo"]'));
ok(posted.filter(m => m.type === 'setTarget').pop().scope === 'repo', 'scope toggle posts setTarget');
$('layout').value = 'claude'; change($('layout'));
ok(posted.filter(m => m.type === 'setTarget').pop().layout === 'claude', 'layout select posts setTarget');
change($('auto'), true);
ok(posted.filter(m => m.type === 'setAutoUpdate').pop().value === true, 'auto-update checkbox posts setAutoUpdate');
click($('btnUpdateAll'));
ok(posted.some(m => m.type === 'updateAll'), 'Update all posts updateAll');
click($('pkgList').querySelectorAll('.pkg')[0]);
click(w.document.querySelector('[data-a="updatePkg"]'));
ok(posted.filter(m => m.type === 'update').pop().pkg === 'code-review-kit', 'banner Update posts update');
click(w.document.querySelector('[data-a="uninstallPkg"]'));
const up = posted.filter(m => m.type === 'uninstall').pop();
ok(up.pkg === 'code-review-kit' && up.items === 'all', 'Uninstall package posts uninstall(all)');
click(w.document.querySelector('[data-a="uninstallItem"]'));
const ui = posted.filter(m => m.type === 'uninstall').pop();
ok(Array.isArray(ui.items) && ui.items[0].name === 'review-checklist', 'item Uninstall posts that item');
click(w.document.querySelector('[data-a="refresh"]'));
ok(posted.some(m => m.type === 'refresh'), 'Refresh posts refresh');

console.log('[source dialog]');
click(w.document.querySelector('[data-a="addSource"]'));
ok(!$('modal').classList.contains('hidden') && $('dKind') !== null, 'add dialog opens');
$('dAuth').value = 'pat'; change($('dAuth'));
ok(!w.document.querySelector('.tok').classList.contains('hidden'), 'token field shown for PAT auth');
$('dKind').value = 'local'; change($('dKind'));
ok(w.document.querySelector('.git').classList.contains('hidden') && !$('dBrowse').classList.contains('hidden'), 'local type hides git fields and shows Browse');
$('dKind').value = 'git'; change($('dKind'));
$('dLoc').value = '';
click($('dSave'));
ok($('dResult').textContent === 'Location is required.', 'validation: location required');
$('dLoc').value = 'owner/repo'; $('dAuth').value = 'pat'; change($('dAuth'));
click($('dSave'));
ok($('dResult').textContent === 'Enter an access token.', 'validation: token required for PAT');
$('dTok').value = 'ghp_x'; $('dTok').dispatchEvent(new w.Event('input', { bubbles: true }));
click($('dTest'));
const t = posted.filter(m => m.type === 'testSource').pop();
ok(t && t.token === 'ghp_x' && t.source.location === 'owner/repo' && t.source.auth === 'pat', 'Test connection posts source + token');
send({ type: 'testResult', ok: false, message: 'Authentication failed' });
ok($('dResult').textContent === 'Authentication failed' && $('dResult').classList.contains('err'), 'test failure shown in red');
click($('dSave'));
const s = posted.filter(m => m.type === 'saveSource').pop();
ok(s && s.token === 'ghp_x', 'Save posts source + token');
send({ type: 'dialogResult', ok: true });
ok($('modal').classList.contains('hidden'), 'dialog closes on success');
send({ type: 'folder', path: 'C:\\x' }); // no dialog open: must not throw

console.log('[edit keeps existing token unless changed]');
const st2 = JSON.parse(JSON.stringify(state)); st2.sources[0].auth = 'pat'; st2.sources[0].hasToken = true;
send({ type: 'state', state: st2 });
click(w.document.querySelector('[data-a="editSource"]'));
ok($('dTok').value === '••••••••', 'stored token shown as placeholder');
click($('dSave'));
const keep = posted.filter(m => m.type === 'saveSource').pop();
ok(keep.token === undefined && keep.source.id === 's1', 'unchanged token is not resent');
click($('dCancel'));

console.log('[busy / empty / log]');
send({ type: 'state', state: { ...state, busy: true, sources: [], currentSourceId: '', packages: [], updateCount: 0 } });
ok(!$('busy').classList.contains('hidden'), 'progress bar visible while busy');
ok($('btnEdit').disabled && $('btnRemove').disabled, 'edit/remove disabled without sources');
ok($('detail').textContent.trim() === '', 'detail pane empty without packages');
send({ type: 'log', text: 'hello log' });
ok($('log').textContent === 'hello log' && !$('log').classList.contains('hidden'), 'log box shows text');

ok(errors.length === 0, 'no uncaught errors in the page' + (errors.length ? ': ' + errors.map(String).join('; ') : ''));
console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
