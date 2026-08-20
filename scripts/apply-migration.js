// Applies a .sql file to the configured database.
//   node --env-file-if-exists=.env scripts/apply-migration.js migrations/002_menu_and_modifiers.sql
const fs = require('fs');
const { Pool } = require('pg');

const file = process.argv[2];
if (!file) { console.error('usage: apply-migration.js <file.sql>'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(1); }

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  const sql = fs.readFileSync(file, 'utf8');
  await pool.query(sql);
  console.log(`applied ${file}`);
  await pool.end();
})().catch(e => {
  console.error('failed:', String(e.message).replace(/postgres(ql)?:\/\/\S+/gi, '[redacted]'));
  process.exit(1);
});
