#!/bin/bash
# Start user-space PostgreSQL for CoDoc if not already running.
# Install: /home/z/my-project/pg/root  |  Data: /home/z/my-project/db/pg-data
# TCP: 127.0.0.1:5432 (user: postgres, trust auth, db: codoc)
PGBIN=/home/z/my-project/pg/root/usr/lib/postgresql/17/bin
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres

if $PGBIN/pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
  echo "PostgreSQL already running."
else
  if [ ! -f /home/z/my-project/db/pg-data/PG_VERSION ]; then
    mkdir -p /home/z/my-project/db/pg-data /home/z/my-project/db/pg-sock
    $PGBIN/initdb -D /home/z/my-project/db/pg-data --no-locale -E UTF8 -A trust -U postgres
  fi
  $PGBIN/pg_ctl -D /home/z/my-project/db/pg-data -l /home/z/my-project/db/pg.log \
    -o "-k /home/z/my-project/db/pg-sock -p 5432 -c listen_addresses=127.0.0.1" start
  sleep 1
fi

if $PGBIN/pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
  $PGBIN/psql -d postgres -tc "SELECT 1 FROM pg_database WHERE datname='codoc'" | grep -q 1 || $PGBIN/createdb codoc
  echo "PostgreSQL up, db 'codoc' ready."
else
  echo "PostgreSQL failed to start:"; tail -20 /home/z/my-project/db/pg.log; exit 1
fi
