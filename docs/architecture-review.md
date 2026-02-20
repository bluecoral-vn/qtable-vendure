# Architecture Review — qtable-vendure

> **Date:** 2026-02-20
> **Purpose:** Internal architecture review for Multi-tenant SaaS readiness
> **Scope:** Vendure core + qtable-saas + current state + technical debt + constraints

---

## Table of Contents

1. [Repository Structure](#1-repository-structure)
2. [Current State Assessment](#2-current-state-assessment)
3. [Core Architecture](#3-core-architecture)
4. [Entity & Data Model](#4-entity--data-model)
5. [Channel System](#5-channel-system)
6. [Request Lifecycle](#6-request-lifecycle)
7. [RBAC & Authorization](#7-rbac--authorization)
8. [Plugin System](#8-plugin-system)
9. [Vendure Core Constraints](#9-vendure-core-constraints)
10. [Technical Debt](#10-technical-debt)
11. [Infrastructure Debt](#11-infrastructure-debt)

---

## 1. Repository Structure

```
qtable-vendure/
├── packages/                     # Vendure upstream (21 packages) — DO NOT MODIFY
│   ├── core/                     # NestJS + TypeORM + GraphQL server
│   ├── common/                   # Shared types, generated GraphQL types
│   ├── dashboard/                # New React 19 admin UI
│   ├── admin-ui/                 # Legacy Angular 19 admin UI
│   ├── dev-server/               # Development environment
│   │   ├── dev-config.ts         # VendureConfig for dev
│   │   └── example-plugins/
│   │       └── multivendor-plugin/  # ⭐ Key reference for multi-tenant
│   ├── qtable-saas/            # ⭐ Custom QTable plugin (empty scaffold)
│   ├── asset-server-plugin/      # Asset serving + S3
│   ├── email-plugin/             # Email notifications
│   ├── job-queue-plugin/         # BullMQ / Pub-Sub jobs
│   └── ...                       # Other official plugins
├── .agent/                       # AI agent skills + workflows
├── docs/                         # Documentation
├── scripts/                      # Build/check scripts
├── docker-compose.yml            # Dev infrastructure
└── lerna.json                    # Monorepo management (v3.5.2)
```

---

## 2. Current State Assessment

### What Exists

| Component | Status | Detail |
|-----------|--------|--------|
| Vendure core v3.5.2 | ✅ Complete | Forked, all 21 packages intact |
| Plugin scaffold | ✅ Created | `packages/qtable-saas/` — empty scaffold |
| Docker dev infra | ✅ Working | MariaDB, PostgreSQL, Redis, Elasticsearch, Keycloak, Jaeger, Grafana |
| Architecture docs | ✅ Written | 10 design documents |

### What Does NOT Exist

| Component | Status | Impact |
|-----------|--------|--------|
| Tenant entity/service | ❌ | No tenant abstraction layer |
| TenantDomain entity | ❌ | No domain → tenant mapping |
| TenantContextMiddleware | ❌ | No domain-based tenant detection |
| TenantGuard | ❌ | No cross-tenant protection guard |
| PostgreSQL RLS policies | ❌ | No DB-level isolation safety net |
| Audit logging | ❌ | No security event tracking |
| Migration workflow | ❌ | Using `synchronize: true` |
| Redis session/cache | ❌ | In-memory only |
| Any custom business logic | ❌ | Plugin is completely empty |

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
│            │  1. Extract token           │                    │
│            │  2. Load Session            │                    │
│            │  3. Resolve Channel         │                    │
│            │  4. Build RequestContext     │                    │
│            │  5. Check Permissions       │                    │
│            └──────┬──────────────────────┘                    │
│                   │                                          │
│            ┌──────▼──────────────────────┐                    │
│            │   Service Layer              │                    │
│            └──────┬──────────────────────┘                    │
│                   │                                          │
│            ┌──────▼──────────────────────┐                    │
│            │   TransactionalConnection    │                    │
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

### Channel-Aware Pattern (ManyToMany)

Entities implementing `ChannelAware` have a `channels: Channel[]` relationship via join tables. This means entity data is **shared** across channels via association rather than copied.

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
| `customFields` | CustomChannelFields | Extensible via custom fields |

### Channel Detection

- `vendure-token` header → `ChannelService.getChannelFromToken(token)` → Channel entity
- Default Channel always exists (created at bootstrap)
- Token-based resolution is the **only** built-in detection mechanism
- No built-in domain/subdomain-based detection

---

## 6. Request Lifecycle

```
1. HTTP Request arrives
   └── Header: vendure-token: <channel_token>
       Header: Authorization: Bearer <session_token>

2. AuthGuard.canActivate()
   ├── extractSessionToken(req) → session token
   ├── SessionService.getSessionFromToken(token) → CachedSession
   ├── RequestContextService.fromRequest(req) → Creates RequestContext
   ├── setActiveChannel() — ensures session tracks active channel
   └── internal_setRequestContext(req, ctx)

3. GraphQL Resolver executes
   ├── @Ctx() decorator extracts RequestContext from req
   └── Service method receives ctx

4. Query execution
   ├── Services filter by ctx.channelId
   ├── ListQueryBuilder applies channel filters
   └── ChannelService.assignToCurrentChannel() for writes
```

### RequestContext Contents

| Property | Source | Description |
|----------|--------|-------------|
| `channel` | `vendure-token` header | Active Channel entity |
| `channelId` | Derived from channel | Channel ID |
| `session` | Session token | User session with permissions |
| `activeUserId` | Session | Current user ID |
| `apiType` | URL path | `'admin'` or `'shop'` |

---

## 7. RBAC & Authorization

### Permission Model

```
Permission (enum, ~80 values)
  ├── CRUD: CreateProduct, ReadProduct, UpdateProduct, DeleteProduct
  ├── Special: SuperAdmin, Owner, Public, Authenticated
  └── Custom permissions (extensible via plugins)

Role → permissions: Permission[] + channels: Channel[] (ManyToMany)
User → roles: Role[]
```

### Key Observations for Multi-tenant

- Permissions are **per-channel**, not global
- `SuperAdmin` bypasses all checks → **security risk** in SaaS
- No distinction between "Tenant Admin" vs "Global Admin"
- Role assignment is channel-scoped via join table

---

## 8. Plugin System

### VendurePlugin Capabilities

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
1. Seller creation → represents a vendor
2. Channel creation → linked to Seller, with unique token
3. Role + Administrator → scoped to the new Channel
4. ShippingMethod + StockLocation → assigned to the Channel

---

## 9. Vendure Core Constraints

### Things We CANNOT Change

| Constraint | Impact | Workaround |
|-----------|--------|------------|
| Channel is ManyToMany | Cannot enforce 1:1 at DB level | Tenant layer on top forces 1:1 |
| SuperAdmin bypasses all guards | Cannot restrict from outside | Custom guard/interceptor + audit |
| `vendure-token` is header-based | Cannot change to domain-based | Custom middleware overrides |
| Default Channel always exists | Cannot remove | Restrict access via RBAC |
| GlobalSettings is singleton | Cannot have per-tenant settings | Custom TenantSettings entity |
| Session cache is in-memory | Cannot share across instances | Redis session cache |
| Entity metadata is static | Cannot add dynamic columns | Use `customFields` or separate entities |

### Things We CAN Change (via plugin system)

| Capability | Mechanism |
|-----------|-----------|
| Add new entities | `@VendurePlugin({ entities: [...] })` |
| Add custom fields | `customFields` config |
| Add API endpoints | `adminApiExtensions` / `shopApiExtensions` |
| Add middleware/guards | NestJS middleware via plugin `configuration` |
| Override strategies | `configuration` callback modifying VendureConfig |
| Subscribe to events | `EventBus.ofType(...)` |
| Add background jobs | JobQueueService |
| Run code at startup | `OnApplicationBootstrap` lifecycle hook |

---

## 10. Technical Debt

### Critical — Blocks Multi-tenant

| ID | Debt | Impact | Status |
|----|------|--------|--------|
| TD-1 | **No Tenant Abstraction Layer** — Direct use of Channel without Tenant wrapper | 🔴 Blocks all multi-tenant work | Unresolved |
| TD-2 | **No Database Isolation** — No RLS, any unfiltered query leaks all data | 🔴 Critical security risk | Unresolved |
| TD-3 | **No Production DB Config** — MariaDB + `synchronize: true` | 🔴 Production blocker | Unresolved |
| TD-4 | **SuperAdmin Has No Boundaries** — No audit, no restrictions | 🟡 Security concern | Unresolved |

### Architecture Violations

| ID | Violation | Impact |
|----|-----------|--------|
| AV-1 | **ManyToMany allows cross-channel data sharing** — Product can exist in multiple tenant channels | Breaks tenant isolation principle |
| AV-2 | **Customer auto-assignment** — `AuthGuard.setActiveChannel()` leaks customers across channels | Privacy violation |
| AV-3 | **Default Channel = "god mode"** — Sees all data, cannot be deleted | Security risk |
| AV-4 | **No tenant-scoped configuration** — GlobalSettings is singleton | Feature gap |
| AV-5 | **EventBus has no tenant filtering** — Events broadcast globally to all subscribers | Data leakage risk |

### Technical Debt Prevention Rules

- Every new entity MUST define its RLS policy at creation time
- Every new query MUST include `channelId` filter
- Every new cache key MUST include tenant/channel scope
- Every new provisioning step MUST be idempotent
- Every new feature MUST have multi-tenant isolation test

---

## 11. Infrastructure Debt

| ID | Debt | Impact | Required |
|----|------|--------|----------|
| ID-1 | **No Redis** — In-memory sessions, in-memory cache | Blocks horizontal scaling | Redis for sessions, jobs, cache |
| ID-2 | **No Container/K8s** — Docker Compose dev only | Blocks production deployment | Dockerfile, K8s manifests |
| ID-3 | **No CI/CD for multi-tenant** — Only upstream Vendure CI | Blocks automated isolation testing | CI pipeline for tenant tests |
| ID-4 | **No per-tenant monitoring** — General observability only | Cannot detect tenant-specific issues | Tenant-tagged metrics |
| ID-5 | **No backup strategy** — No mechanism for individual tenant restore | Cannot recover tenant data | Per-tenant logical backup |

### Priority Matrix

```
                    HIGH IMPACT                     LOW IMPACT
                ┌─────────────────────────────┬─────────────────────────┐
   URGENT       │ TD-1: Tenant Abstraction    │ ID-1: Redis Setup       │
   (Do First)   │ TD-2: DB Isolation          │                         │
                │ TD-3: Prod DB Config        │                         │
                ├─────────────────────────────┼─────────────────────────┤
   IMPORTANT    │ TD-4: SuperAdmin Boundary   │ ID-4: Monitoring        │
   (Do Next)    │ AV-2: Customer Leakage      │ ID-5: Backup Strategy   │
                ├─────────────────────────────┼─────────────────────────┤
   LATER        │ AV-4: Tenant Config         │ ID-3: CI/CD             │
                │ AV-5: Event Filtering       │                         │
                └─────────────────────────────┴─────────────────────────┘
```

---

## Development Guidelines

> [!CAUTION]
> **KHÔNG sửa trực tiếp các file trong `packages/`.**
>
> Mọi custom business logic PHẢI đi qua **Vendure plugin system**.
> Sửa trực tiếp core sẽ block upgrade từ upstream và tạo merge conflict vĩnh viễn.

### Upstream Sync Strategy

```bash
git fetch upstream
git merge upstream/master
# If conflicts in packages/, ALWAYS accept upstream:
git checkout --theirs packages/<conflicting-file>
```
