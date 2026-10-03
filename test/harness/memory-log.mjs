// test/harness/memory-log.mjs — an in-memory log port: what lib/runner.mjs appends, kept in order.
export function memoryLog() {
  const rows = []
  return {
    append(kind, fields) { const seq = rows.length + 1; rows.push({ ...fields, kind, seq }); return { seq } },
    entries() { return rows.map((r) => ({ ...r })) },
  }
}
