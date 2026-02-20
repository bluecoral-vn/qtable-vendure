# Implementation Roadmap — Multi-Tenant SaaS

> **Date:** 2026-02-20
> **Purpose:** Phased implementation plan for multi-tenant SaaS on Vendure
> **Scope:** Foundation → Isolation → Production → Scale
> **Business Context:** Tenant = merchant/store on the platform, each with own domain, products, orders, customers, config

---

## Table of Contents

1. [Phase Overview](#phase-overview)
2. [Phase 1 — Foundation](#phase-1--foundation)
3. [Phase 2 — Isolation Hardening](#phase-2--isolation-hardening)
4. [Phase 3 — Production Readiness](#phase-3--production-readiness)
5. [Phase 4 — Scale Optimization](#phase-4--scale-optimization)
6. [Dependency Graph](#dependency-graph)

---

## Phase Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Phase 1: FOUNDATION              4-6 weeks                     │
│  ████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   │
│  DB setup, Tenant entity, detection, plugin scaffold             │
│                                                                  │
│  Phase 2: ISOLATION HARDENING     3-4 weeks                     │
│  ░░░░░░░░░░░░░░░░░░░████████████████░░░░░░░░░░░░░░░░░░░░░░░░   │
│  RLS, guard hardening, data isolation, audit                     │
│                                                                  │
│  Phase 3: PRODUCTION READINESS    4-5 weeks                     │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░████████████████████░░░░░░░   │
│  Admin UI, lifecycle ops, monitoring, backup, deploy             │
│                                                                  │
│  Phase 4: SCALE OPTIMIZATION      3-4 weeks (ongoing)           │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░████████   │
│  Caching, indexing, K8s tuning, noisy neighbor protection        │
│                                                                  │
│  TOTAL: 14-19 weeks                                             │
└──────────────────────────────────────────────────────────────────┘
```

---

## Phase 1 — Foundation

### Objective

Establish the core multi-tenant infrastructure: database migration, Tenant entity, domain-based tenant detection, and basic provisioning.

### Deliverables

| # | Deliverable | Description |
|---|-------------|-------------|
| 1.1 | PostgreSQL migration | Switch from MariaDB to PostgreSQL with migration workflow |
| 1.2 | Tenant entity | Entity + service for tenant CRUD |
| 1.3 | TenantDomain entity | Domain/subdomain → tenant mapping |
| 1.4 | TenantContextMiddleware | Resolve domain → tenant → inject vendure-token |
| 1.5 | Tenant provisioning | Automated: Seller + Channel + Role + Admin + defaults |
| 1.6 | Admin API (basic) | `createTenant`, `tenants`, `tenant(id)` via GraphQL |
| 1.7 | Shop API (basic) | `registerTenant` self-service registration |
| 1.8 | E2E tests (basic) | Tenant creation, resolution, basic isolation |

### Tasks Breakdown

```
1.1 PostgreSQL Migration
    ├── Update docker-compose.yml to use PostgreSQL 16 as default
    ├── Update dev-config.ts default DB to postgres
    ├── Create initial migration from current schema
    ├── Establish migration naming convention
    └── Disable synchronize: true

1.2 Tenant Entity
    ├── Create Tenant entity (id, name, slug, status, channelId, config, etc.)
    ├── Create TenantService (CRUD + lifecycle state transitions)
    ├── Create TenantConfig type (limits, features, branding)
    └── Register entities in qtable-saas

1.3 TenantDomain Entity
    ├── Create entity (domain, tenantId, isPrimary, verifiedAt)
    ├── Create TenantResolutionService (domain → tenant lookup)
    ├── Add SelfRefreshingCache for domain resolution
    └── Register entity in qtable-saas

1.4 TenantContextMiddleware
    ├── Create NestJS middleware
    ├── Parse Host header → extract domain/subdomain
    ├── Resolve tenant via TenantResolutionService
    ├── Inject vendure-token header
    ├── Attach tenant context to request
    ├── Register via plugin configuration callback
    └── Handle unknown domains (404)

1.5 Tenant Provisioning
    ├── Create TenantProvisioningService
    ├── Step 1: Create Seller
    ├── Step 2: Create Channel
    ├── Step 3: Create Tenant (link to channel)
    ├── Step 4: Create TenantDomain (subdomain)
    ├── Step 5: Create Role with tenant admin permissions
    ├── Step 6: Create Administrator + User
    ├── Step 7: Create default shipping/payment/stock
    ├── Step 8: Emit TenantCreatedEvent
    └── Make each step idempotent

1.6-1.7 API Extensions
    ├── Define GraphQL schema for admin tenant management
    ├── Create TenantAdminResolver
    ├── Define GraphQL schema for shop registration
    ├── Create TenantShopResolver
    └── Register custom permissions (ManageTenants)

1.8 E2E Tests
    ├── Test: Create tenant → verify all resources created
    ├── Test: Domain resolution → correct channel selected
    ├── Test: Tenant admin login → scoped to own channel
    └── Test: Basic isolation → tenant A cannot see tenant B products
```

### Acceptance Criteria

- [ ] PostgreSQL is the default development database with migration workflow
- [ ] A new tenant can be created via Admin API
- [ ] Tenant is resolvable by subdomain (`tenant-slug.qtable.vn`)
- [ ] Tenant admin can log in and see only their data
- [ ] Self-service registration creates a fully provisioned tenant
- [ ] All E2E tests pass

---

## Phase 2 — Isolation Hardening

### Objective

Enforce tenant data isolation at every layer with defense-in-depth: RLS, custom guards, query auditing, and audit logging.

### Deliverables

| # | Deliverable | Description |
|---|-------------|-------------|
| 2.1 | PostgreSQL RLS policies | Row-level security on all tenant-scoped tables |
| 2.2 | TenantGuard | NestJS guard verifying tenant-channel match |
| 2.3 | Default Channel restriction | Block non-SuperAdmin from Default Channel |
| 2.4 | Customer isolation fix | Disable auto-assignment to foreign channels |
| 2.5 | Token override protection | Middleware overrides user-supplied vendure-token |
| 2.6 | Audit logging | Audit log entity + cross-tenant attempt logging |
| 2.7 | Isolation E2E tests | Comprehensive cross-tenant attack simulations |

### Tasks Breakdown

```
2.1 PostgreSQL RLS
    ├── Create DB migration for RLS policies on:
    │   ├── product_channels_channel
    │   ├── order (channelId column)
    │   ├── customer_channels_channel
    │   ├── collection_channels_channel
    │   ├── product_variant_channels_channel
    │   └── All other join tables
    ├── Create TypeORM subscriber to SET app.current_tenant_id
    ├── Ensure RLS is set before queries and RESET after
    └── Test: Verify RLS blocks direct SQL cross-tenant access

2.2 TenantGuard
    ├── Create NestJS guard
    ├── Verify ctx.channelId matches resolved tenant
    ├── Block requests where tenant context missing
    ├── Log mismatches as security events
    └── Register guard globally via plugin

2.3 Default Channel Restriction
    ├── TenantGuard blocks non-platform roles from Default Channel
    ├── Platform Operator role for day-to-day management
    └── SuperAdmin allowed but fully logged

2.4 Customer Isolation
    ├── Override AuthGuard.setActiveChannel behavior
    │   (via custom strategy or guard)
    ├── Prevent customer auto-assignment to other channels
    └── Customer can only be in their registering channel

2.5 Token Override
    ├── Middleware always overrides vendure-token from domain
    ├── Log when user-supplied token differs from resolved
    └── Rate limit on token mismatch attempts

2.6 Audit Logging
    ├── Create AuditLog entity
    ├── Create AuditService
    ├── Log: tenant lifecycle events
    ├── Log: cross-tenant access attempts
    ├── Log: SuperAdmin actions
    └── Admin API: query audit logs (scoped)

2.7 Isolation Tests
    ├── Test: Tenant A creates product → Tenant B cannot see it
    ├── Test: Token substitution → request gets correct tenant
    ├── Test: Direct SQL (bypass ORM) → RLS blocks
    ├── Test: IDOR attempt → EntityNotFoundError
    ├── Test: Default Channel access → blocked for tenant admin
    └── Test: Privilege escalation → blocked
```

### Acceptance Criteria

- [ ] RLS policies active on all channel-scoped tables
- [ ] Direct SQL query without app context returns 0 rows
- [ ] TenantGuard blocks all cross-tenant API requests
- [ ] Customer registration is isolated per tenant
- [ ] Token substitution attack is neutralized
- [ ] Audit log captures all security-relevant events
- [ ] Full isolation test suite passes (≥ 20 test cases)

---

## Phase 3 — Production Readiness

### Objective

Build operational capabilities for production: admin UI, lifecycle operations, monitoring, backup, and deployment.

### Deliverables

| # | Deliverable | Description |
|---|-------------|-------------|
| 3.1 | Tenant admin dashboard | Platform admin UI for tenant management |
| 3.2 | Tenant lifecycle operations | Suspend, reactivate, delete (full flow) |
| 3.3 | Tenant self-service | Tenant admin: update config, domains, branding |
| 3.4 | Monitoring & alerting | Per-tenant metrics, alerts |
| 3.5 | Backup & restore | Per-tenant backup capability |
| 3.6 | Production deployment | Kubernetes manifests, CI/CD, TLS |
| 3.7 | Documentation | Operational runbook, troubleshooting guide |

### Tasks Breakdown

```
3.1 Admin Dashboard
    ├── Tenant list view (filter, search, paginate)
    ├── Tenant detail view (config, domains, usage)
    ├── Create tenant form
    ├── Suspend/reactivate actions
    ├── Audit log viewer
    └── Platform analytics overview

3.2 Lifecycle Operations
    ├── Suspend: Status change + cache invalidation + notification
    ├── Reactivate: Status change + cache refresh + notification
    ├── Delete: 3-phase (pending → soft → hard delete)
    ├── Grace period logic (30 days)
    └── Data purge job (after 90 days)

3.3 Tenant Self-Service
    ├── "My Store" settings page
    ├── Custom domain management (add, verify, remove)
    ├── Branding configuration
    ├── Staff invitation
    └── Data export request

3.4 Monitoring
    ├── Prometheus metrics exporter
    ├── Per-tenant request counts, latency, errors
    ├── Grafana dashboards
    ├── Alert rules (high error rate, slow queries, quota near limit)
    └── Jaeger trace tenant tagging

3.5 Backup
    ├── Per-tenant logical backup service
    ├── S3 storage for backups
    ├── Backup scheduling (daily for active tenants)
    ├── Restore capability
    └── Backup integrity verification

3.6 Deployment
    ├── Dockerfile (multi-stage build)
    ├── Kubernetes Deployment + Service
    ├── Ingress with wildcard TLS
    ├── cert-manager for custom domains (Let's Encrypt)
    ├── HPA configuration
    ├── GitHub Actions CI/CD pipeline
    └── Staging environment

3.7 Documentation
    ├── Operational runbook
    ├── Tenant onboarding guide
    ├── Troubleshooting guide
    ├── API documentation
    └── Architecture decision records (ADRs)
```

### Acceptance Criteria

- [ ] Platform admin can manage tenants via dashboard
- [ ] Tenant can be suspended and reactivated
- [ ] Tenant deletion follows 3-phase process
- [ ] Per-tenant monitoring dashboards operational
- [ ] Per-tenant backup can be created and restored
- [ ] Application deployed to Kubernetes staging
- [ ] Custom domain TLS works automatically
- [ ] CI/CD pipeline runs isolation tests on every PR

---

## Phase 4 — Scale Optimization

### Objective

Optimize for 1K+ tenants: caching, indexing, connection pooling, noisy neighbor protection, and performance tuning.

### Deliverables

| # | Deliverable | Description |
|---|-------------|-------------|
| 4.1 | Redis caching layer | Tenant resolution, session, product cache |
| 4.2 | Database optimization | Composite indexes, partitioning, PgBouncer |
| 4.3 | Noisy neighbor protection | Per-tenant rate limiting, quotas |
| 4.4 | Search index optimization | Per-tenant search filtering |
| 4.5 | Performance testing | Load test at 1K and 10K tenant scale |
| 4.6 | Auto-scaling | HPA tuning, worker scaling |

### Tasks Breakdown

```
4.1 Redis Caching
    ├── Replace in-memory channel cache with Redis
    ├── Redis session store
    ├── Product/collection cache (per-channel)
    ├── Rate limit counters
    └── Cache warming on tenant provision

4.2 Database Optimization
    ├── Add composite indexes on all join tables
    ├── Add partial indexes for active data
    ├── Set up PgBouncer for connection pooling
    ├── Enable query monitoring (pg_stat_statements)
    ├── Evaluate table partitioning (if >1K tenants)
    └── Configure read replicas for read-heavy queries

4.3 Noisy Neighbor Protection
    ├── Per-tenant rate limiting (requests/min)
    ├── Per-tenant connection limits
    ├── Per-tenant query timeout
    ├── Storage quota enforcement
    ├── Product/order count limits per plan
    └── Alert on quota threshold breach

4.4 Search Optimization
    ├── Ensure search index includes channelId
    ├── Search queries always filter by channelId
    ├── Index rebuild per-tenant capability
    └── Search result cache (per-channel)

4.5 Performance Testing
    ├── Create k6/Artillery load test scripts
    ├── Simulate 1K concurrent tenants
    ├── Measure: latency, throughput, error rate
    ├── Identify bottlenecks
    └── Optimize based on results

4.6 Auto-scaling
    ├── Tune HPA thresholds based on load tests
    ├── Configure worker auto-scaling
    ├── Set up pod disruption budgets
    └── DR planning (multi-AZ deployment)
```

### Acceptance Criteria

- [ ] Tenant resolution < 1ms (cached)
- [ ] Product list query < 50ms (for any tenant)
- [ ] System handles 1K concurrent tenants with p95 < 200ms
- [ ] No noisy neighbor impact (tenant A traffic spike doesn't affect tenant B)
- [ ] Rate limiting blocks abusive tenants
- [ ] Auto-scaling responds to load within 2 minutes
- [ ] Performance regression tests in CI

---

## Dependency Graph

```
Phase 1.1 (PostgreSQL)
    │
    ├──► Phase 1.2 (Tenant Entity) ──► Phase 1.5 (Provisioning)
    │                                        │
    ├──► Phase 1.3 (TenantDomain) ──► Phase 1.4 (Middleware)
    │                                        │
    │                                ┌───────┴───────┐
    │                                │               │
    │                          Phase 1.6         Phase 1.7
    │                          (Admin API)       (Shop API)
    │                                │               │
    │                                └───────┬───────┘
    │                                        │
    │                                 Phase 1.8 (E2E Tests)
    │
    └──► Phase 2.1 (RLS) ──► Phase 2.2 (TenantGuard)
                                     │
                              ┌──────┼──────┐
                              │      │      │
                        Phase 2.3  Phase 2.4  Phase 2.5
                              │      │      │
                              └──────┼──────┘
                                     │
                              Phase 2.6 (Audit)
                                     │
                              Phase 2.7 (Isolation Tests)
                                     │
                              ┌──────┴──────┐
                              │             │
                        Phase 3.1-3.3  Phase 3.4-3.5
                        (UI + Lifecycle) (Ops)
                              │             │
                              └──────┬──────┘
                                     │
                              Phase 3.6 (Deploy)
                                     │
                              Phase 4.x (Scale)
```

---

## Blocker Resolution Map

Every production blocker from the readiness assessment is mapped to a specific deliverable:

| Blocker | Description | Resolved By | Phase |
|---------|-------------|-------------|-------|
| B-001 | Default Channel = god mode | 2.3 Default Channel restriction | Phase 2 |
| B-002 | No tenant middleware | 1.4 TenantContextMiddleware | Phase 1 |
| B-003 | Tenant resolution does not exist | 1.2 + 1.3 Tenant + TenantDomain entities | Phase 1 |
| B-004 | No PostgreSQL, no migrations | 1.1 PostgreSQL migration | Phase 1 |
| B-005 | No audit log | 2.6 Audit logging | Phase 2 |
| B-006 | No privilege escalation prevention | 2.2 TenantGuard + 2.3 Default Channel | Phase 2 |
| B-007 | In-memory cache, no Redis | 4.1 Redis caching layer | Phase 4 |

---

## Test Enforcement Gates

### Per-Phase Test Requirements

| Phase | Test Type | Minimum Count | CI Gate |
|-------|-----------|---------------|--------|
| Phase 1 | Provisioning + resolution tests | 8 | ✅ Block merge |
| Phase 2 | Isolation + escalation + audit tests | 20 | ✅ Block merge |
| Phase 3 | Lifecycle + backup/restore tests | 10 | ✅ Block merge |
| Phase 4 | Performance + load tests | 5 | ⚠️ Warning only |

### Business Gap Coverage

| Gap | Description | Phase | Deliverable |
|-----|-------------|-------|-------------|
| G1 | No Tenant entity | Phase 1 | 1.2 |
| G2 | No tenant detection | Phase 1 | 1.3 + 1.4 |
| G3 | ManyToMany data sharing | Phase 2 | 2.1-2.5 |
| G4 | No SuperAdmin boundary | Phase 2 | 2.2 + 2.3 |
| G5 | No onboarding workflow | Phase 1 | 1.5 |
| G6 | No per-tenant config | Phase 1 | 1.2 |
| G7 | No audit logging | Phase 2 | 2.6 |
| G8 | No rate limiting | Phase 4 | 4.3 |
| G9 | No asset isolation | Phase 3 | 3.3 |
| G10 | No per-tenant email | Phase 3 | 3.3 |
| G11 | No search isolation | Phase 4 | 4.4 |
| G12 | No backup/restore | Phase 3 | 3.5 |
