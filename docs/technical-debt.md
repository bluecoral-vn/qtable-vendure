# Technical Debt — qtable-vendure

> **Date:** 2026-02-20  
> **Purpose:** Technical debt assessment blocking Multi-tenant SaaS implementation  
> **Scope:** Architecture violations, refactoring needs, and upgrade risks

---

## Table of Contents

1. [Critical Technical Debt](#1-critical-technical-debt)
2. [Architecture Violations](#2-architecture-violations)
3. [Refactoring Required Before Multi-tenant](#3-refactoring-required-before-multi-tenant)
4. [Vendure Core Constraints](#4-vendure-core-constraints)
5. [Infrastructure Debt](#5-infrastructure-debt)
6. [Summary & Priority Matrix](#6-summary--priority-matrix)

---

## 1. Critical Technical Debt

### TD-1: No Tenant Abstraction Layer

**Impact:** 🔴 Blocks all multi-tenant work  
**Current state:** Direct use of Vendure's Channel as the only data partitioning mechanism.  
**Problem:** Channel's ManyToMany model allows data sharing, which violates tenant isolation.  
**Needed:** A Tenant entity/service layer that wraps Channel with strict isolation semantics.

### TD-2: No Database Isolation Strategy

**Impact:** 🔴 Critical security risk  
**Current state:** Single database, single schema, no Row-Level Security (RLS).  
**Problem:** Any custom query without channel filter can access all tenants' data.  
**Needed:** RLS policies or application-level query interceptors that enforce `tenantId` on every query.

### TD-3: No Production Database Configuration

**Impact:** 🔴 Production blocker  
**Current state:** Development uses MariaDB with `synchronize: true`. Production database is "TBD".  
**Problem:** `synchronize: true` is dangerous in production. No migration strategy enforced.  
**Needed:** PostgreSQL with proper migration workflow, connection pooling, and RLS.

### TD-4: SuperAdmin Has No Boundaries

**Impact:** 🟡 Security concern  
**Current state:** `SuperAdmin` permission bypasses all channel-scoped checks.  
**Problem:** In SaaS, even platform admin should not have unfettered access to tenant data without audit.  
**Needed:** Audit logging for SuperAdmin actions, explicit scope even for global operations.

---

## 2. Architecture Violations

### AV-1: Shared Data Model Violates SaaS Isolation Principle

Vendure's ManyToMany design allows:
```
Product A ←→ Channel 1 (Tenant 1)
Product A ←→ Channel 2 (Tenant 2)   ← VIOLATION: Same product in 2 tenants
```

**SaaS principle:** Each tenant's data must be exclusively owned and not shareable cross-tenant.

### AV-2: Customer Auto-Assignment Breaks Tenant Boundaries

`AuthGuard.setActiveChannel()` automatically assigns customers to the active channel:
```
Customer visits Channel B → Customer entity linked to Channel B
Customer visits Channel A → Customer entity linked to Channel A
              → Customer now exists in BOTH channels
```

**SaaS principle:** Customers should not leak between tenant boundaries.

### AV-3: Default Channel Acts as Implicit "God Mode"

The Default Channel sees all data and cannot be deleted. In SaaS:
- Default Channel should be strictly a platform-admin-only space
- Tenant channels must not inherit from or share data with Default Channel

### AV-4: No Tenant-Scoped Configuration

Vendure uses `GlobalSettings` (single row, shared) and `VendureConfig` (static, loaded once at boot).  
**SaaS requirement:** Per-tenant settings for:
- Feature flags
- Rate limits
- Storage quotas
- Custom domain
- Branding/theme
- Payment configuration

### AV-5: Event Bus Has No Tenant Context Filtering

Events broadcast globally. Any subscriber receives events from all tenants.
```
OrderPlacedEvent (Tenant A) → ALL subscribers, including those for Tenant B
```

---

## 3. Refactoring Required Before Multi-tenant

### Phase 0: Pre-requisites (Do First)

| # | Task | Effort | Rationale |
|---|------|--------|-----------|
| R1 | Switch to PostgreSQL | Small | Required for RLS, better concurrency, production suitability |
| R2 | Disable `synchronize: true` | Small | Use migrations only |
| R3 | Set up proper migration workflow | Medium | TypeORM migrations with versioning |
| R4 | Configure `qtable-plugin` as multi-tenant entry point | Small | Scaffold tenant entities/services |

### Phase 0.5: Foundational Changes

| # | Task | Effort | Rationale |
|---|------|--------|-----------|
| R5 | Design and create Tenant entity | Medium | Core entity for SaaS model |
| R6 | Create TenantService with lifecycle methods | Medium | Provisioning, suspension, deletion |
| R7 | Create domain-based tenant detection middleware | Medium | Map domain/subdomain → tenant |
| R8 | Extend RequestContext with tenant info | Small | Carry tenantId through request lifecycle |
| R9 | Create tenant-aware query interceptor | Large | Ensure all queries include tenant constraint |

### Phase 0.75: Security Hardening

| # | Task | Effort | Rationale |
|---|------|--------|-----------|
| R10 | Implement RLS in PostgreSQL | Large | Database-level safety net |
| R11 | Disable customer auto-assignment cross-channel | Small | Prevent customer leakage |
| R12 | Restrict Default Channel access | Small | Platform admin only |
| R13 | Add audit logging for cross-tenant operations | Medium | Compliance and security |

---

## 4. Vendure Core Constraints

### Things We CANNOT Change (upstream limitation)

| Constraint | Impact | Workaround |
|-----------|--------|------------|
| Channel is ManyToMany | Cannot make it OneToMany | Add tenant layer on top |
| SuperAdmin bypasses all guards | Cannot restrict from outside | Custom guard/interceptor |
| `vendure-token` is header-based | Cannot change to domain-based natively | Custom middleware |
| Default Channel always exists | Cannot remove | Restrict access via RBAC |
| Entity metadata is static | Cannot add dynamic columns per tenant | Use `customFields` or separate entities |
| GlobalSettings is singleton | Cannot have per-tenant settings | Create custom TenantSettings entity |
| Session cache is in-memory by default | Cannot share across instances | Use Redis session cache |

### Things We CAN Change (via plugin system)

| Capability | Mechanism |
|-----------|-----------|
| Add new entities | `@VendurePlugin({ entities: [...] })` |
| Add custom fields to existing entities | `customFields` config |
| Add API endpoints | `adminApiExtensions` / `shopApiExtensions` |
| Add middleware/guards | NestJS middleware via plugin `configuration` |
| Override strategies | `configuration` callback modifying VendureConfig |
| Subscribe to events | `EventBus.ofType(...)` |
| Add background jobs | JobQueueService |
| Run code at startup | `OnApplicationBootstrap` lifecycle hook |

---

## 5. Infrastructure Debt

### ID-1: No Redis Configuration

**Impact:** Blocks horizontal scaling  
**Current:** In-memory session cache, in-memory job queue  
**Needed:** Redis for session storage, job queue, distributed caching

### ID-2: No Container/K8s Setup

**Impact:** Blocks production deployment  
**Current:** Docker Compose for development only  
**Needed:** Dockerfile, Kubernetes manifests or Helm chart

### ID-3: No CI/CD for Multi-tenant

**Impact:** Blocks automated testing of tenant isolation  
**Current:** GitHub Actions for Vendure upstream CI  
**Needed:** CI pipeline for multi-tenant integration tests

### ID-4: No Monitoring/Alerting per Tenant

**Impact:** Cannot detect tenant-specific issues  
**Current:** Jaeger + Grafana for general observability  
**Needed:** Tenant-tagged metrics, per-tenant dashboards

### ID-5: No Backup Strategy

**Impact:** Cannot restore individual tenant data  
**Current:** No backup mechanism  
**Needed:** Per-tenant logical backup capability

---

## 6. Summary & Priority Matrix

```
Priority / Impact Matrix:

                    HIGH IMPACT                     LOW IMPACT
                ┌─────────────────────────────┬─────────────────────────┐
   URGENT       │ TD-1: Tenant Abstraction    │ ID-1: Redis Setup       │
   (Do First)   │ TD-2: DB Isolation          │                         │
                │ TD-3: Prod DB Config        │                         │
                │ R1-R4: Pre-requisites       │                         │
                ├─────────────────────────────┼─────────────────────────┤
   IMPORTANT    │ TD-4: SuperAdmin Boundary   │ ID-4: Monitoring        │
   (Do Next)    │ AV-2: Customer Leakage      │ ID-5: Backup Strategy   │
                │ R5-R9: Foundation           │                         │
                │ R10-R13: Security           │                         │
                ├─────────────────────────────┼─────────────────────────┤
   NICE-TO-HAVE │ AV-4: Tenant Config         │ ID-3: CI/CD             │
                │ AV-5: Event Filtering       │                         │
                └─────────────────────────────┴─────────────────────────┘
```

### Total Estimated Effort

| Category | Items | Effort Range |
|----------|-------|-------------|
| Pre-requisites (R1-R4) | 4 | 1-2 weeks |
| Foundation (R5-R9) | 5 | 3-4 weeks |
| Security (R10-R13) | 4 | 2-3 weeks |
| Infrastructure (ID1-ID5) | 5 | 2-3 weeks |
| **Total** | **18** | **8-12 weeks** |
