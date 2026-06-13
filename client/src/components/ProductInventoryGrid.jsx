import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { fetchInventory, bulkUpdateInventory } from '../api/inventory.js';

const POLL_INTERVAL_MS = 15000;

export function ProductInventoryGrid() {
  const [rows, setRows] = useState([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const reconcileFromServer = useCallback((serverRows) => {
    setRows((previousRows) => mergeServerRows(previousRows, serverRows));
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const data = await fetchInventory();
        if (!cancelled) reconcileFromServer(data);
      } catch (e) {
        if (!cancelled) setMessage('Could not load inventory');
      }
    };

    load();
    const t = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [reconcileFromServer]);

  const onEdit = useCallback((sku, field, rawValue) => {
    const value = Number(rawValue);
    setRows((currentRows) =>
      currentRows.map((row) => {
        if (row.sku !== sku) return row;
        if (row[field] === value && row.dirty && !row.error) return row;
        return {
          ...row,
          [field]: Number.isFinite(value) ? value : 0,
          dirty: true,
          status: row.status === 'conflict' || row.status === 'invalid' || row.status === 'not-found'
            ? 'editing'
            : row.status,
          error: null
        };
      })
    );
  }, []);

  const dirtyCount = useMemo(
    () => rows.reduce((count, row) => count + (row.dirty && !row.saving ? 1 : 0), 0),
    [rows]
  );

  const onSaveAll = useCallback(async () => {
    const itemsToSave = rows
      .filter((row) => row.dirty && !row.saving)
      .map((row) => ({
        id: row.id,
        sku: row.sku,
        price: row.price,
        stock: row.stock,
        version: row.version
      }));

    if (itemsToSave.length === 0) {
      setMessage('No unsaved changes');
      return;
    }

    const requestId = createRequestId();
    const savingSkus = new Set(itemsToSave.map((item) => item.sku));

    setSaving(true);
    setMessage('');
    setRows((currentRows) =>
      currentRows.map((row) =>
        savingSkus.has(row.sku)
          ? {
              ...row,
              dirty: false,
              saving: true,
              status: 'saving',
              error: null,
              pendingSave: {
                requestId,
                price: row.price,
                stock: row.stock,
                version: row.version
              }
            }
          : row
      )
    );

    try {
      const { body } = await bulkUpdateInventory(itemsToSave, requestId);
      const results = Array.isArray(body.results) ? body.results : [];
      const resultBySku = new Map(results.map((result) => [result.sku, result]));

      setRows((currentRows) =>
        currentRows.map((row) => {
          const result = resultBySku.get(row.sku);
          if (!result) return row;
          return reconcileSaveResult(row, result);
        })
      );

      const summary = body.summary || summarizeResults(results);
      const failures = (summary.conflict || 0) + (summary.notFound || 0) + (summary.invalid || 0);
      if (failures > 0) {
        setMessage(
          `Saved ${summary.applied || 0}; ${summary.conflict || 0} conflicts, ${summary.notFound || 0} not found, ${summary.invalid || 0} invalid`
        );
      } else {
        setMessage(`Saved ${summary.applied || 0} rows`);
      }
    } catch (e) {
      setRows((currentRows) =>
        currentRows.map((row) =>
          savingSkus.has(row.sku)
            ? {
                ...row,
                saving: false,
                dirty: true,
                status: 'error',
                error: 'Save failed; retry is safe.'
              }
            : row
        )
      );
      setMessage('Save failed; no rows were marked saved');
    } finally {
      setSaving(false);
    }
  }, [rows]);

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <button onClick={onSaveAll} disabled={saving || dirtyCount === 0}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        <span style={{ marginLeft: 12 }}>{message}</span>
        <span style={{ marginLeft: 12, color: '#555' }}>
          {dirtyCount > 0 ? `${dirtyCount} unsaved row${dirtyCount === 1 ? '' : 's'}` : 'All clean'}
        </span>
      </div>
      <table border="1" cellPadding="6" style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th>SKU</th>
            <th>Name</th>
            <th>Version</th>
            <th>Price (cents)</th>
            <th>Stock</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Row key={row.sku} row={row} onEdit={onEdit} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

const Row = memo(function Row({ row, onEdit }) {
  const background = row.status === 'conflict'
    ? '#fff3cd'
    : row.status === 'invalid' || row.status === 'not-found' || row.status === 'error'
      ? '#fde2e2'
      : row.dirty
        ? '#eef6ff'
        : row.saving
          ? '#f1f1f1'
          : 'transparent';

  return (
    <tr style={{ background }}>
      <td>{row.sku}</td>
      <td>{row.name}</td>
      <td>{row.version}</td>
      <td>
        <input
          type="number"
          min="0"
          value={row.price}
          onChange={(e) => onEdit(row.sku, 'price', e.target.value)}
        />
      </td>
      <td>
        <input
          type="number"
          min="0"
          value={row.stock}
          onChange={(e) => onEdit(row.sku, 'stock', e.target.value)}
        />
      </td>
      <td>{statusText(row)}</td>
    </tr>
  );
});

function statusText(row) {
  if (row.error) return row.error;
  if (row.saving) return 'Saving…';
  if (row.dirty) return 'Unsaved';
  if (row.status === 'saved') return 'Saved';
  if (row.status === 'conflict') return 'Conflict: reloaded server value';
  if (row.status === 'invalid') return 'Invalid value';
  if (row.status === 'not-found') return 'Product no longer exists';
  return '';
}

function mergeServerRows(previousRows, serverRows) {
  const previousBySku = new Map(previousRows.map((row) => [row.sku, row]));

  return serverRows.map((serverRow) => {
    const previous = previousBySku.get(serverRow.sku);
    const normalized = normalizeServerRow(serverRow);

    if (!previous) return normalized;

    if (previous.dirty || previous.saving) {
      const snapshot = normalizeServerRow(serverRow);
      if (sameSnapshot(previous.serverSnapshot, snapshot)) return previous;
      return { ...previous, serverSnapshot: snapshot };
    }

    const next = {
      ...normalized,
      status: previous.status === 'saved' && sameInventory(previous, normalized) ? 'saved' : 'clean'
    };

    if (sameDisplayRow(previous, next)) return previous;
    return next;
  });
}

function normalizeServerRow(row) {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    price: Number(row.price),
    stock: Number(row.stock),
    version: Number(row.version),
    dirty: false,
    saving: false,
    status: 'clean',
    error: null,
    pendingSave: null,
    serverSnapshot: null
  };
}

function reconcileSaveResult(row, result) {
  if (result.status === 'applied') {
    if (row.dirty) {
      return {
        ...row,
        id: result.id || row.id,
        name: result.name || row.name,
        version: Number(result.version),
        saving: false,
        status: 'editing',
        pendingSave: null,
        error: null,
        serverSnapshot: {
          id: result.id || row.id,
          sku: row.sku,
          name: result.name || row.name,
          price: Number(result.price),
          stock: Number(result.stock),
          version: Number(result.version)
        }
      };
    }

    return {
      ...row,
      id: result.id || row.id,
      name: result.name || row.name,
      price: Number(result.price),
      stock: Number(result.stock),
      version: Number(result.version),
      dirty: false,
      saving: false,
      status: 'saved',
      pendingSave: null,
      error: null,
      serverSnapshot: null
    };
  }

  if (result.status === 'conflict') {
    const current = result.current || row.serverSnapshot;
    if (row.dirty) {
      return {
        ...row,
        version: current ? Number(current.version) : row.version,
        saving: false,
        status: 'conflict',
        pendingSave: null,
        error: 'Conflict: server changed while you were editing',
        serverSnapshot: current || row.serverSnapshot
      };
    }

    return {
      ...row,
      price: current ? Number(current.price) : row.price,
      stock: current ? Number(current.stock) : row.stock,
      version: current ? Number(current.version) : row.version,
      dirty: false,
      saving: false,
      status: 'conflict',
      pendingSave: null,
      error: null,
      serverSnapshot: current || null
    };
  }

  if (result.status === 'invalid') {
    return {
      ...row,
      dirty: true,
      saving: false,
      status: 'invalid',
      pendingSave: null,
      error: result.message || 'Invalid value'
    };
  }

  if (result.status === 'not-found') {
    return {
      ...row,
      dirty: true,
      saving: false,
      status: 'not-found',
      pendingSave: null,
      error: 'Product not found on server'
    };
  }

  return {
    ...row,
    dirty: true,
    saving: false,
    status: 'error',
    pendingSave: null,
    error: 'Unknown save result'
  };
}

function sameInventory(a, b) {
  return a.price === b.price && a.stock === b.stock && a.version === b.version;
}

function sameSnapshot(a, b) {
  if (!a || !b) return a === b;
  return a.id === b.id && a.sku === b.sku && a.name === b.name && sameInventory(a, b);
}

function sameDisplayRow(a, b) {
  return (
    a.id === b.id &&
    a.sku === b.sku &&
    a.name === b.name &&
    a.price === b.price &&
    a.stock === b.stock &&
    a.version === b.version &&
    a.dirty === b.dirty &&
    a.saving === b.saving &&
    a.status === b.status &&
    a.error === b.error
  );
}

function summarizeResults(results) {
  return results.reduce(
    (summary, result) => {
      if (result.status === 'applied') summary.applied += 1;
      else if (result.status === 'conflict') summary.conflict += 1;
      else if (result.status === 'not-found') summary.notFound += 1;
      else if (result.status === 'invalid') summary.invalid += 1;
      return summary;
    },
    { applied: 0, conflict: 0, notFound: 0, invalid: 0 }
  );
}

function createRequestId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `save-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
