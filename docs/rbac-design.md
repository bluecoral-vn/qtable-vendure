# RBAC Design — Multi-Tenant

> **Date:** 2026-02-20  
> **Purpose:** Role-based access control design for multi-tenant SaaS  
> **Scope:** Global Admin, Tenant Admin, role separation, permission boundaries, privilege escalation prevention

---

## Table of Contents

1. [Role Hierarchy](#1-role-hierarchy)
2. [Global Admin](#2-global-admin)
3. [Tenant Admin](#3-tenant-admin)
4. [Role Separation](#4-role-separation)
5. [Permission Boundary](#5-permission-boundary)
6. [Privilege Escalation Prevention](#6-privilege-escalation-prevention)
7. [Custom Permissions](#7-custom-permissions)

---

## 1. Role Hierarchy

```
┌─────────────────────────────────────────────────────────────┐
│                      ROLE HIERARCHY                          │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  PLATFORM LEVEL (Default Channel)                    │   │
│  │                                                      │   │
│  │  ┌────────────────┐    ┌──────────────────────┐     │   │
│  │  │  SuperAdmin    │    │  Platform Operator   │     │   │
│  │  │  (Vendure)     │    │  (Custom Role)       │     │   │
│  │  │                │    │                      │     │   │
│  │  │  • ALL perms   │    │  • Manage tenants    │     │   │
│  │  │  • ALL channels│    │  • View analytics    │     │   │
│  │  │  • Bypass RLS  │    │  • Support tickets   │     │   │
│  │  │  ⚠️ RESTRICTED │    │  • NO tenant data    │     │   │
│  │  └────────────────┘    └──────────────────────┘     │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─────────────────────────┐  ┌─────────────────────────┐  │
│  │  TENANT A               │  │  TENANT B               │  │
│  │                         │  │                         │  │
│  │  ┌─────────────────┐   │  │  ┌─────────────────┐   │  │
│  │  │  Tenant Owner   │   │  │  │  Tenant Owner   │   │  │
│  │  │  • Full admin   │   │  │  │  • Full admin   │   │  │
│  │  │  • Manage roles │   │  │  │  • Manage roles │   │  │
│  │  └────────┬────────┘   │  │  └────────┬────────┘   │  │
│  │           │             │  │           │             │  │
│  │  ┌────────▼────────┐   │  │  ┌────────▼────────┐   │  │
│  │  │  Tenant Admin   │   │  │  │  Tenant Admin   │   │  │
│  │  │  • CRUD products│   │  │  │  • CRUD products│   │  │
│  │  │  • Manage orders│   │  │  │  • Manage orders│   │  │
│  │  │  • View reports │   │  │  │  • View reports │   │  │
│  │  └────────┬────────┘   │  │  └────────┬────────┘   │  │
│  │           │             │  │           │             │  │
│  │  ┌────────▼────────┐   │  │  ┌────────▼────────┐   │  │
│  │  │  Staff          │   │  │  │  Staff          │   │  │
│  │  │  • Read products│   │  │  │  • Read products│   │  │
│  │  │  • Process orders│  │  │  │  • Process orders│  │  │
│  │  └─────────────────┘   │  │  └─────────────────┘   │  │
│  │                         │  │                         │  │
│  │  🚫 Cannot see Tenant B │  │  🚫 Cannot see Tenant A │  │
│  └─────────────────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Global Admin

### SuperAdmin Role (Vendure Built-in)

| Aspect | Current Behavior | Multi-tenant Behavior |
|--------|-----------------|----------------------|
| **Scope** | ALL channels, ALL permissions | Same, but with audit logging |
| **Access** | Unrestricted | Logged, rate-limited |
| **Purpose** | System bootstrap, migrations | Emergency access only |
| **Count** | Unlimited | Limited to 2-3 accounts |
| **Usage** | Day-to-day admin | Break-glass emergency only |

### Platform Operator Role (New Custom Role)

For day-to-day platform management without SuperAdmin privileges:

| Permission | Description |
|-----------|-------------|
| `ManageTenants` | Create, update, suspend tenants |
| `ViewTenantList` | List all tenants with summary info |
| `ViewTenantDetails` | View specific tenant configuration |
| `ManagePlans` | Create and modify subscription plans |
| `ViewPlatformAnalytics` | View aggregated metrics |
| `ManageGlobalSettings` | Modify platform-wide settings |
| `ViewAuditLog` | Read audit trail |

**Explicitly DENIED:**
- Read/write tenant business data (products, orders, customers)
- Modify tenant admin credentials
- Bypass RLS

### Global Admin Best Practices

| Practice | Rationale |
|----------|-----------|
| Use Platform Operator role for daily work | Minimize SuperAdmin exposure |
| SuperAdmin requires MFA | Protect highest-privilege account |
| SuperAdmin actions logged to immutable store | Compliance and forensics |
| Rotate SuperAdmin credentials quarterly | Security hygiene |
| SuperAdmin cannot create itself | Prevent unauthorized escalation |

---

## 3. Tenant Admin

### Tenant Owner (Auto-created at Provisioning)

| Capability | Description |
|-----------|-------------|
| Full admin on own channel | All CRUD operations |
| Role management | Create/modify staff roles within tenant |
| Config management | Update store settings, branding |
| Domain management | Add/remove custom domains |
| Invite staff | Create additional admin accounts |
| View analytics | Tenant-scoped reporting |
| Request data export | GDPR compliance |

**Explicitly DENIED:**
- Create channels
- Modify other tenants
- Access Default Channel
- Assign SuperAdmin permission
- Bypass own channel scope

### Tenant Admin (Staff Roles)

Pre-defined role templates that Tenant Owner can assign:

| Role Template | Products | Orders | Customers | Settings | Reports |
|--------------|----------|--------|-----------|----------|---------|
| **Full Admin** | CRUD | CRUD | CRUD | RW | ✅ |
| **Catalog Manager** | CRUD | Read | Read | Read | ✅ |
| **Order Manager** | Read | CRUD | Read | — | ✅ |
| **Customer Support** | Read | Read/Update | Read/Update | — | — |
| **Viewer** | Read | Read | Read | Read | ✅ |

### Tenant Admin Permission Set

Uses existing Vendure permissions, scoped to tenant's channel:

```
TENANT_ADMIN_PERMISSIONS = [
    // Catalog
    CreateProduct, ReadProduct, UpdateProduct, DeleteProduct,
    CreateCollection, ReadCollection, UpdateCollection, DeleteCollection,
    CreateFacet, ReadFacet, UpdateFacet, DeleteFacet,
    
    // Orders
    CreateOrder, ReadOrder, UpdateOrder, DeleteOrder,
    
    // Customers
    CreateCustomer, ReadCustomer, UpdateCustomer, DeleteCustomer,
    
    // Settings (limited)
    ReadSettings, UpdateSettings,
    ReadChannel, UpdateChannel,  // Own channel only
    
    // Assets
    CreateAssets, ReadAssets, UpdateAssets, DeleteAssets,
    
    // Promotions
    CreatePromotion, ReadPromotion, UpdatePromotion, DeletePromotion,
    
    // Shipping & Payment
    ReadShippingMethod, UpdateShippingMethod,
    ReadPaymentMethod, UpdatePaymentMethod,
    
    // Staff management
    CreateAdministrator, ReadAdministrator, UpdateAdministrator,
    
    // Custom
    ManageTenant,  // Custom permission for tenant-specific operations
]
```

---

## 4. Role Separation

### Channel-Scoped Role Assignment

```
┌─────────────────────────────────────────────────────────┐
│  Role: "tenant-alice-admin"                             │
│  ├── permissions: [CreateProduct, ReadProduct, ...]     │
│  └── channels: [Channel "alice"]   ← ONLY Alice's      │
│                                      channel            │
├─────────────────────────────────────────────────────────┤
│  Role: "tenant-bob-admin"                               │
│  ├── permissions: [CreateProduct, ReadProduct, ...]     │
│  └── channels: [Channel "bob"]     ← ONLY Bob's        │
│                                      channel            │
├─────────────────────────────────────────────────────────┤
│  Role: "platform-operator"                              │
│  ├── permissions: [ManageTenants, ViewAnalytics, ...]   │
│  └── channels: [Default Channel]   ← Platform only     │
└─────────────────────────────────────────────────────────┘
```

### Role Naming Convention

```
Tenant roles:     tenant-<slug>-<role-name>
                  tenant-alice-admin
                  tenant-alice-catalog-manager
                  tenant-alice-order-manager

Platform roles:   platform-<role-name>
                  platform-operator
                  platform-support

System roles:     system-<role-name>
                  __super_admin_role    (Vendure built-in)
```

### Role Isolation Rules

| Rule | Description |
|------|-------------|
| Tenant roles only assigned to tenant's channel | Prevents cross-channel access |
| Tenant admin cannot create roles for other channels | Service validates channel ownership |
| Tenant admin cannot assign SuperAdmin permission | Permission whitelist enforced |
| Role deletion cascades to remove admin access | No orphan permissions |
| Default Channel roles only for platform staff | Prevents tenant access to platform |

---

## 5. Permission Boundary

### Permission Validation Matrix

```
┌────────────────────────────┬───────────┬───────────┬─────────┐
│  Operation                 │ SuperAdmin│ Platform  │ Tenant  │
│                            │           │ Operator  │ Admin   │
├────────────────────────────┼───────────┼───────────┼─────────┤
│ Create tenant              │    ✅     │    ✅     │   ❌    │
│ Suspend tenant             │    ✅     │    ✅     │   ❌    │
│ Delete tenant              │    ✅     │    ✅     │   ❌    │
│ View ALL tenants           │    ✅     │    ✅     │   ❌    │
│ Access tenant data         │    ✅*    │    ❌     │   ✅**  │
│ Create Channel             │    ✅     │    ❌     │   ❌    │
│ Modify Vendure config      │    ✅     │    ❌     │   ❌    │
│ Run migrations             │    ✅     │    ❌     │   ❌    │
│ Manage staff roles         │    ✅     │    ❌     │   ✅**  │
│ Manage own store settings  │    ✅     │    ❌     │   ✅    │
│ Export tenant data         │    ✅     │    ❌     │   ✅    │
│ View platform analytics    │    ✅     │    ✅     │   ❌    │
│ View tenant analytics      │    ✅*    │    ❌     │   ✅    │
├────────────────────────────┼───────────┼───────────┼─────────┤
│ * = With audit logging     │           │           │         │
│ ** = Own tenant only       │           │           │         │
└────────────────────────────┴───────────┴───────────┴─────────┘
```

### Permission Enforcement Points

```
1. GraphQL Resolver: @Allow(Permission.Xxx)
   └── AuthGuard checks user.channelPermissions

2. Service Layer: Validates channelId ownership
   └── Entity.channels must include ctx.channelId

3. TenantGuard: Validates tenant context
   └── ctx.channelId must match resolved tenant

4. Database: RLS policy
   └── channelId = current_setting('app.current_tenant_id')
```

---

## 6. Privilege Escalation Prevention

### Escalation Vectors & Countermeasures

| # | Vector | Description | Countermeasure |
|---|--------|-------------|---------------|
| 1 | **Self-promotion to SuperAdmin** | Tenant admin adds SuperAdmin to their role | Block: SuperAdmin not in assignable permission list |
| 2 | **Cross-channel role assignment** | Assign role to another tenant's channel | Block: Validate channel ownership in RoleService |
| 3 | **Default Channel access** | Access Default Channel to see all data | Block: TenantGuard prevents non-platform users |
| 4 | **Create new Channel** | Create unauthorized channel | Block: CreateChannel permission not in tenant scope |
| 5 | **Multiple channel membership** | Get role in multiple tenant channels | Block: User belongs to exactly one tenant |
| 6 | **Token substitution** | Use another tenant's vendure-token | Block: Middleware overrides from domain |
| 7 | **Admin user sharing** | Share admin credentials cross-tenant | Detect: Monitor login locations + MFA |
| 8 | **API key abuse** | Use API key without domain validation | Block: API key bound to specific tenantId |

### Permission Assignment Rules

```
When Tenant Admin assigns permissions to a staff role:

1. WHITELIST CHECK
   └── Permission must be in TENANT_ASSIGNABLE_PERMISSIONS

2. CHANNEL CHECK
   └── Role.channels must contain ONLY the tenant's channel

3. ELEVATION CHECK
   └── Cannot assign permissions the assigner doesn't have

4. SYSTEM CHECK
   └── Cannot modify system-generated roles

5. AUDIT LOG
   └── Record: who assigned what to whom
```

### TENANT_ASSIGNABLE_PERMISSIONS

Permissions that a tenant admin is allowed to assign:
- All Catalog permissions (Product, Collection, Facet)
- All Order permissions  
- All Customer permissions
- Asset permissions
- Promotion permissions
- Read-only Settings permissions

**Excluded from tenant assignment:**
- `SuperAdmin`
- `CreateChannel`, `DeleteChannel`
- `CreateSeller`, `DeleteSeller`
- Platform-level custom permissions (`ManageTenants`, etc.)

---

## 7. Custom Permissions

### New Custom Permissions for Multi-tenant

| Permission | Level | Description |
|-----------|-------|-------------|
| `ManageTenants` | Platform | CRUD tenants (create, suspend, delete) |
| `ViewTenantList` | Platform | List all tenants |
| `ViewPlatformAnalytics` | Platform | View aggregated analytics |
| `ManagePlans` | Platform | Manage subscription plans |
| `ManageTenant` | Tenant | Manage own tenant config |
| `ManageDomains` | Tenant | Add/remove custom domains |
| `ExportData` | Tenant | Export tenant data |
| `ManageStaff` | Tenant | Invite/remove staff members |
| `ViewAuditLog` | Both | View audit logs (scoped) |

---

## 8. Hard Constraints

### Constraint: 1 User = 1 Tenant Channel

A non-platform user MUST belong to exactly ONE tenant channel.

| Rule | Enforcement Point |
|------|-------------------|
| User creation → assigned to creating tenant's channel only | TenantProvisioningService |
| User CANNOT be added to another tenant's channel | RoleService override |
| User CANNOT have roles in multiple tenant channels | Validation on role assignment |
| Platform users (SuperAdmin, Operator) → Default Channel only | TenantGuard |

### Constraint: Tenant Admin Cannot Assign System Permissions

```
TENANT_BLOCKED_PERMISSIONS = [
    SuperAdmin,
    CreateChannel, DeleteChannel,
    CreateSeller, DeleteSeller,
    ManageTenants, ViewTenantList,
    ViewPlatformAnalytics, ManagePlans
]
```

Enforced in `RoleService` — any attempt to include blocked permissions → reject with error.

---

## 9. Privilege Escalation Test Matrix

| # | Attack Vector | Test Action | Expected Result | Priority |
|---|--------------|-------------|----------------|----------|
| 1 | Self-promote to SuperAdmin | Tenant admin calls `updateRole` with SuperAdmin permission | ❌ Rejected — permission not in whitelist | 🔴 P0 |
| 2 | Cross-channel role | Tenant A admin creates role for Channel B | ❌ Rejected — channel ownership check | 🔴 P0 |
| 3 | Access Default Channel | Tenant admin sends request to Default Channel | ❌ 403 Forbidden by TenantGuard | 🔴 P0 |
| 4 | Create new Channel | Tenant admin calls `createChannel` mutation | ❌ Rejected — no `CreateChannel` permission | 🟡 P1 |
| 5 | Multi-channel membership | Add same user to two tenant channels | ❌ Rejected — 1 user = 1 tenant constraint | 🔴 P0 |
| 6 | Token substitution | Tenant A admin sends Tenant B's vendure-token | ❌ Overridden by middleware — stays in Tenant A | 🔴 P0 |
| 7 | Call platform mutations | Tenant admin calls `createTenant` | ❌ Rejected — no `ManageTenants` permission | 🔴 P0 |
| 8 | Login cross-tenant | User at Tenant A tries login at domain Tenant B | ❌ Session invalid — channel mismatch | 🔴 P0 |
| 9 | Modify system roles | Tenant admin tries to update `__super_admin_role` | ❌ Rejected — system role protection | 🟡 P1 |
| 10 | Escalate via API key | Use API key bound to Tenant A on Tenant B domain | ❌ Rejected — API key validated against tenant | 🟡 P1 |
