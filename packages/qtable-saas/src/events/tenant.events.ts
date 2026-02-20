import { VendureEvent, RequestContext } from '@vendure/core';
import { Tenant } from '../entities';

/**
 * Emitted when a new tenant has been fully provisioned.
 */
export class TenantCreatedEvent extends VendureEvent {
    constructor(
        public ctx: RequestContext,
        public tenant: Tenant,
    ) {
        super();
    }
}

/**
 * Emitted when a tenant status changes (e.g. active → suspended).
 */
export class TenantStatusChangedEvent extends VendureEvent {
    constructor(
        public ctx: RequestContext,
        public tenant: Tenant,
        public fromStatus: string,
        public toStatus: string,
    ) {
        super();
    }
}

/**
 * Emitted when a tenant is suspended.
 */
export class TenantSuspendedEvent extends VendureEvent {
    constructor(
        public ctx: RequestContext,
        public tenant: Tenant,
    ) {
        super();
    }
}

/**
 * Emitted when a tenant deletion process is initiated.
 */
export class TenantDeletedEvent extends VendureEvent {
    constructor(
        public ctx: RequestContext,
        public tenant: Tenant,
    ) {
        super();
    }
}
