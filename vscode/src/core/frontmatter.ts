/** Minimal YAML front-matter reader (flat key/value, folded/literal block scalars). */
export function parseFrontMatter(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return result;
  }
  const keyRe = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/;
  for (let i = 1; i < lines.length && lines[i].trim() !== '---'; i++) {
    const m = keyRe.exec(lines[i]);
    if (!m) {
      continue;
    }
    const key = m[1].toLowerCase();
    let value = m[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const folded = value[0] === '>';
      let out = '';
      while (
        i + 1 < lines.length &&
        (lines[i + 1].startsWith(' ') || lines[i + 1].startsWith('\t') || lines[i + 1].trim() === '') &&
        lines[i + 1].trim() !== '---'
      ) {
        i++;
        if (out.length > 0) {
          out += folded ? ' ' : '\n';
        }
        out += lines[i].trim();
      }
      value = out.trim();
    } else if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.substring(1, value.length - 1);
    }
    result[key] = value;
  }
  return result;
}
