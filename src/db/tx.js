// Atomic blocks that nest (savepoints), so domain helpers can compose.
let depth = 0;

export function tx(db, fn) {
  const name = `sp${depth++}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const out = fn();
    db.exec(`RELEASE ${name}`);
    return out;
  } catch (err) {
    db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
    throw err;
  } finally {
    depth--;
  }
}
