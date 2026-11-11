import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ensureDir, exists, forceDelete } from './fsutil';
import { PluginSource } from './types';

export class GitError extends Error { }

export interface SyncContext {
  cacheRoot: string;
  /**
   * Full HTTP header ("Authorization: Basic …" / "Bearer …") to send to the git host.
   * Passed to git through the environment so it never appears on a command line.
   */
  authHeader?: string;
  /** Allow Git Credential Manager to open its sign-in window (single sign-on mode only). */
  interactive: boolean;
  progress?: (message: string) => void;
  signal?: AbortSignal;
}

const SHORTHAND = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function normalizeGitUrl(location: string): string {
  const l = location.trim();
  if (SHORTHAND.test(l) && !exists(l)) {
    return 'https://github.com/' + l + (l.toLowerCase().endsWith('.git') ? '' : '.git');
  }
  return l;
}

function hash(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex').substring(0, 16);
}

/** Returns the local folder that holds the source's files (cloning / updating if needed). */
export async function syncSource(source: PluginSource, ctx: SyncContext): Promise<string> {
  if (source.kind === 'local') {
    if (!fs.existsSync(source.location) || !fs.statSync(source.location).isDirectory()) {
      throw new GitError('Folder not found: ' + source.location);
    }
    return source.location;
  }

  const url = normalizeGitUrl(source.location);
  const dir = path.join(ctx.cacheRoot, hash(url + '|' + source.ref));
  ensureDir(ctx.cacheRoot);
  const git = new GitRunner(source, url, ctx);

  if (exists(path.join(dir, '.git'))) {
    ctx.progress?.('Updating ' + (source.name || url) + '…');
    const target = source.ref.trim() === '' ? 'HEAD' : source.ref.trim();
    await git.run(['-C', dir, 'fetch', '--depth', '1', 'origin', target]);
    await git.run(['-C', dir, 'reset', '--hard', 'FETCH_HEAD']);
    await git.run(['-C', dir, 'clean', '-fdx']);
    return dir;
  }

  if (exists(dir)) {
    forceDelete(dir);
  }
  ctx.progress?.('Cloning ' + (source.name || url) + ' (sign-in may open a window)…');
  if (source.ref.trim() === '') {
    await git.run(['clone', '--depth', '1', '--', url, dir]);
  } else {
    try {
      await git.run(['clone', '--depth', '1', '--branch', source.ref.trim(), '--', url, dir]);
    } catch (ex) {
      if (ex instanceof GitError && /abort/i.test(ex.message)) {
        throw ex;
      }
      // Ref may be a commit SHA: clone the default branch, then fetch the ref explicitly.
      if (exists(dir)) {
        forceDelete(dir);
      }
      await git.run(['clone', '--depth', '1', '--', url, dir]);
      await git.run(['-C', dir, 'fetch', '--depth', '1', 'origin', source.ref.trim()]);
      await git.run(['-C', dir, 'checkout', '--detach', 'FETCH_HEAD']);
    }
  }
  return dir;
}

/** Cheap connectivity/auth check (also triggers interactive sign-in once). */
export async function testSource(source: PluginSource, ctx: SyncContext): Promise<void> {
  if (source.kind === 'local') {
    if (!fs.existsSync(source.location)) {
      throw new GitError('Folder not found.');
    }
    return;
  }
  const url = normalizeGitUrl(source.location);
  await new GitRunner(source, url, ctx).run(['ls-remote', '--exit-code', '--', url, 'HEAD']);
}

class GitRunner {
  private readonly uri?: URL;

  constructor(private readonly source: PluginSource, url: string, private readonly ctx: SyncContext) {
    try {
      this.uri = new URL(url);
    } catch {
      this.uri = undefined;
    }
  }

  run(args: string[]): Promise<void> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // No terminal exists: never let git wait on a prompt.
    env.GIT_TERMINAL_PROMPT = '0';
    env.GCM_INTERACTIVE = this.ctx.interactive && this.source.auth === 'sso' ? 'true' : 'false';

    if (this.ctx.authHeader && this.uri) {
      env.GIT_CONFIG_COUNT = '2';
      env.GIT_CONFIG_KEY_0 = `http.${this.uri.origin}/.extraheader`;
      env.GIT_CONFIG_VALUE_0 = this.ctx.authHeader;
      env.GIT_CONFIG_KEY_1 = 'credential.helper';
      env.GIT_CONFIG_VALUE_1 = '';
    }

    return new Promise<void>((resolve, reject) => {
      if (this.ctx.signal?.aborted) {
        reject(new GitError('Aborted'));
        return;
      }
      const child = spawn(findGit(), args, { env, windowsHide: true });
      let err = '';
      child.stderr.on('data', d => { err += d.toString(); });
      child.stdout.on('data', () => { /* drain */ });
      const onAbort = () => { try { child.kill(); } catch { /* ignore */ } };
      this.ctx.signal?.addEventListener('abort', onAbort);
      child.on('error', e => {
        this.ctx.signal?.removeEventListener('abort', onAbort);
        reject(new GitError('Could not start git (' + e.message + '). Install Git and make sure it is on your PATH.'));
      });
      child.on('close', code => {
        this.ctx.signal?.removeEventListener('abort', onAbort);
        if (this.ctx.signal?.aborted) {
          reject(new GitError('Aborted'));
        } else if (code === 0) {
          resolve();
        } else {
          reject(new GitError(friendly(err.trim())));
        }
      });
    });
  }
}

function friendly(text: string): string {
  if (/SAML|SSO/i.test(text)) {
    return text + "\n\nThe organization enforces SSO: choose 'Single sign-on' or 'Sign in with VS Code', or authorize your token for the organization (GitHub: Settings › Tokens › Configure SSO).";
  }
  if (/Authentication failed|could not read Username|terminal prompts disabled/i.test(text)) {
    return text + "\n\nAuthentication required. Use 'Single sign-on', 'Sign in with VS Code' or provide a personal access token.";
  }
  return text.length === 0 ? 'git failed.' : text;
}

let cachedGit: string | undefined;
function findGit(): string {
  if (cachedGit) {
    return cachedGit;
  }
  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Git', 'cmd', 'git.exe'),
      path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'cmd', 'git.exe'),
      path.join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'Git', 'cmd', 'git.exe'),
    ];
    // Prefer git on PATH; these are fallbacks.
    const onPath = (process.env['PATH'] ?? '').split(path.delimiter).map(d => path.join(d.trim(), 'git.exe')).find(exists);
    cachedGit = onPath ?? candidates.find(exists) ?? 'git';
  } else {
    cachedGit = 'git';
  }
  return cachedGit;
}

/** Builds the "Authorization" header value for a token, depending on the git host. */
export function basicAuthHeader(location: string, token: string): string | undefined {
  let host = '';
  try {
    host = new URL(normalizeGitUrl(location)).host.toLowerCase();
  } catch {
    return undefined;
  }
  const azure = host.endsWith('dev.azure.com') || host.endsWith('.visualstudio.com');
  const user = azure ? '' : 'x-access-token';
  return 'Authorization: Basic ' + Buffer.from(user + ':' + token).toString('base64');
}

export function bearerAuthHeader(token: string): string {
  return 'Authorization: Bearer ' + token;
}

export function hostOf(location: string): string {
  try {
    return new URL(normalizeGitUrl(location)).host.toLowerCase();
  } catch {
    return '';
  }
}
