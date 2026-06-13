export async function fetchInventory() {
  const res = await fetch('/api/inventory');
  if (!res.ok) throw new Error('Failed to load inventory');
  return res.json();
}

export async function bulkUpdateInventory(items, idempotencyKey) {
  const key = idempotencyKey || createIdempotencyKey();
  const res = await fetch('/api/inventory/bulk-update', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key
    },
    body: JSON.stringify({ requestId: key, items })
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function createIdempotencyKey() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `inv-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
