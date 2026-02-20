# @qtable/vendure-saas

QTable SaaS plugin for Vendure — multi-tenant business logic, entities, and services.

## Structure

```
src/
├── entities/         # TypeORM entities (Tenant, TenantDomain)
├── events/           # Lifecycle events
├── middleware/        # TenantContextMiddleware
├── services/         # Business logic services
├── qtable.plugin.ts  # Plugin entry point
└── index.ts          # Barrel exports
```

## Usage

```typescript
import { QTablePlugin } from '../qtable-saas/src';

export const config: VendureConfig = {
    plugins: [
        QTablePlugin,
    ],
};
```
