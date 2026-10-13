#!/usr/bin/env sh
# Deletes the local database and recreates it from schema.sql + seed.sql.
set -e
cd "$(dirname "$0")"
DB="${1:-onboarding.db}"
rm -f "$DB"
sqlite3 -bail "$DB" < schema.sql
sqlite3 -bail "$DB" < seed.sql
echo "Database reset and seeded: database/$DB"
