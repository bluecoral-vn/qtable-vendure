---
description: Run unit or E2E tests for Vendure packages
---

# Test

// turbo-all

1. Run ALL unit tests:
```bash
npm run test
```

2. Run unit tests for a specific package:
```bash
cd packages/<package-name> && npm run test
```

3. Run ALL E2E tests:
```bash
npm run e2e
```

4. Run a specific E2E test:
```bash
cd packages/<package-name> && npm run e2e <test-file>
```

5. Reset E2E cache (required after schema changes):
```bash
rm -rf packages/<package-name>/e2e/__data__
```

## PostgreSQL E2E Tests (qtable-saas)

// turbo-all

6. Start PostgreSQL (required for qtable-saas E2E):
```bash
docker compose up -d postgres_17
```

7. Create test database (first time only):
```bash
docker exec postgres_17 psql -U vendure -d vendure-dev -c 'CREATE DATABASE "vendure-e2e-test"'
```

8. Run qtable-saas E2E tests on PostgreSQL:
```bash
cd packages/qtable-saas && npm run build && DB=postgres npm run e2e
```

9. Reset test database (when schema changes):
```bash
docker exec postgres_17 psql -U vendure -d vendure-dev -c 'DROP DATABASE IF EXISTS "vendure-e2e-test"'
docker exec postgres_17 psql -U vendure -d vendure-dev -c 'CREATE DATABASE "vendure-e2e-test"'
```

> [!IMPORTANT]
> qtable-saas uses `jsonb` columns and `enum` types that require PostgreSQL.
> SQLjs does NOT support these features — always use `DB=postgres` for E2E.

