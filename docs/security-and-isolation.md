# Security & Isolation — Multi-Tenant

> **Date:** 2026-02-20
> **Purpose:** Comprehensive security design for multi-tenant data isolation at all layers
> **Scope:** Isolation architecture, tenant detection, middleware, guards, ORM enforcement, RLS, write/read paths, edge cases, audit, threat model, enforcement rules

---

## Table of Contents

1. [Isolation Architecture](#1-isolation-architecture)
2. [Tenant Detection](#2-tenant-detection)
3. [Middleware Flow](#3-middleware-flow)
4. [Guard Layer](#4-guard-layer)
5. [ORM-Level Enforcement](#5-orm-level-enforcement)
6. [Write Path Isolation](#6-write-path-isolation)
7. [Read Path Isolation](#7-read-path-isolation)
8. [RLS Policy Registry](#8-rls-policy-registry)
9. [Edge Cases](#9-edge-cases)
10. [Cross-tenant Protection](#10-cross-tenant-protection)
11. [Audit Logging Strategy](#11-audit-logging-strategy)
12. [Threat Model](#12-threat-model)
13. [Enforcement Rules](#13-enforcement-rules)

---

## 1. Isolation Architecture

### Defense-in-Depth Model

```
┌─────────────────────────────────────────────────────────┐
│  Layer 1: API / Middleware                               │
│  ┌─────────────────────────────────────────────────────┐│
│  │ Domain → Tenant resolution                          ││
│  │ vendure-token injection (override user-supplied)    ││
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
│  │ TypeORM Subscriber validates writes                 ││
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

### Isolation at Each Layer

| Layer | Mechanism | Isolation Level | Failure Mode |
|-------|-----------|----------------|-------------|
| **Database** | PostgreSQL RLS policies | 🟢 Enforced by DB engine | Misconfigured RLS → data leak |
| **Application** | RequestContext.channelId in all queries | 🟡 Developer discipline | Forgotten filter → data leak |
| **API** | TenantGuard verifies channel-tenant match | 🟢 Automatic per-request | Guard bypass → cross-tenant |
| **Middleware** | Domain → Tenant → token override | 🟢 First line of defense | Middleware skip → user picks tenant |

---

## 2. Tenant Detection

### Detection Methods (Priority Order)

| # | Method | Source | Use Case | Priority |
|---|--------|--------|----------|----------|
| 1 | **Custom Domain** | `Host` header | `store.com` | Highest |
| 2 | **Subdomain** | `Host` header | `tenant-slug.qtable.vn` | High |
| 3 | **vendure-token Header** | Request header | API clients, mobile apps | Medium |
| 4 | **API Key** | `X-API-Key` header | Server-to-server | Low |

### Detection Flow

```
Host header: "alice-store.qtable.vn"
        │
        ▼
┌───────────────────────────┐
│  1. Parse hostname        │
│     └─ subdomain: "alice" │
├───────────────────────────┤
│  2. Check cache (Redis)   │
│     └─ cache hit? → done  │
├───────────────────────────┤
│  3. Query TenantDomain    │
│     WHERE domain = Host   │
│     └─ found? → cache it  │
├───────────────────────────┤
│  4. Query by subdomain    │
│     WHERE slug = "alice"  │
│     └─ found? → cache it  │
├───────────────────────────┤
│  5. No match → 404        │
│     ⚠️ DO NOT fallback    │
│     to Default Channel    │
└───────────────────────────┘
```

### Custom Domain Resolution

```
TenantDomain table:
┌────┬───────────────────────┬──────────┬───────────┐
│ id │ domain                │ tenantId │ isPrimary │
├────┼───────────────────────┼──────────┼───────────┤
│  1 │ alice.qtable.vn       │     10   │   true    │
│  2 │ www.alice-store.com   │     10   │   false   │
│  3 │ bob.qtable.vn         │     20   │   true    │
└────┴───────────────────────┴──────────┴───────────┘
```

---

## 3. Middleware Flow

### Complete Request Flow

```
 ┌─────────────────────────────────────────────────────┐
 │              HTTP Request                            │
 │  Host: alice.qtable.vn                              │
 │  Authorization: Bearer <session_token>               │
 │  [vendure-token: <IGNORED — will be overridden>]    │
 └──────────────┬──────────────────────────────────────┘
                │
 ┌──────────────▼──────────────────────────────────────┐
 │         TenantContextMiddleware                      │
 │                                                      │
 │  1. Parse Host header → resolve tenant               │
 │  2. Check tenant status:                             │
 │     ├── active     → continue                       │
 │     ├── trial      → set trial flag                 │
 │     ├── suspended  → HTTP 403 + message             │
 │     └── not found  → HTTP 404                       │
 │  3. OVERRIDE vendure-token header                    │
 │     req.headers['vendure-token'] = tenant.channelToken │
 │  4. Store tenant context on request                  │
 │     req[TENANT_KEY] = { tenantId, slug, plan, ... }  │
 │  5. Set DB session var for RLS                       │
 │     SET app.current_tenant_id = tenant.channelId     │
 └──────────────┬──────────────────────────────────────┘
                │
 ┌──────────────▼──────────────────────────────────────┐
 │         AuthGuard (Vendure built-in)                 │
 │                                                      │
 │  1. Extract session token (Bearer / Cookie)          │
 │  2. Load CachedSession from session store            │
 │  3. Resolve Channel from vendure-token               │
 │  4. Create RequestContext { channel, session, ... }   │
 │  5. Check permissions                                │
 └──────────────┬──────────────────────────────────────┘
                │
 ┌──────────────▼──────────────────────────────────────┐
 │         TenantGuard (Custom)                         │
 │                                                      │
 │  1. Compare ctx.channelId with req[TENANT_KEY]       │
 │  2. Reject if mismatch (cross-tenant attempt)        │
 │  3. Block Default Channel for non-SuperAdmin         │
 │  4. Log suspicious patterns                          │
 └──────────────┬──────────────────────────────────────┘
                │
 ┌──────────────▼──────────────────────────────────────┐
 │         GraphQL Resolver                             │
 └─────────────────────────────────────────────────────┘
```

---

## 4. Guard Layer

### AuthGuard (Existing — Vendure)

Handles authentication and channel resolution:
- Session token → CachedSession
- `vendure-token` header → Channel
- Permission checking against `@Allow()` decorators

### TenantGuard (New — Custom)

Runs AFTER AuthGuard to enforce tenant boundaries:

| Check | Description | Action on Failure |
|-------|-------------|-------------------|
| Channel match | ctx.channelId must match resolved tenant's channelId | 403 Forbidden |
| Default Channel block | Block non-SuperAdmin from Default Channel | 403 Forbidden |
| Tenant status check | Reject if tenant is suspended/deleted | 403/404 |
| Session channel scope | User's session should match tenant's channel | Force re-auth |
| Plan limit check | Check if tenant has exceeded plan limits | 429 Too Many Requests |

### Guard Execution Order

```
1. TenantContextMiddleware (global)     → Resolves tenant, overrides token
2. AuthGuard (Vendure, per-resolver)    → Authenticates + resolves channel
3. TenantGuard (custom, per-resolver)   → Verifies tenant isolation
4. @Allow() permissions (Vendure)       → Authorization
```

---

## 5. ORM-Level Enforcement

### Mechanism A: TypeORM Subscriber (Event-based)

A TypeORM subscriber that intercepts entity-based operations:

| Event | Action |
|-------|--------|
| `beforeInsert` | Verify entity has correct channel assignment |
| `afterLoad` | Verify loaded entity belongs to current tenant |
| `beforeUpdate` | Verify update target belongs to current tenant |
| `beforeRemove` | Verify delete target belongs to current tenant |

**Limitation:** Subscribers don't intercept `QueryBuilder` queries, only entity-based operations.

### Mechanism B: Custom QueryRunner Wrapper (RLS Context)

Wrap TypeORM's QueryRunner to inject RLS context:

```
Connection established
  → SET app.current_tenant_id = <channelId>
  → All subsequent queries filtered by RLS
  → Connection returned to pool
  → RESET app.current_tenant_id
```

**Advantage:** Works for ALL queries, including raw SQL and QueryBuilder.

### Combined Approach (Required)

| Mechanism | Coverage | Purpose |
|-----------|----------|---------|
| TypeORM Subscriber | Entity operations | Application-level validation |
| RLS via QueryRunner | ALL queries | Database-level safety net |

### Queries That BYPASS Channel Filtering

| Pattern | Risk | Fix |
|---------|------|-----|
| `rawConnection.getRepository(X).find()` | 🔴 No channel filter | Always use `connection.getRepository(ctx, X)` |
| Direct `QueryBuilder` without channel join | 🟡 Missing filter | Audit and add channel filter |
| `connection.getEntityOrThrow(ctx, X, id)` | 🟡 Checks existence only | Add channel membership check after load |
| GlobalSettings queries | 🟢 Intentionally global | N/A |
| Migration scripts | 🟠 Run without context | Use system context with explicit channel |

---

## 6. Write Path Isolation

### Entity Creation

Vendure's `ChannelService.assignToCurrentChannel(entity, ctx)` auto-assigns to `ctx.channel`.

For multi-tenant SaaS:
- Entity is assigned to ONLY the tenant's channel
- Entity is NOT assigned to the Default Channel
- Custom entities with direct `tenantId` column get it set automatically

### Preventing Cross-Channel Assignment

| Operation | Multi-tenant Behavior |
|-----------|----------------------|
| `assignToChannels()` | Only allow own channel — reject any other |
| `removeFromChannels()` | Only allow own channel |
| Product assignment | Only tenant's channel |
| Customer assignment | Only via explicit registration within tenant |

### Write Guards

Before any write operation:
1. Verify `ctx.channelId` matches the resolved tenantId
2. For entities being modified, verify they belong to `ctx.channel`
3. Prevent assignment to channels other than the tenant's own channel

---

## 7. Read Path Isolation

### Vendure's Built-in Read Filtering

Most Vendure read operations use `ListQueryBuilder` which auto-joins channel:

```sql
SELECT "product".*
FROM "product"
INNER JOIN "product_channels_channel" "product_channel"
    ON "product_channel"."productId" = "product"."id"
    AND "product_channel"."channelId" = :channelId
WHERE ...
```

### Additional Read Guards

| Scenario | Guard |
|----------|-------|
| Single entity fetch by ID | Verify entity's channels include ctx.channelId |
| Relations loading | Ensure loaded relations are channel-filtered |
| Aggregate queries | Always group by channelId |
| Search results | Index per channel / filter results by channelId |
| Asset URLs | Verify asset belongs to tenant before serving |

---

## 8. RLS Policy Registry

### Tables Requiring RLS Policies

Every table that contains or references tenant-scoped data MUST have an RLS policy.

#### Tables with Direct `channelId` Column

| Table | Column | Policy Type |
|-------|--------|-------------|
| `order` | `channelId` | `USING (channelId::text = current_setting('app.current_tenant_id', true))` |

#### Channel Join Tables (ManyToMany)

| Join Table | Policy |
|------------|--------|
| `product_channels_channel` | `USING (channelId::text = current_setting('app.current_tenant_id', true))` |
| `product_variant_channels_channel` | Same |
| `customer_channels_channel` | Same |
| `collection_channels_channel` | Same |
| `facet_channels_channel` | Same |
| `facet_value_channels_channel` | Same |
| `promotion_channels_channel` | Same |
| `shipping_method_channels_channel` | Same |
| `payment_method_channels_channel` | Same |
| `stock_location_channels_channel` | Same |
| `asset_channels_channel` | Same |
| `role_channels_channel` | Same |

#### Tenant-Specific Tables

| Table | Column | Policy |
|-------|--------|--------|
| `tenant` | `channelId` | Same pattern |
| `tenant_domain` | Via `tenantId` → `tenant.channelId` | JOIN-based or denormalized |
| `audit_log` | `tenantId` | Same pattern |

### RLS Setup Requirements

```
-- 1. Enable RLS on each table
ALTER TABLE "order" ENABLE ROW LEVEL SECURITY;

-- 2. Create policy
CREATE POLICY tenant_isolation ON "order"
  USING ("channelId"::text = current_setting('app.current_tenant_id', true));

-- 3. Force RLS for application role (not superuser)
ALTER TABLE "order" FORCE ROW LEVEL SECURITY;

-- 4. Platform admin uses BYPASSRLS role for maintenance
```

### RLS Maintenance Rule

> **Every new entity that is ChannelAware MUST have its RLS policy created in the same migration that creates the entity.**

---

## 9. Edge Cases

### 9.1 Background Jobs

Jobs are processed outside the HTTP request lifecycle:

```
Job serialized with: { channelId, tenantId, ... }
  → Job worker deserializes
  → Creates RequestContext with saved channelId
  → RLS: SET app.current_tenant_id = channelId
  → Job executes with tenant isolation
  → RESET app.current_tenant_id on completion
```

### 9.2 Cron Jobs / Scheduled Tasks

Scheduled tasks that run across all tenants:

```
For each active tenant:
  → Create RequestContext for tenant's channel
  → SET app.current_tenant_id
  → Execute task with tenant context
  → RESET app.current_tenant_id
  → Move to next tenant
```

### 9.3 Webhooks

Incoming webhooks must carry tenant identification:

```
POST /webhooks/stripe?tenantId=abc
  → Middleware resolves tenant from query param
  → Verifies webhook signature
  → Sets channel context
  → Processes webhook within tenant scope
```

### 9.4 Data Export/Import

Exports must be scoped to tenant:

```
ExportService.export(ctx)
  → Queries all data filtered by ctx.channelId
  → Generates tenant-specific export file
  → Stores in tenant-scoped storage path
```

### 9.5 Search Index

Strategy: **Shared index with `channelId` field** (matches shared-schema approach).

- Every document indexed with `channelId` field
- Every search query MUST include `channelId` filter
- Index rebuild capability per-tenant

### 9.6 File/Asset Storage

Asset paths must include tenant context:

```
Current:      /assets/<assetId>/<filename>
Multi-tenant: /assets/<tenantSlug>/<assetId>/<filename>
```

This prevents URL guessing across tenants and enables per-tenant storage quotas.

---

## 10. Cross-tenant Protection

### Attack Vectors & Mitigations

| # | Attack Vector | Description | Mitigation |
|---|--------------|-------------|------------|
| 1 | **Token manipulation** | User sends different vendure-token | Middleware overrides token from domain resolution |
| 2 | **IDOR (ID guessing)** | Request entity by ID from another tenant | Entity fetch verifies channel membership |
| 3 | **Channel switching** | Admin tries to access another channel | TenantGuard blocks channel mismatch |
| 4 | **SuperAdmin abuse** | SuperAdmin accesses tenant data without audit | Audit log for all SuperAdmin actions |
| 5 | **GraphQL batch** | Batched queries targeting multiple channels | Each query uses same tenant context |
| 6 | **Job queue injection** | Malicious job with wrong tenant context | Validate tenantId in job payload |
| 7 | **Webhook spoofing** | Fake webhook with another tenant's data | Verify webhook signature + tenant match |
| 8 | **Asset URL guessing** | Access /assets/\<id\> for other tenant's files | Asset serving middleware checks tenant |
| 9 | **Search index leakage** | Search returns results from other tenant | Index query includes channelId filter |
| 10 | **Session fixation** | Use another user's session cross-tenant | Session bound to specific channel |

### Token Override Protection

The middleware MUST override any user-supplied `vendure-token` header:

```
Incoming request:
  Host: tenant-a.qtable.vn
  vendure-token: <tenant-b-token>   ← MALICIOUS

TenantContextMiddleware:
  1. Resolve tenant from Host → Tenant A
  2. OVERRIDE vendure-token → Tenant A's token
  3. Log the manipulation attempt as SECURITY event
  4. Increment rate-limit counter for this IP
```

### Entity-Level Protection

For every entity fetch by ID:

```
getEntityOrThrow(ctx, Product, productId)
  → Fetch product
  → Verify product.channels includes ctx.channelId
  → If not → EntityNotFoundError (NEVER ForbiddenError — don't reveal cross-tenant)
```

---

## 11. Audit Logging Strategy

### What to Log

| Category | Events | Detail Level |
|----------|--------|-------------|
| **Tenant Lifecycle** | Create, suspend, delete, reactivate | Full |
| **Cross-tenant Attempts** | Token mismatch, IDOR blocked | Full + alert |
| **SuperAdmin Actions** | Any action on tenant data | Full |
| **Admin Actions** | Create admin, change role, change config | Standard |
| **Data Access** | Sensitive reads (customer PII, orders) | Configurable |
| **Authentication** | Login, logout, failed attempts | Standard |

### Audit Log Entity

| Field | Type | Description |
|-------|------|-------------|
| `id` | ID | Primary key |
| `tenantId` | FK → Tenant | Which tenant was affected |
| `actorId` | FK → User | Who performed the action |
| `actorType` | enum | `tenant_admin`, `global_admin`, `system` |
| `action` | string | Action identifier |
| `resource` | string | Entity type affected |
| `resourceId` | ID? | Entity ID affected |
| `details` | jsonb | Additional context |
| `ipAddress` | string | Client IP |
| `userAgent` | string | Client user agent |
| `createdAt` | timestamp | When it happened |

### Alert Triggers

| Trigger | Severity | Action |
|---------|----------|--------|
| Token mismatch detected | 🔴 Critical | Alert + block + log |
| Multiple failed IDOR attempts | 🟡 High | Rate limit + log |
| SuperAdmin accesses tenant data | 🟠 Medium | Auto-log |
| Mass data export | 🟠 Medium | Log + notify tenant admin |
| Admin role escalation | 🟡 High | Log + require confirmation |

---

## 12. Threat Model

### STRIDE Analysis

| Threat | Category | Scenario | Mitigation |
|--------|----------|----------|------------|
| **S** — Spoofing | Identity | Attacker impersonates another tenant | Domain-based detection + token override |
| **T** — Tampering | Data | Modify another tenant's data | RLS + channel check on writes |
| **R** — Repudiation | Audit | Deny having accessed tenant data | Immutable audit log |
| **I** — Information Disclosure | Privacy | Read another tenant's data | 4-layer isolation model |
| **D** — Denial of Service | Availability | One tenant overwhelms shared resources | Per-tenant rate limiting + quotas |
| **E** — Elevation of Privilege | Authorization | Tenant admin gains SuperAdmin access | Role boundary enforcement + audit |

### Security Boundaries

```
┌─────────────────────────────────────────────────────────┐
│                    Platform Boundary                      │
│                                                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │  Tenant A   │  │  Tenant B   │  │  Tenant C   │     │
│  │ ╔═════════╗ │  │ ╔═════════╗ │  │ ╔═════════╗ │     │
│  │ ║ Data    ║ │  │ ║ Data    ║ │  │ ║ Data    ║ │     │
│  │ ║ Users   ║ │  │ ║ Users   ║ │  │ ║ Users   ║ │     │
│  │ ║ Config  ║ │  │ ║ Config  ║ │  │ ║ Config  ║ │     │
│  │ ║ Assets  ║ │  │ ║ Assets  ║ │  │ ║ Assets  ║ │     │
│  │ ╚═════════╝ │  │ ╚═════════╝ │  │ ╚═════════╝ │     │
│  │ 🚫 No cross │  │ 🚫 No cross │  │             │     │
│  │    access    │  │    access    │  │             │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │             Global Admin (SuperAdmin)              │  │
│  │  ✅ Can access ALL tenants (with audit logging)   │  │
│  │  🔒 Every action logged to audit trail            │  │
│  └────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

---

## 13. Enforcement Rules

### ESLint Rules (Development-time)

| Rule ID | Pattern | Action | Severity |
|---------|---------|--------|----------|
| `no-raw-repository` | `rawConnection.getRepository()` | ❌ Error | Critical |
| `no-unscoped-querybuilder` | `QueryBuilder` without `.channelId` | ⚠️ Warning | High |
| `require-ctx-parameter` | Service methods without `ctx: RequestContext` | ⚠️ Warning | Medium |

### Code Review Checklist (Mandatory for every PR)

```
□ Every DB query includes channelId filter?
□ Every new entity has RLS policy migration?
□ API returns EntityNotFoundError (not ForbiddenError) for cross-tenant?
□ Cache keys include tenant/channel scope?
□ Background jobs serialize tenantId in payload?
□ No rawConnection.getRepository() in production code?
□ Tenant boundary test exists for every new entity/API?
```

### CI Gate Requirements

| Gate | Condition | Block Merge? |
|------|-----------|-------------|
| Tenant isolation test suite | All pass | ✅ Yes |
| ESLint `no-raw-repository` | 0 violations | ✅ Yes |
| ChannelAware entity coverage | ≥ 90% | ✅ Yes |
| RLS policy exists for new entity | Verified | ✅ Yes |
