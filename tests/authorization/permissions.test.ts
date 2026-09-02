import { AuthorizationError } from '../../src/domain/errors.js';
import { hasCapability, requireCapability, resolveAuthority } from '../../src/modules/authorization/permissions.js';

const roles = {
  devRoleId: 'dev',
  headRoleId: 'head',
  deputyRoleId: 'deputy',
  activeMemberRoleId: 'member',
};

describe('authorization permissions', () => {
  it('gives Dev every capability', () => {
    expect(hasCapability('DEV', 'SYSTEM_CONFIGURE')).toBe(true);
    expect(hasCapability('DEV', 'FINANCIAL_REVERSE')).toBe(true);
    expect(hasCapability('DEV', 'ROUTINE_ADMIN')).toBe(true);
  });

  it('limits Deputy to routine member administration', () => {
    expect(hasCapability('DEPUTY', 'MEMBER_MANAGE')).toBe(true);
    expect(hasCapability('DEPUTY', 'ROSTER_TITLE_MANAGE')).toBe(false);
    expect(hasCapability('DEPUTY', 'CHANNEL_CONFIGURE')).toBe(false);
    expect(hasCapability('DEPUTY', 'FINANCIAL_REVERSE')).toBe(false);
  });

  it('allows Head to configure channels and reverse business records', () => {
    expect(hasCapability('HEAD', 'CHANNEL_CONFIGURE')).toBe(true);
    expect(hasCapability('HEAD', 'STOCK_REVERSE')).toBe(true);
    expect(hasCapability('HEAD', 'SYSTEM_CONFIGURE')).toBe(false);
    expect(hasCapability('HEAD', 'ROSTER_TITLE_MANAGE')).toBe(true);
  });

  it('throws when a capability is missing', () => {
    expect(() => requireCapability('MEMBER', 'ROUTINE_ADMIN')).toThrow(AuthorizationError);
    expect(() => requireCapability('HEAD', 'MEMBER_MANAGE')).not.toThrow();
  });

  it('resolves the highest role when a member has multiple roles', () => {
    expect(resolveAuthority(new Set(['member', 'deputy', 'head']), roles)).toBe('HEAD');
    expect(resolveAuthority(new Set(['member', 'dev']), roles)).toBe('DEV');
    expect(resolveAuthority(new Set(['deputy']), roles)).toBe('DEPUTY');
    expect(resolveAuthority(new Set(['member']), roles)).toBe('MEMBER');
    expect(resolveAuthority(new Set(['unrelated']), roles)).toBeNull();
  });

  it('does not treat null role configuration as a match', () => {
    expect(resolveAuthority(new Set(['dev']), { ...roles, devRoleId: null })).toBeNull();
  });
});
