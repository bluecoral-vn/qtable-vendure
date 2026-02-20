import { DeepPartial, ID } from '@vendure/common/lib/shared-types';
import { VendureEntity } from '@vendure/core';
import { Column, Entity, Index, JoinColumn, OneToMany, OneToOne } from 'typeorm';
import { Channel } from '@vendure/core';
import { EntityId } from '@vendure/core';

import { TenantStatus } from './tenant-status.enum';
import { TenantDomain } from './tenant-domain.entity';

/**
 * Tenant entity — wraps Vendure's Channel with SaaS-specific logic.
 *
 * Each Tenant maps 1:1 to a Channel. The Channel handles data filtering
 * (products, orders, customers), while the Tenant handles lifecycle,
 * domain routing, subscription plans, and tenant-specific configuration.
 *
 * @see plugin-architecture.md §1 "Tenant Wraps Channel"
 * @see tenant-lifecycle.md for state transitions
 */
@Entity()
export class Tenant extends VendureEntity {
    constructor(input?: DeepPartial<Tenant>) {
        super(input);
    }

    /**
     * Display name of the tenant (store name).
     */
    @Column()
    name: string;

    /**
     * URL-safe unique identifier used for subdomain routing.
     * e.g. "alice-store" → alice-store.qtable.vn
     */
    @Index({ unique: true })
    @Column()
    slug: string;

    /**
     * Current lifecycle status of the tenant.
     */
    @Column({
        type: 'enum',
        enum: TenantStatus,
        default: TenantStatus.REQUESTED,
    })
    status: TenantStatus;

    /**
     * 1:1 link to the Vendure Channel that handles data filtering.
     */
    @OneToOne(() => Channel)
    @JoinColumn()
    channel: Channel;

    @EntityId()
    channelId: ID;

    /**
     * Subscription plan identifier.
     */
    @Column({ default: 'trial' })
    plan: string;

    /**
     * Per-tenant configuration stored as JSONB.
     * Contains: feature flags, rate limits, branding, storage quotas.
     */
    @Column({ type: 'jsonb', default: {} })
    config: Record<string, any>;

    /**
     * Domains associated with this tenant.
     */
    @OneToMany(() => TenantDomain, domain => domain.tenant)
    domains: TenantDomain[];

    /**
     * When the tenant was suspended (null if not suspended).
     */
    @Column({ type: 'timestamp', nullable: true })
    suspendedAt: Date | null;

    /**
     * When the tenant was soft-deleted (null if not deleted).
     */
    @Column({ type: 'timestamp', nullable: true })
    deletedAt: Date | null;
}
