import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Interaction,
} from "discord.js";
import { commandsByName } from "../commands/index.js";
import { getTicketByChannel } from "../services/ticketService.js";
import { saveAnswers } from "../services/recruitmentService.js";
import { getItem, listActive } from "../services/catalogService.js";
import { addItemFromAnswers, computeTotal, getOrCreateOrder, getOrderByTicket } from "../services/orderService.js";
import { getGuildConfig } from "../services/guildConfigService.js";
import { logger } from "../utils/logger.js";

const RECRUITMENT_QUESTIONS = ["Nom RP", "Age", "Experience RP", "Disponibilites", "Motivation"];

async function handleChatInputCommand(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand()) return;

  const command = commandsByName.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (error) {
    logger.error(`Erreur lors de l'execution de /${interaction.commandName}`, error);
    const payload = { content: "Une erreur est survenue lors de l'execution de la commande.", ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  }
}

async function handleRecruitmentStartForm(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;

  const modal = new ModalBuilder().setCustomId("recruitment:submit-form").setTitle("Formulaire de candidature");
  const rows = RECRUITMENT_QUESTIONS.map((question, index) => {
    const input = new TextInputBuilder()
      .setCustomId(`q${index}`)
      .setLabel(question)
      .setStyle(index >= 2 ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(true);
    return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
  });
  modal.addComponents(...rows);

  await interaction.showModal(modal);
}

async function handleRecruitmentSubmitForm(interaction: Interaction): Promise<void> {
  if (!interaction.isModalSubmit() || !interaction.channelId) return;

  const ticket = await getTicketByChannel(interaction.channelId);
  if (!ticket || ticket.type !== "RECRUITMENT") {
    await interaction.reply({ content: "Ce salon n'est pas rattache a une candidature.", ephemeral: true });
    return;
  }

  const answers = RECRUITMENT_QUESTIONS.map((question, index) => ({
    question,
    answer: interaction.fields.getTextInputValue(`q${index}`),
  }));

  await saveAnswers(ticket.id, answers);

  const embed = new EmbedBuilder()
    .setTitle("Candidature recue")
    .setColor(0x5865f2)
    .addFields(answers.map((a) => ({ name: a.question, value: a.answer || "-" })));

  if (interaction.channel?.isTextBased() && !interaction.channel.isDMBased()) {
    await interaction.channel.send({ embeds: [embed] });
  }
  await interaction.reply({ content: "Formulaire envoye, merci !", ephemeral: true });
}

async function handleOrderSelectItem(interaction: Interaction): Promise<void> {
  if (!interaction.isStringSelectMenu()) return;

  const catalogItemId = interaction.values[0];
  const item = await getItem(interaction.guildId!, catalogItemId);
  if (!item) {
    await interaction.reply({ content: "Cet article n'existe plus.", ephemeral: true });
    return;
  }

  const modal = new ModalBuilder().setCustomId(`order:submit-item:${item.id}`).setTitle(item.name.slice(0, 45));

  if (item.fields.length === 0) {
    const input = new TextInputBuilder()
      .setCustomId("confirm")
      .setLabel("Confirmer la commande de cet article")
      .setStyle(TextInputStyle.Short)
      .setValue("oui")
      .setRequired(false);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  } else {
    for (const field of item.fields) {
      const input = new TextInputBuilder()
        .setCustomId(field.id)
        .setLabel(field.label.slice(0, 45))
        .setStyle(field.style === "PARAGRAPH" ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(field.required);
      if (field.style === "QUANTITY") input.setPlaceholder("Nombre (ex: 1)");
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    }
  }

  await interaction.showModal(modal);
}

async function handleOrderSubmitItem(interaction: Interaction, catalogItemId: string): Promise<void> {
  if (!interaction.isModalSubmit() || !interaction.channelId) return;

  const ticket = await getTicketByChannel(interaction.channelId);
  if (!ticket || ticket.type !== "SERVICE") {
    await interaction.reply({ content: "Ce salon n'est pas rattache a une commande.", ephemeral: true });
    return;
  }

  const item = await getItem(interaction.guildId!, catalogItemId);
  if (!item) {
    await interaction.reply({ content: "Cet article n'existe plus.", ephemeral: true });
    return;
  }

  const order = await getOrCreateOrder(ticket.id);
  const answers = item.fields.map((field) => ({
    field,
    value: interaction.fields.getTextInputValue(field.id),
  }));
  await addItemFromAnswers(order.id, item, answers);

  const fullOrder = await getOrderByTicket(ticket.id);
  const total = fullOrder ? computeTotal(fullOrder) : 0;

  const embed = new EmbedBuilder()
    .setTitle("Commande en cours")
    .setColor(0x5865f2)
    .setDescription(
      (fullOrder?.items ?? [])
        .map((i) => `**${i.name}** x${i.quantity} — ${(i.unitPrice * i.quantity).toLocaleString("fr-FR")} $`)
        .join("\n") || "Aucun article"
    )
    .addFields({ name: "Total", value: `${total.toLocaleString("fr-FR")} $` });

  const addMore = new ButtonBuilder().setCustomId("order:add-more").setLabel("Ajouter un article").setStyle(ButtonStyle.Secondary);
  const confirm = new ButtonBuilder().setCustomId("order:confirm").setLabel("Valider la commande").setStyle(ButtonStyle.Success);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(addMore, confirm);

  if (interaction.channel?.isTextBased() && !interaction.channel.isDMBased()) {
    await interaction.channel.send({ embeds: [embed], components: [row] });
  }
  await interaction.reply({ content: "Article ajoute a la commande.", ephemeral: true });
}

async function handleOrderAddMore(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;

  const items = await listActive(interaction.guildId!);
  if (items.length === 0) {
    await interaction.reply({ content: "Le catalogue est vide.", ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("order:select-item")
    .setPlaceholder("Choisir un article")
    .addOptions(
      items.slice(0, 25).map((item) => ({
        label: item.name.slice(0, 100),
        description: `${item.price.toLocaleString("fr-FR")} $`,
        value: item.id,
      }))
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

async function handleOrderConfirm(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;

  const ticket = await getTicketByChannel(interaction.channelId);
  if (!ticket || ticket.type !== "SERVICE") {
    await interaction.reply({ content: "Ce salon n'est pas rattache a une commande.", ephemeral: true });
    return;
  }

  const order = await getOrderByTicket(ticket.id);
  if (!order || order.items.length === 0) {
    await interaction.reply({ content: "La commande est vide, ajoutez au moins un article.", ephemeral: true });
    return;
  }

  const config = await getGuildConfig(ticket.guildId);
  const mentions = (config?.staffRoleIds ?? []).map((roleId) => `<@&${roleId}>`).join(" ");
  const total = computeTotal(order);

  const embed = new EmbedBuilder()
    .setTitle("Commande validee")
    .setColor(0x57f287)
    .setDescription(order.items.map((i) => `**${i.name}** x${i.quantity} — ${(i.unitPrice * i.quantity).toLocaleString("fr-FR")} $`).join("\n"))
    .addFields({ name: "Total", value: `${total.toLocaleString("fr-FR")} $` });

  if (interaction.channel?.isTextBased() && !interaction.channel.isDMBased()) {
    await interaction.channel.send({
      content: mentions ? `${mentions} Nouvelle commande a traiter.` : "Nouvelle commande a traiter.",
      embeds: [embed],
    });
  }
  await interaction.reply({ content: "Commande validee, le staff a ete notifie.", ephemeral: true });
}

export async function onInteractionCreate(interaction: Interaction): Promise<void> {
  try {
    if (interaction.isChatInputCommand()) {
      await handleChatInputCommand(interaction);
      return;
    }

    if (interaction.isButton()) {
      if (interaction.customId === "recruitment:start-form") return handleRecruitmentStartForm(interaction);
      if (interaction.customId === "order:add-more") return handleOrderAddMore(interaction);
      if (interaction.customId === "order:confirm") return handleOrderConfirm(interaction);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === "order:select-item") return handleOrderSelectItem(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === "recruitment:submit-form") return handleRecruitmentSubmitForm(interaction);
      if (interaction.customId.startsWith("order:submit-item:")) {
        const catalogItemId = interaction.customId.slice("order:submit-item:".length);
        return handleOrderSubmitItem(interaction, catalogItemId);
      }
    }
  } catch (error) {
    logger.error("Erreur lors du traitement d'une interaction", error);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "Une erreur est survenue.", ephemeral: true }).catch(() => undefined);
    }
  }
}
