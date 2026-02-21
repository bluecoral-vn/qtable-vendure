import { gql } from 'graphql-tag';

/**
 * Common types shared between Admin and Shop APIs.
 */
const commonApiExtensions = gql`
    enum TenantStatus {
        REQUESTED
        PROVISIONING
        TRIAL
        ACTIVE
        SUSPENDED
        PENDING_DELETION
        DELETED
    }

    type TenantDomain implements Node {
        id: ID!
        createdAt: DateTime!
        updatedAt: DateTime!
        domain: String!
        isPrimary: Boolean!
        sslStatus: String!
        verifiedAt: DateTime
    }

    type Tenant implements Node {
        id: ID!
        createdAt: DateTime!
        updatedAt: DateTime!
        name: String!
        slug: String!
        status: TenantStatus!
        plan: String!
        config: JSON!
        channel: Channel!
        domains: [TenantDomain!]!
        suspendedAt: DateTime
        deletedAt: DateTime
    }

    type TenantList implements PaginatedList {
        items: [Tenant!]!
        totalItems: Int!
    }

    input TenantSortParameter {
        id: SortOrder
        createdAt: SortOrder
        updatedAt: SortOrder
        name: SortOrder
        slug: SortOrder
        status: SortOrder
        plan: SortOrder
    }

    input TenantFilterParameter {
        id: IDOperators
        createdAt: DateOperators
        updatedAt: DateOperators
        name: StringOperators
        slug: StringOperators
        status: StringOperators
        plan: StringOperators
    }

    input TenantListOptions {
        take: Int
        skip: Int
        sort: TenantSortParameter
        filter: TenantFilterParameter
    }
`;

/**
 * Admin API extensions — full CRUD + provisioning + lifecycle management.
 */
export const adminApiExtensions = gql`
    ${commonApiExtensions}

    input ProvisionTenantInput {
        name: String!
        slug: String!
        primaryDomain: String!
        plan: String
        adminFirstName: String!
        adminLastName: String!
        adminEmailAddress: String!
        adminPassword: String!
        defaultLanguageCode: LanguageCode
        defaultCurrencyCode: CurrencyCode
        pricesIncludeTax: Boolean
    }

    input UpdateTenantInput {
        id: ID!
        name: String
        plan: String
        config: JSON
    }

    type ProvisionTenantResult {
        tenant: Tenant!
        channelToken: String!
        adminId: ID!
    }

    input AddTenantDomainInput {
        tenantId: ID!
        domain: String!
        isPrimary: Boolean
    }

    extend type Query {
        tenants(options: TenantListOptions): TenantList!
        tenant(id: ID!): Tenant
        tenantBySlug(slug: String!): Tenant
        auditLogs(options: AuditLogListOptions): AuditLogList!
    }

    type AuditLog implements Node {
        id: ID!
        createdAt: DateTime!
        action: String!
        severity: String!
        userId: Int
        channelId: Int
        tenantId: Int
        metadata: JSON!
        ipAddress: String
    }

    type AuditLogList implements PaginatedList {
        items: [AuditLog!]!
        totalItems: Int!
    }

    input AuditLogListOptions {
        take: Int
        skip: Int
        action: String
        severity: String
        tenantId: ID
    }

    extend type Mutation {
        provisionTenant(input: ProvisionTenantInput!): ProvisionTenantResult!
        updateTenant(input: UpdateTenantInput!): Tenant!
        changeTenantStatus(id: ID!, status: TenantStatus!): Tenant!
        addTenantDomain(input: AddTenantDomainInput!): TenantDomain!
        removeTenantDomain(tenantId: ID!, domainId: ID!): Boolean!
    }
`;

/**
 * Shop API extensions — read-only current tenant info.
 */
export const shopApiExtensions = gql`
    ${commonApiExtensions}

    extend type Query {
        """ Returns the current tenant based on the resolved domain/channel. """
        currentTenant: Tenant
    }
`;
