# Multi-Tenancy Strategy — qtable-vendure

> **Date:** 2026-02-20
> **Decision:** Single DB – Shared Schema (with application-level + RLS isolation)
> **Scope:** Multi-tenant data partitioning strategy for Vendure SaaS platform

---

## Table of Contents

1. [Selected Strategy](#1-selected-strategy)
2. [Compatibility with Vendure](#2-compatibility-with-vendure)
3. [Data Isolation Approach](#3-data-isolation-approach)
4. [Migration Complexity](#4-migration-complexity)
5. [Scale Analysis](#5-scale-analysis)

---

## 1. Selected Strategy

### Single DB – Shared Schema

```
┌─────────────────────────────────────────────────────────┐
│                   PostgreSQL Database                    │
│                     (Single DB)                          │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │              Public Schema (Shared)              │    │
│  │                                                  │    │
│  │  ┌──────────┐  Every tenant-owned table has:    │    │
│  │  │ product  │  ┌────────────────────────────┐   │    │
│  │  │──────────│  │ channelId (tenant column)  │   │    │
│  │  │ id       │  │ RLS policy enforced        │   │    │
│  │  │ name     │  │ Application-level filter   │   │    │
│  │  │ ...      │  └────────────────────────────┘   │    │
│  │  └──────────┘                                   │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  Row-Level Security (RLS)                               │
│  ├── SET app.current_tenant_id = ?                      │
│  └── Policy: WHERE channelId = current_setting(...)     │
└─────────────────────────────────────────────────────────┘
```

### Advantages

| # | Advantage | Details |
|---|-----------|---------|
| 1 | **Schema simplicity** | Single migration path for all tenants |
| 2 | **Vendure compatibility** | Channel-based data partitioning aligns naturally |
| 3 | **Low operational cost** | One database to manage, back up, monitor |
| 4 | **Easy cross-tenant queries** | Platform analytics, billing aggregation |
| 5 | **Simple onboarding** | New tenant = new Channel row + config, no DDL |
| 6 | **Connection efficiency** | Single connection pool shared across all tenants |
| 7 | **TypeORM compatibility** | Works with existing TypeORM setup |

### Known Trade-offs & Mitigations

| # | Trade-off | Mitigation |
|---|-----------|------------|
| 1 | Isolation is application-enforced | RLS as DB-level safety net |
| 2 | Noisy neighbor risk | Per-tenant query limits, connection pooling |
| 3 | Single point of failure | DB replication, failover |
| 4 | Large table sizes | Partitioning by channelId, composite indexes |
| 5 | Backup granularity | Logical per-tenant backup via filtered queries |

---

## 2. Compatibility with Vendure

### Natural Alignment

Vendure's Channel system provides the foundation:

| Vendure Feature | Multi-tenant Usage |
|----------------|-------------------|
| Channel entity | Maps to Tenant (1:1) |
| `vendure-token` header | Tenant identification at API level |
| ManyToMany join tables | Already partition most entities by channel |
| Per-channel permissions | Maps to per-tenant RBAC |
| `ChannelAware` interface | Marks entities as tenant-scoped |

### Alignment Gaps

| Gap | Impact | Solution |
|-----|--------|---------|
| ManyToMany allows sharing | Data can leak | Enforce 1:1 at application level |
| Default Channel is "god mode" | Platform admin sees all | Restrict via custom guard |
| No `tenantId` column on tables | RLS needs explicit column | Channel join tables serve this purpose |
| CustomFields no per-tenant scope | All tenants see same custom fields | Use Tenant entity's own config |

### How Vendure Already Filters by Channel

Most Vendure services use `ListQueryBuilder`:
```sql
SELECT p.* FROM product p
INNER JOIN product_channels_channel pcc ON pcc.productId = p.id
WHERE pcc.channelId = :channelId
```

Gap areas (require explicit enforcement):
- Custom queries that skip ListQueryBuilder
- Direct repository queries without channel filters
- Aggregate/reporting queries
- Relations loaded without channel scope

---

## 3. Data Isolation Approach

### Layer 1: Application Level (Primary)

```
Request → Middleware (tenant detection)
       → RequestContext (carries tenantId / channelId)
       → Service Layer (passes ctx)
       → TransactionalConnection.getRepository(ctx)
       → Query built with channel filter
```

### Layer 2: RLS (Safety Net)

```sql
-- Set tenant context on each connection
SET app.current_tenant_id = '123';

-- RLS policy on tables with direct channelId
CREATE POLICY tenant_isolation ON "order"
  USING (channelId = current_setting('app.current_tenant_id')::int);

-- RLS policy on ManyToMany join tables
CREATE POLICY tenant_isolation ON "product_channels_channel"
  USING (channelId = current_setting('app.current_tenant_id')::int);
```

### Layer 3: API Gateway (Future)

For production, add an API gateway that:
- Resolves domain → tenant
- Injects tenant context
- Rate limits per tenant
- Terminates TLS per domain

---

## 4. Migration Complexity

### From Current State to Multi-tenant

| Step | Complexity | Blocking? |
|------|-----------|----------|
| Switch to PostgreSQL | Low | Yes |
| Create Tenant entity + service | Medium | Yes |
| Add domain → tenant resolution | Medium | Yes |
| Enable RLS on tenant-scoped tables | Medium | No (incremental) |
| Index channel join tables | Low | No |
| Restrict Default Channel | Low | No |

### Schema Migration Strategy

1. Switch to PostgreSQL immediately
2. Use TypeORM migrations for all future changes
3. Create initial migration from current schema
4. Add RLS policies as separate migrations
5. Establish migration CI/CD pipeline

---

## 5. Scale Analysis

### Tenant Count Projections

| Scale | Tenants | Products/tenant | Orders/month | DB Strategy |
|-------|---------|----------------|-------------|-------------|
| **Startup** | 1–100 | ~500 | ~5K | Single PostgreSQL |
| **Growth** | 100–1K | ~1K | ~50K | PostgreSQL + read replicas |
| **Scale** | 1K–10K | ~2K | ~500K | PostgreSQL + partitioning + read replicas |
| **Enterprise** | 10K–100K | ~5K | ~5M | Sharding or Citus/distributed PG |

### Index Strategy for Channel-Scoped Queries

```sql
-- Composite indexes on join tables
CREATE INDEX idx_product_channels ON product_channels_channel (channelId, productId);
CREATE INDEX idx_order_channel ON "order" (channelId, createdAt DESC);
CREATE INDEX idx_customer_channels ON customer_channels_channel (channelId, customerId);
```

### Final Architecture Decision

```
┌─────────────────────────────────────────┐
│  Decision: Single DB – Shared Schema    │
│                                         │
│  Database:    PostgreSQL 16             │
│  Isolation:   Application + RLS         │
│  Tenant ID:   Channel.id (via Tenant)   │
│  Detection:   Domain → Tenant mapping   │
│  Scale:       Up to 10K tenants         │
│  Safety Net:  PostgreSQL RLS policies   │
└─────────────────────────────────────────┘
```
