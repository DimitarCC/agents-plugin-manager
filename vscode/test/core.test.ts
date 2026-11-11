import { execFileSync } from 'child_process';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, before, after } from 'node:test';
import { parseFrontMatter } from '../src/core/frontmatter';
import { canonicalJson } from '../src/core/hash';
import { install, presenceOf, resolveLayout, uninstall, InstallEnv } from '../src/core/installer';
import { LockStore } from '../src/core/lockstore';
import { Host, Manager } from '../src/core/manager';
import { discover } from '../src/core/scanner';
import { sourceKey } from '../src/core/sourcekey';
import {
  annotate, applyUpdate, findUpdates, fingerprint, isUpdateAvailable, recordInstall, sourceInfoOf, trackPresent, untrackedPresence,
} from '../src/core/updates';
import { InstallRecord, PluginComponent, PluginPackage, PluginSource, keyOf } from '../src/core/types';

let tmp: string;
let examples: string;   // git repo with 2 plugins, tag v1.3.0 and HEAD = 1.4.0
const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'shared', 'test-vectors.json'), 'utf8'));
const sharedRoot = path.join(__dirname, '..', '..', '..', 'shared');

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

const SRC: PluginSource = { id: 'src1', name: 'ex', kind: 'git', location: 'https://github.com/Owner/Repo.git', ref: '', auth: 'none' };

// ───────── shared vectors (identical expectations in the Visual Studio edition) ─────────

test('shared vectors: source keys', () => {
  for (const v of vectors.sourceKeys) {
    assert.strictEqual(sourceKey({ kind: v.kind, location: v.input }), v.key, `${v.kind} ${v.input}`);
  }
});

test('shared vectors: canonical JSON', () => {
  for (const v of vectors.canonicalJson) {
    assert.strictEqual(canonicalJson(v.input), v.output);
  }
});

function fixturePackage(): { pkg: PluginPackage; comps: PluginComponent[] } {
  const f = vectors.fixture;
  const comps: PluginComponent[] = f.components.map((c: any): PluginComponent => ({
    kind: c.kind, name: c.name, description: '', relativePath: c.path ?? '', isDirectory: !!c.isDirectory, installable: true, preview: '', mcp: c.definition,
  }));
  const pkg: PluginPackage = {
    name: 'sample', version: '1.0.0', description: '', author: '', homepage: '', license: '', keywords: [],
    rootPath: path.join(sharedRoot, '..', f.folder), hasManifest: false, components: comps, warnings: [],
  };
  return { pkg, comps };
}

test('shared vectors: fingerprint of the sample plugin', () => {
  const { pkg, comps } = fixturePackage();
  assert.strictEqual(fingerprint(pkg, comps), vectors.fixture.fingerprint);
  // order of components must not matter
  assert.strictEqual(fingerprint(pkg, [...comps].reverse()), vectors.fixture.fingerprint);
});

// ───────── client namespace folders (com.github.copilot/agents, …) ─────────

test('shared vectors: scanning the sample plugin finds portable items and client namespace items', () => {
  const pkg = discover(path.join(sharedRoot, 'fixtures', 'sample-plugin'))[0];
  const actual = pkg.components.filter(c => c.kind !== 'hook')
    .map(c => `${c.kind}:${c.name}:${c.relativePath}:${c.client ?? ''}:${c.installable}`).sort();
  const expected = vectors.scan.components
    .map((c: any) => `${c.kind}:${c.name}:${c.path}:${c.client ?? ''}:${c.installable}`).sort();
  assert.deepStrictEqual(actual, expected);
  assert.ok(pkg.warnings.some(w => w.includes('com.example.client') && w.includes('not recognised')), 'unknown client namespace is reported');
});

function sampleInstall(layout: 'copilot' | 'claude' | 'agents', scope: 'repo' | 'user', root: string) {
  const pkg = discover(path.join(sharedRoot, 'fixtures', 'sample-plugin'))[0];
  const env = { ...envFor(root), home: path.join(root, 'home') };
  const comps = pkg.components.filter(c => c.installable);
  return { pkg, env, res: install({ pkg, components: comps, scope, layout, repoRoot: root, overwrite: false, env }), root };
}

test('namespace items install only for their own client; rules go to the client-specific folder', () => {
  const rc = path.join(tmp, 'ns-copilot');
  fs.mkdirSync(rc, { recursive: true });
  const copilot = sampleInstall('copilot', 'repo', rc);
  assert.ok(fs.existsSync(path.join(rc, '.github', 'agents', 'pilot.agent.md')), 'Copilot agent from com.github.copilot/agents');
  assert.ok(fs.existsSync(path.join(rc, '.github', 'instructions', 'style.instructions.md')), 'Copilot rule becomes .github/instructions/*.instructions.md');
  assert.ok(fs.existsSync(path.join(rc, '.github', 'agents', 'helper.agent.md')), 'portable agent installs too');
  assert.ok(!fs.existsSync(path.join(rc, '.claude')), 'nothing Claude-specific is written');
  const skipped = copilot.res.skipped.join('\n');
  assert.ok(skipped.includes('ship') && skipped.includes('tone') && skipped.includes('made for Claude Code'), 'Claude items are skipped with an explanation');

  const rk = path.join(tmp, 'ns-claude');
  fs.mkdirSync(rk, { recursive: true });
  const claude = sampleInstall('claude', 'repo', rk);
  assert.ok(fs.existsSync(path.join(rk, '.claude', 'commands', 'ship.md')), 'Claude command from com.anthropic.claude/commands');
  assert.ok(fs.existsSync(path.join(rk, '.claude', 'rules', 'tone.md')), 'Claude rule goes to .claude/rules');
  assert.ok(!fs.existsSync(path.join(rk, '.github')), 'nothing Copilot-specific is written');
  assert.ok(claude.res.skipped.join('\n').includes('made for GitHub Copilot'));

  const ra = path.join(tmp, 'ns-agents');
  fs.mkdirSync(ra, { recursive: true });
  const neutral = sampleInstall('agents', 'repo', ra);
  assert.deepStrictEqual(fs.readdirSync(path.join(ra, '.agents', 'skills')), ['alpha'], 'agent-neutral layout only takes skills');
  assert.ok(neutral.res.installedComponents.every(c => c.kind === 'skill'));

  // user scope (VS Code: rules live in the profile prompts folder)
  const ru = path.join(tmp, 'ns-user');
  fs.mkdirSync(ru, { recursive: true });
  const user = sampleInstall('copilot', 'user', ru);
  assert.ok(fs.existsSync(path.join(user.env.userDir, 'prompts', 'style.instructions.md')));

  // presence ignores items made for another client; uninstall removes rules
  const style = copilot.pkg.components.find(c => c.name === 'style')!;
  const tone = copilot.pkg.components.find(c => c.name === 'tone')!;
  assert.strictEqual(presenceOf(copilot.pkg, style, 'repo', 'copilot', rc, copilot.env), 'same');
  assert.strictEqual(presenceOf(copilot.pkg, tone, 'repo', 'copilot', rc, copilot.env), '', 'Claude rule is not "present" for Copilot');
  const rec = { packageName: 'p', sourceKey: 's', sourceKind: 'git', sourceLocation: '', ref: '', version: '', fingerprint: '', scope: 'repo' as const, repoRoot: rc, layout: 'copilot' as const, installedUtc: '', installedBy: '',
    components: [{ kind: 'rule' as const, name: 'style' }] } as InstallRecord;
  assert.strictEqual(uninstall(rec, rec.components, copilot.env).removedComponents.length, 1);
  assert.ok(!fs.existsSync(path.join(rc, '.github', 'instructions', 'style.instructions.md')));
});

test('unknown client namespaces are listed but never installed', () => {
  const pkg = discover(path.join(sharedRoot, 'fixtures', 'sample-plugin'))[0];
  const odd = pkg.components.find(c => c.name === 'odd')!;
  assert.strictEqual(odd.installable, false);
  const root = path.join(tmp, 'ns-odd');
  fs.mkdirSync(root, { recursive: true });
  const res = install({ pkg, components: [odd], scope: 'repo', layout: 'copilot', repoRoot: root, overwrite: false, env: envFor(root) });
  assert.strictEqual(res.installedComponents.length, 0);
});

test('duplicate names between portable and namespace folders are reported once', () => {
  const dir = path.join(tmp, 'dup-plugin');
  write(path.join(dir, 'plugin.json'), manifest('dup', '1.0.0', 'x'));
  write(path.join(dir, 'agents', 'same.md'), '---\ndescription: portable\n---\n');
  write(path.join(dir, 'com.github.copilot', 'agents', 'same.md'), '---\ndescription: copilot\n---\n');
  const pkg = discover(dir)[0];
  assert.strictEqual(pkg.components.filter(c => c.name === 'same').length, 1);
  assert.ok(pkg.warnings.some(w => w.includes('more than once')));
});

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

  // identical items already there: tracked again instead of skipped
  const again = install({ pkg: crk, components: pick, scope: 'repo', layout: 'copilot', repoRoot: root, overwrite: false, env });
  assert.strictEqual(again.skipped.length, 0);
  assert.strictEqual(again.installedComponents.length, 3);
  assert.ok(again.installed[0].includes('already up to date'));

  // a modified item is skipped, with an explanation
  fs.appendFileSync(path.join(root, '.github', 'agents', 'reviewer.agent.md'), 'local edit\n');
  const third = install({ pkg: crk, components: pick, scope: 'repo', layout: 'copilot', repoRoot: root, overwrite: false, env });
  assert.strictEqual(third.skipped.length, 1);
  assert.ok(third.skipped[0].includes('differs'));

  const rec = { packageName: crk.name, sourceKey: 's', sourceKind: 'git', sourceLocation: '', ref: '', version: '', fingerprint: '', scope: 'repo' as const, repoRoot: root, layout: 'copilot' as const, installedUtc: '', installedBy: '',
    components: res.installedComponents.map(c => ({ kind: c.kind, name: c.name })) } as InstallRecord;
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

  const rec = { packageName: 'mcp-demo', sourceKey: 's', sourceKind: 'git', sourceLocation: '', ref: '', version: '', fingerprint: '', scope: 'repo' as const, repoRoot: root, layout: 'copilot' as const, installedUtc: '', installedBy: '',
    components: res.installedComponents.map(c => ({ kind: c.kind, name: c.name })) } as InstallRecord;
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

// ───────── lock file ─────────

test('lock file: location, format, ordering, LF endings, deleted when empty', () => {
  const home = path.join(tmp, 'lock-home');
  const repo = path.join(tmp, 'lock-repo');
  fs.mkdirSync(repo, { recursive: true });
  const lock = new LockStore(home, path.join(tmp, 'lock-data'), 'vscode 9.9.9');
  const base = { sourceKey: 'github.com/o/r', sourceKind: 'git' as const, sourceLocation: 'o/r', ref: '', version: '1.0.0', fingerprint: 'fp', installedUtc: '2026-01-01T00:00:00.000Z', installedBy: 'vscode 9.9.9' };
  lock.upsert({ ...base, packageName: 'zeta', scope: 'repo', repoRoot: repo, layout: 'copilot', components: [{ kind: 'skill', name: 'a' }] });
  lock.upsert({ ...base, packageName: 'alpha', scope: 'repo', repoRoot: repo, layout: 'claude', components: [{ kind: 'agent', name: 'b' }] });
  lock.upsert({ ...base, packageName: 'alpha', scope: 'repo', repoRoot: repo, layout: 'copilot', components: [{ kind: 'mcp', name: 'm' }] });
  const file = path.join(repo, '.agents', 'plugin-lock.json');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes('\r'), 'LF line endings');
  assert.ok(text.endsWith('}\n'));
  const doc = JSON.parse(text);
  assert.strictEqual(doc.version, 1);
  assert.deepStrictEqual(doc.installs.map((i: any) => i.package + '/' + i.layout), ['alpha/claude', 'alpha/copilot', 'zeta/copilot']);
  assert.deepStrictEqual(Object.keys(doc.installs[0]), ['package', 'source', 'sourceKind', 'sourceLocation', 'ref', 'version', 'fingerprint', 'layout', 'components', 'installedAt', 'installedBy']);

  lock.upsert({ ...base, packageName: 'user-pkg', scope: 'user', layout: 'agents', components: [{ kind: 'skill', name: 's' }] });
  assert.ok(fs.existsSync(path.join(home, '.agents', 'plugin-lock.json')), 'user scope lives under ~/.agents');

  for (const r of lock.load('repo', repo)) { lock.removeComponents(r, r.components); }
  assert.ok(!fs.existsSync(file), 'file removed when the last entry goes');
});

test('lock file: the shared golden file (written by TypeScript, also tested by C#) round-trips byte for byte', () => {
  const golden = fs.readFileSync(path.join(sharedRoot, 'fixtures', 'plugin-lock.sample.json'), 'utf8').replace(/\r\n/g, '\n');
  const repo = path.join(tmp, 'golden-repo');
  write(path.join(repo, '.agents', 'plugin-lock.json'), golden);
  const lock = new LockStore(path.join(tmp, 'golden-home'), path.join(tmp, 'golden-data'), 'vscode 1.1.0');
  const records = lock.load('repo', repo);
  assert.strictEqual(records.length, 3);
  assert.strictEqual(records[2].sourceLocation, 'E:\\Plugins\\café');
  assert.strictEqual(records[2].components[0].kind, 'mcp');
  lock.upsert(records[0]);   // rewrite an unchanged record: the file must not change
  assert.strictEqual(fs.readFileSync(path.join(repo, '.agents', 'plugin-lock.json'), 'utf8'), golden);
});

test('lock file: another edition (different data folder and tool) sees and updates the same records', () => {
  const home = path.join(tmp, 'share-home');
  const repo = path.join(tmp, 'share-repo');
  fs.mkdirSync(repo, { recursive: true });
  const env = { ...envFor(tmp), home };
  const lockVs = new LockStore(home, path.join(tmp, 'vs-data'), 'visual-studio 1.1.0');
  const lockCode = new LockStore(home, path.join(tmp, 'code-data'), 'vscode 1.1.0');

  const old = path.join(tmp, 'share-checkout');
  git(tmp, 'clone', '-q', '--branch', 'v1.3.0', examples, old);
  const oldPkg = discover(old).find(p => p.name === 'code-review-kit')!;
  const info = sourceInfoOf({ ...SRC, kind: 'local', location: examples });
  const res = install({ pkg: oldPkg, components: oldPkg.components.filter(c => c.name === 'reviewer'), scope: 'repo', layout: 'copilot', repoRoot: repo, overwrite: false, env });
  recordInstall(lockVs, oldPkg, info, 'repo', repo, 'copilot', res.installedComponents);   // "Visual Studio" installs

  const seen = lockCode.loadAll(repo);                                                        // "VS Code" looks
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].installedBy, 'visual-studio 1.1.0');
  assert.strictEqual(seen[0].version, '1.3.0');

  const newPkgs = discover(examples);
  const ups = findUpdates(newPkgs, info.key, seen);
  assert.strictEqual(ups.length, 1);
  applyUpdate(ups[0], lockCode, env);                                                         // "VS Code" updates

  const after = lockVs.loadAll(repo);                                                         // "Visual Studio" looks again
  assert.strictEqual(after[0].version, '1.4.0');
  assert.strictEqual(after[0].installedBy, 'vscode 1.1.0');
  assert.strictEqual(findUpdates(newPkgs, info.key, after).length, 0, 'no stale update offered to the other edition');
});

test('lock file: records are matched by source key, not by how the source was typed', () => {
  const a = sourceKey({ kind: 'git', location: 'https://github.com/Owner/Repo.git' });
  const b = sourceKey({ kind: 'git', location: 'owner/repo' });
  assert.strictEqual(a, b);
});

test('lock file: legacy per-tool records are migrated once', () => {
  const home = path.join(tmp, 'mig-home');
  const repo = path.join(tmp, 'mig-repo');
  const data = path.join(tmp, 'mig-data');
  fs.mkdirSync(repo, { recursive: true });
  write(path.join(data, 'installed.json'), JSON.stringify([
    { packageName: 'p', sourceId: 'src1', version: '2.0.0', fingerprint: 'f', scope: 'repo', repoRoot: repo, layout: 'claude', components: [{ kind: 'skill', name: 's' }], installedUtc: '2026-01-01T00:00:00.000Z' },
    { packageName: 'u', sourceId: 'src1', version: '1.0.0', fingerprint: 'f', scope: 'user', layout: 'copilot', components: [{ kind: 'agent', name: 'a' }], installedUtc: '2026-01-02T00:00:00.000Z' },
    { packageName: 'orphan', sourceId: 'unknown', version: '1', fingerprint: '', scope: 'user', layout: 'copilot', components: [{ kind: 'skill', name: 'x' }], installedUtc: '' },
  ]));
  const lock = new LockStore(home, data, 'vscode 1.1.0');
  assert.strictEqual(lock.migrateLegacy([SRC]), 2);
  assert.strictEqual(lock.load('repo', repo)[0].sourceKey, 'github.com/owner/repo');
  assert.strictEqual(lock.load('user')[0].packageName, 'u');
  assert.ok(fs.existsSync(path.join(data, 'installed.json.migrated')) && !fs.existsSync(path.join(data, 'installed.json')));
  assert.strictEqual(lock.migrateLegacy([SRC]), 0, 'second run does nothing');
});

// ───────── updates ─────────

test('version comparison is numeric', () => {
  const up = (a: string, b: string) => isUpdateAvailable(a, '', { version: b }, 'x');
  assert.ok(up('1.9.0', '1.10.0'));
  assert.ok(up('1.0', '1.0.1'));
  assert.ok(!up('1.4.0', '1.4.0'));
  assert.ok(!up('2.0.0', '1.9.9'));
  assert.ok(up('', '1.0.0'), 'unknown installed version is offered the update');
});

test('update flow: detect, apply only installed items, do not add new ones', () => {
  const root = path.join(tmp, 'repo4');
  fs.mkdirSync(root, { recursive: true });
  const env = { ...envFor(root), home: path.join(root, 'home') };
  const lock = new LockStore(env.home, path.join(tmp, 'data-upd'), 'vscode 1.1.0');
  const info = sourceInfoOf({ ...SRC, kind: 'local', location: examples });

  const old = path.join(tmp, 'checkout-1.3.0');
  git(tmp, 'clone', '-q', '--branch', 'v1.3.0', examples, old);
  const oldPkg = discover(old).find(p => p.name === 'code-review-kit')!;
  const res = install({ pkg: oldPkg, components: oldPkg.components.filter(c => c.name === 'reviewer' || c.name === 'review-checklist'), scope: 'repo', layout: 'copilot', repoRoot: root, overwrite: false, env });
  recordInstall(lock, oldPkg, info, 'repo', root, 'copilot', res.installedComponents);
  assert.strictEqual(lock.load('repo', root)[0].version, '1.3.0');

  const newPkgs = discover(examples);
  const updates = findUpdates(newPkgs, info.key, lock.load('repo', root));
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].fromVersion + ' → ' + updates[0].toVersion, 'v1.3.0 → v1.4.0');
  assert.strictEqual(updates[0].components.length, 2, 'only the installed items are targeted');

  annotate(newPkgs, info.key, lock.load('repo', root));
  const crk = newPkgs.find(p => p.name === 'code-review-kit')!;
  assert.ok(crk.hasUpdate && crk.installedSummary!.startsWith('Installed v1.3.0'));

  applyUpdate(updates[0], lock, env);
  assert.ok(fs.readFileSync(path.join(root, '.github', 'agents', 'reviewer.agent.md'), 'utf8').includes('verdict'));
  assert.ok(!fs.existsSync(path.join(root, '.github', 'prompts', 'write-tests.prompt.md')), 'new upstream prompt is not auto-installed');
  assert.strictEqual(lock.load('repo', root)[0].version, '1.4.0');
  assert.strictEqual(findUpdates(newPkgs, info.key, lock.load('repo', root)).length, 0);
});

// ───────── present but not tracked ─────────

test('presence: untracked items are detected as identical / different / present, and can be tracked', () => {
  const root = path.join(tmp, 'repo-presence');
  fs.mkdirSync(root, { recursive: true });
  const env = { ...envFor(root), home: path.join(root, 'home') };
  const lock = new LockStore(env.home, path.join(tmp, 'data-presence'), 'visual-studio 1.1.0');
  const pkgs = discover(examples);
  const crk = pkgs.find(p => p.name === 'code-review-kit')!;
  const info = sourceInfoOf({ ...SRC, kind: 'local', location: examples });

  // somebody copied things in by hand (or another tool without a lock file)
  fs.cpSync(path.join(crk.rootPath, 'skills', 'review-checklist'), path.join(root, '.github', 'skills', 'review-checklist'), { recursive: true });
  write(path.join(root, '.github', 'agents', 'reviewer.agent.md'), 'my own reviewer\n');

  const found = untrackedPresence(crk, undefined, 'repo', 'copilot', root, env);
  assert.deepStrictEqual(found.map(f => `${f.name}:${f.state}`).sort(), ['review-checklist:same', 'reviewer:differs']);
  assert.ok(!found.some(f => f.name === 'commit-message'), 'absent items are not reported');

  const n = trackPresent(lock, crk, info, 'repo', root, 'copilot', env);
  assert.strictEqual(n, 2);
  const rec = lock.load('repo', root)[0];
  assert.strictEqual(rec.version, '', 'differing items are recorded without a version so the next update replaces them');
  assert.strictEqual(rec.installedBy, 'visual-studio 1.1.0');
  assert.strictEqual(untrackedPresence(crk, rec, 'repo', 'copilot', root, env).length, 0, 'tracked items are no longer "untracked"');

  const ups = findUpdates(pkgs, info.key, lock.load('repo', root));
  assert.strictEqual(ups.length, 1, 'update offered to bring the different item in line');
  applyUpdate(ups[0], lock, env);
  assert.ok(fs.readFileSync(path.join(root, '.github', 'agents', 'reviewer.agent.md'), 'utf8').includes('verdict'));
  assert.strictEqual(lock.load('repo', root)[0].version, '1.4.0');
});

test('presence: MCP servers are reported as present', () => {
  const root = path.join(tmp, 'repo-presence-mcp');
  write(path.join(root, '.vscode', 'mcp.json'), JSON.stringify({ servers: { 'remote-demo': { type: 'http', url: 'x' } } }));
  const mcp = discover(examples).find(p => p.name === 'mcp-demo')!;
  const found = untrackedPresence(mcp, undefined, 'repo', 'copilot', root, envFor(root));
  assert.deepStrictEqual(found.map(f => `${f.name}:${f.state}`), ['remote-demo:present']);
});

// ───────── manager (full flow with a fake host) ─────────

function fakeHost(dataRoot: string, repo: string | undefined, home: string, tool: string, answers: { confirm: boolean } = { confirm: true }): Host {
  const tokens = new Map<string, string>();
  return {
    dataRoot,
    env: { ...envFor(dataRoot), home },
    toolName: tool,
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
  const m = new Manager(fakeHost(dataRoot, repo, path.join(tmp, 'home5'), 'vscode 1.1.0'));
  m.onLog = () => { /* ignore */ };

  const src = await m.saveSource({ name: 'ex', kind: 'git', location: examples, ref: 'v1.3.0', auth: 'none' }, undefined);
  m.setTarget('repo', 'copilot');
  let vs = await m.viewState();
  assert.strictEqual(vs.packages.find(p => p.name === 'code-review-kit')!.version, '1.3.0');
  assert.ok(vs.destination.some(l => l.includes('.github')));
  assert.ok(vs.destination.some(l => l.startsWith('lock') && l.includes('plugin-lock.json')));

  await m.install([{ pkg: 'code-review-kit', components: [{ kind: 'skill', name: 'review-checklist' }, { kind: 'agent', name: 'reviewer' }] }], false);
  assert.ok(fs.existsSync(path.join(repo, '.agents', 'plugin-lock.json')), 'lock file written into the repository');
  vs = await m.viewState();
  let crk = vs.packages.find(p => p.name === 'code-review-kit')!;
  assert.deepStrictEqual(crk.components.filter(c => c.installedHere).map(c => c.name).sort(), ['reviewer', 'review-checklist'].sort());
  assert.strictEqual(crk.installedHere?.count, 2);
  assert.strictEqual(crk.installedHere?.installedBy, 'vscode 1.1.0');

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
  assert.ok(!fs.existsSync(path.join(repo, '.agents', 'plugin-lock.json')), 'lock file removed with the last item');
});

test('manager: a second manager (other edition) sees what the first installed, and track picks up manual copies', async () => {
  const repo = path.join(tmp, 'repo-two');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const home = path.join(tmp, 'home-two');

  const a = new Manager(fakeHost(path.join(tmp, 'data-a'), repo, home, 'visual-studio 1.1.0'));
  a.onLog = () => { /* ignore */ };
  await a.saveSource({ name: 'ex', kind: 'local', location: examples, ref: '', auth: 'none' }, undefined);
  a.setTarget('repo', 'claude');
  await a.install([{ pkg: 'code-review-kit', components: [{ kind: 'skill', name: 'review-checklist' }] }], false);

  // the other edition: separate data folder, same sources by address (added independently, different id)
  const b = new Manager(fakeHost(path.join(tmp, 'data-b'), repo, home, 'vscode 1.1.0'));
  const logs: string[] = [];
  b.onLog = t => logs.push(t);
  await b.saveSource({ name: 'same folder, typed differently', kind: 'local', location: examples + path.sep, ref: '', auth: 'none' }, undefined);
  b.setTarget('repo', 'claude');
  let vs = await b.viewState();
  let crk = vs.packages.find(p => p.name === 'code-review-kit')!;
  assert.ok(crk.installedHere, 'second edition sees the first edition\'s install');
  assert.strictEqual(crk.installedHere!.installedBy, 'visual-studio 1.1.0');
  assert.ok(crk.components.find(c => c.name === 'review-checklist')!.installedHere);

  // something copied in by hand: presence + track
  fs.cpSync(path.join(repo, '.claude', 'skills', 'review-checklist'), path.join(repo, '.claude', 'skills', 'commit-message'), { recursive: true });
  assert.deepStrictEqual(b.presence('code-review-kit').map(p => p.name), ['commit-message']);   // differs from the package's commit-message
  assert.strictEqual(b.presence('code-review-kit')[0].state, 'differs');
  await b.track('code-review-kit');
  assert.deepStrictEqual(b.presence('code-review-kit'), []);
  vs = await b.viewState();
  crk = vs.packages.find(p => p.name === 'code-review-kit')!;
  assert.strictEqual(crk.installedHere!.count, 2);
  assert.strictEqual(crk.installedHere!.installedBy, 'vscode 1.1.0');
});

test('manager: auto-update applies on load, declined confirmation cancels uninstall', async () => {
  const repo = path.join(tmp, 'repo6');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const answers = { confirm: true };
  const m = new Manager(fakeHost(path.join(tmp, 'data-auto'), repo, path.join(tmp, 'home6'), 'vscode 1.1.0', answers));
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
  const m = new Manager(fakeHost(dataRoot, undefined, path.join(tmp, 'home-pat'), 'vscode 1.1.0'));
  await assert.rejects(() => m.saveSource({ name: 'p', kind: 'git', location: 'owner/repo', ref: '', auth: 'pat' }, undefined), /token/i);
  const hostWithToken = fakeHost(path.join(tmp, 'data-pat2'), undefined, path.join(tmp, 'home-pat2'), 'vscode 1.1.0');
  const m2 = new Manager(hostWithToken);
  m2.onLog = () => { /* load fails (no network); we only assert persistence */ };
  try { await m2.saveSource({ name: 'p', kind: 'git', location: 'owner/repo', ref: '', auth: 'pat' }, 'secret-token'); } catch { /* ignore */ }
  assert.strictEqual(await hostWithToken.getToken(m2.currentSource!.id), 'secret-token');
  assert.ok(!fs.readFileSync(path.join(tmp, 'data-pat2', 'settings.json'), 'utf8').includes('secret-token'), 'token is never written to settings.json');
});

test('record keys differ per destination', () => {
  const base = { packageName: 'p', sourceKey: 's' } as any;
  const a = keyOf({ ...base, scope: 'user', layout: 'copilot' });
  const b = keyOf({ ...base, scope: 'user', layout: 'claude' });
  const c = keyOf({ ...base, scope: 'repo', repoRoot: '/x', layout: 'copilot' });
  assert.notStrictEqual(a, b);
  assert.notStrictEqual(a, c);
});
