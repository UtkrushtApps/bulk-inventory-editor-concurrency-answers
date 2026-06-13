#!/usr/bin/env bash
set -e

echo "Stopping containers..."
cd /root/task || true
docker compose -f /root/task/docker-compose.yml down --volumes --remove-orphans || true

echo "Stopping any stray containers..."
docker ps -q | xargs -r docker stop || true
docker ps -aq | xargs -r docker rm -f || true

echo "Removing volumes..."
docker volume prune -f || true

echo "Removing images..."
docker image prune -a -f || true
docker rmi -f $(docker images -q | grep -E 'react-node|node-react|fullstack|inventory|postgres' || true) || true

echo "Pruning system..."
docker system prune -a --volumes -f || true

echo "Deleting folder..."
rm -rf /root/task || true

echo "Cleanup completed successfully! Droplet is now clean."
