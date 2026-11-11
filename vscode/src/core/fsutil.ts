import * as fs from 'fs';
import * as path from 'path';

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function forceDelete(target: string): void {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
}

/** Recursively copies a folder, skipping .git. */
export function copyTree(src: string, dst: string): void {
  ensureDir(dst);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.git') {
      continue;
    }
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyTree(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

export function readJsonFile<T>(file: string): T | undefined {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export function writeJsonFile(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

export function safeName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
}

export function exists(p: string): boolean {
  return fs.existsSync(p);
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
