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
