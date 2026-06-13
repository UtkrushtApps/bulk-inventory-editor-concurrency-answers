const crypto = require('crypto');
const { pool } = require('./db');

let schemaReadyPromise;

async function listInventory() {
  const { rows } = await pool.query(
    'SELECT id, sku, name, price, stock, version FROM products ORDER BY sku'
  );
  return rows;
}

async function bulkUpdateInventory(items, options = {}) {
  await ensureIdempotencySchema();

  const requestId = normalizeRequestId(options.idempotencyKey, items);
  const payloadHash = hashPayload(items);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Serialize requests using the same idempotency key. A concurrent retry waits
    // for the first request to store its response, then returns that exact result.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), 9017)', [requestId]);

    const inserted = await client.query(
      `INSERT INTO bulk_inventory_requests (request_id, payload_hash)
       VALUES ($1, $2)
       ON CONFLICT (request_id) DO NOTHING
       RETURNING request_id`,
      [requestId, payloadHash]
    );

    if (inserted.rowCount === 0) {
      const existing = await client.query(
        `SELECT payload_hash, response, status_code
         FROM bulk_inventory_requests
         WHERE request_id = $1`,
        [requestId]
      );

      const record = existing.rows[0];
      if (!record || record.payload_hash !== payloadHash) {
        await client.query('ROLLBACK');
        return {
          statusCode: 409,
          requestId,
          error: 'idempotency_key_reused',
          message: 'The idempotency key was already used with a different payload.'
        };
      }

      if (record.response) {
        await client.query('COMMIT');
        return { statusCode: record.status_code || 200, ...record.response };
      }

      // Should be rare because of the advisory lock, but keep the response safe.
      await client.query('ROLLBACK');
      return {
        statusCode: 409,
        requestId,
        error: 'request_in_progress',
        message: 'A request with this idempotency key is still being processed.'
      };
    }

    const response = await applyBulkUpdate(client, items, requestId);
    await client.query(
      `UPDATE bulk_inventory_requests
       SET response = $2::jsonb, status_code = $3, completed_at = now()
       WHERE request_id = $1`,
      [requestId, JSON.stringify(response), response.statusCode]
    );

    await client.query('COMMIT');
    return response;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function applyBulkUpdate(client, items, requestId) {
  if (!Array.isArray(items)) {
    return buildResponse(requestId, [
      {
        sku: null,
        status: 'invalid',
        message: 'items must be an array'
      }
    ]);
  }

  const { validItems, results } = validateItems(items);

  if (validItems.length === 0) {
    return buildResponse(requestId, results);
  }

  // One validation query for all products. FOR UPDATE ensures the version we
  // inspect is still current when the following conditional UPDATE runs.
  const skus = validItems.map((item) => item.sku);
  const existingProducts = await client.query(
    `SELECT id, sku, name, price, stock, version
     FROM products
     WHERE sku = ANY($1::text[])
     FOR UPDATE`,
    [skus]
  );

  const productBySku = new Map(existingProducts.rows.map((row) => [row.sku, row]));
  const candidates = [];

  for (const item of validItems) {
    const current = productBySku.get(item.sku);
    if (!current) {
      results[item.index] = {
        sku: item.sku,
        status: 'not-found',
        message: 'Product not found'
      };
      continue;
    }

    if (Number(current.version) !== item.version) {
      results[item.index] = {
        sku: item.sku,
        id: current.id,
        status: 'conflict',
        message: 'Stale version',
        attempted: {
          price: item.price,
          stock: item.stock,
          version: item.version
        },
        current: {
          id: current.id,
          sku: current.sku,
          name: current.name,
          price: Number(current.price),
          stock: Number(current.stock),
          version: Number(current.version)
        }
      };
      continue;
    }

    candidates.push(item);
  }

  if (candidates.length > 0) {
    // One set-based UPDATE for all non-conflicting rows. Stock is assigned as an
    // absolute value; it is not added as a delta, so retries cannot double-apply.
    const updatePayload = candidates.map((item) => ({
      sku: item.sku,
      price: item.price,
      stock: item.stock,
      version: item.version
    }));

    const updated = await client.query(
      `WITH input AS (
         SELECT *
         FROM jsonb_to_recordset($1::jsonb)
           AS x(sku text, price integer, stock integer, version integer)
       )
       UPDATE products AS p
       SET price = input.price,
           stock = input.stock,
           version = p.version + 1,
           updated_at = now()
       FROM input
       WHERE p.sku = input.sku
         AND p.version = input.version
       RETURNING p.id, p.sku, p.name, p.price, p.stock, p.version`,
      [JSON.stringify(updatePayload)]
    );

    const updatedBySku = new Map(updated.rows.map((row) => [row.sku, row]));

    for (const item of candidates) {
      const row = updatedBySku.get(item.sku);
      if (row) {
        results[item.index] = {
          sku: row.sku,
          id: row.id,
          name: row.name,
          status: 'applied',
          price: Number(row.price),
          stock: Number(row.stock),
          version: Number(row.version)
        };
      } else {
        // Defensive fallback for an unexpected concurrent change. The normal
        // path is protected by SELECT ... FOR UPDATE above.
        const current = productBySku.get(item.sku);
        results[item.index] = {
          sku: item.sku,
          id: current && current.id,
          status: 'conflict',
          message: 'Stale version',
          current: current
            ? {
                id: current.id,
                sku: current.sku,
                name: current.name,
                price: Number(current.price),
                stock: Number(current.stock),
                version: Number(current.version)
              }
            : undefined
        };
      }
    }
  }

  return buildResponse(requestId, results);
}

function validateItems(items) {
  const seenSkus = new Set();
  const validItems = [];
  const results = new Array(items.length);

  items.forEach((item, index) => {
    const sku = typeof item?.sku === 'string' ? item.sku.trim() : '';
    const price = Number(item?.price);
    const stock = Number(item?.stock);
    const version = Number(item?.version);

    if (!sku) {
      results[index] = {
        sku: null,
        status: 'invalid',
        message: 'sku is required'
      };
      return;
    }

    if (seenSkus.has(sku)) {
      results[index] = {
        sku,
        status: 'invalid',
        message: 'duplicate sku in request'
      };
      return;
    }
    seenSkus.add(sku);

    if (!Number.isInteger(price) || price < 0) {
      results[index] = {
        sku,
        status: 'invalid',
        message: 'price must be a non-negative integer'
      };
      return;
    }

    if (!Number.isInteger(stock) || stock < 0) {
      results[index] = {
        sku,
        status: 'invalid',
        message: 'stock must be a non-negative integer'
      };
      return;
    }

    if (!Number.isInteger(version) || version < 0) {
      results[index] = {
        sku,
        status: 'invalid',
        message: 'version must be a non-negative integer'
      };
      return;
    }

    validItems.push({ index, sku, price, stock, version });
  });

  return { validItems, results };
}

function buildResponse(requestId, results) {
  const compactResults = results.filter(Boolean);
  const summary = compactResults.reduce(
    (acc, result) => {
      if (result.status === 'applied') acc.applied += 1;
      else if (result.status === 'conflict') acc.conflict += 1;
      else if (result.status === 'not-found') acc.notFound += 1;
      else if (result.status === 'invalid') acc.invalid += 1;
      return acc;
    },
    { applied: 0, conflict: 0, notFound: 0, invalid: 0 }
  );

  const failures = summary.conflict + summary.notFound + summary.invalid;
  const statusCode = chooseStatusCode(summary);

  return {
    statusCode,
    requestId,
    summary,
    results: compactResults,
    applied: compactResults.filter((result) => result.status === 'applied').map((result) => result.sku),
    conflicts: compactResults.filter((result) => result.status === 'conflict').map((result) => result.sku),
    notFound: compactResults.filter((result) => result.status === 'not-found').map((result) => result.sku),
    invalid: compactResults.filter((result) => result.status === 'invalid').map((result) => result.sku),
    partial: summary.applied > 0 && failures > 0
  };
}

function chooseStatusCode(summary) {
  const failures = summary.conflict + summary.notFound + summary.invalid;
  if (failures === 0) return 200;
  if (summary.applied > 0) return 207;
  if (summary.conflict > 0 && summary.notFound === 0 && summary.invalid === 0) return 409;
  if (summary.notFound > 0 && summary.conflict === 0 && summary.invalid === 0) return 404;
  return 400;
}

async function ensureIdempotencySchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = pool.query(
      `CREATE TABLE IF NOT EXISTS bulk_inventory_requests (
         request_id   TEXT PRIMARY KEY,
         payload_hash TEXT NOT NULL,
         response     JSONB,
         status_code  INTEGER,
         created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
         completed_at TIMESTAMPTZ
       )`
    );
  }
  await schemaReadyPromise;
}

function normalizeRequestId(idempotencyKey, items) {
  if (typeof idempotencyKey === 'string' && idempotencyKey.trim()) {
    return idempotencyKey.trim();
  }
  return `payload:${hashPayload(items)}`;
}

function hashPayload(items) {
  return crypto.createHash('sha256').update(stableStringify(items)).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

module.exports = { listInventory, bulkUpdateInventory };
