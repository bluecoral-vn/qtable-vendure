---
description: Create and develop a new Vendure plugin
---

# Plugin Development

## Creating a New Feature

All custom logic goes into `packages/qtable-plugin/`.

1. Create entity (if needed) in `packages/qtable-plugin/src/entities/`:
```typescript
// my-entity.entity.ts
import { DeepPartial, VendureEntity } from '@vendure/core';
import { Column, Entity } from 'typeorm';

@Entity()
export class MyEntity extends VendureEntity {
    constructor(input?: DeepPartial<MyEntity>) {
        super(input);
    }

    @Column()
    name: string;
}
```

2. Create service in `packages/qtable-plugin/src/services/`:
```typescript
// my.service.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MyEntity } from '../entities/my-entity.entity';

@Injectable()
export class MyService {
    constructor(
        @InjectRepository(MyEntity)
        private repository: Repository<MyEntity>,
    ) {}
}
```

3. Create GraphQL resolver in `packages/qtable-plugin/src/api/`:
```typescript
// my.resolver.ts
import { Resolver, Query } from '@nestjs/graphql';

@Resolver()
export class MyResolver {
    @Query()
    myQuery() { return []; }
}
```

4. Register in `qtable.plugin.ts`:
```typescript
@VendurePlugin({
    imports: [PluginCommonModule],
    entities: [MyEntity],
    providers: [MyService],
    adminApiExtensions: {
        resolvers: [MyResolver],
    },
})
export class QTablePlugin {}
```

5. Build and test:
```bash
cd packages/dev-server && npm run dev
```

## Reference Examples

- `packages/dev-server/test-plugins/reviews/` — Full CRUD plugin with dashboard UI
- `packages/dev-server/example-plugins/wishlist-plugin/` — Simple plugin
- `packages/dev-server/example-plugins/multivendor-plugin/` — Complex plugin

## Tenant Provisioning Checklist

When writing code that creates new Channels programmatically (e.g. tenant provisioning), follow this exact order:

```
1. Validate slug/domain uniqueness
2. Create Seller
3. Create Channel (linked to seller)
   ⚠️ 3.5. Assign SuperAdmin role → new channel
4. Create tenant admin Role (scoped to new channel)
5. Create Administrator (with tenant role)
6. Create Tenant entity
7. Create TenantDomain
8. Transition status: REQUESTED → PROVISIONING → TRIAL
9. Emit TenantCreatedEvent
```

> [!CAUTION]
> Step 3.5 is CRITICAL. Without it, `RoleService.create()` throws `ForbiddenError`
> because `getPermittedChannels()` checks `CreateAdministrator` on the target channel.

## E2E Test Setup for Plugins

```typescript
// vitest.e2e.config.ts — Required for decorator support
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    plugins: [swc.vite({
        jsc: { transform: {
            useDefineForClassFields: false,
            legacyDecorator: true,
            decoratorMetadata: true,
        }},
    })],
    test: {
        include: ['e2e/**/*.e2e-spec.ts'],
        testTimeout: 30_000,
        hookTimeout: 120_000,
        poolOptions: { forks: { singleFork: true } },
    },
});
```

Key points:
- **`unplugin-swc`** required for TypeScript decorators (`@Entity`, `@Column`, etc.)
- **`singleFork: true`** ensures server stays up across all tests in file
- **`hookTimeout: 120_000`** allows time for DB schema sync + initial data population
- Use `mergeConfig(defaultTestConfig, { ... })` to merge with Vendure's test config
- Always call `adminClient.asSuperAdmin()` in `beforeAll`

