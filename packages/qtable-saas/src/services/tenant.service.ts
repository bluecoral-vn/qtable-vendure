import { Injectable } from '@nestjs/common';
import {
    ChannelService,
    EventBus,
    ID,
    PaginatedList,
    RequestContext,
    TransactionalConnection,
    UserInputError,
} from '@vendure/core';

import { Tenant, TenantDomain, TenantStatus } from '../entities';
import {
    TenantCreatedEvent,
    TenantDeletedEvent,
    TenantStatusChangedEvent,
    TenantSuspendedEvent,
} from '../events';

/**
 * Input for creating a new tenant.
 */
export interface CreateTenantInput {
    name: string;
    slug: string;
    channelId: ID;
    plan?: string;
    config?: Record<string, any>;
}

/**
 * Input for updating an existing tenant.
 */
export interface UpdateTenantInput {
    id: ID;
    name?: string;
    plan?: string;
    config?: Record<string, any>;
}

/**
 * TenantService — CRUD operations and lifecycle management for tenants.
 *
 * This service manages the Tenant entity which wraps Vendure's Channel.
 * It does NOT handle provisioning (Channel creation, admin setup, etc.)
 * — that is handled by TenantProvisioningService.
 *
 * @see tenant-lifecycle.md for state transition rules
 */
@Injectable()
export class TenantService {
    constructor(
        private connection: TransactionalConnection,
        private channelService: ChannelService,
        private eventBus: EventBus,
    ) { }

    /**
     * Find all tenants with pagination and filtering.
     */
    async findAll(
        ctx: RequestContext,
        options?: { take?: number; skip?: number },
    ): Promise<PaginatedList<Tenant>> {
        const repo = this.connection.getRepository(ctx, Tenant);
        const [items, totalItems] = await repo.findAndCount({
            relations: ['channel', 'domains'],
            take: options?.take ?? 100,
            skip: options?.skip ?? 0,
            order: { createdAt: 'DESC' },
        });
        return { items, totalItems };
    }

    /**
     * Find a tenant by ID.
     */
    async findById(ctx: RequestContext, id: ID): Promise<Tenant | undefined> {
        return this.connection
            .getRepository(ctx, Tenant)
            .findOne({
                where: { id },
                relations: ['channel', 'domains'],
            }) as Promise<Tenant | undefined>;
    }

    /**
     * Find a tenant by slug.
     */
    async findBySlug(ctx: RequestContext, slug: string): Promise<Tenant | undefined> {
        return this.connection
            .getRepository(ctx, Tenant)
            .findOne({
                where: { slug },
                relations: ['channel', 'domains'],
            }) as Promise<Tenant | undefined>;
    }

    /**
     * Find a tenant by its associated channel ID.
     */
    async findByChannelId(ctx: RequestContext, channelId: ID): Promise<Tenant | undefined> {
        return this.connection
            .getRepository(ctx, Tenant)
            .findOne({
                where: { channelId },
                relations: ['channel', 'domains'],
            }) as Promise<Tenant | undefined>;
    }

    /**
     * Create a new Tenant entity (DOES NOT provision Channel/Seller/Admin).
     * Use TenantProvisioningService for full provisioning.
     */
    async create(ctx: RequestContext, input: CreateTenantInput): Promise<Tenant> {
        // Check slug uniqueness
        const existing = await this.connection
            .getRepository(ctx, Tenant)
            .findOne({ where: { slug: input.slug } });
        if (existing) {
            throw new UserInputError(`Tenant with slug "${input.slug}" already exists`);
        }

        const channel = await this.channelService.findOne(ctx, input.channelId);
        if (!channel) {
            throw new UserInputError(`Channel with ID "${input.channelId}" not found`);
        }

        const tenant = new Tenant({
            name: input.name,
            slug: input.slug,
            status: TenantStatus.REQUESTED,
            plan: input.plan ?? 'trial',
            config: input.config ?? {},
            channel,
        });

        const savedTenant = await this.connection
            .getRepository(ctx, Tenant)
            .save(tenant);

        return savedTenant;
    }

    /**
     * Update tenant metadata (name, plan, config).
     */
    async update(ctx: RequestContext, input: UpdateTenantInput): Promise<Tenant> {
        const tenant = await this.findById(ctx, input.id);
        if (!tenant) {
            throw new UserInputError(`Tenant with ID "${input.id}" not found`);
        }

        if (input.name !== undefined) tenant.name = input.name;
        if (input.plan !== undefined) tenant.plan = input.plan;
        if (input.config !== undefined) tenant.config = { ...tenant.config, ...input.config };

        return this.connection.getRepository(ctx, Tenant).save(tenant);
    }

    /**
     * Transition tenant status with validation.
     */
    async changeStatus(ctx: RequestContext, id: ID, newStatus: TenantStatus): Promise<Tenant> {
        const tenant = await this.findById(ctx, id);
        if (!tenant) {
            throw new UserInputError(`Tenant with ID "${id}" not found`);
        }

        const oldStatus = tenant.status;
        this.validateStatusTransition(oldStatus, newStatus);

        tenant.status = newStatus;

        // Set timestamps based on status
        if (newStatus === TenantStatus.SUSPENDED) {
            tenant.suspendedAt = new Date();
        } else if (newStatus === TenantStatus.PENDING_DELETION) {
            tenant.deletedAt = new Date();
        } else if (newStatus === TenantStatus.ACTIVE || newStatus === TenantStatus.TRIAL) {
            // Reactivation — clear timestamps
            tenant.suspendedAt = null;
            tenant.deletedAt = null;
        }

        const saved = await this.connection.getRepository(ctx, Tenant).save(tenant);

        // Emit events
        await this.eventBus.publish(new TenantStatusChangedEvent(ctx, saved, oldStatus, newStatus));

        if (newStatus === TenantStatus.SUSPENDED) {
            await this.eventBus.publish(new TenantSuspendedEvent(ctx, saved));
        } else if (newStatus === TenantStatus.DELETED) {
            await this.eventBus.publish(new TenantDeletedEvent(ctx, saved));
        }

        return saved;
    }

    /**
     * Add a domain to a tenant.
     */
    async addDomain(
        ctx: RequestContext,
        tenantId: ID,
        domain: string,
        isPrimary: boolean = false,
    ): Promise<TenantDomain> {
        // Check domain uniqueness
        const existing = await this.connection
            .getRepository(ctx, TenantDomain)
            .findOne({ where: { domain } });
        if (existing) {
            throw new UserInputError(`Domain "${domain}" is already in use`);
        }

        const tenantDomain = new TenantDomain({
            domain,
            tenantId,
            isPrimary,
            sslStatus: 'pending',
        });

        return this.connection.getRepository(ctx, TenantDomain).save(tenantDomain);
    }

    /**
     * Remove a domain from a tenant.
     */
    async removeDomain(ctx: RequestContext, tenantId: ID, domainId: ID): Promise<boolean> {
        const tenantDomain = await this.connection
            .getRepository(ctx, TenantDomain)
            .findOne({ where: { id: domainId, tenantId } });
        if (!tenantDomain) {
            throw new UserInputError('Domain not found');
        }

        await this.connection.getRepository(ctx, TenantDomain).remove(tenantDomain);
        return true;
    }

    /**
     * Validate allowed status transitions.
     *
     * Valid transitions:
     * REQUESTED → PROVISIONING
     * PROVISIONING → TRIAL | ACTIVE
     * TRIAL → ACTIVE | SUSPENDED | PENDING_DELETION
     * ACTIVE → SUSPENDED | PENDING_DELETION
     * SUSPENDED → ACTIVE | PENDING_DELETION
     * PENDING_DELETION → ACTIVE | DELETED
     * DELETED → (terminal, no transitions out)
     */
    private validateStatusTransition(from: TenantStatus, to: TenantStatus): void {
        const allowed: Record<TenantStatus, TenantStatus[]> = {
            [TenantStatus.REQUESTED]: [TenantStatus.PROVISIONING],
            [TenantStatus.PROVISIONING]: [TenantStatus.TRIAL, TenantStatus.ACTIVE],
            [TenantStatus.TRIAL]: [TenantStatus.ACTIVE, TenantStatus.SUSPENDED, TenantStatus.PENDING_DELETION],
            [TenantStatus.ACTIVE]: [TenantStatus.SUSPENDED, TenantStatus.PENDING_DELETION],
            [TenantStatus.SUSPENDED]: [TenantStatus.ACTIVE, TenantStatus.PENDING_DELETION],
            [TenantStatus.PENDING_DELETION]: [TenantStatus.ACTIVE, TenantStatus.DELETED],
            [TenantStatus.DELETED]: [TenantStatus.PURGED],
            [TenantStatus.PURGED]: [],
        };

        if (!allowed[from]?.includes(to)) {
            throw new UserInputError(
                `Invalid status transition: ${from} → ${to}. Allowed: ${allowed[from].join(', ') || 'none'}`,
            );
        }
    }
}
