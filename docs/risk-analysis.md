# Risk Analysis — Multi-Tenant

> **Date:** 2026-02-20  
> **Purpose:** Risk assessment for multi-tenant SaaS architecture on Vendure  
> **Scope:** Technical risks, irreversible decisions, lock-in, upgrade risks

---

## Table of Contents

1. [Top 10 Technical Risks](#1-top-10-technical-risks)
2. [Irreversible Architecture Decisions](#2-irreversible-architecture-decisions)
3. [Potential Technical Debt](#3-potential-technical-debt)
4. [Lock-in Risks](#4-lock-in-risks)
5. [Vendure Upgrade Risks](#5-vendure-upgrade-risks)

---

## 1. Top 10 Technical Risks

| # | Risk | Severity | Probability | Impact | Mitigation |
|---|------|----------|-------------|--------|-----------|
| 1 | **Cross-tenant data leakage** | 🔴 Critical | Medium | Catastrophic — loss of trust, legal liability | 4-layer isolation (middleware, guard, app, RLS); e2e isolation tests |
| 2 | **Shared schema performance degradation** | 🟡 High | High (at scale) | Slow queries across all tenants | Partitioning, composite indexes, connection pooling, monitoring |
| 3 | **Vendure core breaking change** | 🟡 High | Medium | Tenant plugin may break on upgrade | Pin Vendure version; comprehensive e2e test suite; upgrade quarterly |
| 4 | **RLS misconfiguration** | 🔴 Critical | Low | Silent data leak at DB level | Automated RLS verification tests; policy-as-code |
| 5 | **Noisy neighbor exhausting resources** | 🟠 Medium | High | Other tenants experience slowness | Per-tenant rate limiting, connection quotas, query timeouts |
| 6 | **Tenant provisioning failure (partial)** | 🟠 Medium | Medium | Orphaned resources, broken tenant | Idempotent provisioning; compensation logic; health check |
| 7 | **Session/cache poisoning** | 🟡 High | Low | Cross-tenant session hijack | Cache keys include channelId; session bound to channel |
| 8 | **Migration breaking tenant data** | 🟡 High | Low | Data corruption for all tenants simultaneously | Migration staging environment; backup before migration; rollback plan |
| 9 | **Domain resolution failure** | 🟠 Medium | Low | Tenant unreachable via custom domain | DNS health checks; fallback to subdomain; monitoring |
| 10 | **SuperAdmin account compromise** | 🔴 Critical | Low | Access to ALL tenant data | MFA required; audit logging; IP restrictions; privilege reduction |

### Risk Heat Map

```
                    PROBABILITY
                    Low      Medium     High
              ┌──────────┬──────────┬──────────┐
  CRITICAL    │ R4: RLS  │ R1: Data │          │
              │ R10: SA  │  leakage │          │
              ├──────────┼──────────┼──────────┤
  HIGH        │ R8: Migr │ R3: Core │ R2: Perf │
              │          │ R7: Cache│          │
              ├──────────┼──────────┼──────────┤
  MEDIUM      │ R9: DNS  │ R6: Prov │ R5:Noisy │
              │          │          │          │
              └──────────┴──────────┴──────────┘
```

---

## 2. Irreversible Architecture Decisions

### Decision 1: Single DB – Shared Schema

| Aspect | Detail |
|--------|--------|
| **Decision** | All tenants share one database and schema |
| **Reversibility** | 🔴 Extremely difficult to change later |
| **Why irreversible** | Migrating 10K tenants from shared to separate DBs requires massive data migration, application rewrite, and infrastructure changes |
| **Acceptable if** | You are confident you will not need physical data separation for regulatory reasons (some industries require it) |
| **Escape hatch** | Hybrid approach: start shared, move large/regulated tenants to dedicated DB |

### Decision 2: Channel = Tenant Mapping (1:1)

| Aspect | Detail |
|--------|--------|
| **Decision** | Each tenant maps to exactly one Vendure Channel |
| **Reversibility** | 🟡 Difficult but not impossible |
| **Why difficult** | All data filtering relies on channelId. Changing to a different key requires query-level changes |
| **Acceptable if** | You do not need multi-channel PER tenant (e.g., tenant with B2B + B2C channels) |
| **Escape hatch** | Tenant can own multiple Channels in the future (1:N), but enforce primary channel |

### Decision 3: PostgreSQL as Primary Database

| Aspect | Detail |
|--------|--------|
| **Decision** | Use PostgreSQL (replacing MariaDB) |
| **Reversibility** | 🟡 Possible but painful |
| **Why** | RLS, JSONB, better concurrency, partitioning support |
| **Risk** | Vendure officially supports both MySQL/MariaDB and PostgreSQL, but some edge cases differ |
| **Acceptable** | PostgreSQL is the recommended production DB per Vendure docs |

### Decision 4: Plugin-Based Architecture (No Core Modification)

| Aspect | Detail |
|--------|--------|
| **Decision** | ALL multi-tenant logic lives in the plugin; core packages untouched |
| **Reversibility** | ✅ Easy — plugin can be removed or replaced |
| **Why good** | Preserves upgrade path from upstream Vendure |
| **Limitation** | Some features may be harder to implement without core changes |
| **Accepted trade-off** | Slightly more complex workarounds vs. clean upgrade path |

---

## 3. Potential Technical Debt

### Debt Created by Multi-tenant Design

| # | Debt | Trigger | Impact | Prevention |
|---|------|---------|--------|-----------|
| 1 | **Channel join table growth** | Every entity assignment creates rows in multiple join tables | Query slowdown | Regular index maintenance, partitioning |
| 2 | **RLS policy maintenance** | Every new entity needs its own RLS policy | Missed policies = leak risk | Automated policy generation from entity metadata |
| 3 | **Cache invalidation complexity** | Tenant-scoped cache keys multiply cache entries | Memory growth, stale data | TTL-based expiry, event-driven invalidation |
| 4 | **Tenant provisioning complexity** | Each new resource type adds provisioning steps | Provisioning failures | Provisioning pipeline with step tracking |
| 5 | **Test matrix expansion** | Must test in single-tenant AND multi-tenant modes | Slower CI/CD | Focused test suites, parallel execution |
| 6 | **Migration testing** | Migration must work for 0 and N tenants | Migration failures in production | Staging with production-like tenant count |
| 7 | **Monitoring overhead** | Per-tenant metrics multiply cardinality | Monitoring cost | Sampling, aggregation, tiered monitoring |

### Technical Debt Prevention Rules

- Every new entity MUST define its RLS policy at creation time
- Every new query MUST include `channelId` filter (enforced by code review)
- Every new cache key MUST include tenant/channel scope
- Every new provisioning step MUST be idempotent
- Every new feature MUST have multi-tenant isolation test

---

## 4. Lock-in Risks

### Vendure Framework Lock-in

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Vendure project becomes unmaintained | 🟠 Medium | Active OSS community; framework is MIT licensed; fork possible |
| Vendure changes Channel architecture | 🟡 High | Pin version; our plugin isolates dependency on Channel |
| Vendure introduces native multi-tenant | 🟢 Low (opportunity) | Could simplify our plugin or replace it |
| NestJS major breaking change | 🟠 Medium | Vendure team handles NestJS upgrades |
| TypeORM breaking change | 🟡 High | Vendure team handles TypeORM compatibility |

### PostgreSQL Lock-in

| Risk | Severity | Mitigation |
|------|----------|-----------|
| RLS is PostgreSQL-specific | 🟡 High | Application-level filtering works without RLS (RLS is safety net) |
| JSONB queries are PG-specific | 🟠 Medium | Abstract config queries behind service layer |
| Partitioning syntax is PG-specific | 🟠 Medium | Only needed at 10K+ tenants; can defer |

### Infrastructure Lock-in

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Cloud provider lock-in | 🟠 Medium | Use Kubernetes for portability; avoid cloud-specific services |
| Redis dependency | 🟢 Low | Standard Redis, available everywhere |
| S3 dependency | 🟢 Low | S3-compatible APIs (MinIO for self-hosted) |

---

## 5. Vendure Upgrade Risks

### Current Version: 3.5.2

### Upgrade Impact Assessment

| Change Type | Frequency | Multi-tenant Impact | Risk Level |
|------------|-----------|---------------------|-----------|
| **Patch (3.5.x)** | Monthly | Low — bug fixes | 🟢 Low |
| **Minor (3.x.0)** | Quarterly | Medium — new features, possible API changes | 🟠 Medium |
| **Major (4.0.0)** | Yearly+ | High — breaking changes possible | 🔴 High |

### Specific Upgrade Risks

| Risk | Description | Impact on Multi-tenant |
|------|-------------|----------------------|
| Channel entity schema change | Vendure adds/modifies Channel columns | Tenant entity wrapper may need update |
| RequestContext API change | Properties added/removed | Our middleware/guard may break |
| AuthGuard refactoring | Guard execution order changes | TenantGuard may execute at wrong time |
| TypeORM version upgrade | ORM behavior changes | RLS integration may need adjustment |
| Dashboard replacement | Angular → React migration (in progress) | Admin UI extensions need migration |
| Permission enum changes | New permissions added | Role templates may need update |
| Plugin API changes | VendurePlugin decorator changes | Plugin registration may need update |

### Upgrade Strategy

```
1. Pin Vendure version in package.json (exact version)
2. Monitor upstream CHANGELOG weekly
3. Quarterly upgrade cycle:
   a. Create upgrade branch
   b. Merge upstream changes
   c. Run full multi-tenant test suite
   d. Fix any breaking changes in plugin
   e. Deploy to staging with production data snapshot
   f. Validate tenant isolation
   g. Deploy to production
4. Emergency patches:
   a. Cherry-pick specific fix from upstream
   b. Apply to current pinned version
   c. Expedited testing + deploy
```

### Safe Zone vs Danger Zone

```
SAFE (low risk to change):
├── Plugin registration mechanism
├── Entity custom fields
├── EventBus subscription
├── Service injection
└── GraphQL schema extensions

DANGER (high risk of upstream change):
├── AuthGuard internals
├── RequestContext constructor
├── Channel resolution flow
├── TransactionalConnection internals
└── Session management
```

### Recommendation

- **Track Vendure's v4 roadmap** closely (may introduce native multi-tenant features)
- **Maintain abstraction layer** between plugin and Vendure internals
- **Automated upgrade tests**: Run multi-tenant isolation tests against new Vendure versions in CI
