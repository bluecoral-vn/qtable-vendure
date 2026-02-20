/**
 * Tenant status lifecycle states.
 *
 * @see tenant-lifecycle.md for state transition rules
 */
export enum TenantStatus {
    /** Tenant has been requested but not yet provisioned */
    REQUESTED = 'REQUESTED',
    /** Tenant is being provisioned (creating Channel, Seller, Admin, etc.) */
    PROVISIONING = 'PROVISIONING',
    /** Tenant is in trial period */
    TRIAL = 'TRIAL',
    /** Tenant is fully active */
    ACTIVE = 'ACTIVE',
    /** Tenant is suspended (no access, data preserved) */
    SUSPENDED = 'SUSPENDED',
    /** Tenant is pending deletion (grace period) */
    PENDING_DELETION = 'PENDING_DELETION',
    /** Tenant data has been soft-deleted */
    DELETED = 'DELETED',
}
