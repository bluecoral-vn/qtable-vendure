# Plugin Architecture — Multi-Tenant

> **Date:** 2026-02-20
> **Purpose:** Architecture design for multi-tenant plugin system in Vendure
> **Scope:** Plugin structure, lifecycle hooks, RequestContext extension, middleware, service layer, entities, API

---

## Table of Contents

1. [Tenant Wraps Channel](#1-tenant-wraps-channel)
2. [Plugin Structure](#2-plugin-structure)
3. [Lifecycle Hooks](#3-lifecycle-hooks)
4. [RequestContext Extension](#4-requestcontext-extension)
5. [Middleware Strategy](#5-middleware-strategy)
6. [Service Layer Integration](#6-service-layer-integration)
7. [Entity Design](#7-entity-design)
8. [API Design](#8-api-design)

---

## 1. Tenant Wraps Channel

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
- Vendure's ListQueryBuilder, services, and resolvers all filter by `ctx.channelId`
- Reusing Channel means **zero changes to Vendure core**
- Tenant entity adds SaaS-specific logic: domain routing, subscription, lifecycle states

---

## 2. Plugin Structure

```
packages/qtable-saas/
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
│   │   │   └── tenant-self.resolver.ts    # Tenant admin: manage own
│   │   ├── schema/
│   │   │   ├── tenant-admin.api.graphql
│   │   │   └── tenant-shop.api.graphql
│   │   └── middleware/
│   │       └── tenant-context.middleware.ts
│   │
│   ├── events/
│   │   ├── tenant-created.event.ts
│   │   ├── tenant-suspended.event.ts
│   │   └── tenant-deleted.event.ts
│   │
│   ├── guards/
│   │   └── tenant-guard.ts
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
| **Bootstrap** | Initialize tenant cache, validate default channel | `OnApplicationBootstrap` |
| **Per-Request** | Resolve domain → tenant → channel | NestJS Middleware |
| **AuthGuard** | Enforce tenant boundaries after auth | Custom guard |
| **Entity Save** | Ensure tenant association on write | TypeORM subscriber |
| **Query Execution** | Verify channel filter presence | TypeORM query subscriber |
| **Event Processing** | Filter events by tenant | `EventBus.ofType()` |
| **Job Processing** | Carry tenant context into background jobs | RequestContext serialization |

### Request Lifecycle with Tenant Plugin

```
1. HTTP Request
   │
2. TenantContextMiddleware (NEW)
   ├── Extract domain from Host header
   ├── TenantResolutionService.resolve(domain)
   ├── OVERRIDE vendure-token header
   └── Attach tenantId to request object
   │
3. AuthGuard (Vendure built-in)
   ├── Session validation
   ├── Channel resolution (uses overridden vendure-token)
   └── RequestContext creation
   │
4. TenantGuard (NEW)
   ├── Verify ctx.channelId matches resolved tenantId
   ├── Block Default Channel for non-global-admins
   └── Log cross-tenant attempt if detected
   │
5. Resolver + Service Layer
   │
6. Database query (with channel filter + RLS)
```

---

## 4. RequestContext Extension

### Approach: DO NOT extend RequestContext class

Extending `RequestContext` requires modifying Vendure core. Instead, use combined approach:

### Request Object (Runtime context)

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

Access via `@TenantCtx()` custom parameter decorator.

### Channel Custom Fields (Persistent link)

Add tenant metadata to Channel's `customFields`:
- `tenantId` → Tenant entity reference
- `tenantSlug`

Access via `ctx.channel.customFields.tenantId`.

**Combined:** Request object for runtime (plan, limits, status), Channel customFields for persistent DB link.

---

## 5. Middleware Strategy

### Registration via Plugin Configuration

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
| Token override | ALWAYS override `vendure-token` from resolved tenant |
| Status check | Reject suspended/deleted tenants |
| Caching | Cache domain → tenant mapping (Redis) |
| Fallback | Unknown domain → 404 (NEVER Default Channel) |

---

## 6. Service Layer Integration

### Context Flow

```
Resolver (@Ctx() ctx, @TenantCtx() tenant)
    │
    ▼
Service.method(ctx, ...)
    │ ctx.channelId → data filtering (existing)
    │ tenant.tenantId → tenant-specific logic (new)
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
| **Core Vendure services** | Already filter by `ctx.channelId` | None |
| **Custom tenant services** | Fully tenant-aware | Design from scratch |
| **Background jobs** | Must carry tenant context | Serialize tenant info |
| **Event handlers** | Must filter by tenant | Check event's channel |

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
| `ownerId` | FK → Administrator | Tenant owner |
| `plan` | string | Subscription plan identifier |
| `config` | jsonb | Per-tenant configuration |
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

---

## 8. API Design

### Admin API Extensions (Global Admin)

| Operation | Permission | Description |
|-----------|-----------|-------------|
| `tenants` (query) | `ManageTenants` | List all tenants |
| `tenant(id)` (query) | `ManageTenants` | Get tenant details |
| `createTenant` (mutation) | `ManageTenants` | Provision new tenant |
| `updateTenant` (mutation) | `ManageTenants` | Update tenant config |
| `suspendTenant` (mutation) | `ManageTenants` | Suspend tenant |
| `deleteTenant` (mutation) | `ManageTenants` | Soft-delete tenant |
| `reactivateTenant` (mutation) | `ManageTenants` | Reactivate |

### Admin API Extensions (Tenant Self-Service)

| Operation | Permission | Description |
|-----------|-----------|-------------|
| `myTenant` (query) | `Authenticated` | Get own tenant info |
| `updateMyTenant` (mutation) | `ManageTenant` | Update own config |
| `addDomain` (mutation) | `ManageTenant` | Add custom domain |
| `removeDomain` (mutation) | `ManageTenant` | Remove custom domain |

### Shop API Extensions

| Operation | Permission | Description |
|-----------|-----------|-------------|
| `registerTenant` (mutation) | `Public` | Self-service registration |
| `tenantInfo` (query) | `Public` | Public tenant info |
