import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
  type APIModalInteractionResponseCallbackData,
  type InteractionDeferReplyOptions,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
  type InteractionUpdateOptions,
  type ModalBuilder,
  type RepliableInteraction,
} from 'discord.js';
import { PreparedModalStore } from './prepared-modal-store.js';

const ACKNOWLEDGEMENT_DELAY_MS = 800;
const responses = new WeakMap<RepliableInteraction, ResponsiveInteraction>();
const preparedModals = new PreparedModalStore();

export function interactionResponse(interaction: RepliableInteraction): ResponsiveInteraction {
  let response = responses.get(interaction);
  if (response === undefined) {
    response = new ResponsiveInteraction(interaction, preparedModals);
    responses.set(interaction, response);
  }
  return response;
}

export class ResponsiveInteraction {
  private timer: NodeJS.Timeout | null = null;
  private automaticAcknowledgement: Promise<void> | null = null;
  private acknowledgementError: unknown;
  private acknowledgementFailed = false;
  private acknowledgedAsUpdate = false;
  private replyIntent = false;
  private privateReplyId: string | null = null;

  public constructor(
    private readonly interaction: RepliableInteraction,
    private readonly modals: PreparedModalStore,
  ) {}

  public get automaticallyDeferred(): boolean {
    return this.automaticAcknowledgement !== null;
  }

  public start(): void {
    const elapsed = Date.now() - this.interaction.createdTimestamp;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.automaticAcknowledgement = this.acknowledgeAutomatically().catch((error: unknown) => {
        this.acknowledgementFailed = true;
        this.acknowledgementError = error;
      });
    }, Math.max(0, ACKNOWLEDGEMENT_DELAY_MS - elapsed));
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  public async reply(options: InteractionReplyOptions): Promise<void> {
    await this.prepareResponse();
    this.replyIntent = true;
    if (this.interaction.deferred) {
      const message = await this.interaction.followUp(options);
      this.privateReplyId = message.id;
      return;
    }
    await this.interaction.reply(options);
  }

  public async deferReply(options: InteractionDeferReplyOptions): Promise<void> {
    await this.prepareResponse();
    this.replyIntent = true;
    if (!this.interaction.deferred) await this.interaction.deferReply(options);
  }

  public async deferUpdate(): Promise<void> {
    await this.prepareResponse();
    this.replyIntent = false;
    if (!this.interaction.isMessageComponent()) throw new Error('Cannot defer an update without a component message');
    if (!this.interaction.deferred) {
      await this.interaction.deferUpdate();
      this.acknowledgedAsUpdate = true;
    }
  }

  public async editReply(options: InteractionEditReplyOptions): Promise<void> {
    await this.prepareResponse();
    if (this.acknowledgedAsUpdate && this.replyIntent) {
      if (this.privateReplyId !== null) {
        await this.interaction.webhook.editMessage(this.privateReplyId, options);
      } else {
        const message = await this.interaction.followUp({ ...options, content: options.content ?? '', flags: MessageFlags.Ephemeral });
        this.privateReplyId = message.id;
      }
      return;
    }
    await this.interaction.editReply(options);
  }

  public async update(options: InteractionUpdateOptions): Promise<void> {
    await this.prepareResponse();
    this.replyIntent = false;
    if (!this.interaction.isMessageComponent()) throw new Error('Cannot update without a component message');
    if (this.interaction.deferred) {
      await this.interaction.editReply(options);
    } else {
      await this.interaction.update(options);
    }
  }

  public async showModal(modal: ModalBuilder | APIModalInteractionResponseCallbackData): Promise<void> {
    await this.prepareResponse();
    if (this.interaction.isModalSubmit()) throw new Error('Cannot open a modal from a modal submission');
    if (!this.interaction.deferred) {
      await this.interaction.showModal(modal);
      return;
    }
    // Discord cannot open a modal after deferring. A fresh, owner-bound button keeps slow preparation usable.
    const data = 'toJSON' in modal ? modal.toJSON() : modal;
    const customId = this.modals.save(this.interaction.guildId, this.interaction.user.id, data);
    await this.reply({
      content: 'เตรียมแบบฟอร์มพร้อมแล้ว กด **เปิดแบบฟอร์ม** เพื่อทำรายการต่อได้เลย (ภายใน 2 นาที)',
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(customId).setLabel('เปิดแบบฟอร์ม').setStyle(ButtonStyle.Primary),
      )],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }

  public async openPreparedModal(customId: string): Promise<void> {
    await this.prepareResponse();
    if (!this.interaction.isButton()) throw new Error('A prepared modal requires a button interaction');
    const modal = this.modals.take(customId, this.interaction.guildId, this.interaction.user.id);
    await this.interaction.showModal(modal);
  }

  public async sendError(options: InteractionReplyOptions): Promise<void> {
    await this.prepareResponse();
    if (this.acknowledgedAsUpdate || this.interaction.replied) {
      await this.interaction.followUp({ ...options, flags: MessageFlags.Ephemeral });
    } else if (this.interaction.deferred) {
      await this.reply({ ...options, flags: MessageFlags.Ephemeral });
    } else {
      await this.interaction.reply({ ...options, flags: MessageFlags.Ephemeral });
    }
  }

  private async prepareResponse(): Promise<void> {
    this.stop();
    await this.automaticAcknowledgement;
    if (this.acknowledgementFailed) throw this.acknowledgementError;
  }

  private async acknowledgeAutomatically(): Promise<void> {
    if (this.interaction.deferred || this.interaction.replied) return;
    if (this.interaction.isMessageComponent()) {
      await this.interaction.deferUpdate();
      this.acknowledgedAsUpdate = true;
    } else {
      await this.interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
  }
}
