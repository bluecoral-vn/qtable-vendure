# Test Enforcement Charter — Multi-Tenant SaaS

> **Date:** 2026-02-20
> **Purpose:** Mandatory test strategy ensuring tenant isolation is enforced at every layer
> **Scope:** All test categories, CI gates, PR merge rules, coverage requirements

---

## Table of Contents

1. [Tenant Boundary Tests](#1-tenant-boundary-tests)
2. [Privilege Escalation Tests](#2-privilege-escalation-tests)
3. [Provisioning Tests](#3-provisioning-tests)
4. [Migration Safety Tests](#4-migration-safety-tests)
5. [Performance Guard Tests](#5-performance-guard-tests)
6. [CI Gate Configuration](#6-ci-gate-configuration)
7. [PR Merge Rules](#7-pr-merge-rules)
8. [Coverage Requirements](#8-coverage-requirements)

---

## 1. Tenant Boundary Tests

### Per-Entity Isolation Tests

Every ChannelAware entity MUST have the following tests:

| Test | Description | Expected Result |
|------|-------------|----------------|
| **Create isolation** | Tenant A creates entity → Tenant B queries → NOT visible | 0 results for Tenant B |
| **Read isolation** | Tenant A entity exists → Tenant B queries by ID → NOT found | `EntityNotFoundError` |
| **Update isolation** | Tenant B tries to update Tenant A's entity | `EntityNotFoundError` |
| **Delete isolation** | Tenant B tries to delete Tenant A's entity | `EntityNotFoundError` |
| **List isolation** | Both tenants have entities → each only sees their own | Count matches tenant's data |
| **Search isolation** | Search keyword matches both tenants → each sees own results only | Filtered results |

### Entity Coverage Required

| Entity | Priority | test file |
|--------|----------|-----------|
| Product | 🔴 P0 | `tenant-product-isolation.e2e-spec.ts` |
| Order | 🔴 P0 | `tenant-order-isolation.e2e-spec.ts` |
| Customer | 🔴 P0 | `tenant-customer-isolation.e2e-spec.ts` |
| Collection | 🟡 P1 | `tenant-collection-isolation.e2e-spec.ts` |
| Facet | 🟡 P1 | `tenant-facet-isolation.e2e-spec.ts` |
| Asset | 🟡 P1 | `tenant-asset-isolation.e2e-spec.ts` |
| Administrator | 🔴 P0 | `tenant-admin-isolation.e2e-spec.ts` |
| Promotion | 🟠 P2 | `tenant-promotion-isolation.e2e-spec.ts` |
| ShippingMethod | 🟠 P2 | `tenant-shipping-isolation.e2e-spec.ts` |
| PaymentMethod | 🟠 P2 | `tenant-payment-isolation.e2e-spec.ts` |

### Cross-Tenant Attack Tests

| Test | Attack Vector | Expected |
|------|--------------|----------|
| Token substitution | Send Tenant B's vendure-token on Tenant A's domain | Middleware overrides → only Tenant A data |
| IDOR by ID | Query `product(id: <TenantB_productId>)` | `EntityNotFoundError` (NOT `ForbiddenError`) |
| Default Channel access | Tenant admin sends request without domain context | 404 or 403 |
| GraphQL batch | Batch query with mixed tenant references | All resolve within same tenant |
| Webhook spoof | POST webhook with Tenant B's data to Tenant A endpoint | Signature verification fails |

---

## 2. Privilege Escalation Tests

| # | Test | Expected Result |
|---|------|----------------|
| 1 | Tenant admin assigns SuperAdmin to own role | ❌ Rejected — not in assignable list |
| 2 | Tenant admin creates role for another channel | ❌ Rejected — channel ownership |
| 3 | Tenant admin accesses Default Channel | ❌ 403 Forbidden |
| 4 | Tenant admin calls `createChannel` | ❌ Insufficient permissions |
| 5 | Tenant admin calls `createTenant` | ❌ Insufficient permissions |
| 6 | Add user to two tenant channels | ❌ Rejected — 1 user = 1 tenant |
| 7 | Tenant A user logs in on Tenant B domain | ❌ Session invalid/mismatch |
| 8 | Tenant admin modifies system role | ❌ Rejected — system role protected |
| 9 | Platform operator accesses tenant data | ❌ Rejected — no data permissions |
| 10 | SuperAdmin action WITHOUT audit log | ❌ Must produce audit entry |

---

## 3. Provisioning Tests

| # | Test | Expected Result |
|---|------|----------------|
| 1 | Create tenant → verify all 11 resources | Channel, Seller, Tenant, Domain, Role, Admin, Zone, StockLocation, Shipping, Payment, Event |
| 2 | Create 10 tenants concurrently | All succeed, no slug/domain collisions |
| 3 | Create tenant with duplicate slug | ❌ Rejected with clear error |
| 4 | Create tenant with duplicate domain | ❌ Rejected with clear error |
| 5 | Provisioning fails at step 6 → retry | Idempotent — no duplicate resources |
| 6 | Tenant domain resolves correctly after creation | Subdomain returns correct tenant |
| 7 | Suspend tenant → API returns 403 | Shop API blocked, Admin API read-only |
| 8 | Reactivate tenant → data intact | All previous data accessible |
| 9 | Delete tenant → 3-phase process | PENDING → DELETED → PURGED with grace periods |
| 10 | Cancel deletion within grace period | Tenant restored to ACTIVE |
| 11 | SuperAdmin role assigned to new channel | After channel creation, SuperAdmin can create roles/admins on it (no `ForbiddenError`) |
| 12 | Channel `defaultLanguageCode` matches initial data | `LanguageCode.en` or language present in `availableLanguages` |

---

## 4. Migration Safety Tests

| # | Test | Expected Result |
|---|------|----------------|
| 1 | Run migration with 10 active tenants | All tenant data intact post-migration |
| 2 | Migration adds column | New column present for all tenants |
| 3 | Rollback migration | Schema and data reverted cleanly |
| 4 | Migration during active transactions | No deadlocks, no data loss |
| 5 | New entity migration includes RLS policy | RLS policy active after migration |
| 6 | Migration does not break existing indexes | All composite indexes valid |

---

## 5. Performance Guard Tests

| # | Test | Expected Result |
|---|------|----------------|
| 1 | Product list with 100K total products | Response < 500ms for single tenant |
| 2 | Order list with 100K orders per tenant | Response < 500ms, EXPLAIN shows index scan |
| 3 | No full table scan on scoped queries | `EXPLAIN ANALYZE` confirms index usage |
| 4 | RLS blocks uncontexted queries | Query WITHOUT `SET app.current_tenant_id` → 0 rows |
| 5 | Cache isolation | Invalidate Tenant A cache → Tenant B unaffected |
| 6 | Cache collision test | 1K tenants with similar data → no cross-contamination |
| 7 | Tenant resolution < 1ms (cached) | Redis cache hit returns in < 1ms |

---

## 6. CI Gate Configuration

### Required Test Suites

| Suite | Trigger | Block Merge? | Timeout |
|-------|---------|-------------|---------|
| `tenant-isolation` | Every PR | ✅ Yes | 10 min |
| `privilege-escalation` | Every PR | ✅ Yes | 5 min |
| `provisioning` | Every PR touching tenant/* | ✅ Yes | 5 min |
| `migration-safety` | Every PR with migrations | ✅ Yes | 10 min |
| `performance-guard` | Nightly / pre-release | ⚠️ Warning only | 30 min |

### ESLint Gates

| Rule | Pattern | Action |
|------|---------|--------|
| `no-raw-repository` | `rawConnection.getRepository()` | ❌ Error — blocks merge |
| `no-unscoped-querybuilder` | `createQueryBuilder()` without `channelId` | ⚠️ Warning |
| `require-ctx-param` | Service method without `ctx: RequestContext` | ⚠️ Warning |

---

## 7. PR Merge Rules

### Mandatory Checklist (enforced by CI or reviewer)

```
EVERY PR that touches entities, APIs, or services MUST:

□ Tenant boundary test for each new/modified entity
□ Cross-tenant rejection test for each new API endpoint
□ channelId filter verified in every new DB query
□ Cache key includes tenant namespace
□ Background job serializes tenantId
□ No rawConnection.getRepository() in production code
□ RLS policy migration for new ChannelAware entities
□ EXPLAIN ANALYZE for new queries on large tables
```

### Automatic Enforcement

```
GitHub Actions workflow:
  on: pull_request
  jobs:
    tenant-isolation:
      - Run: npm run test:tenant-isolation
      - Required: true
    eslint-tenant-rules:
      - Run: npm run lint -- --rule 'no-raw-repository: error'
      - Required: true
    rls-policy-check:
      - Run: scripts/check-rls-policies.sh
      - Required: true (for PRs with new entities)
```

---

## 8. Coverage Requirements

### Minimum Coverage by Area

| Area | Test Type | Coverage Target |
|------|-----------|----------------|
| ChannelAware entities | E2E isolation tests | ≥ 90% of entities |
| Privilege escalation vectors | E2E escalation tests | 100% of vectors |
| Provisioning steps | Integration tests | 100% of steps |
| RLS policies | DB-level tests | 100% of policies |
| Custom API endpoints | E2E tests | 100% of endpoints |
| Cache keys | Unit tests | 100% of new keys |

### When to Add Tests

| Trigger | Required Test |
|---------|--------------|
| New entity (ChannelAware) | Tenant boundary test (CRUD) |
| New API endpoint | Cross-tenant rejection test |
| New service method with DB access | channelId filter verification |
| New background job | Tenant context serialization test |
| New cache key | Namespace verification test |
| New migration | Migration safety test |
| New RLS policy | RLS verification test |
