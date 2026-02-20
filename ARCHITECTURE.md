# Architecture Guide — qtable-vendure

> **Mục đích:** Quy tắc phát triển nội bộ và hướng dẫn kiến trúc cho team.

## Golden Rule

> [!CAUTION]
> **KHÔNG sửa trực tiếp các file trong `packages/`.**
>
> Mọi custom business logic PHẢI đi qua **Vendure plugin system**.
> Sửa trực tiếp core sẽ block upgrade từ upstream và tạo merge conflict vĩnh viễn.

## Repository Structure

```
qtable-vendure/
├── packages/                 # Vendure upstream — DO NOT MODIFY
│   ├── core/                 # Server framework
│   ├── common/               # Shared types
│   ├── dashboard/            # React admin (new)
│   ├── admin-ui/             # Angular admin (legacy)
│   ├── *-plugin/             # Official plugins
│   └── dev-server/           # Dev environment
├── .agent/skills/            # AI agent skills (bc-skills submodule)
└── ARCHITECTURE.md           # This file
```

## How to Extend Vendure

### 1. Custom Plugin (recommended)

Tạo plugin trong `packages/dev-server/test-plugins/` (dev) hoặc tạo package riêng:

```typescript
import { PluginCommonModule, VendurePlugin } from '@vendure/core';

@VendurePlugin({
    imports: [PluginCommonModule],
    entities: [],           // Custom TypeORM entities
    adminApiExtensions: {}, // Custom admin GraphQL
    shopApiExtensions: {},  // Custom shop GraphQL
})
export class MyCustomPlugin {}
```

### 2. Custom Fields

Thêm fields vào entities có sẵn mà không cần entity mới:

```typescript
// In VendureConfig.customFields
customFields: {
    Product: [
        { name: 'myField', type: 'string' },
    ],
}
```

### 3. Strategy Overrides

Override behavior qua config strategies: auth, tax, shipping, payment, order process, etc.

### 4. Event Listeners

React to domain events mà không sửa core:

```typescript
@Injectable()
export class MyHandler {
    constructor(private eventBus: EventBus) {
        this.eventBus.ofType(OrderStateTransitionEvent).subscribe(event => {
            // Handle event
        });
    }
}
```

## Plugin Development Reference

| Example | Location | Mô tả |
|---|---|---|
| Reviews Plugin | `packages/dev-server/test-plugins/reviews/` | Full-featured: entities, resolvers, dashboard UI |
| Multivendor | `packages/dev-server/example-plugins/multivendor-plugin/` | Complex marketplace logic |
| Wishlist | `packages/dev-server/example-plugins/wishlist-plugin/` | Simple CRUD plugin |
| Digital Products | `packages/dev-server/example-plugins/digital-products/` | Custom fulfillment |

## Upstream Sync Strategy

```bash
# Fetch upstream changes
git fetch upstream

# Merge upstream master into local master
git merge upstream/master

# If conflicts arise in packages/, ALWAYS accept upstream
git checkout --theirs packages/<conflicting-file>
```

Sync nên thực hiện **hàng tuần** hoặc khi upstream release phiên bản mới.

## Database Strategy

| Environment | DB | Config |
|---|---|---|
| Development | MariaDB (Docker) | `docker-compose up -d mariadb` |
| Testing | SQLite | `DB=sqlite npm run populate` |
| Production | TBD (Postgres recommended) | Via env vars |

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | NestJS + TypeORM + Apollo GraphQL |
| Admin UI | React 19 + Radix UI (dashboard — active), Angular 19 (legacy) |
| Testing | Vitest (unit), Custom E2E framework |
| Package Mgmt | npm + Lerna v9 |
| CI/CD | GitHub Actions |
| Infra | Docker Compose (dev) |
