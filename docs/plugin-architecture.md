# Plugin Architecture — Multi-Tenant

> **Date:** 2026-02-20  
> **Purpose:** Architecture design for multi-tenant plugin system in Vendure  
> **Scope:** Plugin structure, lifecycle hooks, RequestContext extension, service layer injection

---

## Table of Contents

1. [Should Channel Be Used as Tenant?](#1-should-channel-be-used-as-tenant)
2. [Plugin Structure](#2-plugin-structure)
3. [Lifecycle Hooks](#3-lifecycle-hooks)
4. [RequestContext Extension](#4-requestcontext-extension)
5. [Middleware Strategy](#5-middleware-strategy)
6. [Service Layer Integration](#6-service-layer-integration)
7. [Entity Design](#7-entity-design)
8. [API Design](#8-api-design)

---

## 1. Should Channel Be Used as Tenant?

### Analysis

| Approach | Pros | Cons |
|----------|------|------|
| **Channel = Tenant** | Leverages ALL existing filtering; zero changes to core queries | Inherits ManyToMany sharing; limited tenant metadata |
| **Separate Tenant entity** | Full control over tenant lifecycle; clean domain model | Must replicate or bridge Channel filtering |
| **Tenant wraps Channel** ✅ | Best of both worlds; uses Channel for data filtering, Tenant for business logic | Slight indirection cost |

### Decision: Tenant Wraps Channel

```
┌─────────────────────────────────────────────────────────┐
│                    Tenant Entity                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │ id, name, slug, domain, status, plan              │  │
│  │ config (JSON), createdAt, suspendedAt, deletedAt  │  │
│  └───────────────────┬───────────────────────────────┘  │
│                      │ 1:1                              │
│  ┌───────────────────▼───────────────────────────────┐  │
│  │               Channel (Vendure)                    │  │
│  │ token, code, currency, language, tax, shipping     │  │
│  │ → Used for ALL existing data filtering             │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

**Why this approach:**
- Vendure's ListQueryBuilder, service methods, and resolvers all filter by `ctx.channelId`
- Reusing Channel means **zero changes to Vendure core**
- Tenant entity adds SaaS-specific logic: domain routing, subscription, lifecycle states

---

## 2. Plugin Structure

### Proposed Plugin Layout

```
packages/qtable-plugin/
├── src/
│   ├── qtable.plugin.ts              # Plugin entry point
│   │
│   ├── entities/
│   │   ├── tenant.entity.ts           # Tenant entity (wraps Channel)
│   │   ├── tenant-config.entity.ts    # Per-tenant configuration
│   │   └── tenant-domain.entity.ts    # Domain/subdomain mapping
│   │
│   ├── services/
│   │   ├── tenant.service.ts          # Tenant CRUD + lifecycle
│   │   ├── tenant-resolution.service.ts # Domain → Tenant resolution
│   │   └── tenant-provisioning.service.ts # Onboarding automation
│   │
│   ├── api/
│   │   ├── resolvers/
│   │   │   ├── tenant-admin.resolver.ts   # Global admin: manage tenants
│   │   │   └── tenant-self.resolver.ts    # Tenant admin: manage own tenant
│   │   ├── schema/
│   │   │   ├── tenant-admin.api.graphql
│   │   │   └── tenant-shop.api.graphql
│   │   └── middleware/
│   │       └── tenant-context.middleware.ts # Domain → Channel resolution
│   │
│   ├── events/
│   │   ├── tenant-created.event.ts
│   │   ├── tenant-suspended.event.ts
│   │   └── tenant-deleted.event.ts
│   │
│   ├── guards/
│   │   └── tenant-guard.ts           # Cross-tenant access prevention
│   │
│   ├── strategies/
│   │   └── tenant-aware-auth.strategy.ts
│   │
│   └── config/
│       └── tenant-plugin-options.ts
│
├── e2e/
│   ├── tenant-isolation.e2e-spec.ts
│   └── tenant-lifecycle.e2e-spec.ts
│
├── package.json
└── tsconfig.json
```

---

## 3. Lifecycle Hooks

### Where the Plugin Hooks into Vendure

| Hook | Purpose | Mechanism |
|------|---------|-----------|
| **Bootstrap** (`OnApplicationBootstrap`) | Initialize tenant cache, validate default channel | NestJS lifecycle |
| **Per-Request** (NestJS Middleware) | Resolve domain → tenant → channel | `configuration` callback |
| **AuthGuard** (Custom Guard) | Enforce tenant boundaries after auth | Custom guard wrapping existing AuthGuard |
| **Entity Save** (TypeORM Subscriber) | Ensure tenant association on write | TypeORM entity subscriber |
| **Query Execution** (Query Interceptor) | Verify channel filter presence | TypeORM query subscriber |
| **Event Processing** (EventBus Subscriber) | Filter events by tenant | EventBus.ofType() |
| **Job Processing** (Job Queue) | Carry tenant context into background jobs | RequestContext serialization |

### Request Lifecycle with Tenant Plugin

```
1. HTTP Request
   │
2. TenantContextMiddleware (NEW)
   ├── Extract domain from Host header
   ├── TenantResolutionService.resolve(domain)
   │   └── Returns { tenantId, channelToken }
   ├── Inject vendure-token header if not present
   └── Attach tenantId to request object
   │
3. AuthGuard (Vendure built-in)
   ├── Session validation
   ├── Channel resolution (uses vendure-token)
   └── RequestContext creation
   │
4. TenantGuard (NEW, runs after AuthGuard)
   ├── Verify ctx.channelId matches resolved tenantId
   ├── Prevent Default Channel access for non-global-admins
   └── Log cross-tenant attempt if detected
   │
5. Resolver + Service Layer
   │
6. Database query (with channel filter)
```

---

## 4. RequestContext Extension

### Approach: Do NOT extend RequestContext class

Extending `RequestContext` would require modifying Vendure core. Instead:

### Option A: Use Request Object (Recommended)

Store tenant information on the Express Request object:

```
req[TENANT_CONTEXT_KEY] = {
    tenantId: string,
    tenantSlug: string,
    tenantStatus: 'active' | 'suspended' | 'trial',
    planId: string,
    domain: string,
}
```

Access pattern: Create a `@TenantCtx()` decorator that extracts tenant info from `req`.

### Option B: Use Channel Custom Fields

Add tenant metadata to Channel's `customFields`:
- `tenantId` → Tenant entity reference
- `tenantSlug`
- `tenantStatus`

Access via `ctx.channel.customFields.tenantId`.

### Recommended: Option A + Option B Combined

- **Option A** for runtime tenant context (plan limits, feature flags, status)
- **Option B** for persistent tenant link (stored in DB, survives restarts)

---

## 5. Middleware Strategy

### Global Middleware Required?

**Yes.** A global NestJS middleware is needed to resolve tenant from domain before Vendure's AuthGuard runs.

### Registration via Plugin Configuration

The middleware is registered via the plugin's `configuration` callback:

```
@VendurePlugin({
    configuration: (config) => {
        config.apiOptions.middleware.push({
            handler: TenantContextMiddleware,
            route: '*',
            beforeListen: true,
        });
        return config;
    },
})
```

### Middleware Responsibilities

| Responsibility | Details |
|---------------|---------|
| Domain resolution | `Host` header → TenantDomain entity lookup |
| Channel token injection | Set `vendure-token` header from resolved tenant |
| Tenant status check | Reject requests for suspended/deleted tenants |
| Caching | Cache domain → tenant mapping (Redis or in-memory) |
| Fallback | Unknown domain → 404 or redirect to platform |

### Middleware Flow Diagram

```
┌──────────────────────────────────────────────────────────┐
│                   TenantContextMiddleware                 │
│                                                          │
│  Host: store-a.qtable.vn                                │
│      │                                                   │
│      ▼                                                   │
│  ┌─────────────────────────────┐                        │
│  │ TenantResolutionService     │                        │
│  │ ┌─────────────────────────┐ │                        │
│  │ │ 1. Check cache          │ │                        │
│  │ │ 2. Query TenantDomain   │ │                        │
│  │ │ 3. Return Tenant +      │ │                        │
│  │ │    Channel token        │ │                        │
│  │ └─────────────────────────┘ │                        │
│  └──────────┬──────────────────┘                        │
│             │                                           │
│      ┌──────▼────────────────────────┐                  │
│      │ Tenant Status Check            │                  │
│      │ ├── active  → continue        │                  │
│      │ ├── suspended → 403           │                  │
│      │ ├── trial   → continue + flag │                  │
│      │ └── deleted → 404             │                  │
│      └──────┬────────────────────────┘                  │
│             │                                           │
│      ┌──────▼────────────────────────┐                  │
│      │ Inject vendure-token header   │                  │
│      │ Attach tenant context to req  │                  │
│      └───────────────────────────────┘                  │
└──────────────────────────────────────────────────────────┘
```

---

## 6. Service Layer Integration

### How Tenant Context Flows Through Services

```
Resolver (@Ctx() ctx, @TenantCtx() tenant)
    │
    ▼
Service.method(ctx, ...)
    │ ctx.channelId → used for data filtering (existing behavior)
    │ tenant.tenantId → used for tenant-specific logic (new)
    │
    ▼
TransactionalConnection.getRepository(ctx, Entity)
    │ TypeORM query with channel filter
    │
    ▼
Database (RLS enforces channelId match)
```

### Service Categories

| Category | Tenant Awareness | Changes Needed |
|----------|-----------------|---------------|
| **Core Vendure services** | Already filter by `ctx.channelId` | None (Channel = Tenant) |
| **Custom tenant services** | New, fully tenant-aware | Design from scratch |
| **Background jobs** | Must carry tenant context | Serialize tenant info in job data |
| **Event handlers** | Must filter by tenant | Check event's channel against subscriber's tenant |

---

## 7. Entity Design

### Tenant Entity

| Field | Type | Description |
|-------|------|-------------|
| `id` | ID (auto) | Primary key |
| `name` | string | Display name (store name) |
| `slug` | string (unique) | URL-safe identifier |
| `status` | enum | `active`, `trial`, `suspended`, `deleted` |
| `channelId` | FK → Channel | 1:1 link to Vendure Channel |
| `ownerId` | FK → Administrator | Tenant owner (first admin) |
| `plan` | string | Subscription plan identifier |
| `config` | jsonb | Per-tenant configuration blob |
| `createdAt` | timestamp | |
| `updatedAt` | timestamp | |
| `suspendedAt` | timestamp? | When suspended |
| `deletedAt` | timestamp? | Soft delete |

### TenantDomain Entity

| Field | Type | Description |
|-------|------|-------------|
| `id` | ID | Primary key |
| `domain` | string (unique) | Full domain or subdomain |
| `tenantId` | FK → Tenant | Owner tenant |
| `isPrimary` | boolean | Primary domain flag |
| `sslStatus` | enum | SSL certificate status |
| `verifiedAt` | timestamp? | Domain ownership verified |

### TenantConfig (within `config` jsonb)

| Key | Type | Description |
|-----|------|-------------|
| `maxProducts` | number | Product limit |
| `maxAdmins` | number | Admin account limit |
| `maxStorage` | number (MB) | Asset storage limit |
| `features` | string[] | Enabled feature flags |
| `theme` | object | Branding configuration |
| `emailFrom` | string | Custom sender email |
| `timezone` | string | Tenant timezone |

---

## 8. API Design

### Admin API Extensions (Global Admin)

| Operation | Permission | Description |
|-----------|-----------|-------------|
| `tenants` (query) | `SuperAdmin` | List all tenants with filtering |
| `tenant(id)` (query) | `SuperAdmin` | Get tenant details |
| `createTenant` (mutation) | `SuperAdmin` | Provision new tenant |
| `updateTenant` (mutation) | `SuperAdmin` | Update tenant config |
| `suspendTenant` (mutation) | `SuperAdmin` | Suspend tenant |
| `deleteTenant` (mutation) | `SuperAdmin` | Soft-delete tenant |
| `reactivateTenant` (mutation) | `SuperAdmin` | Reactivate suspended tenant |

### Admin API Extensions (Tenant Self-Service)

| Operation | Permission | Description |
|-----------|-----------|-------------|
| `myTenant` (query) | `Authenticated` | Get own tenant info |
| `updateMyTenant` (mutation) | Custom: `ManageTenant` | Update own tenant config |
| `addDomain` (mutation) | Custom: `ManageTenant` | Add custom domain |
| `removeDomain` (mutation) | Custom: `ManageTenant` | Remove custom domain |

### Shop API Extensions

| Operation | Permission | Description |
|-----------|-----------|-------------|
| `registerTenant` (mutation) | `Public` | Self-service tenant registration |
| `tenantInfo` (query) | `Public` | Public tenant info (name, branding) |
