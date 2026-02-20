# Architecture Review — qtable-vendure

> **Date:** 2026-02-20  
> **Purpose:** Internal architecture review for Multi-tenant SaaS readiness assessment  
> **Scope:** Vendure core + qtable-plugin + dev-server configuration

---

## Table of Contents

1. [Repository Structure](#1-repository-structure)
2. [Package Inventory](#2-package-inventory)
3. [Core Architecture](#3-core-architecture)
4. [Entity & Data Model](#4-entity--data-model)
5. [Channel System](#5-channel-system)
6. [Request Lifecycle](#6-request-lifecycle)
7. [RBAC & Authorization](#7-rbac--authorization)
8. [API Layer](#8-api-layer)
9. [Plugin System](#9-plugin-system)
10. [Current Custom Code](#10-current-custom-code)
11. [Database Setup](#11-database-setup)
12. [Infrastructure](#12-infrastructure)
13. [Development Guidelines](#13-development-guidelines)

---

## 1. Repository Structure

```
qtable-vendure/
├── packages/                     # Vendure upstream (21 packages) — DO NOT MODIFY
│   ├── core/                     # NestJS + TypeORM + GraphQL server
│   │   ├── src/api/              # GraphQL resolvers, guards, middleware
│   │   ├── src/entity/           # ~55 TypeORM entities
│   │   ├── src/service/          # Business logic services + helpers
│   │   ├── src/config/           # VendureConfig, strategies
│   │   ├── src/connection/       # TransactionalConnection wrapper
│   │   ├── src/event-bus/        # Domain event system
│   │   ├── src/plugin/           # Plugin module + common module
│   │   └── src/job-queue/        # Background job processing
│   ├── common/                   # Shared types, generated GraphQL types
│   ├── dashboard/                # New React 19 admin UI (replacing Angular)
│   ├── admin-ui/                 # Legacy Angular 19 admin UI
│   ├── dev-server/               # Development environment
│   │   ├── dev-config.ts         # VendureConfig for dev
│   │   ├── example-plugins/      # Reference plugin implementations
│   │   │   └── multivendor-plugin/  # ⭐ Key reference for multi-tenant
│   │   └── test-plugins/         # Test plugin implementations
│   ├── qtable-plugin/            # ⭐ Custom QTable plugin (empty scaffold)
│   ├── asset-server-plugin/      # Asset serving + S3
│   ├── email-plugin/             # Email notifications
│   ├── elasticsearch-plugin/     # Search
│   ├── job-queue-plugin/         # BullMQ / Pub-Sub jobs
│   ├── payments-plugin/          # Stripe / Mollie
│   ├── harden-plugin/            # Security hardening
│   ├── sentry-plugin/            # Error tracking
│   └── ...                       # Other official plugins
├── .agent/                       # AI agent skills + workflows
├── docs/                         # Documentation (985 items)
├── scripts/                      # Build/check scripts
├── docker-compose.yml            # Dev infrastructure
└── lerna.json                    # Monorepo management (v3.5.2)
```

---

## 2. Package Inventory

| Package | Role | Multi-tenant Impact |
|---------|------|---------------------|
| `core` | Server framework | **Critical** — Channel, RBAC, RequestContext |
| `common` | Shared types | Generated GraphQL types, Permission enum |
| `qtable-plugin` | Custom business logic | **Entry point** for tenant logic |
| `dashboard` | React admin UI | Needs tenant-aware UI |
| `admin-ui` | Angular admin (legacy) | Will be replaced |
| `asset-server-plugin` | File/image serving | Needs tenant-scoped asset paths |
| `email-plugin` | Email templates | Needs tenant-scoped templates |
| `job-queue-plugin` | BullMQ jobs | Jobs must carry tenant context |
| `harden-plugin` | Security hardening | Rate limiting per tenant |

---

## 3. Core Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     Client (Storefront / Admin)              │
├──────────────────────────────────────────────────────────────┤
│                    GraphQL API Layer                          │
│            ┌─────────────┬──────────────┐                    │
│            │  Admin API   │  Shop API    │                    │
│            │ /admin-api   │ /shop-api    │                    │
│            └──────┬───────┴──────┬───────┘                    │
│                   │              │                            │
│            ┌──────▼──────────────▼───────┐                    │
│            │       AuthGuard             │                    │
│            │  ┌─────────────────────┐    │                    │
│            │  │ 1. Extract token    │    │                    │
│            │  │ 2. Load Session     │    │                    │
│            │  │ 3. Resolve Channel  │    │                    │
│            │  │ 4. Build ReqCtx     │    │                    │
│            │  │ 5. Check Permissions│    │                    │
│            │  └─────────────────────┘    │                    │
│            └──────┬──────────────────────┘                    │
│                   │                                          │
│            ┌──────▼──────────────────────┐                    │
│            │   RequestContext             │                    │
│            │  ╔═══════════════════════╗   │                    │
│            │  ║ channel (Channel)     ║   │                    │
│            │  ║ session (CachedSess.) ║   │                    │
│            │  ║ apiType (admin/shop)  ║   │                    │
│            │  ║ languageCode          ║   │                    │
│            │  ║ currencyCode          ║   │                    │
│            │  ║ permissions           ║   │                    │
│            │  ╚═══════════════════════╝   │                    │
│            └──────┬──────────────────────┘                    │
│                   │                                          │
│            ┌──────▼──────────────────────┐                    │
│            │   Service Layer              │                    │
│            │  (ChannelService, Product,   │                    │
│            │   Order, Customer, etc.)     │                    │
│            └──────┬──────────────────────┘                    │
│                   │                                          │
│            ┌──────▼──────────────────────┐                    │
│            │   TransactionalConnection    │                    │
│            │  (TypeORM + Transaction Mgmt)│                    │
│            └──────┬──────────────────────┘                    │
│                   │                                          │
│            ┌──────▼──────────────────────┐                    │
│            │   Database (MariaDB/PG)      │                    │
│            └─────────────────────────────┘                    │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. Entity & Data Model

### Core Entities (~55 entities)

| Category | Entities | Channel-Aware? |
|----------|----------|----------------|
| **Catalog** | Product, ProductVariant, Collection, Facet, FacetValue | ✅ ManyToMany |
| **Order** | Order, OrderLine, Payment, Fulfillment, Refund | ✅ via Order |
| **Customer** | Customer, Address, CustomerGroup | ✅ ManyToMany |
| **Auth** | User, Role, Administrator, Session | ✅ Role→Channel |
| **Commerce** | PaymentMethod, ShippingMethod, Promotion | ✅ ManyToMany |
| **Inventory** | StockLocation, StockLevel, StockMovement | ✅ ManyToMany |
| **Config** | Channel, Seller, Zone, TaxCategory, TaxRate | Channel IS the entity |
| **System** | GlobalSettings, HistoryEntry, Tag, Asset | Partial |

### Base Entity

All entities inherit from `VendureEntity`:
- `id` (configurable strategy: UUID, auto-increment, NanoID)
- `createdAt`, `updatedAt`
- Custom fields support via `@Column(type => CustomXxxFields)`

### Channel-Aware Pattern (ManyToMany)

Entities implementing `ChannelAware` have a `channels: Channel[]` relationship via join tables.
This means entity data is **shared** across channels via association rather than copied.

```
┌──────────────┐         ┌───────────────────────┐         ┌──────────────┐
│   Channel A  │◄────────│  product_channels_    │────────►│   Product    │
│              │         │  channel (join table)  │         │              │
│   Channel B  │◄────────│                       │────────►│              │
└──────────────┘         └───────────────────────┘         └──────────────┘
```

> **Multi-tenant implication:** A single Product row can be visible in multiple Channels.
> This is a **shared data model**, not a tenant-isolated model.

---

## 5. Channel System

### Channel Entity

| Field | Type | Purpose |
|-------|------|---------|
| `code` | string (unique) | Human-readable identifier |
| `token` | string (unique) | API identification via `vendure-token` header |
| `seller` | ManyToOne → Seller | Links channel to a seller/vendor |
| `defaultLanguageCode` | LanguageCode | Channel locale |
| `defaultCurrencyCode` | CurrencyCode | Channel currency |
| `defaultTaxZone` | Zone | Tax defaults |
| `defaultShippingZone` | Zone | Shipping defaults |
| `pricesIncludeTax` | boolean | Tax display mode |
| `trackInventory` | boolean | Inventory tracking |
| `customFields` | CustomChannelFields | ⭐ Extensible via custom fields |

### Channel Detection Flow

```
Request Header: vendure-token → ChannelService.getChannelFromToken(token) → Channel entity
                                         ↓
                            SelfRefreshingCache (in-memory, refreshed periodically)
```

- Default Channel always exists (created at bootstrap)
- Token-based resolution is the **only** built-in channel detection mechanism
- No built-in domain/subdomain-based detection

### Seller → Channel Relationship

```
Seller (1) ──── Channel (N)
  │                  │
  │                  ├── Products (ManyToMany)
  │                  ├── Customers (ManyToMany)
  │                  ├── Orders (ManyToOne)
  │                  ├── Roles (ManyToMany)
  │                  └── PaymentMethods (ManyToMany)
  │
  └── customFields (extensible)
```

---

## 6. Request Lifecycle

### Full Request Flow

```
1. HTTP Request arrives
   └── Header: vendure-token: <channel_token>
       Header: Authorization: Bearer <session_token>

2. AuthGuard.canActivate()
   ├── extractSessionToken(req) → session token
   ├── SessionService.getSessionFromToken(token) → CachedSession
   │     CachedSession contains:
   │     ├── user.id
   │     └── user.channelPermissions[] (permissions per channel)
   ├── RequestContextService.fromRequest(req, info, permissions, session)
   │     └── ChannelService.getChannelFromToken(vendure-token) → Channel
   │         └── Creates RequestContext { channel, session, apiType, permissions }
   ├── setActiveChannel() — ensures session tracks active channel
   └── internal_setRequestContext(req, ctx) — stores on Express request

3. GraphQL Resolver executes
   ├── @Ctx() decorator extracts RequestContext from req
   ├── Service method receives ctx
   └── TransactionalConnection.getRepository(ctx, Entity)
       └── Uses ctx for transaction management

4. Query execution
   ├── Services typically filter by ctx.channelId
   ├── ListQueryBuilder applies channel filters
   └── ChannelService.assignToCurrentChannel() for writes
```

### RequestContext Contents (Immutable per request)

| Property | Source | Description |
|----------|--------|-------------|
| `channel` | `vendure-token` header | Active Channel entity |
| `channelId` | Derived from channel | Channel ID |
| `session` | Session token | User session with permissions |
| `activeUserId` | Session | Current user ID |
| `apiType` | URL path | `'admin'` or `'shop'` |
| `languageCode` | Channel default or request | Active language |
| `currencyCode` | Channel default or request | Active currency |
| `isAuthorized` | Guard evaluation | Whether user is authorized |

---

## 7. RBAC & Authorization

### Permission Model

```
Permission (enum, ~80 values)
  ├── CRUD permissions: CreateProduct, ReadProduct, UpdateProduct, DeleteProduct
  ├── Special: SuperAdmin, Owner, Public, Authenticated
  └── Custom permissions (extensible via plugins)

Role
  ├── code: string
  ├── permissions: Permission[]
  └── channels: Channel[] (ManyToMany)

Administrator
  ├── user: User
  └── customFields

User
  ├── roles: Role[]
  └── authenticationMethods: AuthenticationMethod[]
```

### Authorization Flow

```
@Allow(Permission.ReadProduct)     ← Resolver decorator
         │
         ▼
AuthGuard checks:
  1. session.user.channelPermissions
     └── Find permissions for ctx.channelId
  2. userHasPermissions(requiredPermissions)
     └── OR logic: user has ANY of required permissions
  3. SuperAdmin bypasses all checks
```

### Key Observations for Multi-tenant

- Permissions are **per-channel**, not global
- `SuperAdmin` permission grants access to **ALL** channels → **security risk** in SaaS
- No concept of "Tenant Admin" vs "Global Admin" distinction
- Role assignment is channel-scoped via join table

---

## 8. API Layer

### GraphQL APIs

| API | Path | Purpose | Auth Default |
|-----|------|---------|-------------|
| Admin API | `/admin-api` | Back-office management | Authenticated |
| Shop API | `/shop-api` | Storefront operations | Public + Owner |

### Channel Resolution in API

- Both APIs use `vendure-token` header to identify the active channel
- Without `vendure-token`, requests are routed to the **default channel**
- Admin API resolvers are protected by `@Allow(Permission.Xxx)` decorators
- Shop API resolvers use `Permission.Public` or `Permission.Owner`

### Configurable Options

| Config | Default | Description |
|--------|---------|-------------|
| `channelTokenKey` | `'vendure-token'` | Header name for channel identification |
| `tokenMethod` | `['bearer', 'cookie']` | Session token transport |
| `disableAuth` | `false` | Global auth toggle |
| `requireVerification` | `true` | Email verification requirement |

---

## 9. Plugin System

### VendurePlugin Decorator

Vendure plugins are NestJS modules with extended capabilities:

```
@VendurePlugin({
    imports: [PluginCommonModule],     // Required: provides core services
    entities: [],                      // Custom TypeORM entities
    adminApiExtensions: {              // Admin API schema + resolvers
        schema: gql`...`,
        resolvers: [...]
    },
    shopApiExtensions: {               // Shop API schema + resolvers
        schema: gql`...`,
        resolvers: [...]
    },
    providers: [],                     // NestJS providers
    configuration: (config) => config, // Modify VendureConfig at startup
    compatibility: '^3.0.0',           // Version constraint
})
```

### Extension Points Available

| Extension | Mechanism | Multi-tenant Use |
|-----------|-----------|-----------------|
| Custom Entities | TypeORM entities registered via plugin | Tenant-specific entities |
| Custom Fields | `customFields` config | Add tenant metadata to existing entities |
| API Extensions | GraphQL schema + resolvers | Tenant management APIs |
| Event Listeners | EventBus subscription | React to tenant events |
| Strategies | Config strategy override | Custom tenant logic |
| Middleware | NestJS middleware/guards | Tenant detection |
| `configuration` callback | Modify VendureConfig | Global config changes |

### Reference: Multivendor Plugin Pattern

The `multivendor-plugin` demonstrates a proto-multi-tenant pattern:
1. **Seller** creation → represents a vendor
2. **Channel** creation → linked to Seller, with unique token
3. **Role + Administrator** → scoped to the new Channel
4. **ShippingMethod + StockLocation** → assigned to the Channel

---

## 10. Current Custom Code

### qtable-plugin (packages/qtable-plugin/)

```
qtable-plugin/
├── src/
│   ├── api/         # (empty)
│   ├── entities/    # (empty)
│   ├── events/      # (empty)
│   ├── services/    # (empty)
│   ├── index.ts     # Re-exports plugin
│   └── qtable.plugin.ts  # Empty scaffold
├── e2e/             # (empty)
├── package.json
└── tsconfig.json
```

**Status:** Empty scaffold. No custom entities, services, resolvers, or event handlers.  
**Assessment:** Clean starting point for multi-tenant implementation.

### dev-config.ts

Active plugins in development:
- ReviewsPlugin (test plugin)
- GraphiqlPlugin
- AssetServerPlugin
- DefaultSearchPlugin
- DefaultJobQueuePlugin
- DefaultSchedulerPlugin
- EmailPlugin
- AdminUiPlugin + DashboardPlugin

**Not active:** MultivendorPlugin (commented out), ElasticsearchPlugin, BullMQJobQueuePlugin

---

## 11. Database Setup

| Environment | Database | Config |
|-------------|----------|--------|
| Development | MariaDB (Docker) | `docker-compose up -d mariadb` |
| Testing | SQLite | `DB=sqlite` |
| Production | TBD (Postgres recommended) | Via env vars |

### TypeORM Configuration

- Synchronize: `true` in development (auto-schema sync)
- Migrations: supported via `packages/dev-server/migrations/`
- Connection options: host, port, username, password, database, schema

### Key Observations

- No database-level tenant isolation
- No Row-Level Security (RLS) configured
- No per-tenant database or schema separation
- All data in single database, single schema

---

## 12. Infrastructure

### Docker Compose Services (Development)

| Service | Purpose | Multi-tenant Relevance |
|---------|---------|----------------------|
| MariaDB | Primary database | Single instance shared |
| PostgreSQL 16 | Alternative database | Supports RLS (useful for tenants) |
| Redis | Caching/job queue | Needed for session sharing in scaled setup |
| Elasticsearch | Search | Index per tenant consideration |
| Keycloak | OAuth/OIDC | Potential tenant SSO |
| Jaeger | Distributed tracing | Observability per tenant |
| Grafana + Loki | Monitoring + logs | Tenant-aware monitoring |

---

## 13. Development Guidelines

> [!CAUTION]
> **KHÔNG sửa trực tiếp các file trong `packages/`.**
>
> Mọi custom business logic PHẢI đi qua **Vendure plugin system**.
> Sửa trực tiếp core sẽ block upgrade từ upstream và tạo merge conflict vĩnh viễn.

### How to Extend Vendure

| Method | Description | Example |
|--------|------------|---------|
| **Custom Plugin** | NestJS module via `@VendurePlugin()` | `packages/qtable-plugin/` |
| **Custom Fields** | Add fields to existing entities via config | `customFields.Product` |
| **Strategy Overrides** | Override auth, tax, shipping, payment strategies | `config.authOptions.authenticationStrategy` |
| **Event Listeners** | React to domain events via `EventBus.ofType()` | `OrderStateTransitionEvent` |

### Plugin Development Reference

| Example | Location | Description |
|---------|----------|-------------|
| Reviews Plugin | `packages/dev-server/test-plugins/reviews/` | Full-featured: entities, resolvers, dashboard UI |
| Multivendor | `packages/dev-server/example-plugins/multivendor-plugin/` | Complex marketplace logic |
| Wishlist | `packages/dev-server/example-plugins/wishlist-plugin/` | Simple CRUD plugin |
| Digital Products | `packages/dev-server/example-plugins/digital-products/` | Custom fulfillment |

### Upstream Sync Strategy

```bash
git fetch upstream
git merge upstream/master
# If conflicts in packages/, ALWAYS accept upstream:
git checkout --theirs packages/<conflicting-file>
```

Sync nên thực hiện **hàng tuần** hoặc khi upstream release phiên bản mới.

---

## Summary Assessment

| Aspect | Current State | Multi-tenant Readiness |
|--------|--------------|----------------------|
| Data Isolation | Channel-based (ManyToMany) | ⚠️ Shared data, not isolated |
| Tenant Identity | `vendure-token` header | ⚠️ No domain-based detection |
| RBAC | Per-channel permissions | ⚠️ SuperAdmin crosses boundaries |
| Custom Code | Empty scaffold | ✅ Clean starting point |
| Database | Single DB, single schema | ⚠️ No RLS, no tenant constraints |
| Plugin System | Comprehensive | ✅ Supports needed extensions |
| Event System | Full domain events | ✅ Supports tenant lifecycle events |
| API Layer | Admin + Shop GraphQL | ⚠️ No tenant management API |
| Infrastructure | Docker Compose (dev) | ⚠️ Not production-ready |
