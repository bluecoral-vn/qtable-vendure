# Security & Isolation — Multi-Tenant

> **Date:** 2026-02-20  
> **Purpose:** Security design for multi-tenant tenant isolation at all layers  
> **Scope:** Tenant detection, middleware flow, guards, cross-tenant protection, audit

---

## Table of Contents

1. [Isolation Architecture](#1-isolation-architecture)
2. [Tenant Detection](#2-tenant-detection)
3. [Middleware Flow](#3-middleware-flow)
4. [Guard Layer](#4-guard-layer)
5. [Cross-tenant Protection](#5-cross-tenant-protection)
6. [Audit Logging Strategy](#6-audit-logging-strategy)
7. [Threat Model](#7-threat-model)

---

## 1. Isolation Architecture

### Isolation at Each Layer

| Layer | Mechanism | Isolation Level | Failure Mode |
|-------|-----------|----------------|-------------|
| **Database** | PostgreSQL RLS policies | 🟢 Enforced by DB engine | Misconfigured RLS → data leak |
| **Schema** | Shared schema, channelId column | 🟡 Convention-based | Missing column → no filtering |
| **Application** | RequestContext.channelId in all queries | 🟡 Developer discipline | Forgotten filter → data leak |
| **API** | TenantGuard verifies channel-tenant match | 🟢 Automatic per-request | Guard bypass → cross-tenant |
| **Admin UI** | Tenant-scoped admin dashboard | 🟡 UI-level restriction | API-level must also enforce |

### Database-Level Isolation (PostgreSQL RLS)

```
┌─────────────────────────────────────────────────────┐
│                 PostgreSQL                            │
│                                                      │
│  Session Variable: app.current_tenant_id             │
│  Set per connection from middleware                   │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │  RLS Policy on "order" table                   │  │
│  │  USING (channelId::text =                      │  │
│  │    current_setting('app.current_tenant_id'))    │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │  RLS Policy on join tables                     │  │
│  │  ("product_channels_channel", etc.)            │  │
│  │  USING (channelId::text =                      │  │
│  │    current_setting('app.current_tenant_id'))    │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  Platform admin role: BYPASSRLS                      │
│  Application role: subject to RLS                    │
└─────────────────────────────────────────────────────┘
```

### Application-Level Isolation

```
Request → TenantMiddleware → AuthGuard → TenantGuard → Resolver → Service → DB
   │           │                │            │           │          │
   │      Domain→Tenant    Session→Channel  Verify     ctx.channelId  RLS
   │           │                │         match           │
   └───────────┴────────────────┴──────────┴──────────────┴──── Tenant enforced
```

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
│  5. Check vendure-token   │
│     header (fallback)     │
├───────────────────────────┤
│  6. No match → 404        │
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
 │  [vendure-token: <optional>]                        │
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
 │  3. Inject vendure-token header                      │
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

### Guard Priority

```
1. TenantContextMiddleware (global)     → Resolves tenant
2. AuthGuard (Vendure, per-resolver)    → Authenticates + resolves channel
3. TenantGuard (custom, per-resolver)   → Verifies tenant isolation
4. @Allow() permissions (Vendure)       → Authorization
```

---

## 5. Cross-tenant Protection

### Attack Vectors & Mitigations

| # | Attack Vector | Description | Mitigation |
|---|--------------|-------------|-----------|
| 1 | **Token manipulation** | User sends different vendure-token | Middleware overrides token from domain resolution |
| 2 | **IDOR (ID guessing)** | Request entity by ID from another tenant | Entity fetch verifies channel membership |
| 3 | **Channel switching** | Admin tries to access another channel | TenantGuard blocks channel mismatch |
| 4 | **SuperAdmin abuse** | SuperAdmin accesses tenant data without audit | Audit log for all SuperAdmin actions |
| 5 | **GraphQL batch** | Batched queries targeting multiple channels | Each query uses same tenant context |
| 6 | **Job queue injection** | Malicious job with wrong tenant context | Validate tenantId in job payload |
| 7 | **Webhook spoofing** | Fake webhook with another tenant's data | Verify webhook signature + tenant match |
| 8 | **Asset URL guessing** | Access /assets/<id> for other tenant's files | Asset serving middleware checks tenant |
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
  3. Log the manipulation attempt
```

### Entity-Level Protection

For every entity fetch by ID:

```
getEntityOrThrow(ctx, Product, productId)
  → Fetch product
  → Verify product.channels includes ctx.channelId
  → If not → EntityNotFoundError (don't reveal cross-tenant)
```

**Important:** Error response must NOT reveal that the entity exists in another tenant.
Always return `EntityNotFoundError`, never `ForbiddenError` for IDOR.

---

## 6. Audit Logging Strategy

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

## 7. Threat Model

### STRIDE Analysis for Multi-tenant

| Threat | Category | Scenario | Mitigation |
|--------|----------|----------|-----------|
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
│  │             │  │             │  │             │     │
│  │ 🚫 ←───────┼──┼─→ 🚫       │  │             │     │
│  │  No cross-  │  │  No cross-  │  │             │     │
│  │  tenant     │  │  tenant     │  │             │     │
│  │  access     │  │  access     │  │             │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │             Global Admin (SuperAdmin)              │  │
│  │  ✅ Can access ALL tenants (with audit logging)   │  │
│  │  🔒 Every action logged to audit trail            │  │
│  └────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```
