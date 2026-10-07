// node:sqlite-shaped facade over a sql.js Database, so the server's domain
// code runs unchanged on the phone. Kept import-free so Node tests can use it.

const bindable = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

/** node:sqlite-shaped facade over a sql.js Database. */
export function adapt(raw) {
  function query(sql, params, firstOnly) {
    const stmt = raw.prepare(sql);
    try {
      stmt.bind(params.map(bindable));
      const rows = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
        if (firstOnly) break;
      }
      return rows;
    } finally {
      stmt.free();
    }
  }
  return {
    exec: (sql) => void raw.exec(sql),
    // Statements compile per call: sql.js frees them all on export().
    prepare: (sql) => ({
      get: (...p) => query(sql, p, true)[0],
      all: (...p) => query(sql, p, false),
      run: (...p) => {
        query(sql, p, false);
        const changes = raw.getRowsModified();
        const lastInsertRowid = raw.exec('SELECT last_insert_rowid()')[0].values[0][0];
        return { changes, lastInsertRowid };
      },
    }),
  };
}
