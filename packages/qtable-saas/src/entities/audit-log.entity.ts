import { DeepPartial } from '@vendure/common/lib/shared-types';
import { VendureEntity } from '@vendure/core';
import { Column, Entity, Index } from 'typeorm';

/**
 * AuditLog entity — records security-relevant events.
 *
 * Used to track:
 * - Tenant lifecycle events (created, suspended, deleted)
 * - Cross-tenant access attempts
 * - SuperAdmin actions
 * - Token mismatch/override events
 * - Default Channel access blocks
 *
 * This entity is NOT ChannelAware — it stores platform-wide audit data.
 *
 * @see implementation_plan.md Phase 2 — 2.6 Audit Logging
 */
@Entity()
export class AuditLog extends VendureEntity {
    constructor(input?: DeepPartial<AuditLog>) {
        super(input);
    }

    /**
     * Action type identifier.
     * e.g. 'TENANT_CREATED', 'CROSS_TENANT_ATTEMPT', 'SUPERADMIN_ACTION'
     */
    @Index()
    @Column()
    action: string;

    /**
     * Severity level: INFO, WARN, CRITICAL
     */
    @Column({ default: 'INFO' })
    severity: string;

    /**
     * ID of the user who triggered the event (nullable for anonymous).
     */
    @Column({ type: 'int', nullable: true })
    userId: number | null;

    /**
     * Channel (tenant) where the event occurred.
     */
    @Column({ type: 'int', nullable: true })
    channelId: number | null;

    /**
     * Tenant associated with the event.
     */
    @Column({ type: 'int', nullable: true })
    tenantId: number | null;

    /**
     * Arbitrary metadata (stored as JSONB).
     */
    @Column({ type: 'jsonb', default: {} })
    metadata: Record<string, any>;

    /**
     * IP address of the request.
     */
    @Column({ type: 'varchar', nullable: true })
    ipAddress: string | null;
}
