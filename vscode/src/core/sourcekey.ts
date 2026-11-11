import { PluginSource } from './types';

// See docs/plugin-lock.md ("Source key"). The Visual Studio edition implements the same algorithm.
const SHORTHAND = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SCP = /^[A-Za-z0-9_.-]+@([^:/]+):(.+)$/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

export function gitSourceKey(location: string): string {
  const l = location.trim();
  let host: string;
  let path: string;
  let m: RegExpExecArray | null;
  if (SHORTHAND.test(l)) {
    host = 'github.com';
    path = l;
  } else if (!SCHEME.test(l) && (m = SCP.exec(l))) {
    host = m[1];
    path = m[2];
  } else {
    const rest = l.replace(SCHEME, '');
    const slash = rest.indexOf('/');
    let authority = slash < 0 ? rest : rest.substring(0, slash);
    path = slash < 0 ? '' : rest.substring(slash + 1);
    const at = authority.lastIndexOf('@');
    if (at >= 0) {
      authority = authority.substring(at + 1);
    }
    host = authority.replace(/:\d+$/, '');
  }
  const cut = path.search(/[?#]/);
  if (cut >= 0) {
    path = path.substring(0, cut);
  }
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  return host.toLowerCase() + (path.length > 0 ? '/' + path.toLowerCase() : '');
}

export function localSourceKey(location: string): string {
  let p = location.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[A-Za-z]:/.test(p) || p.startsWith('//')) {
    p = p.toLowerCase();
  }
  return 'file:' + p;
}

export function sourceKey(source: Pick<PluginSource, 'kind' | 'location'>): string {
  return source.kind === 'local' ? localSourceKey(source.location) : gitSourceKey(source.location);
}
