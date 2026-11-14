import { expect, it } from 'vitest';
import { compilePostgresSql } from '../server/postgres/sql';

it('binds positional and repeated named values without altering quoted text or comments', () => {
  expect(compilePostgresSql("SELECT '?' AS marker, @name AS displayName -- ?\nWHERE (@name IS NULL OR name=@name) AND n>?", [{ name: 'Alice' }, 3])).toEqual({
    text: "SELECT '?' AS \"marker\", $1 AS \"displayName\" -- ?\nWHERE ($2::text IS NULL OR name=$3) AND n>$4",
    values: ['Alice', 'Alice', 'Alice', 3],
  });
});

it('translates the SQLite operations used by existing stores without interpolating parameters', () => {
  expect(compilePostgresSql('INSERT OR IGNORE INTO x(id) VALUES (?)', ["x'); DROP TABLE x;--"])).toEqual({
    text: 'INSERT INTO x(id) VALUES ($1) ON CONFLICT DO NOTHING', values: ["x'); DROP TABLE x;--"],
  });
  expect(compilePostgresSql('SELECT instr(name,?), length(CAST(value AS BLOB)), MAX(missing_client_checkpoint_time,?) AS n', ['a', 1]).text)
    .toBe('SELECT strpos(name,$1), octet_length(value), GREATEST(missing_client_checkpoint_time,$2) AS "n"');
});
