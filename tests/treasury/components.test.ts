import { buildManualTreasuryModal } from '../../src/infrastructure/discord/treasury-components.js';

describe('treasury Discord components', () => {
  it('builds manual entry modals for file upload and Discord Media Link', () => {
    const fileModal = buildManualTreasuryModal('INCOME', 'FILE').toJSON();
    const linkModal = buildManualTreasuryModal('EXPENSE', 'LINK').toJSON();

    expect(fileModal.custom_id).toBe('treasury:manual_modal:FILE:INCOME');
    expect(fileModal.components[2]).toMatchObject({ component: { type: 19, required: true } });
    expect(linkModal.custom_id).toBe('treasury:manual_modal:LINK:EXPENSE');
    expect(linkModal.components[2]).toMatchObject({
      component: { type: 4, custom_id: 'treasury:evidence_media_link', required: true },
    });
  });
});
