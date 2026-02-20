import { DeepPartial, ID } from '@vendure/common/lib/shared-types';
import { VendureEntity } from '@vendure/core';
import { Column, Entity, Index, ManyToOne, JoinColumn } from 'typeorm';
import { EntityId } from '@vendure/core';

import { Tenant } from './tenant.entity';

/**
 * TenantDomain — maps custom domains and subdomains to a Tenant.
 *
 * Used by TenantContextMiddleware to resolve the tenant from the
 * incoming Host header.
 *
 * @see security-and-isolation.md §2 "Tenant Detection"
 */
@Entity()
export class TenantDomain extends VendureEntity {
    constructor(input?: DeepPartial<TenantDomain>) {
        super(input);
    }

    /**
     * Full domain or subdomain.
     * e.g. "alice-store.qtable.vn" or "www.alice-store.com"
     */
    @Index({ unique: true })
    @Column()
    domain: string;

    /**
     * The tenant this domain belongs to.
     */
    @ManyToOne(() => Tenant, tenant => tenant.domains, { onDelete: 'CASCADE' })
    @JoinColumn()
    tenant: Tenant;

    @EntityId()
    tenantId: ID;

    /**
     * Whether this is the primary/canonical domain for the tenant.
     */
    @Column({ default: false })
    isPrimary: boolean;

    /**
     * SSL certificate provisioning status.
     */
    @Column({ default: 'pending' })
    sslStatus: string;

    /**
     * When domain ownership was verified (null if not verified).
     */
    @Column({ type: 'timestamp', nullable: true })
    verifiedAt: Date | null;
}
