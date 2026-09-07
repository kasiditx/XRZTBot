import { buildReasonedCancellationModal, cancellationConfirmationRow } from '../../src/infrastructure/discord/cancellation-confirmation.js';
import { buildFineCancellationModal, buildFineRejectionModal } from '../../src/infrastructure/discord/fine-components.js';
import { buildDepositRejectionModal, buildWithdrawalRejectionModal } from '../../src/infrastructure/discord/stock-components.js';
import { buildTreasuryWithdrawalRejectionModal } from '../../src/infrastructure/discord/treasury-components.js';
import { buildWeeklyRejectionModal } from '../../src/infrastructure/discord/weekly-dues-components.js';

describe('cancellation confirmation', () => {
  it.each([buildFineCancellationModal, buildFineRejectionModal, buildDepositRejectionModal,
    buildWithdrawalRejectionModal, buildTreasuryWithdrawalRejectionModal, buildWeeklyRejectionModal])(
    'adds confirmation to existing review modals within Discord limits', (build) => {
      const modal = build('11111111-1111-4111-8111-111111111111').addComponents(cancellationConfirmationRow()).toJSON();
      expect(modal.components).toHaveLength(2);
    },
  );
  it('serializes required reason and explicit confirmation within Discord limits', () => {
    const modal = buildReasonedCancellationModal('leave:cancel_modal:example', 'ยกเลิกใบลา').toJSON();
    expect(modal.components).toHaveLength(2);
    expect(cancellationConfirmationRow().toJSON().components[0]).toMatchObject({
      custom_id: 'cancellation:confirm', required: true, type: 4,
    });
  });
});
