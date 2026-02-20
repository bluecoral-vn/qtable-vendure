# Tenant Lifecycle — Multi-Tenant

> **Date:** 2026-02-20  
> **Purpose:** Design for tenant lifecycle management from onboarding to deletion  
> **Scope:** Provisioning, configuration, suspension, deletion, migration, backup/restore

---

## Table of Contents

1. [Lifecycle State Machine](#1-lifecycle-state-machine)
2. [Tenant Onboarding](#2-tenant-onboarding)
3. [Provisioning](#3-provisioning)
4. [Config Setup](#4-config-setup)
5. [Suspend](#5-suspend)
6. [Delete](#6-delete)
7. [Migrate](#7-migrate)
8. [Backup & Restore](#8-backup--restore)

---

## 1. Lifecycle State Machine

```
                    ┌─────────────┐
                    │  REQUESTED  │
                    └──────┬──────┘
                           │ Auto or manual approval
                    ┌──────▼──────┐
                    │  PROVISION  │ ← Creating Channel, Admin, config
                    │   ING       │
                    └──────┬──────┘
                           │ Provisioning complete
                    ┌──────▼──────┐
               ┌───►│   TRIAL     │◄───────────────────┐
               │    └──────┬──────┘                     │
               │           │ Plan activated              │
               │    ┌──────▼──────┐                     │
               │    │   ACTIVE    │◄─────┐              │
               │    └──┬──────┬───┘      │              │
               │       │      │          │              │
  Reactivate   │       │      │    Reactivate           │
               │       │      │          │              │
               │  Suspend  Delinquent    │              │
               │       │      │          │              │
               │    ┌──▼──────▼───┐      │              │
               └────│  SUSPENDED  │──────┘              │
                    └──────┬──────┘                     │
                           │ Grace period expired        │
                    ┌──────▼──────┐                     │
                    │  PENDING    │                     │
                    │  DELETION   │ ← 30-day grace       │
                    └──────┬──────┘                     │
                           │ Confirmed                   │
                    ┌──────▼──────┐                     │
                    │  DELETED    │ ← Soft delete         │
                    │  (archived) │   Data retained 90d   │
                    └──────┬──────┘                     │
                           │ 90 days                     │
                    ┌──────▼──────┐                     │
                    │   PURGED    │ ← Hard delete         │
                    └─────────────┘                     │
```

### State Definitions

| State | Description | API Access | Admin Access | Data |
|-------|-------------|-----------|-------------|------|
| `REQUESTED` | Registration submitted, pending approval | ❌ | ❌ | None |
| `PROVISIONING` | System creating resources | ❌ | ❌ | Creating |
| `TRIAL` | Active with trial limitations | ✅ Limited | ✅ | Full |
| `ACTIVE` | Fully active with paid plan | ✅ Full | ✅ | Full |
| `SUSPENDED` | Temporarily disabled | ❌ | ✅ Read-only | Preserved |
| `PENDING_DELETION` | Marked for deletion, grace period | ❌ | ✅ Read-only | Preserved |
| `DELETED` | Soft-deleted, data archived | ❌ | ❌ | Archived |
| `PURGED` | Permanently removed | ❌ | ❌ | Destroyed |

---

## 2. Tenant Onboarding

### Self-Service Registration Flow

```
┌─────────────────────────────────────────────┐
│  1. User fills registration form             │
│     ├── Store name                           │
│     ├── Owner email                          │
│     ├── Owner name                           │
│     ├── Password                             │
│     └── Desired subdomain (slug)             │
├──────────────────────────────────────────────┤
│  2. Validation                               │
│     ├── Email uniqueness check               │
│     ├── Slug availability check              │
│     ├── Email format validation              │
│     └── Password strength check              │
├──────────────────────────────────────────────┤
│  3. Email verification                       │
│     └── Send verification link               │
├──────────────────────────────────────────────┤
│  4. Trigger provisioning pipeline            │
│     └── Status: REQUESTED → PROVISIONING     │
├──────────────────────────────────────────────┤
│  5. Provisioning complete                    │
│     └── Status: PROVISIONING → TRIAL         │
│     └── Notify owner: "Your store is ready"  │
└──────────────────────────────────────────────┘
```

### Admin-Initiated Registration

Global admin can create tenants with custom configuration:
- Pre-configured plan
- Custom domain mapping
- Skip email verification
- Pre-populated catalog

---

## 3. Provisioning

### Provisioning Pipeline

```
createTenant(input)
│
├── Step 1: Create Seller entity
│   └── name = input.storeName
│
├── Step 2: Create Channel
│   ├── code = input.slug
│   ├── token = generateToken()
│   ├── seller = createdSeller
│   ├── defaultLanguageCode = input.language || 'vi'
│   ├── defaultCurrencyCode = input.currency || 'VND'
│   └── pricesIncludeTax = true
│
├── Step 3: Create Tenant entity
│   ├── name = input.storeName
│   ├── slug = input.slug
│   ├── status = 'PROVISIONING'
│   ├── channelId = createdChannel.id
│   └── plan = 'trial'
│
├── Step 4: Create TenantDomain
│   ├── domain = `${input.slug}.qtable.io`
│   ├── tenantId = createdTenant.id
│   └── isPrimary = true
│
├── Step 5: Create Role for Tenant Admin
│   ├── code = `${input.slug}-admin`
│   ├── permissions = TENANT_ADMIN_PERMISSIONS
│   └── channels = [createdChannel]
│
├── Step 6: Create Administrator + User
│   ├── firstName, lastName, email
│   ├── user → authentication method (email/password)
│   └── role = createdRole
│
├── Step 7: Create default Zone assignments
│   ├── defaultTaxZone = global default
│   └── defaultShippingZone = global default
│
├── Step 8: Create default resources
│   ├── Default StockLocation
│   ├── Default ShippingMethod (assigned to channel)
│   └── Default PaymentMethod (assigned to channel)
│
├── Step 9: Configure RLS (set tenant in DB context)
│
├── Step 10: Emit TenantCreatedEvent
│
└── Step 11: Set status = 'TRIAL'
```

### Provisioning Idempotency

Each provisioning step must be idempotent:
- Check if resource already exists before creating
- Use unique constraints (slug, code, domain)
- Log each step for debugging
- Support retry on failure

### Provisioning Error Handling

| Failure Point | Recovery | Rollback? |
|--------------|----------|----------|
| Seller creation | Retry | No — idempotent |
| Channel creation | Retry | Delete orphan Seller |
| Tenant creation | Retry | Delete orphan Channel + Seller |
| Admin creation | Retry | Tenant exists, just retry admin |
| Domain setup | Retry | Tenant usable without custom domain |

---

## 4. Config Setup

### Default Configuration (Set at Provisioning)

| Category | Setting | Default | Customizable |
|----------|---------|---------|-------------|
| **Store** | Language | `vi` | ✅ |
| | Currency | `VND` | ✅ |
| | Timezone | `Asia/Ho_Chi_Minh` | ✅ |
| | Tax included | `true` | ✅ |
| **Limits** | Max products | 100 (trial) / plan-based | ✅ by plan |
| | Max admins | 1 (trial) / plan-based | ✅ by plan |
| | Max storage | 100MB (trial) / plan-based | ✅ by plan |
| **Features** | Inventory tracking | `true` | ✅ |
| | Multi-currency | `false` (trial) | ✅ by plan |
| | Custom domain | `false` (trial) | ✅ by plan |
| | API access | `true` | ✅ |
| **Branding** | Store name | From registration | ✅ |
| | Logo | None | ✅ |
| | Theme colors | Default | ✅ |

### Configuration Storage

```
Tenant.config (jsonb column):
{
  "limits": {
    "maxProducts": 100,
    "maxAdmins": 1,
    "maxStorageMB": 100
  },
  "features": {
    "inventoryTracking": true,
    "multiCurrency": false,
    "customDomain": false,
    "apiAccess": true
  },
  "branding": {
    "primaryColor": "#1a73e8",
    "logoUrl": null
  },
  "notifications": {
    "orderEmail": true,
    "lowStockAlert": true
  }
}
```

---

## 5. Suspend

### Suspension Triggers

| Trigger | Actor | Auto/Manual |
|---------|-------|-------------|
| Payment failure | System | Automatic (after grace period) |
| Terms violation | Global Admin | Manual |
| Abuse detected | System/Admin | Manual or automatic |
| Owner request | Tenant Admin | Manual |
| Trial expired | System | Automatic |

### Suspension Process

```
suspendTenant(tenantId, reason)
│
├── 1. Set status = 'SUSPENDED'
├── 2. Set suspendedAt = now()
├── 3. Store suspension reason
├── 4. Emit TenantSuspendedEvent
├── 5. Invalidate tenant cache → middleware will return 403
├── 6. Notify tenant owner via email
├── 7. Deactivate background jobs for this tenant
└── 8. Keep data intact (no deletion)
```

### Suspended State Behavior

| Capability | Status |
|-----------|--------|
| Shop API (storefront) | ❌ Returns 503 "Store temporarily unavailable" |
| Admin API (read) | ✅ Tenant admin can view data |
| Admin API (write) | ❌ No modifications allowed |
| Background jobs | ❌ Paused |
| Email notifications | ❌ Disabled |
| Webhooks | ❌ Disabled |
| Data export | ✅ Allowed (for data portability) |

### Reactivation

```
reactivateTenant(tenantId)
│
├── 1. Set status = 'ACTIVE'
├── 2. Clear suspendedAt
├── 3. Refresh tenant cache
├── 4. Resume background jobs
├── 5. Emit TenantReactivatedEvent
└── 6. Notify tenant owner
```

---

## 6. Delete

### Deletion Process (Multi-phase)

```
Phase 1: Mark for deletion (immediate)
├── Set status = 'PENDING_DELETION'
├── Set deletedAt = now()
├── Notify tenant owner: "Deletion scheduled in 30 days"
├── Allow cancellation within 30 days
└── Disable all access (same as suspended)

Phase 2: Soft delete (after 30 days)
├── Set status = 'DELETED'
├── Remove from tenant domain cache
├── Archive data (optional: export to cold storage)
├── Remove custom domains
├── Revoke all sessions
└── Disable admin accounts

Phase 3: Hard delete (after 90 days from soft delete)
├── Delete all tenant data from database:
│   ├── Products, Variants, Collections
│   ├── Orders, Customers
│   ├── Assets (files)
│   ├── Settings, Roles, Admins
│   └── Tenant entity itself
├── Delete Channel
├── Delete Seller
├── Remove RLS entries
└── Set status = 'PURGED'
```

### Data Deletion Order (Foreign Key Safe)

```
1. OrderLines → Orders → Payments, Fulfillments
2. ProductVariants → Products
3. FacetValues → Facets
4. Collections
5. Customers → Addresses
6. StockLevel → StockMovement → StockLocation
7. Promotions
8. ShippingMethods, PaymentMethods
9. Roles → Administrators → Users
10. TenantDomains → TenantConfig → Tenant
11. Assets (files from storage)
12. Channel
13. Seller
```

---

## 7. Migrate

### Tenant Data Migration Scenarios

| Scenario | Complexity | Method |
|----------|-----------|--------|
| Migrate to different plan | Low | Update config jsonb |
| Migrate to dedicated infrastructure | High | Export → Import to new DB |
| Merge two tenants | High | Data reconciliation |
| Split a tenant | High | Selective export |
| Platform version upgrade | Medium | Schema migration (shared for all) |

### Cross-Version Migration

Since all tenants share one schema, database migrations apply atomically:

```
1. npm run migration:generate
2. npm run migration:run
   → Applies to ALL tenants simultaneously
   → Zero per-tenant migration effort
```

### Tenant Data Portability

Export format for tenant data:

```
tenant-export-<slug>-<timestamp>/
├── metadata.json          # Tenant config, plan, domains
├── products.json          # All products + variants
├── collections.json       # Collection tree
├── customers.json         # Customer data
├── orders.json            # Order history
├── assets/                # Media files
│   ├── images/
│   └── documents/
└── settings.json          # Tenant-specific settings
```

---

## 8. Backup & Restore

### Backup Strategy

| Level | Scope | Frequency | Retention |
|-------|-------|-----------|----------|
| **Full DB backup** | Entire database | Daily | 30 days |
| **Incremental** | Changed data only | Hourly | 7 days |
| **Point-in-time** | WAL-based recovery | Continuous | 7 days |
| **Per-tenant logical** | Single tenant data | On-demand | Until deleted |

### Per-Tenant Backup Process

```
backupTenant(tenantId)
│
├── 1. Begin read-only transaction
├── 2. Query all data with channelId = tenant.channelId
│   ├── Products, Variants, Prices
│   ├── Collections
│   ├── Customers
│   ├── Orders (with lines, payments)
│   ├── Assets metadata
│   └── Tenant configuration
├── 3. Export assets from storage
├── 4. Package into archive (signed + encrypted)
├── 5. Upload to backup storage (S3/GCS)
├── 6. Log backup metadata + checksum
└── 7. Commit (end read transaction)
```

### Per-Tenant Restore Process

```
restoreTenant(tenantId, backupId)
│
├── 1. Validate backup integrity (checksum)
├── 2. Suspend tenant (prevent writes during restore)
├── 3. Begin transaction
├── 4. Delete current tenant data (within channel scope)
├── 5. Import data from backup
│   ├── Re-map IDs (backup IDs → new IDs)
│   ├── Assign to tenant's channel
│   └── Restore asset files
├── 6. Commit transaction
├── 7. Rebuild search index for tenant
├── 8. Invalidate caches
└── 9. Reactivate tenant
```

### Recovery Time Objectives

| Scenario | RTO | RPO |
|----------|-----|-----|
| Single tenant restore | < 1 hour | < 1 hour (from last backup) |
| Full platform restore | < 4 hours | < 1 hour |
| Point-in-time recovery | < 2 hours | Continuous (WAL) |
