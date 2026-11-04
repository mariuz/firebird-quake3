// demo.js – a recorded demo (sql/demo.sql) to a file and back: the rows of its tables as JSON, the page's
// stand-in for Quake III's .dm_68 files (demos/*.dm_68 in the game's directory). Nothing here plays anything:
// playback is demo_play in SQL.

const TABLES = ['demos', 'demo_frames', 'demo_ents', 'demo_sounds', 'demo_fx', 'demo_msgs'];
export const DEMO_FORMAT = 'firebird-quake3-demo';

/** The demo `id` as a plain object: each table's column names and rows. */
export async function exportDemo(db, id) {
  const out = { format: DEMO_FORMAT, version: 1, tables: {} };
  for (const t of TABLES) {
    const r = await db.query(`SELECT * FROM ${t} WHERE ${t === 'demos' ? 'id' : 'demo_id'} = ?${t === 'demos' ? '' : ' ORDER BY n'}`, [id], { rowMode: 'array' });
    out.tables[t] = { columns: r.fields.map((f) => f.name.toLowerCase()), rows: r.rows };
  }
  return out;
}

/** A demo object from exportDemo into the tables, under a new id (returned). */
export async function importDemo(db, demo) {
  if (demo?.format !== DEMO_FORMAT || !demo.tables?.demos?.rows?.length) throw new Error('not a firebird-quake3 demo');
  const id = (await db.query('SELECT NEXT VALUE FOR demo_seq id FROM rdb$database')).rows[0].ID;
  for (const t of TABLES) {
    const { columns, rows } = demo.tables[t] ?? { columns: [], rows: [] };
    if (!rows.length) continue;
    const key = columns.indexOf(t === 'demos' ? 'id' : 'demo_id');
    const sql = `INSERT INTO ${t} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
    for (const r of rows) {
      const v = [...r];
      v[key] = id;
      await db.query(sql, v);
    }
  }
  return id;
}

/** The demos recorded or loaded this session, the newest first. */
export async function listDemos(db) {
  return (await db.query('SELECT id, map_name, frames, seconds FROM demos ORDER BY id DESC')).rows;
}
