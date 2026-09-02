import { AuthorizationError } from '../../domain/errors.js';

export const authorityLevels = ['MEMBER', 'DEPUTY', 'HEAD', 'DEV'] as const;
export type AuthorityLevel = (typeof authorityLevels)[number];

export const capabilities = [
  'MEMBER_USE',
  'ROUTINE_ADMIN',
  'MEMBER_MANAGE',
  'ROSTER_TITLE_MANAGE',
  'CHANNEL_CONFIGURE',
  'FINANCIAL_REVERSE',
  'STOCK_REVERSE',
  'SYSTEM_CONFIGURE',
] as const;
export type Capability = (typeof capabilities)[number];

const grants: Readonly<Record<AuthorityLevel, ReadonlySet<Capability>>> = {
  MEMBER: new Set(['MEMBER_USE']),
  DEPUTY: new Set(['MEMBER_USE', 'ROUTINE_ADMIN', 'MEMBER_MANAGE']),
  HEAD: new Set([
    'MEMBER_USE',
    'ROUTINE_ADMIN',
    'MEMBER_MANAGE',
    'ROSTER_TITLE_MANAGE',
    'CHANNEL_CONFIGURE',
    'FINANCIAL_REVERSE',
    'STOCK_REVERSE',
  ]),
  DEV: new Set(capabilities),
};

export function hasCapability(authority: AuthorityLevel, capability: Capability): boolean {
  return grants[authority].has(capability);
}

export function requireCapability(authority: AuthorityLevel, capability: Capability): void {
  if (!hasCapability(authority, capability)) {
    throw new AuthorizationError();
  }
}

export interface RoleConfiguration {
  readonly devRoleId: string | null;
  readonly headRoleId: string | null;
  readonly deputyRoleId: string | null;
  readonly activeMemberRoleId: string | null;
}

export function resolveAuthority(roleIds: ReadonlySet<string>, roles: RoleConfiguration): AuthorityLevel | null {
  if (roles.devRoleId !== null && roleIds.has(roles.devRoleId)) {
    return 'DEV';
  }

  if (roles.headRoleId !== null && roleIds.has(roles.headRoleId)) {
    return 'HEAD';
  }

  if (roles.deputyRoleId !== null && roleIds.has(roles.deputyRoleId)) {
    return 'DEPUTY';
  }

  if (roles.activeMemberRoleId !== null && roleIds.has(roles.activeMemberRoleId)) {
    return 'MEMBER';
  }

  return null;
}
