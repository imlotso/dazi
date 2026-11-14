/** Compile the SQLite-style bound placeholders used by the existing stores. */
export function compilePostgresSql(input: string, args: unknown[]) {
  let sql = input.replace(/\blength\s*\(\s*CAST\s*\(\s*value\s+AS\s+BLOB\s*\)\s*\)/gi, 'octet_length(value)')
    .replace(/\bMAX\s*\(\s*missing_client_checkpoint_time\s*,\s*\?\s*\)/gi, 'GREATEST(missing_client_checkpoint_time,?)');
  const ignore = /^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(sql);
  if (ignore) sql = sql.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/i, 'INSERT INTO').replace(/;\s*$/, '') + ' ON CONFLICT DO NOTHING';
  const named = args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) && !Buffer.isBuffer(args[0])
    ? args[0] as Record<string, unknown> : undefined;
  let position = named ? 1 : 0;
  const values: unknown[] = [];
  let out = '';
  let alias = false;
  for (let i = 0; i < sql.length;) {
    const char = sql[i];
    if (char === "'" || char === '"') {
      const quote = char;
      let end = i + 1;
      while (end < sql.length) {
        if (sql[end++] === quote) {
          if (sql[end] === quote) { end++; continue; }
          break;
        }
      }
      out += sql.slice(i, end); i = end; alias = false; continue;
    }
    if (char === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const next = end < 0 ? sql.length : end;
      out += sql.slice(i, next); i = next; continue;
    }
    if (char === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Unterminated SQL comment');
      out += sql.slice(i, end + 2); i = end + 2; continue;
    }
    if (char === '?' || char === '@' && /[a-z_]/i.test(sql[i + 1] ?? '')) {
      let value: unknown;
      let end = i + 1;
      if (char === '?') {
        if (position >= args.length) throw new Error('Missing SQL parameter');
        value = args[position++];
      } else {
        while (/[a-z0-9_]/i.test(sql[end] ?? '')) end++;
        const key = sql.slice(i + 1, end);
        if (!named || !Object.hasOwn(named, key)) throw new Error('Missing named SQL parameter');
        value = named[key];
      }
      values.push(value);
      out += '$' + values.length + (/^\s+IS\s+(?:NOT\s+)?NULL\b/i.test(sql.slice(end)) ? '::text' : '');
      i = end; alias = false; continue;
    }
    if (/[a-z_]/i.test(char)) {
      let end = i + 1;
      while (/[a-z0-9_]/i.test(sql[end] ?? '')) end++;
      const word = sql.slice(i, end);
      if (alias) { out += `"${word}"`; alias = false; }
      else if (/^instr$/i.test(word) && /^\s*\(/.test(sql.slice(end))) out += 'strpos';
      else { out += word; alias = /^AS$/i.test(word); }
      i = end; continue;
    }
    out += char;
    if (!/\s/.test(char)) alias = false;
    i++;
  }
  return { text: out, values };
}
