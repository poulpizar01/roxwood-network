#!/bin/sh
set -e

echo "Applying database migrations..."
npx prisma migrate deploy

echo "Starting bot..."
exec node dist/index.js
