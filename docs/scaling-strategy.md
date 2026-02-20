# Scaling Strategy — Multi-Tenant

> **Date:** 2026-02-20  
> **Purpose:** Performance and scaling design for multi-tenant Vendure SaaS  
> **Scope:** Caching, indexing, query optimization, horizontal scaling, Kubernetes

---

## Table of Contents

1. [Caching Strategy](#1-caching-strategy)
2. [Index Strategy](#2-index-strategy)
3. [Query Optimization](#3-query-optimization)
4. [Horizontal Scaling](#4-horizontal-scaling)
5. [Kubernetes Considerations](#5-kubernetes-considerations)
6. [Tenant Scale Impact](#6-tenant-scale-impact)

---

## 1. Caching Strategy

### Cache Layers

```
┌────────────────────────────────────────────────────────────┐
│  Layer 1: CDN / Edge Cache (Cloudflare / CloudFront)       │
│  ├── Static assets (images, CSS, JS)                       │
│  ├── Product listing pages (short TTL, per-tenant key)     │
│  └── Cache key includes tenant domain/subdomain            │
├────────────────────────────────────────────────────────────┤
│  Layer 2: Application Cache (Redis)                        │
│  ├── Session store (per-user, includes channelId)          │
│  ├── Channel/Tenant resolution cache                       │
│  ├── Product data cache (per-channel)                      │
│  ├── Permission/Role cache (per-user, per-channel)         │
│  └── Rate limiting counters (per-tenant)                   │
├────────────────────────────────────────────────────────────┤
│  Layer 3: Database Query Cache (PostgreSQL)                │
│  ├── Prepared statement cache                              │
│  ├── Query plan cache                                      │
│  └── pg_stat_statements monitoring                         │
└────────────────────────────────────────────────────────────┘
```

### Cache Key Design (Tenant-Scoped)

| Cache Type | Key Pattern | TTL | Invalidation |
|-----------|-------------|-----|-------------|
| Channel resolution | `channel:token:<token>` | 5 min | On channel update event |
| Tenant resolution | `tenant:domain:<domain>` | 5 min | On domain change |
| Product list | `products:ch:<channelId>:page:<n>` | 1 min | On product update event |
| Session | `session:<sessionToken>` | Session TTL | On logout/expire |
| Role permissions | `perms:user:<userId>:ch:<channelId>` | 5 min | On role update |
| Rate limit | `rl:tenant:<tenantId>:min:<minuteTs>` | 2 min | Auto-expire |

### Vendure's Existing Cache System

Vendure uses `SelfRefreshingCache` for channels (in-memory):
- Refreshes on TTL expiry
- Per-instance (not shared across nodes)
- **Multi-tenant concern:** Must switch to Redis-backed cache for multi-instance deployments

### Redis Cache Architecture

```
┌──────────────────┐     ┌──────────────────┐
│  Vendure Node 1  │────►│                  │
├──────────────────┤     │   Redis Cluster   │
│  Vendure Node 2  │────►│                  │
├──────────────────┤     │  ┌────────────┐  │
│  Vendure Node N  │────►│  │ Sessions   │  │
└──────────────────┘     │  │ Channels   │  │
                         │  │ Tenants    │  │
                         │  │ Rate Limits│  │
                         │  └────────────┘  │
                         └──────────────────┘
```

---

## 2. Index Strategy

### Critical Indexes for Multi-tenant Queries

#### Join Table Indexes (Channel associations)

```
-- Product ↔ Channel
CREATE INDEX idx_product_channel_cid ON product_channels_channel (channelId);
CREATE INDEX idx_product_channel_pid ON product_channels_channel (productId);
CREATE INDEX idx_product_channel_both ON product_channels_channel (channelId, productId);

-- Order (has direct channelId)
CREATE INDEX idx_order_channel_date ON "order" (channelId, "orderPlacedAt" DESC);
CREATE INDEX idx_order_channel_state ON "order" (channelId, state);
CREATE INDEX idx_order_channel_code ON "order" (channelId, code);

-- Customer ↔ Channel
CREATE INDEX idx_customer_channel ON customer_channels_channel (channelId, customerId);

-- ProductVariant ↔ Channel
CREATE INDEX idx_variant_channel ON product_variant_channels_channel (channelId, productVariantId);

-- Collection ↔ Channel
CREATE INDEX idx_collection_channel ON collection_channels_channel (channelId, collectionId);
```

#### Tenant-Specific Indexes

```
-- Tenant lookup
CREATE UNIQUE INDEX idx_tenant_slug ON tenant (slug);
CREATE INDEX idx_tenant_channel ON tenant (channelId);
CREATE INDEX idx_tenant_status ON tenant (status);

-- Domain lookup
CREATE UNIQUE INDEX idx_tenant_domain ON tenant_domain (domain);
CREATE INDEX idx_tenant_domain_tenant ON tenant_domain (tenantId);
```

### Partial Indexes (Per-Status)

```
-- Only index active tenants for resolution (most queries)
CREATE INDEX idx_tenant_active ON tenant (slug) WHERE status = 'active';

-- Only index non-deleted orders
CREATE INDEX idx_order_active ON "order" (channelId, "orderPlacedAt" DESC)
  WHERE state != 'Cancelled';
```

### Table Partitioning (at scale: 10K+ tenants)

```
-- Partition orders by channelId (range or hash)
CREATE TABLE "order" (...) PARTITION BY HASH (channelId);
CREATE TABLE order_p0 PARTITION OF "order" FOR VALUES WITH (MODULUS 16, REMAINDER 0);
CREATE TABLE order_p1 PARTITION OF "order" FOR VALUES WITH (MODULUS 16, REMAINDER 1);
...
```

---

## 3. Query Optimization

### Common Query Patterns and Optimizations

| Query Pattern | Current | Optimized |
|--------------|---------|-----------|
| Product list with channel | JOIN via ManyToMany | Pre-join index, covering index |
| Order search by date | Sequential scan | Composite index (channelId, date) |
| Customer lookup | No channel filter by default | Always include channel filter |
| Asset serving | ID-based lookup | Tenant-scoped path lookup |
| Inventory check | Per-variant query | Batch query per channel |

### N+1 Query Prevention

Vendure uses DataLoader patterns in entity resolvers. For multi-tenant:  
- DataLoader keys must include channelId
- Batch loading respects tenant boundaries
- Cache DataLoader results per-request (not cross-request)

### Connection Pooling

```
┌───────────────────────────────────────────────────────┐
│                   PgBouncer                            │
│                                                       │
│  Mode: transaction pooling                            │
│  Max connections to PG: 200                           │
│  Max client connections: 2000                         │
│                                                       │
│  Per-tenant: Connection from shared pool              │
│  RLS: SET app.current_tenant_id on checkout           │
│  RESET on connection return                           │
└───────────────────────────────────────────────────────┘
```

---

## 4. Horizontal Scaling

### Scaling Architecture

```
                    ┌─────────────┐
                    │  CDN/Edge   │
                    │ (per-domain │
                    │  routing)   │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │   Nginx /   │
                    │  Ingress    │
                    │  Controller │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
       ┌──────▼─────┐ ┌───▼────┐ ┌────▼─────┐
       │ Vendure    │ │Vendure │ │ Vendure  │
       │ Server 1   │ │Server 2│ │ Server N │
       │ (API)      │ │ (API)  │ │ (API)    │
       └──────┬─────┘ └───┬────┘ └────┬─────┘
              │            │           │
              └────────────┼───────────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
       ┌──────▼─────┐ ┌───▼────┐ ┌────▼─────┐
       │   Redis    │ │  PG    │ │  Worker  │
       │  Cluster   │ │Primary │ │ Nodes    │
       │            │ │+ Repli │ │          │
       └────────────┘ └────────┘ └──────────┘
```

### Scaling Dimensions

| Component | Scaling Method | Trigger |
|-----------|---------------|---------|
| API Servers | Horizontal (add pods) | CPU > 70%, latency > 200ms |
| Workers | Horizontal (add pods) | Queue depth > 1000 |
| PostgreSQL | Vertical + Read Replicas | Connections > 80%, IOPS > threshold |
| Redis | Cluster mode | Memory > 80% |
| Asset Storage | S3/GCS (unlimited) | N/A |

### Stateless API Servers

Requirements for horizontal scaling:
- ❌ No in-memory session store → use Redis
- ❌ No in-memory job queue → use BullMQ with Redis
- ❌ No local file uploads → use S3/GCS
- ❌ No in-memory channel cache → use Redis-backed cache
- ✅ RequestContext is per-request (no server state)

---

## 5. Kubernetes Considerations

### Deployment Architecture

```
Namespace: qtable-production
│
├── Deployment: vendure-api (Replicas: 3-10, HPA)
│   ├── Container: vendure-server
│   ├── Resources: 512Mi-2Gi RAM, 500m-2 CPU
│   ├── Probes: /health-check (liveness + readiness)
│   └── Env: DB_HOST, REDIS_URL, S3_BUCKET, etc.
│
├── Deployment: vendure-worker (Replicas: 2-5, HPA)
│   ├── Container: vendure-worker
│   ├── Resources: 512Mi-1Gi RAM, 500m-1 CPU
│   └── Env: Same as API
│
├── StatefulSet: postgresql (Replicas: 1 primary + 2 replicas)
│   └── Or: Cloud-managed (RDS/CloudSQL)
│
├── Deployment: redis (Replicas: 3, Sentinel/Cluster)
│   └── Or: Cloud-managed (ElastiCache/Memorystore)
│
├── Ingress: nginx-ingress
│   ├── Wildcard cert: *.qtable.vn
│   ├── Custom domain TLS: cert-manager + Let's Encrypt
│   └── Rate limiting annotations per-tenant
│
└── CronJob: tenant-maintenance
    └── Cleanup, backup, metrics aggregation
```

### HPA (Horizontal Pod Autoscaler) Config

| Metric | Target | Scale Range |
|--------|--------|-------------|
| CPU utilization | 70% | 3-10 pods |
| Request latency (p95) | < 200ms | Scale up trigger |
| Queue depth | < 100 | 2-5 worker pods |

### Resource Quotas per Namespace

```
Total CPU:    20 cores
Total Memory: 40Gi
Total Pods:   50
Total PVC:    500Gi
```

---

## 6. Tenant Scale Impact

### Performance at Different Scales

| Scale | Tenants | Total Products | Total Orders/mo | DB Size | Infra |
|-------|---------|---------------|----------------|---------|-------|
| **Small** | 10 | 5K | 5K | ~1GB | Single node |
| **Medium** | 100 | 50K | 50K | ~10GB | 2 API + 1 worker |
| **Growth** | 1K | 500K | 500K | ~100GB | 5 API + 3 workers + read replica |
| **Scale** | 10K | 5M | 5M | ~1TB | 10 API + 5 workers + sharding |
| **Enterprise** | 100K | 50M | 50M | ~10TB | Distributed PG (Citus) + multi-region |

### Bottleneck Analysis

| Scale | Primary Bottleneck | Solution |
|-------|-------------------|---------|
| 1-100 | None (comfortable) | Single instance suffices |
| 100-1K | Database connections | PgBouncer + connection pooling |
| 1K-10K | Channel join table sizes | Hash partitioning by channelId |
| 10K-100K | Single DB write capacity | Write sharding (Citus) or tenant routing |
| 100K+ | Cross-shard queries | Re-evaluate architecture (per-tenant DB for large tenants) |

### Monitoring per Tenant

| Metric | Purpose | Alert Threshold |
|--------|---------|----------------|
| Request count | Usage tracking | > plan limit |
| Response time (p95) | Quality of service | > 500ms |
| Error rate | Tenant health | > 1% |
| Storage usage | Quota enforcement | > 80% of plan limit |
| Query count | DB load attribution | > 10K/min |
| Job queue depth | Processing backlog | > 100 pending jobs |

### Noisy Neighbor Mitigation

| Strategy | Mechanism |
|----------|-----------|
| Per-tenant rate limiting | Redis-backed counters, configurable per plan |
| Query timeout | PostgreSQL `statement_timeout` per connection |
| Connection limiting | PgBouncer per-pool limits |
| Resource quotas | Storage, products, admins per plan |
| Background job priority | Higher plan = higher queue priority |
| Dedicated worker pools | Enterprise tenants get dedicated workers |

---

## 7. Query Plan Analysis

### Expected EXPLAIN Output for Key Queries

| Query | Expected Plan | Red Flag |
|-------|--------------|----------|
| Product list by channel | Index Scan on `idx_product_channel_both` | Seq Scan on product or join table |
| Order list by channel + date | Index Scan on `idx_order_channel_date` | Seq Scan on order |
| Customer lookup by channel | Index Scan on `idx_customer_channel` | Seq Scan on customer_channels |
| Tenant resolution by domain | Index Only Scan on `idx_tenant_domain` | Seq Scan on tenant_domain |
| Tenant resolution by slug | Index Only Scan on `idx_tenant_slug` | Seq Scan on tenant |

### Performance Guard Rule

Every query touching tenant-scoped data MUST be verified with `EXPLAIN ANALYZE`:
1. No `Seq Scan` on tables > 10K rows
2. Index used must include `channelId` as leading column
3. Estimated rows should match tenant's data size, not total DB size

---

## 8. Cache Collision Prevention

### Proof: All Cache Keys Are Tenant-Namespaced

| Cache Type | Key Pattern | Tenant Component | Collision Risk |
|-----------|-------------|------------------|---------------|
| Channel resolution | `channel:token:<token>` | token is unique per tenant | ✅ None |
| Tenant resolution | `tenant:domain:<domain>` | domain is unique per tenant | ✅ None |
| Product list | `products:ch:<channelId>:page:<n>` | channelId is unique | ✅ None |
| Session | `session:<sessionToken>` | sessionToken is unique | ✅ None |
| Role permissions | `perms:user:<userId>:ch:<channelId>` | channelId included | ✅ None |
| Rate limit | `rl:tenant:<tenantId>:min:<ts>` | tenantId included | ✅ None |

### Rule: Every new cache key MUST include tenantId or channelId.

Keys without tenant scope are only allowed for global platform data (e.g., plan definitions).

---

## 9. In-Memory Cache Replacement

> [!WARNING]
> **Vendure's `SelfRefreshingCache` is in-memory and per-instance.**
> It MUST be replaced with Redis-backed cache BEFORE horizontal scaling.
> Otherwise, cache invalidation will race between instances.

| What to replace | Current | Target |
|----------------|---------|--------|
| Channel cache | In-memory `SelfRefreshingCache` | Redis-backed with event-driven invalidation |
| Session store | In-memory | Redis |
| Job queue | In-memory | BullMQ (Redis-backed) |
| Tenant resolution cache | Does not exist | Redis with 5-min TTL |
