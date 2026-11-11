import { execFileSync } from 'child_process';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, before, after } from 'node:test';
import { parseFrontMatter } from '../src/core/frontmatter';
import { install, resolveLayout, uninstall, InstallEnv } from '../src/core/installer';
import { Host, Manager } from '../src/core/manager';
import { discover } from '../src/core/scanner';
import { RecordStore, annotate, applyUpdate, findUpdates, isUpdateAvailable, recordInstall } from '../src/core/updates';
import { keyOf } from '../src/core/types';

let tmp: string;
let examples: string;   // git repo with 3 plugins, tags v1.3.0 and HEAD = 1.4.0

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });
}

function manifest(name: string, version: string, description: string): string {
  return JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name, version, description, author: { name: 'Tester' }, license: 'MIT', keywords: ['a', 'b'] }, null, 2);
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-test-'));
  examples = path.join(tmp, 'examples');
  const crk = path.join(examples, 'code-review-kit');
  write(path.join(crk, 'plugin.json'), manifest('code-review-kit', '1.3.0', 'Review kit'));
  write(path.join(crk, 'skills', 'review-checklist', 'SKILL.md'), '---\nname: review-checklist\ndescription: Use when reviewing a diff.\n---\n# Review\n1. Correctness\n6. Performance\n');
  write(path.join(crk, 'skills', 'commit-message', 'SKILL.md'), '---\nname: commit-message\ndescription: >\n  Use when asked to write\n  a commit message.\n---\nBody\n');
  write(path.join(crk, 'skills', 'commit-message', 'references', 'c.md'), 'conventions');
  write(path.join(crk, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Read-only reviewer.\n---\nYou review.\n');
  write(path.join(crk, 'prompts', 'explain-code.md'), '---\ndescription: Explain code.\n---\nExplain.\n');

  const mcp = path.join(examples, 'mcp-demo');
  write(path.join(mcp, 'plugin.json'), manifest('mcp-demo', '0.1.0', 'MCP demo'));
  write(path.join(mcp, 'mcp.json'), JSON.stringify({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: {
      'local-echo': { type: 'stdio', command: './server/echo.cmd', args: ['--data', '${PLUGIN_DATA}'], env: { DEMO_TOKEN: 'secret' } },
      'remote-demo': { type: 'streamable-http', url: 'https://example.com/mcp', headers: { 'X-Tenant': 'demo' } },
    },
  }, null, 2));
  write(path.join(mcp, 'server', 'echo.cmd'), '@echo off\n');
  write(path.join(mcp, 'skills', 'using-mcp-demo', 'SKILL.md'), '---\nname: using-mcp-demo\ndescription: Demo.\n---\nx\n');
  write(path.join(mcp, 'com.example.client', 'hooks', 'hooks.json'), '{}');

  git(examples, 'init', '-q', '-b', 'main');
  git(examples, 'add', '-A');
  git(examples, 'commit', '-q', '-m', 'v1.3.0');
  git(examples, 'tag', 'v1.3.0');

  // 1.4.0: changes an installed item, adds a NEW prompt
  write(path.join(crk, 'plugin.json'), manifest('code-review-kit', '1.4.0', 'Review kit with verdicts'));
  write(path.join(crk, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Read-only reviewer.\n---\nYou review.\nFinish with a verdict.\n');
  write(path.join(crk, 'prompts', 'write-tests.md'), '---\ndescription: Write tests.\n---\nTests.\n');
  git(examples, 'add', '-A');
  git(examples, 'commit', '-q', '-m', 'v1.4.0');
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function envFor(root: string): InstallEnv {
  return { home: path.join(root, 'home'), userDir: path.join(root, 'userdir'), userPayloadRoot: path.join(root, 'payload') };
}

// ───────── scanner ─────────

test('front matter: plain, quoted and folded values', () => {
  const fm = parseFrontMatter('---\nname: x\ndescription: >\n  one\n  two\ntitle: "quoted"\n---\nbody');
  assert.strictEqual(fm['description'], 'one two');
  assert.strictEqual(fm['title'], 'quoted');
  assert.deepStrictEqual(parseFrontMatter('no front matter'), {});
});

test('scanner finds packages and every component type', () => {
  const pkgs = discover(examples);
  assert.deepStrictEqual(pkgs.map(p => p.name), ['code-review-kit', 'mcp-demo']);
  const crk = pkgs[0];
  assert.strictEqual(crk.version, '1.4.0');
  assert.strictEqual(crk.author, 'Tester');
  assert.deepStrictEqual(crk.keywords, ['a', 'b']);
  const count = (k: string) => crk.components.filter(c => c.kind === k).length;
  assert.deepStrictEqual([count('skill'), count('agent'), count('prompt')], [2, 1, 2]);
  assert.strictEqual(crk.components.find(c => c.name === 'commit-message')!.description, 'Use when asked to write a commit message.');
  const mcp = pkgs[1];
  assert.strictEqual(mcp.components.filter(c => c.kind === 'mcp').length, 2);
  assert.ok(mcp.components.some(c => c.kind === 'hook' && !c.installable), 'hooks are informational only');
  const echo = mcp.components.find(c => c.name === 'local-echo')!;
  assert.ok(!echo.preview.includes('secret'), 'env values are masked in previews');
});

// ───────── installer / uninstaller ─────────

test('install and uninstall skills, agents, prompts into a repository (Copilot layout)', () => {
  const root = path.join(tmp, 'repo1');
  fs.mkdirSync(root, { recursive: true });
  const env = envFor(root);
  const crk = discover(examples)[0];
  const pick = crk.components.filter(c => ['review-checklist', 'reviewer', 'explain-code'].includes(c.name));
  const res = install({ pkg: crk, components: pick, scope: 'repo', layout: 'copilot', repoRoot: root, overwrite: false, env });
  assert.strictEqual(res.installedComponents.length, 3);
  assert.ok(fs.existsSync(path.join(root, '.github', 'skills', 'review-checklist', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(root, '.github', 'agents', 'reviewer.agent.md')));
  assert.ok(fs.existsSync(path.join(root, '.github', 'prompts', 'explain-code.prompt.md')));
  assert.ok(!fs.existsSync(path.join(root, '.github', 'skills', 'commit-message')), 'unselected items are not installed');

  const again = install({ pkg: crk, components: pick, scope: 'repo', layout: 'copilot', repoRoot: root, overwrite: false, env });
  assert.strictEqual(again.skipped.length, 3, 'existing items are skipped without overwrite');

  const rec = { packageName: crk.name, sourceId: 's', version: '', fingerprint: '', scope: 'repo' as const, repoRoot: root, layout: 'copilot' as const, installedUtc: '',
    components: res.installedComponents.map(c => ({ kind: c.kind, name: c.name })) };
  const un = uninstall(rec, rec.components, env);
  assert.strictEqual(un.removedComponents.length, 3);
  assert.ok(!fs.existsSync(path.join(root, '.github', 'skills', 'review-checklist')));
  assert.ok(!fs.existsSync(path.join(root, '.github', 'agents', 'reviewer.agent.md')));
});

test('MCP servers: type mapping, payload copy, placeholder expansion, uninstall cleanup', () => {
  const root = path.join(tmp, 'repo2');
  fs.mkdirSync(root, { recursive: true });
  const env = envFor(root);
  const mcpPkg = discover(examples)[1];
  const servers = mcpPkg.components.filter(c => c.kind === 'mcp');
  const res = install({ pkg: mcpPkg, components: servers, scope: 'repo', layout: 'copilot', repoRoot: root, overwrite: false, env });
  const file = path.join(root, '.vscode', 'mcp.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(doc.servers['remote-demo'].type, 'http');
  const echo = doc.servers['local-echo'];
  assert.ok(path.isAbsolute(echo.command) && fs.existsSync(echo.command), 'bundled script copied and path resolved');
  assert.ok(!JSON.stringify(echo).includes('${PLUGIN_DATA}'));

  const rec = { packageName: 'mcp-demo', sourceId: 's', version: '', fingerprint: '', scope: 'repo' as const, repoRoot: root, layout: 'copilot' as const, installedUtc: '',
    components: res.installedComponents.map(c => ({ kind: c.kind, name: c.name })) };
  uninstall(rec, rec.components.filter(c => c.name === 'remote-demo'), env);
  assert.ok(fs.existsSync(echo.command), 'payload kept while another server remains');
  rec.components = rec.components.filter(c => c.name !== 'remote-demo');
  const last = uninstall(rec, rec.components, env);
  assert.strictEqual(last.removedComponents.length, 1);
  assert.ok(!fs.existsSync(echo.command), 'payload removed after the last server');
  assert.ok(fs.existsSync(file + '.bak'));
});

test('existing mcp.json that is not valid JSON is left untouched', () => {
  const root = path.join(tmp, 'repo3');
  write(path.join(root, '.vscode', 'mcp.json'), '{ // comment\n "servers": {} }');
  const mcpPkg = discover(examples)[1];
  const res = install({ pkg: mcpPkg, components: mcpPkg.components.filter(c => c.name === 'remote-demo'), scope: 'repo', layout: 'copilot', repoRoot: root, overwrite: false, env: envFor(root) });
  assert.strictEqual(res.installedComponents.length, 0);
  assert.ok(res.skipped[0].includes('cannot parse'));
  assert.ok(fs.readFileSync(path.join(root, '.vscode', 'mcp.json'), 'utf8').includes('// comment'));
});

test('layout paths for each client', () => {
  const env = envFor(tmp);
  const claude = resolveLayout('repo', 'claude', '/r', env);
  assert.strictEqual(claude.mcpSection, 'mcpServers');
  assert.strictEqual(claude.promptsDir, path.join('/r', '.claude', 'commands'));
  const copilotUser = resolveLayout('user', 'copilot', undefined, env);
  assert.strictEqual(copilotUser.mcpFile, path.join(env.userDir, 'mcp.json'));
  assert.strictEqual(copilotUser.promptsDir, path.join(env.userDir, 'prompts'));
  const neutral = resolveLayout('repo', 'agents', '/r', env);
  assert.strictEqual(neutral.agentsDir, undefined);
});

// ───────── updates ─────────

test('version comparison is numeric', () => {
  const up = (a: string, b: string) => isUpdateAvailable(a, '', { version: b }, 'x');
  assert.ok(up('1.9.0', '1.10.0'));
  assert.ok(up('1.0', '1.0.1'));
  assert.ok(!up('1.4.0', '1.4.0'));
  assert.ok(!up('2.0.0', '1.9.9'));
});

test('update flow: detect, apply only installed items, do not add new ones', async () => {
  const dataRoot = path.join(tmp, 'data-upd');
  const store = new RecordStore(dataRoot);
  const root = path.join(tmp, 'repo4');
  fs.mkdirSync(root, { recursive: true });
  const env = envFor(root);

  // install 1.3.0 (checkout of the tag)
  const old = path.join(tmp, 'checkout-1.3.0');
  git(tmp, 'clone', '-q', '--branch', 'v1.3.0', examples, old);
  const oldPkg = discover(old).find(p => p.name === 'code-review-kit')!;
  const res = install({ pkg: oldPkg, components: oldPkg.components.filter(c => c.name === 'reviewer' || c.name === 'review-checklist'), scope: 'repo', layout: 'copilot', repoRoot: root, overwrite: false, env });
  recordInstall(store, oldPkg, 'src1', 'repo', root, 'copilot', res.installedComponents);
  assert.strictEqual(store.load()[0].version, '1.3.0');

  const newPkgs = discover(examples);
  const updates = findUpdates(newPkgs, 'src1', store.load());
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].fromVersion + ' → ' + updates[0].toVersion, 'v1.3.0 → v1.4.0');
  assert.strictEqual(updates[0].components.length, 2, 'only the installed items are targeted');

  annotate(newPkgs, 'src1', store.load());
  const crk = newPkgs.find(p => p.name === 'code-review-kit')!;
  assert.ok(crk.hasUpdate && crk.installedSummary!.startsWith('Installed v1.3.0'));

  applyUpdate(updates[0], store, env);
  assert.ok(fs.readFileSync(path.join(root, '.github', 'agents', 'reviewer.agent.md'), 'utf8').includes('verdict'));
  assert.ok(!fs.existsSync(path.join(root, '.github', 'prompts', 'write-tests.prompt.md')), 'new upstream prompt is not auto-installed');
  assert.strictEqual(store.load()[0].version, '1.4.0');
  assert.strictEqual(findUpdates(newPkgs, 'src1', store.load()).length, 0);
});

// ───────── manager (full flow with a fake host) ─────────

function fakeHost(dataRoot: string, repo: string | undefined, answers: { confirm: boolean } = { confirm: true }): Host {
  const tokens = new Map<string, string>();
  return {
    dataRoot,
    env: envFor(dataRoot),
    confirm: async () => answers.confirm,
    pickFolder: async () => undefined,
    getWorkspaceFolder: () => repo,
    authHeader: async () => undefined,
    getToken: async id => tokens.get(id),
    setToken: async (id, t) => { if (t) { tokens.set(id, t); } else { tokens.delete(id); } },
  };
}

test('manager: add git source at a tag, install, switch to HEAD, update, uninstall', async () => {
  const dataRoot = path.join(tmp, 'data-mgr');
  const repo = path.join(tmp, 'repo5');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const m = new Manager(fakeHost(dataRoot, repo));
  const logs: string[] = [];
  m.onLog = t => logs.push(t);

  const src = await m.saveSource({ name: 'ex', kind: 'git', location: examples, ref: 'v1.3.0', auth: 'none' }, undefined);
  m.setTarget('repo', 'copilot');
  let vs = await m.viewState();
  assert.strictEqual(vs.packages.find(p => p.name === 'code-review-kit')!.version, '1.3.0');
  assert.ok(vs.destination.some(l => l.includes('.github')));

  await m.install([{ pkg: 'code-review-kit', components: [{ kind: 'skill', name: 'review-checklist' }, { kind: 'agent', name: 'reviewer' }] }], false);
  vs = await m.viewState();
  let crk = vs.packages.find(p => p.name === 'code-review-kit')!;
  assert.deepStrictEqual(crk.components.filter(c => c.installedHere).map(c => c.name).sort(), ['reviewer', 'review-checklist'].sort());
  assert.strictEqual(crk.installedHere?.count, 2);

  // new version appears: clear the ref
  await m.saveSource({ id: src.id, name: 'ex', kind: 'git', location: examples, ref: '', auth: 'none' }, undefined);
  vs = await m.viewState();
  crk = vs.packages.find(p => p.name === 'code-review-kit')!;
  assert.ok(crk.hasUpdate, 'update offered');
  assert.strictEqual(vs.updateCount, 1);

  await m.updateAll();
  vs = await m.viewState();
  assert.strictEqual(vs.updateCount, 0);
  assert.ok(fs.readFileSync(path.join(repo, '.github', 'agents', 'reviewer.agent.md'), 'utf8').includes('verdict'));

  await m.uninstall('code-review-kit', [{ kind: 'agent', name: 'reviewer' }]);
  assert.ok(!fs.existsSync(path.join(repo, '.github', 'agents', 'reviewer.agent.md')));
  assert.ok(fs.existsSync(path.join(repo, '.github', 'skills', 'review-checklist')));
  await m.uninstall('code-review-kit', 'all');
  assert.ok(!fs.existsSync(path.join(repo, '.github', 'skills', 'review-checklist')));
  vs = await m.viewState();
  assert.strictEqual(vs.packages.find(p => p.name === 'code-review-kit')!.installedHere, undefined);
  assert.strictEqual(new RecordStore(dataRoot).load().length, 0);
});

test('manager: auto-update applies on load, declined confirmation cancels uninstall', async () => {
  const dataRoot = path.join(tmp, 'data-auto');
  const repo = path.join(tmp, 'repo6');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const answers = { confirm: true };
  const m = new Manager(fakeHost(dataRoot, repo, answers));
  m.onLog = () => { /* ignore */ };

  const src = await m.saveSource({ name: 'ex', kind: 'git', location: examples, ref: 'v1.3.0', auth: 'none' }, undefined);
  m.setTarget('repo', 'claude');
  await m.install([{ pkg: 'code-review-kit', components: [{ kind: 'agent', name: 'reviewer' }] }], false);
  await m.setAutoUpdate(true);
  await m.saveSource({ id: src.id, name: 'ex', kind: 'git', location: examples, ref: '', auth: 'none' }, undefined);
  assert.ok(fs.readFileSync(path.join(repo, '.claude', 'agents', 'reviewer.md'), 'utf8').includes('verdict'), 'auto-update applied on load');
  assert.strictEqual((await m.viewState()).updateCount, 0);

  answers.confirm = false;
  await m.uninstall('code-review-kit', 'all');
  assert.ok(fs.existsSync(path.join(repo, '.claude', 'agents', 'reviewer.md')), 'declined confirmation keeps the files');
});

test('manager: PAT sources require a token and keep it out of settings.json', async () => {
  const dataRoot = path.join(tmp, 'data-pat');
  const m = new Manager(fakeHost(dataRoot, undefined));
  await assert.rejects(() => m.saveSource({ name: 'p', kind: 'git', location: 'owner/repo', ref: '', auth: 'pat' }, undefined), /token/i);
  const settings = fs.readFileSync(path.join(dataRoot, 'settings.json'), 'utf8');
  assert.ok(!/secret-token/.test(settings));
  const hostWithToken = fakeHost(path.join(tmp, 'data-pat2'), undefined);
  const m2 = new Manager(hostWithToken);
  m2.onLog = () => { /* load fails (no network); we only assert persistence */ };
  try { await m2.saveSource({ name: 'p', kind: 'git', location: 'owner/repo', ref: '', auth: 'pat' }, 'secret-token'); } catch { /* ignore */ }
  assert.strictEqual(await hostWithToken.getToken(m2.currentSource!.id), 'secret-token');
  assert.ok(!fs.readFileSync(path.join(tmp, 'data-pat2', 'settings.json'), 'utf8').includes('secret-token'), 'token is never written to settings.json');
});

test('record keys differ per destination', () => {
  const a = keyOf({ packageName: 'p', sourceId: 's', scope: 'user', layout: 'copilot' } as any);
  const b = keyOf({ packageName: 'p', sourceId: 's', scope: 'user', layout: 'claude' } as any);
  const c = keyOf({ packageName: 'p', sourceId: 's', scope: 'repo', repoRoot: '/x', layout: 'copilot' } as any);
  assert.notStrictEqual(a, b);
  assert.notStrictEqual(a, c);
});
