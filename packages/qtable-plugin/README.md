# @qtable/vendure-plugin

Custom Vendure plugin chứa toàn bộ business logic riêng của QTable.

## Cấu trúc

```
src/
├── qtable.plugin.ts    # Main plugin (VendurePlugin decorator)
├── api/                # GraphQL resolvers & schema extensions
├── entities/           # TypeORM entities
├── services/           # Business logic services
├── events/             # Domain events
└── index.ts            # Public API exports
```

## Sử dụng

Thêm vào `dev-config.ts`:

```typescript
import { QTablePlugin } from '../qtable-plugin/src';

export const devConfig: VendureConfig = {
    plugins: [
        QTablePlugin,
        // ...other plugins
    ],
};
```

## Quy tắc phát triển

Xem [ARCHITECTURE.md](../../ARCHITECTURE.md) để biết các quy tắc quan trọng.
