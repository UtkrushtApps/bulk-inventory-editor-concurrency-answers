#!/usr/bin/env bash
set -e

cd /root/task

echo "[1/4] Building and starting containers..."
docker compose up -d --build

echo "[2/4] Waiting for PostgreSQL to become ready..."
for i in $(seq 1 30); do
  if docker compose exec -T postgres pg_isready -U admin -d catalog >/dev/null 2>&1; then
    echo "PostgreSQL is ready."
    break
  fi
  echo "  ...waiting for PostgreSQL ($i)"
  sleep 2
  if [ "$i" -eq 30 ]; then
    echo "PostgreSQL did not become ready in time."
    docker compose logs
    exit 1
  fi
done

echo "[3/4] Validating Node.js API and database connectivity..."
API_OK=0
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    API_OK=1
    echo "API health check passed."
    break
  fi
  echo "  ...waiting for API ($i)"
  sleep 2
done
if [ "$API_OK" -ne 1 ]; then
  echo "API failed to respond."
  docker compose logs
  exit 1
fi

echo "[4/4] Validating frontend availability..."
FE_OK=0
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:3000/ >/dev/null 2>&1; then
    FE_OK=1
    echo "Frontend is reachable."
    break
  fi
  echo "  ...waiting for frontend ($i)"
  sleep 2
done
if [ "$FE_OK" -ne 1 ]; then
  echo "Frontend failed to respond."
  docker compose logs
  exit 1
fi

echo ""
echo "Deployment successful!"
echo "Frontend: http://127.0.0.1:3000/"
echo "API:      http://127.0.0.1:3000/api/inventory"
