#!/bin/bash
# Ensure PostgreSQL is running, then push the Prisma schema.
cd /home/z/my-project
bash scripts/start-postgres.sh
DATABASE_URL="postgresql://postgres@127.0.0.1:5432/codoc" bunx prisma db push --accept-data-loss
