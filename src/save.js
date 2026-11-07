// save.js – a save game to a file and back (sql/save.sql): the rows of the tables play changes, as JSON. The
// page loads the save's arena first (its world, models and entities from the pak), then importSave puts the
// saved rows in place of the arena's and save_restored sets the rest in order. Nothing here plays anything.

// table → the key a row is replaced by (null: the table is emptied and refilled); bot_defs keeps its roster
// from the pak and takes back only the skills
const TABLES = {
  game: null, player: null, ents: null, messages: null, bot_avoid: null, bot_routes: null,
  waypoints: null, wp_edges: null, wp_build: null, areas: null, area_portals: null, bot_defs: 'name',
};
const COLUMNS = { bot_defs: 'name, skill' };
export const SAVE_FORMAT = 'firebird-quake3-save';

/** The game as it stands: { format, version, map, time, tables: { name: { columns, rows } } }. */
export async function exportSave(db) {
  const g = (await db.query('SELECT map_name, time_ FROM game WHERE id = 1')).rows[0];
  const out = { format: SAVE_FORMAT, version: 1, map: g.MAP_NAME?.trim(), time: g.TIME_, tables: {} };
  for (const t of Object.keys(TABLES)) {
    const r = await db.query(`SELECT ${COLUMNS[t] ?? '*'} FROM ${t}`, [], { rowMode: 'array' });
    out.tables[t] = { columns: r.fields.map((f) => f.name.toLowerCase()), rows: r.rows };
  }
  // the map's brush models by name (the world, *1, *2 …): a fresh load of the map numbers them anew
  out.brushModels = (await db.query("SELECT id, name FROM models WHERE kind = 'B'", [], { rowMode: 'array' })).rows;
  return out;
}

/** Check a parsed file is a save; returns its map. */
export function saveMap(save) {
  if (save?.format !== SAVE_FORMAT || !save.map || !save.tables?.ents) throw new Error('not a firebird-quake3 save');
  return save.map;
}

/** The save's rows in place of the arena's (its map already loaded), then save_restored. */
export async function importSave(db, save) {
  saveMap(save);
  // the saved brush model ids → this load's (by name); the pak's models keep theirs
  const now = new Map((await db.query("SELECT name, id FROM models WHERE kind = 'B'", [], { rowMode: 'array' })).rows.map(([n, id]) => [n.trim(), id]));
  const remap = new Map((save.brushModels ?? []).map(([id, n]) => [id, now.get(String(n).trim()) ?? id]));
  const fix = { ents: 'model_id', game: 'world_model' };
  for (const [t, key] of Object.entries(TABLES)) {
    let { columns, rows } = save.tables[t] ?? { columns: [], rows: [] };
    if (fix[t]) {
      const c = columns.indexOf(fix[t]);
      rows = rows.map((r) => { const v = [...r]; if (remap.has(v[c])) v[c] = remap.get(v[c]); return v; });
    }
    if (key) {
      // (only the rows the arena has: the skills of the roster's bots)
      const k = columns.indexOf(key);
      const sets = columns.filter((c) => c !== key);
      for (const r of rows) await db.query(`UPDATE ${t} SET ${sets.map((c) => `${c} = ?`).join(', ')} WHERE ${key} = ?`, [...sets.map((c) => r[columns.indexOf(c)]), r[k]]);
      continue;
    }
    await db.exec(`DELETE FROM ${t}`);
    if (!rows.length) continue;
    const sql = `INSERT INTO ${t} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
    for (const r of rows) await db.query(sql, r);
  }
  await db.exec('EXECUTE PROCEDURE save_restored');
}
