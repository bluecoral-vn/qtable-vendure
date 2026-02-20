# Risk Analysis — Multi-Tenant

> **Date:** 2026-02-20
> **Purpose:** Risk assessment for multi-tenant SaaS architecture on Vendure
> **Scope:** Technical risks, failure modes, lock-in, upgrade risks, cross-tenant risks

---

## Table of Contents

1. [Top 10 Technical Risks](#1-top-10-technical-risks)
2. [Cross-tenant Access Risks](#2-cross-tenant-access-risks)
3. [Failure Mode Analysis](#3-failure-mode-analysis)
4. [Irreversible Architecture Decisions](#4-irreversible-architecture-decisions)
5. [Lock-in Risks](#5-lock-in-risks)
6. [Vendure Upgrade Risks](#6-vendure-upgrade-risks)

---

## 1. Top 10 Technical Risks

| # | Risk | Severity | Probability | Impact | Mitigation | Mitigated? |
|---|------|----------|-------------|--------|------------|------------|
| 1 | **Cross-tenant data leakage** | 🔴 Critical | Medium | Catastrophic | 4-layer isolation + e2e tests | ❌ No |
| 2 | **Shared schema performance degradation** | 🟡 High | High (at scale) | Slow queries | Partitioning, indexes, pooling | ❌ No |
| 3 | **Vendure core breaking change** | 🟡 High | Medium | Plugin may break | Pin version; e2e test suite | ⚠️ Partial |
| 4 | **RLS misconfiguration** | 🔴 Critical | Low | Silent data leak | Automated RLS verification tests | ❌ No |
| 5 | **Noisy neighbor exhausting resources** | 🟠 Medium | High | Other tenants slow | Per-tenant rate limiting, quotas | ❌ No |
| 6 | **Tenant provisioning failure (partial)** | 🟠 Medium | Medium | Orphaned resources | Idempotent provisioning; health check | ❌ No |
| 7 | **Session/cache poisoning** | 🟡 High | Low | Cross-tenant session hijack | Cache keys include channelId | ❌ No |
| 8 | **Migration breaking tenant data** | 🟡 High | Low | All tenants corrupted | Staging env; backup before migration | ❌ No |
| 9 | **Domain resolution failure** | 🟠 Medium | Low | Tenant unreachable | DNS health checks; subdomain fallback | ❌ No |
| 10 | **SuperAdmin account compromise** | 🔴 Critical | Low | ALL tenant data exposed | MFA + audit logging + IP restrictions | ❌ No |

### Risk Heat Map

```
                    PROBABILITY
                    Low      Medium     High
              ┌──────────┬──────────┬──────────┐
  CRITICAL    │ R4: RLS  │ R1: Data │          │
              │ R10: SA  │  leakage │          │
              ├──────────┼──────────┼──────────┤
  HIGH        │ R8: Migr │ R3: Core │ R2: Perf │
              │ R7: Cache│          │          │
              ├──────────┼──────────┼──────────┤
  MEDIUM      │ R9: DNS  │ R6: Prov │ R5:Noisy │
              │          │          │          │
              └──────────┴──────────┴──────────┘
```

---

## 2. Cross-tenant Access Risks

| # | Risk | Severity | Description | Required Mitigation |
|---|------|----------|-------------|-------------------|
| 1 | **SuperAdmin data leak** | 🔴 Critical | SuperAdmin has unrestricted access to all channels | Audit logging + operational guard |
| 2 | **Default Channel exposure** | 🔴 Critical | Products assigned to default channel visible to all | TenantGuard blocks non-platform users |
| 3 | **Customer cross-access** | 🟡 High | Customers auto-assigned to channels on request | Override setActiveChannel behavior |
| 4 | **No channel constraint on queries** | 🟡 High | Custom queries without channel filter leak data | ESLint rule + RLS safety net |
| 5 | **Asset path leakage** | 🟡 High | Asset URLs not tenant-scoped, guessable paths | Tenant-scoped asset paths |
| 6 | **Job queue context loss** | 🟡 High | Background jobs may lose tenant context | Serialize tenantId in job payload |
| 7 | **Session cross-channel** | 🟠 Medium | A session can switch channels freely | TenantGuard validates session-channel match |
| 8 | **GraphQL introspection** | 🟠 Medium | Schema exposes all types to all tenants | Per-tenant introspection filtering |
| 9 | **Event bus leakage** | 🟠 Medium | Events from all channels broadcast globally | Filter events by channelId |
| 10 | **Cache poisoning** | 🟠 Medium | Channel cache shared in-memory | Redis + tenant-namespaced keys |

---

## 3. Failure Mode Analysis

### 10 Critical Failure Scenarios

| # | Scenario | Severity | System Response (current) | Data Corruption? | Required Response |
|---|----------|----------|--------------------------|-----------------|-------------------|
| 1 | **Token substitution** — user sends vendure-token of another tenant | 🔴 CRITICAL | ❌ No protection — switches to that tenant | ✅ Read/write cross-tenant | Middleware overrides token from domain |
| 2 | **RLS not active** — query lacks channel filter | 🔴 CRITICAL | ❌ Returns ALL data | ✅ Data leak | RLS as safety net + ESLint |
| 3 | **SuperAdmin compromised** | 🔴 CRITICAL | ❌ No audit — undetectable | ✅ Full access ALL tenants | MFA + audit + IP restrict |
| 4 | **Migration fails mid-way** | 🟡 HIGH | ❌ No automated rollback | ✅ Schema inconsistent | Backup before migration + rollback plan |
| 5 | **Provisioning fails step 6/11** | 🟠 MEDIUM | ❌ Orphan Channel + Seller | No — only resource leak | Idempotent steps + cleanup job |
| 6 | **Noisy neighbor heavy query** | 🟡 HIGH | ❌ No rate limit or timeout | No — only performance | Per-tenant query timeout + rate limit |
| 7 | **Customer auto-assigned cross-channel** | 🟡 HIGH | ❌ Vendure auto-assigns | ✅ Privacy violation | Override setActiveChannel |
| 8 | **Cache stale after tenant suspend** | 🟠 MEDIUM | ❌ No invalidation | No — access violation | Event-driven cache invalidation |
| 9 | **Background job wrong tenant context** | 🟡 HIGH | ❌ No serialization logic | ✅ Job modifies wrong tenant | Serialize + validate tenantId |
| 10 | **Search returns cross-tenant results** | 🟡 HIGH | ❌ No channelId filter in search | ✅ Data leak via search | Always filter search by channelId |

---

## 4. Irreversible Architecture Decisions

### Decision 1: Single DB – Shared Schema

| Aspect | Detail |
|--------|--------|
| **Reversibility** | 🔴 Extremely difficult |
| **Why** | Migrating 10K tenants to separate DBs requires massive infrastructure changes |
| **Escape hatch** | Hybrid: move large/regulated tenants to dedicated DB |

### Decision 2: Channel = Tenant Mapping (1:1)

| Aspect | Detail |
|--------|--------|
| **Reversibility** | 🟡 Difficult but possible |
| **Why** | All data filtering relies on channelId |
| **Escape hatch** | Tenant can own multiple Channels (1:N), enforce primary |

### Decision 3: PostgreSQL as Primary Database

| Aspect | Detail |
|--------|--------|
| **Reversibility** | 🟡 Possible but painful |
| **Why** | RLS, JSONB, better concurrency, partitioning |

### Decision 4: Plugin-Based Architecture (No Core Modification)

| Aspect | Detail |
|--------|--------|
| **Reversibility** | ✅ Easy — plugin can be removed or replaced |
| **Why** | Preserves upgrade path from upstream Vendure |

---

## 5. Lock-in Risks

### Vendure Framework

| Risk | Severity | Mitigation |
|------|----------|------------|
| Vendure becomes unmaintained | 🟠 Medium | MIT licensed; fork possible |
| Vendure changes Channel architecture | 🟡 High | Pin version; plugin isolates dependency |
| NestJS major breaking change | 🟠 Medium | Vendure team handles upgrades |
| TypeORM breaking change | 🟡 High | Vendure team handles compatibility |

### PostgreSQL

| Risk | Severity | Mitigation |
|------|----------|------------|
| RLS is PostgreSQL-specific | 🟡 High | Application-level filtering works without RLS |
| JSONB queries are PG-specific | 🟠 Medium | Abstract behind service layer |

---

## 6. Vendure Upgrade Risks

### Upgrade Impact Assessment

| Change Type | Frequency | Multi-tenant Impact |
|------------|-----------|---------------------|
| Patch (3.5.x) | Monthly | 🟢 Low — bug fixes |
| Minor (3.x.0) | Quarterly | 🟠 Medium — API changes |
| Major (4.0.0) | Yearly+ | 🔴 High — breaking changes |

### Danger Zone (High risk of upstream change)

- AuthGuard internals
- RequestContext constructor
- Channel resolution flow
- TransactionalConnection internals
- Session management

### Upgrade Strategy

```
1. Pin Vendure version exactly
2. Monitor upstream CHANGELOG weekly
3. Quarterly upgrade cycle:
   a. Create upgrade branch
   b. Merge upstream changes
   c. Run full multi-tenant test suite
   d. Fix breaking changes in plugin
   e. Deploy to staging → validate isolation
   f. Deploy to production
4. Emergency patches: cherry-pick + expedited testing
```
