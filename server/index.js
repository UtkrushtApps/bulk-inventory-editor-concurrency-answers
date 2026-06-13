const path = require('path');
const express = require('express');
const { pool, waitForDb } = require('./db');
const { bulkUpdateInventory, listInventory } = require('./inventoryService');

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (e) {
    res.status(500).json({ status: 'db_unavailable' });
  }
});

app.get('/api/inventory', async (req, res) => {
  try {
    const data = await listInventory();
    res.json(data);
  } catch (e) {
    console.error('Failed to list inventory', e);
    res.status(500).json({ error: 'failed_to_list' });
  }
});

app.post('/api/inventory/bulk-update', async (req, res) => {
  try {
    const { items, requestId, idempotencyKey } = req.body || {};
    const result = await bulkUpdateInventory(items, {
      idempotencyKey: req.get('Idempotency-Key') || idempotencyKey || requestId
    });
    const { statusCode, ...body } = result;
    res.status(statusCode || 200).json(body);
  } catch (e) {
    console.error('Failed to bulk update inventory', e);
    res.status(500).json({ error: 'failed_to_bulk_update' });
  }
});

const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

const PORT = 3000;

waitForDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Inventory app listening on ${PORT}`);
    });
  })
  .catch((e) => {
    console.error('Database not reachable', e);
    process.exit(1);
  });
