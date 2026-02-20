# Tenant Isolation Design — qtable-vendure

> **Date:** 2026-02-20  
> **Purpose:** Design for enforcing tenant data isolation at every layer  
> **Scope:** ORM-level enforcement, query constraints, service layer injection

---

## Table of Contents

1. [Isolation Strategy Overview](#1-isolation-strategy-overview)
2. [ORM-Level Enforcement](#2-orm-level-enforcement)
3. [Query Constraint Enforcement](#3-query-constraint-enforcement)
4. [Service Layer Injection](#4-service-layer-injection)
5. [Write Path Isolation](#5-write-path-isolation)
6. [Read Path Isolation](#6-read-path-isolation)
7. [Edge Cases](#7-edge-cases)

---

## 1. Isolation Strategy Overview

### Defense-in-Depth Model

```
┌─────────────────────────────────────────────────────────┐
│  Layer 1: API / Middleware                               │
│  ┌─────────────────────────────────────────────────────┐│
│  │ Domain → Tenant resolution                          ││
│  │ vendure-token injection                             ││
│  │ Tenant status check (reject if suspended/deleted)   ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  Layer 2: Guard / Auth                                  │
│  ┌─────────────────────────────────────────────────────┐│
│  │ AuthGuard (Vendure): session → channel → permissions││
│  │ TenantGuard (Custom): verify ctx.channel matches    ││
│  │                       resolved tenant               ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  Layer 3: Service / Application                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ All queries use ctx.channelId                       ││
│  │ ListQueryBuilder auto-filters by channel            ││
│  │ Custom services MUST accept RequestContext          ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  Layer 4: Database / RLS                                │
│  ┌─────────────────────────────────────────────────────┐│
│  │ PostgreSQL RLS policies                             ││
│  │ SET app.current_tenant_id per connection            ││
│  │ Fallback safety if application layer fails          ││
│  └─────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

---

## 2. ORM-Level Enforcement

### Approach: TypeORM Subscriber + Global Scope

TypeORM provides two mechanisms for automatic query filtering:

### Mechanism A: TypeORM Subscriber (Event-based)

A TypeORM subscriber that intercepts all database operations:

| Event | Action |
|-------|--------|
| `beforeInsert` | Verify entity has correct channel assignment |
| `afterLoad` | Verify loaded entity belongs to current tenant |
| `beforeUpdate` | Verify update target belongs to current tenant |
| `beforeRemove` | Verify delete target belongs to current tenant |

**Limitation:** Subscribers don't intercept `QueryBuilder` queries, only entity-based operations.

### Mechanism B: Custom Query Runner Wrapper

Wrap TypeORM's QueryRunner to inject RLS context:

```
Connection established
  → SET app.current_tenant_id = <channelId>
  → All subsequent queries filtered by RLS
  → Connection returned to pool
  → RESET app.current_tenant_id
```

**Advantage:** Works for ALL queries, including raw SQL and QueryBuilder.

### Recommended: Both Mechanisms Combined

| Mechanism | Coverage | Purpose |
|-----------|----------|---------|
| TypeORM Subscriber | Entity operations | Application-level validation |
| RLS via QueryRunner | ALL queries | Database-level safety net |

---

## 3. Query Constraint Enforcement

### How Vendure Already Enforces Channel Filtering

Most Vendure services use `ListQueryBuilder`:

```
ListQueryBuilder
  .build(Product, options, {
      channelId: ctx.channelId,     // ← automatic channel filter
      relations: [...],
  })
```

This generates:
```sql
SELECT p.* FROM product p
INNER JOIN product_channels_channel pcc ON pcc.productId = p.id
WHERE pcc.channelId = :channelId
```

### Queries That BYPASS Channel Filtering

| Pattern | Risk | Where Found | Fix |
|---------|------|-------------|-----|
| `rawConnection.getRepository(X).find()` | 🔴 No channel filter | Plugin code, bootstrap | Always use `connection.getRepository(ctx, X)` |
| Direct `QueryBuilder` without channel join | 🟡 Missing filter | Custom queries | Audit and add channel filter |
| `connection.getEntityOrThrow(ctx, X, id)` | 🟢 Checks entity existence only | Service helpers | Add channel membership check after load |
| GlobalSettings queries | 🟢 Intentionally global | Core | N/A — not tenant data |
| Migration scripts | 🟡 Run without context | System tasks | Use system context with explicit channel |

### Ensuring All Custom Queries Have Tenant Constraint

Pattern to enforce in all custom services:

```
// GOOD — Uses RequestContext → channel filter applied
const products = await this.connection
    .getRepository(ctx, Product)
    .createQueryBuilder('product')
    .innerJoin('product.channels', 'ch', 'ch.id = :channelId', { channelId: ctx.channelId })
    .getMany();

// BAD — No channel filter
const products = await this.connection
    .rawConnection.getRepository(Product)
    .find();
```

### Linting Rule (Development-time Enforcement)

Establish ESLint custom rules or code review checklist:
- ❌ `rawConnection.getRepository()` without channel filter
- ❌ `QueryBuilder` without `channelId` condition
- ✅ All queries go through `ctx`-aware methods

---

## 4. Service Layer Injection

### Injecting Tenant Context into Services

```
┌─────────────────────────────────────────────────────────┐
│                  Resolver                                │
│  @Ctx() ctx: RequestContext                             │
│  @TenantCtx() tenant: TenantContext                     │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │  ctx.channelId                                      ││
│  │  ├── Used by ALL Vendure core services              ││
│  │  └── Ensures data filtering at ORM level            ││
│  │                                                     ││
│  │  tenant.tenantId                                    ││
│  │  ├── Used by custom tenant services                 ││
│  │  ├── Tenant config, limits, feature flags           ││
│  │  └── Audit logging                                  ││
│  └─────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

### TenantContext Shape

| Property | Type | Source |
|----------|------|--------|
| `tenantId` | ID | Resolved from domain or token |
| `channelId` | ID | From RequestContext |
| `slug` | string | Tenant slug |
| `status` | enum | `active`, `trial`, `suspended` |
| `plan` | string | `free`, `starter`, `pro`, `enterprise` |
| `config` | TenantConfig | Cached configuration |
| `limits` | TenantLimits | Plan-based resource limits |

### @TenantCtx() Decorator

Custom parameter decorator that:
1. Reads `req[TENANT_CONTEXT_KEY]` set by middleware
2. Returns typed `TenantContext` object
3. Throws if tenant context is missing (misconfigured middleware)

---

## 5. Write Path Isolation

### Entity Creation

When creating entities via Vendure services:

```
ChannelService.assignToCurrentChannel(entity, ctx)
```

This automatically assigns the entity to `ctx.channel`. For multi-tenant SaaS:
- Entity is assigned to ONLY the tenant's channel
- Entity is NOT assigned to the Default Channel
- Custom entities with direct `tenantId` column get it set automatically

### Preventing Cross-Channel Assignment

| Operation | Current Behavior | Multi-tenant Behavior |
|-----------|-----------------|----------------------|
| `assignToChannels()` | Assigns to any channel | Only allow own channel + restrict |
| `removeFromChannels()` | Removes from any channel | Only allow own channel |
| Product assignment | Any channel | Only tenant's channel |
| Customer assignment | Auto-assigns on visit | Only via explicit registration |

### Write Guards

Before any write operation:
1. Verify `ctx.channelId` matches the resolved tenantId
2. For entities being modified, verify they belong to `ctx.channel`
3. Prevent assignment to channels other than the tenant's own channel

---

## 6. Read Path Isolation

### Vendure's Built-in Read Filtering

Most Vendure read operations use `ListQueryBuilder` which auto-joins channel:

```sql
-- Typical Vendure query for products
SELECT "product".*
FROM "product"
INNER JOIN "product_channels_channel" "product_channel"
    ON "product_channel"."productId" = "product"."id"
    AND "product_channel"."channelId" = :channelId
WHERE ...
```

### Additional Read Guards for Multi-tenant

| Scenario | Guard |
|----------|-------|
| Single entity fetch by ID | Verify entity's channels include ctx.channelId |
| Relations loading | Ensure loaded relations are channel-filtered |
| Aggregate queries | Always group by channelId |
| Search results | Index per channel / filter results by channelId |
| Asset URLs | Verify asset belongs to tenant before serving |

### RLS Policies (Database Layer)

```
-- For tables with direct channel relationship (via join table)
-- RLS is applied on the join table itself

-- For the Order table (has direct channelId column)
Policy: tenant_isolation_order
  ON "order"
  USING ("channelId"::text = current_setting('app.current_tenant_id', true))

-- For join tables
Policy: tenant_isolation_product_channel
  ON "product_channels_channel"
  USING ("channelId"::text = current_setting('app.current_tenant_id', true))
```

---

## 7. Edge Cases

### 7.1 Background Jobs

Jobs are processed outside the HTTP request lifecycle:

```
Job serialized with: { channelId, tenantId, ... }
  → Job worker deserializes
  → Creates RequestContext with saved channelId
  → RLS: SET app.current_tenant_id = channelId
  → Job executes with tenant isolation
```

### 7.2 Cron Jobs / Scheduled Tasks

Scheduled tasks that run across all tenants:

```
For each active tenant:
  → Create RequestContext for tenant's channel
  → Execute task with tenant context
  → Move to next tenant
```

### 7.3 Webhooks

Incoming webhooks must carry tenant identification:

```
POST /webhooks/stripe?tenantId=abc
  → Middleware resolves tenant from query param
  → Sets channel context
  → Processes webhook within tenant scope
```

### 7.4 Data Export/Import

Exports must be scoped to tenant:

```
ExportService.export(ctx)
  → Queries all data filtered by ctx.channelId
  → Generates tenant-specific export file
```

### 7.5 Search Index

Elasticsearch/search index must be tenant-scoped:

| Strategy | Pros | Cons |
|----------|------|------|
| Index per tenant | Perfect isolation | Many indexes at scale |
| Shared index with channelId field | Simple, efficient | Must always filter by channelId |
| Alias per tenant | Good balance | Medium complexity |

**Recommendation:** Shared index with `channelId` field for simplicity, matching the shared-schema approach.

### 7.6 File/Asset Storage

Asset paths must include tenant context:

```
Current:   /assets/<assetId>/<filename>
Multi-tenant: /assets/<tenantSlug>/<assetId>/<filename>
```

This prevents URL guessing across tenants and enables per-tenant storage quotas.
