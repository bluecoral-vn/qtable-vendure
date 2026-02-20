# Multi-Tenancy Strategy — qtable-vendure

> **Date:** 2026-02-20  
> **Decision:** Single DB – Shared Schema (with application-level + RLS isolation)  
> **Scope:** Multi-tenant data partitioning strategy for Vendure SaaS platform

---

## Table of Contents

1. [Strategy Options Overview](#1-strategy-options-overview)
2. [Selected Strategy: Single DB – Shared Schema](#2-selected-strategy-single-db--shared-schema)
3. [Compatibility with Vendure](#3-compatibility-with-vendure)
4. [Data Isolation Approach](#4-data-isolation-approach)
5. [Migration Complexity](#5-migration-complexity)
6. [Scale Analysis](#6-scale-analysis)
7. [Decision Rationale](#7-decision-rationale)

---

## 1. Strategy Options Overview

| Strategy | Description | Isolation | Cost | Scale | Complexity |
|----------|-------------|-----------|------|-------|-----------|
| **DB per tenant** | Each tenant has own database | 🟢 Maximum | 🔴 Highest | 🔴 Poor beyond 100 | 🔴 Highest |
| **Schema per tenant** | Shared DB, separate schemas | 🟡 Good | 🟡 Medium | 🟡 Medium | 🟡 Medium |
| **Shared schema** ✅ | Single DB, single schema, tenant column | 🟠 Application-enforced | 🟢 Lowest | 🟢 Best | 🟢 Lowest |
| **Hybrid** | Hot tenants → own DB, rest → shared | 🟡 Variable | 🟡 Variable | 🟡 Complex | 🔴 Highest |

---

## 2. Selected Strategy: Single DB – Shared Schema

### Why This Strategy

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
│  │                                                  │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐     │    │
│  │  │  order   │  │ customer │  │  asset    │     │    │
│  │  └──────────┘  └──────────┘  └──────────┘     │    │
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
| 2 | **Vendure compatibility** | Vendure already uses Channel-based data partitioning, aligns naturally |
| 3 | **Low operational cost** | One database to manage, back up, monitor |
| 4 | **Easy cross-tenant queries** | Platform analytics, billing aggregation |
| 5 | **Simple onboarding** | New tenant = new Channel row + config, no DDL operations |
| 6 | **Connection efficiency** | Single connection pool shared across all tenants |
| 7 | **TypeORM compatibility** | Works with existing TypeORM setup without modification |

### Disadvantages

| # | Disadvantage | Mitigation |
|---|-------------|-----------|
| 1 | **Isolation is application-enforced** | RLS as DB-level safety net |
| 2 | **Noisy neighbor risk** | Per-tenant query limits, connection pooling |
| 3 | **Single point of failure** | DB replication, failover |
| 4 | **Regulatory compliance** | RLS provides sufficient isolation for most regulations; if GDPR requires physical separation, consider hybrid approach for EU tenants |
| 5 | **Large table sizes** | Partitioning by channelId, proper indexing |
| 6 | **Backup granularity** | Logical per-tenant backup via `pg_dump` with WHERE clause |

---

## 3. Compatibility with Vendure

### Natural Alignment

Vendure's Channel system already provides the foundation:

| Vendure Feature | Multi-tenant Usage |
|----------------|-------------------|
| Channel entity | Maps to Tenant (1:1) |
| `vendure-token` header | Tenant identification at API level |
| ManyToMany join tables | Already partition most entities by channel |
| Per-channel permissions | Maps to per-tenant RBAC |
| ChannelService cache | Efficient tenant resolution |
| `ChannelAware` interface | Marks entities as tenant-scoped |

### Alignment Gaps

| Gap | Impact | Solution |
|-----|--------|---------|
| ManyToMany allows sharing | Data can leak | Enforce 1:1 at application level |
| Default Channel is "god mode" | Platform admin sees all | Restrict via custom guard |
| No `tenantId` column on tables | RLS needs explicit column | Channel join tables serve this purpose; for non-ChannelAware entities, add explicit column |
| CustomFields has no per-tenant scope | All tenants see same custom fields | Use Tenant entity's own config |

### How Vendure Already Filters by Channel

Most Vendure services use patterns like:
```
ListQueryBuilder
  .build(Entity, listOptions)
  .innerJoin('entity.channels', 'channel', 'channel.id = :channelId', { channelId: ctx.channelId })
```

This means **most existing queries already filter by Channel** out of the box. The gap is in:
- Custom queries that skip ListQueryBuilder
- Direct repository queries without channel filters
- Aggregate queries (reporting)
- Relations loaded without channel scope

---

## 4. Data Isolation Approach

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

-- RLS policy example (for tables with direct channelId)
CREATE POLICY tenant_isolation ON "order"
  USING (channelId = current_setting('app.current_tenant_id')::int);

-- For ManyToMany join tables
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

## 5. Migration Complexity

### From Current State to Multi-tenant

| Step | Complexity | Blocking? |
|------|-----------|----------|
| Switch to PostgreSQL | Low | Yes |
| Create Tenant entity + service | Medium | Yes |
| Add domain → tenant resolution | Medium | Yes |
| Enable RLS on tenant-scoped tables | Medium | No (can do incrementally) |
| Index channel join tables | Low | No |
| Restrict Default Channel | Low | No |
| Migrate existing data (if any) | Low (no prod data yet) | No |

### Schema Migration Strategy

Since `synchronize: true` is used in dev and no production data exists:
1. Switch to PostgreSQL immediately
2. Use TypeORM migrations for all future changes
3. Create initial migration from current schema
4. Add RLS policies as separate migrations
5. Establish migration CI/CD pipeline

---

## 6. Scale Analysis

### Tenant Count Projections

| Scale | Tenants | Products/tenant | Orders/month | DB Strategy |
|-------|---------|----------------|-------------|-------------|
| **Startup** | 1–100 | ~500 | ~5K | Single PostgreSQL |
| **Growth** | 100–1K | ~1K | ~50K | PostgreSQL + read replicas |
| **Scale** | 1K–10K | ~2K | ~500K | PostgreSQL + partitioning + read replicas |
| **Enterprise** | 10K–100K | ~5K | ~5M | Sharding or Citus/distributed PG |

### Performance Characteristics

| Metric | Shared Schema Impact | Mitigation |
|--------|---------------------|-----------|
| Query latency | Increases with row count | Composite indexes on (channelId, ...) |
| Connection count | Shared pool, more efficient | PgBouncer connection pooling |
| Migration speed | One migration for all tenants | Scheduled maintenance windows |
| Backup time | Entire DB backed up | pg_dump with --section for faster |
| Monitoring | Single set of metrics | Tenant-tagged spans (Jaeger) |

### Index Strategy for Channel-Scoped Queries

```
-- Existing join tables need composite indexes
CREATE INDEX idx_product_channels ON product_channels_channel (channelId, productId);
CREATE INDEX idx_order_channel ON "order" (channelId, createdAt DESC);
CREATE INDEX idx_customer_channels ON customer_channels_channel (channelId, customerId);
```

---

## 7. Decision Rationale

### Why Not Database-Per-Tenant?

1. **Vendure incompatibility:** Vendure uses a single TypeORM DataSource. Supporting multiple DataSources requires forking core.
2. **Connection explosion:** At 1K tenants × 10 connections = 10K connections. PostgreSQL cannot handle this.
3. **Migration nightmare:** Schema changes must be applied to every tenant database individually.
4. **Vendure Channel system wasted:** The entire Channel-based filtering system would be unused.

### Why Not Schema-Per-Tenant?

1. **TypeORM limitation:** TypeORM's schema switching per request is not natively supported.
2. **Vendure assumption:** Core services assume a single schema. No hook point for schema switching.
3. **Migration complexity:** N schemas × M migrations = exponential complexity.

### Why Shared Schema Is Optimal for Vendure

1. **Vendure's Channel system IS a shared-schema multi-tenant pattern.** It uses join tables to partition data, which is exactly how shared-schema works.
2. **All existing Vendure services, queries, and resolvers already filter by Channel.** We extend this rather than fight it.
3. **PostgreSQL RLS provides database-level safety net** without changing application code.
4. **Scalable to 10K+ tenants** with proper indexing and partitioning.
5. **Lowest operational complexity** — one database, one migration path, one backup.

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
