const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'postgres',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'admin',
  password: process.env.PGPASSWORD || 'admin',
  database: process.env.PGDATABASE || 'catalog'
});

async function waitForDb() {
  let attempts = 0;
  while (attempts < 30) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (e) {
      attempts += 1;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('Database connection timed out');
}

module.exports = { pool, waitForDb };
