CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE products (
  id          UUID PRIMARY KEY,
  sku         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  price       INTEGER NOT NULL,
  stock       INTEGER NOT NULL,
  version     INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bulk_inventory_requests (
  request_id   TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  response     JSONB,
  status_code  INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

INSERT INTO products (id, sku, name, price, stock, version) VALUES
('11111111-1111-1111-1111-111111111111', 'SKU-0001', 'Aurora Desk Lamp', 4999, 120, 0),
('22222222-2222-2222-2222-222222222222', 'SKU-0002', 'Nimbus Wireless Mouse', 2599, 340, 0),
('33333333-3333-3333-3333-333333333333', 'SKU-0003', 'Vertex Mechanical Keyboard', 8999, 75, 0),
('44444444-4444-4444-4444-444444444444', 'SKU-0004', 'Cobalt USB-C Hub', 3499, 210, 0),
('55555555-5555-5555-5555-555555555555', 'SKU-0005', 'Lumen Monitor Stand', 5999, 95, 0),
('66666666-6666-6666-6666-666666666666', 'SKU-0006', 'Pebble Laptop Sleeve', 1999, 500, 0),
('77777777-7777-7777-7777-777777777777', 'SKU-0007', 'Drift Noise Headphones', 12999, 60, 0),
('88888888-8888-8888-8888-888888888888', 'SKU-0008', 'Glide Standing Mat', 4499, 150, 0),
('99999999-9999-9999-9999-999999999999', 'SKU-0009', 'Orbit Webcam 1080p', 5499, 130, 0),
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'SKU-0010', 'Slate Cable Organizer', 1299, 620, 0);

DO $$
DECLARE
  i INTEGER;
BEGIN
  FOR i IN 11..360 LOOP
    INSERT INTO products (id, sku, name, price, stock, version)
    VALUES (
      gen_random_uuid(),
      'SKU-' || lpad(i::text, 4, '0'),
      'Catalog Item ' || i,
      ((i * 137) % 9000) + 999,
      ((i * 53) % 480) + 20,
      0
    );
  END LOOP;
END $$;
