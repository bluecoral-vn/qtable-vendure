---
description: Start Vendure dev server with PostgreSQL
---

# Dev Server

// turbo-all

1. Ensure PostgreSQL 17 is running:
```bash
docker compose up -d postgres_17
```

2. Build core and common (if not built):
```bash
npm run build:core-common
```

3. Generate initial migration (first time only, skip if migrations/ exists):
```bash
cd packages/dev-server && npm run migration:generate -- initial
```

4. Start dev server (migrations auto-run on startup):
```bash
cd packages/dev-server && npm run dev
```

5. Dev server will be available at:
- Admin API: http://localhost:3000/admin-api
- Shop API: http://localhost:3000/shop-api
- Admin UI: http://localhost:5001/admin
- Dashboard: http://localhost:5001/dashboard

## Migration Commands

```bash
# Generate new migration after schema change
cd packages/dev-server && npm run migration:generate -- <name>

# Run pending migrations manually
cd packages/dev-server && npm run migration:run

# Revert last migration
cd packages/dev-server && npm run migration:revert
```

## Using MariaDB (legacy)

To use MariaDB instead, set the `DB` environment variable:
```bash
DB=mysql docker-compose up -d mariadb
DB=mysql cd packages/dev-server && npm run dev
```
