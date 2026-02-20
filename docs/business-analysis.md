# Business Analysis — qtable-vendure

> **Date:** 2026-02-20  
> **Purpose:** Business logic assessment for Multi-tenant SaaS readiness  
> **Scope:** Current tenant-like patterns, cross-tenant risks, business flows

---

## Table of Contents

1. [Business Context](#1-business-context)
2. [Current Multi-tenant Simulation](#2-current-multi-tenant-simulation)
3. [Cross-tenant Access Risks](#3-cross-tenant-access-risks)
4. [Business Flows Affected](#4-business-flows-affected)
5. [Gap Analysis](#5-gap-analysis)

---

## 1. Business Context

### Target Model

| Concept | Definition |
|---------|-----------|
| **Tenant** | A merchant/store on the platform |
| **Tenant Data** | Products, orders, customers, inventory, config |
| **Tenant Admin** | Administrator managing their own store |
| **Global Admin** | Platform operator managing all tenants |
| **Storefront** | Each tenant has their own domain/subdomain |

### Vendure's Built-in Model vs SaaS Needs

| Vendure Concept | SaaS Equivalent | Gap |
|----------------|-----------------|-----|
| Channel | Tenant workspace | Partial — data sharing breaks isolation |
| Seller | Tenant entity | Partial — lacks lifecycle, billing, config |
| SuperAdmin | Global Admin | ⚠️ No boundary enforcement |
| Channel Admin | Tenant Admin | Partial — lacks onboarding flow |
| `vendure-token` | Tenant identifier | ⚠️ Not domain-based |

---

## 2. Current Multi-tenant Simulation

### What exists today?

**Nothing.** The `qtable-plugin` is an empty scaffold. No custom entities, services, or business logic has been implemented.

### Vendure's Native Channel System

Vendure's Channels provide a **proto-multi-tenant** pattern used in the `multivendor-plugin` example:

```
┌─────────────────────────────────────────────────┐
│              Default Channel                     │
│  (Platform-level, aggregates all data)           │
├──────────┬──────────┬──────────┬────────────────┤
│ Channel A│ Channel B│ Channel C│  ...           │
│ (Vendor) │ (Vendor) │ (Vendor) │               │
│          │          │          │               │
│ Products │ Products │ Products │               │
│ Orders   │ Orders   │ Orders   │               │
│ Admins   │ Admins   │ Admins   │               │
└──────────┴──────────┴──────────┴────────────────┘
```

This is a **marketplace model**, not a SaaS multi-tenant model:
- Products can be **shared** across channels
- The Default Channel sees **all** data
- No true tenant isolation at data level

### How it's NOT multi-tenant

| Aspect | Marketplace (Current) | Multi-tenant SaaS (Target) |
|--------|----------------------|---------------------------|
| Data ownership | Shared via ManyToMany | Tenant owns data exclusively |
| Default Channel | Aggregates everything | Should not exist or be restricted |
| Product sharing | Cross-channel allowed | Must be isolated |
| Customer sharing | Cross-channel possible | Per-tenant customers |
| Order visibility | Platform sees all orders | Tenant sees only their orders |
| Admin access | SuperAdmin sees everything | Global Admin with explicit boundaries |

---

## 3. Cross-tenant Access Risks

### Risk Level: HIGH

Since no multi-tenant logic exists, the following risks apply if the system were deployed as-is:

| # | Risk | Severity | Description |
|---|------|----------|-------------|
| 1 | **SuperAdmin data leak** | 🔴 Critical | SuperAdmin has unrestricted access to all channels |
| 2 | **Default Channel exposure** | 🔴 Critical | Products assigned to default channel visible to all |
| 3 | **Customer cross-access** | 🟡 High | Customers auto-assigned to channels on request |
| 4 | **No channel constraint on queries** | 🟡 High | Custom queries without channel filter leak data |
| 5 | **Asset path leakage** | 🟡 High | Asset URLs not tenant-scoped, guessable paths |
| 6 | **Job queue context loss** | 🟡 High | Background jobs may lose tenant context |
| 7 | **Session cross-channel** | 🟠 Medium | A session can switch channels freely |
| 8 | **GraphQL introspection** | 🟠 Medium | Schema exposes all types to all tenants |
| 9 | **Event bus leakage** | 🟠 Medium | Events from all channels broadcast globally |
| 10 | **Cache poisoning** | 🟠 Medium | Channel cache shared in-memory |

---

## 4. Business Flows Affected

### 4.1 Tenant Onboarding (Does NOT exist)

Current state: No automated process for creating a new tenant.
The `multivendor-plugin` provides a reference with `registerNewSeller` mutation that:
- Creates Seller
- Creates Channel + links to Seller
- Creates Role + Administrator
- Creates ShippingMethod + StockLocation

**Gap:** No tenant config, domain setup, admin portal invitation, or subscription flow.

### 4.2 Product Management

Current state: Products are assigned to Channels via ManyToMany.

**SaaS requirement:** Each tenant creates and manages products exclusively within their channel. Products must not leak to other channels or the default channel.

### 4.3 Order Processing

Current state: Orders belong to a single Channel. The `multivendor-plugin` splits orders into "aggregate" (default channel) and "seller" orders.

**SaaS requirement:** Orders must be strictly isolated per tenant. No aggregate order concept needed.

### 4.4 Customer Management

Current state: Customers can exist in multiple Channels (auto-assigned in `AuthGuard.setActiveChannel()`).

**SaaS requirement:** Customers should be isolated per tenant unless explicitly shared (marketplace cross-selling).

### 4.5 Reporting & Analytics

Current state: No reporting system. GlobalSettings shared across all channels.

**SaaS requirement:** Per-tenant reporting, dashboards, and metrics isolation.

---

## 5. Gap Analysis

### Critical Gaps (Must resolve before production)

| # | Gap | Description | Effort |
|---|-----|-------------|--------|
| G1 | Tenant Entity | No dedicated Tenant entity with lifecycle, config, subscription | Large |
| G2 | Tenant Detection | No domain/subdomain → tenant resolution | Medium |
| G3 | Data Isolation | ManyToMany sharing model, not isolation model | Large |
| G4 | SuperAdmin Boundary | No separation between platform admin and tenant admin | Medium |
| G5 | Tenant Onboarding | No automated provisioning workflow | Large |
| G6 | Tenant Config | No per-tenant configuration (theme, domain, features, limits) | Medium |

### Important Gaps (Should resolve for production quality)

| # | Gap | Description | Effort |
|---|-----|-------------|--------|
| G7 | Audit Logging | No tenant-scoped audit trail | Medium |
| G8 | Rate Limiting | No per-tenant rate limiting | Small |
| G9 | Asset Isolation | Assets not scoped to tenant paths | Medium |
| G10 | Email Templates | No per-tenant email customization | Small |
| G11 | Search Index | No per-tenant search index isolation | Medium |
| G12 | Backup/Restore | No per-tenant backup capability | Large |

### Informational Gaps (Nice to have)

| # | Gap | Description |
|---|-----|-------------|
| G13 | Tenant Metrics | Per-tenant usage tracking |
| G14 | Feature Flags | Per-tenant feature toggle |
| G15 | White Labeling | Per-tenant branding |
