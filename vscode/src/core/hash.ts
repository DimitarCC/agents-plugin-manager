import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// See docs/plugin-lock.md ("Fingerprint"). The Visual Studio edition implements the same algorithm.

export function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** base64(sha1(bytes with 0x0D removed)), so CRLF and LF checkouts hash the same. */
export function fileHash(file: string): string {
  const bytes = fs.readFileSync(file).filter(b => b !== 13);
  return crypto.createHash('sha1').update(bytes).digest('base64');
}

function listFiles(dir: string, rel: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name !== '.git') {
        listFiles(path.join(dir, e.name), rel + '/' + e.name, out);
      }
    } else if (e.isFile()) {
      out.push(rel + '/' + e.name);
    }
  }
}

/** The content block of a skill folder (one line per file) or a single agent/prompt file. Empty when missing. */
export function contentBlock(target: string, isDirectory: boolean): string {
  if (!fs.existsSync(target)) {
    return '';
  }
  if (!isDirectory) {
    return ':' + fileHash(target) + '\n';
  }
  const files: string[] = [];
  listFiles(target, '', files);
  files.sort(ordinal);
  return files.map(f => f + ':' + fileHash(path.join(target, ...f.split('/').slice(1))) + '\n').join('');
}

function quote(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) { out += '\\"'; }
    else if (c === 0x5c) { out += '\\\\'; }
    else if (c < 0x20 || c > 0x7e) { out += '\\u' + c.toString(16).padStart(4, '0'); }
    else { out += s[i]; }
  }
  return out + '"';
}

/** Canonical JSON: sorted keys, no whitespace, ASCII-only strings. */
export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) { return 'null'; }
  if (typeof v === 'string') { return quote(v); }
  if (typeof v === 'number' || typeof v === 'boolean') { return String(v); }
  if (Array.isArray(v)) { return '[' + v.map(canonicalJson).join(',') + ']'; }
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort(ordinal).map(k => quote(k) + ':' + canonicalJson(o[k])).join(',') + '}';
}
