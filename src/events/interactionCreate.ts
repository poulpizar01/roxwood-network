import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Interaction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { commandsByName } from "../commands/index.js";
import { getTicketByChannel, getTicketById } from "../services/ticketService.js";
import { assignRecruiter, getApplication, saveAnswers, saveLogMessageRef, setStatus } from "../services/recruitmentService.js";
import { getItem, listActive } from "../services/catalogService.js";
import { addItemFromAnswers, computeTotal, getOrCreateOrder, getOrderByTicket } from "../services/orderService.js";
import { getGuildConfig, isStaffMember } from "../services/guildConfigService.js";
import { logger } from "../utils/logger.js";

/**
 * Point d'entree unique pour toutes les interactions Discord (commandes slash, boutons,
 * menus deroulants, soumissions de modal). Route chaque interaction vers son handler dedie
 * en fonction de son type et de son `customId`. C'est ici que vivent les deux flux
 * conversationnels a plusieurs etapes du bot :
 * - Recrutement : bouton "recruitment:start-form" -> modal -> "recruitment:submit-form",
 *   puis pilotage staff par boutons "recruitment:assign:<ticketId>" / "recruitment:status:<ticketId>"
 *   -> menu "recruitment:set-status:<ticketId>"
 * - Commande self-service : select "order:select-item" -> modal dynamique ->
 *   "order:submit-item:<catalogItemId>" -> boutons "order:add-more" / "order:confirm"
 */

/** Questions fixes du formulaire de candidature (limite Discord : 5 champs max par modal). */
const RECRUITMENT_QUESTIONS = ["Nom RP", "Age", "Experience RP", "Disponibilites", "Motivation"];

/** Etapes du pipeline de recrutement proposees dans le menu deroulant "Statut". */
const RECRUITMENT_STATUS_CHOICES = [
  { name: "En attente", value: "PENDING" },
  { name: "Entretien", value: "INTERVIEW" },
  { name: "Accepte", value: "ACCEPTED" },
  { name: "Refuse", value: "REJECTED" },
] as const;

/** Libelle affichable d'un statut de candidature (fallback sur la valeur brute si inconnue). */
function recruitmentStatusLabel(status: string): string {
  return RECRUITMENT_STATUS_CHOICES.find((c) => c.value === status)?.name ?? status;
}

/**
 * Verifie que l'utilisateur a l'origine d'une interaction sur un composant (bouton, menu)
 * fait partie du staff de la guilde. `interaction.member` est soit un `GuildMember` complet
 * (roles exposes via un `RoleManager.cache`), soit un objet API brut non-cache (roles
 * directement en `string[]`) — les deux formes sont geres ici pour eviter un appel reseau
 * supplementaire (`guild.members.fetch`) a chaque clic.
 */
async function isStaffInteraction(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<boolean> {
  if (!interaction.guildId || !interaction.member) return false;
  const config = await getGuildConfig(interaction.guildId);
  const roles = interaction.member.roles;
  const roleIds = Array.isArray(roles) ? roles : [...roles.cache.keys()];
  return isStaffMember(config, roleIds);
}

/**
 * Construit l'embed de suivi d'une candidature (candidat, salon, statut, recruteur,
 * reponses au formulaire). Reutilise a la fois pour le premier envoi et pour la mise a
 * jour du message apres un changement de statut/assignation.
 */
function buildRecruitmentEmbed(
  ticket: { channelId: string; openerId: string | null },
  application: { status: string; recruiterId: string | null; answers: { question: string; answer: string }[] }
): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Candidature")
    .setColor(0x5865f2)
    .addFields(
      { name: "Candidat", value: ticket.openerId ? `<@${ticket.openerId}>` : "inconnu", inline: true },
      { name: "Ticket", value: `<#${ticket.channelId}>`, inline: true },
      { name: "Statut", value: `**${recruitmentStatusLabel(application.status)}**`, inline: true },
      { name: "Recruteur", value: application.recruiterId ? `<@${application.recruiterId}>` : "non assigne", inline: true },
      ...application.answers.map((a) => ({ name: a.question, value: a.answer || "-" }))
    );
}

/** Boutons "Statut" et "S'assigner" affiches sous le message de suivi d'une candidature. */
function buildRecruitmentActionRow(ticketId: string): ActionRowBuilder<ButtonBuilder> {
  const statusButton = new ButtonBuilder()
    .setCustomId(`recruitment:status:${ticketId}`)
    .setLabel("Statut")
    .setStyle(ButtonStyle.Secondary);
  const assignButton = new ButtonBuilder()
    .setCustomId(`recruitment:assign:${ticketId}`)
    .setLabel("S'assigner")
    .setStyle(ButtonStyle.Primary);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(statusButton, assignButton);
}

/**
 * Determine ou poster le message de suivi d'une candidature : le salon dedie configure
 * par la guilde (`recruitmentLogChannelId`) si present et accessible, sinon le salon du
 * ticket lui-meme. Le repli est silencieux (juste logge) pour ne jamais bloquer l'envoi
 * du recap a cause d'une mauvaise configuration (salon supprime, permissions manquantes...).
 */
async function resolveRecruitmentLogChannel(interaction: Interaction, ticketChannelId: string) {
  const guildId = interaction.guildId;
  const config = guildId ? await getGuildConfig(guildId) : null;
  const configuredChannelId = config?.recruitmentLogChannelId;

  if (configuredChannelId) {
    try {
      const channel = await interaction.client.channels.fetch(configuredChannelId);
      if (channel?.isTextBased() && !channel.isDMBased()) return channel;
    } catch (error) {
      logger.warn(`Salon de suivi recrutement ${configuredChannelId} inaccessible, repli sur le salon du ticket`, error);
    }
  }

  const fallback = await interaction.client.channels.fetch(ticketChannelId);
  return fallback?.isTextBased() && !fallback.isDMBased() ? fallback : null;
}

/**
 * Recharge le ticket/la candidature depuis la base et met a jour en place le message de
 * suivi (embed + boutons), apres un changement de statut ou d'assignation. No-op silencieux
 * si le message de suivi n'a jamais ete envoye (candidature pas encore soumise) ou n'est
 * plus accessible (salon/message supprime) — journalise mais ne fait pas echouer l'action
 * qui a declenche la mise a jour (le statut/l'assignation reste change en base dans tous les cas).
 */
async function refreshRecruitmentLogMessage(interaction: ButtonInteraction | StringSelectMenuInteraction, ticketId: string): Promise<void> {
  const ticket = await getTicketById(ticketId);
  const application = await getApplication(ticketId);
  if (!ticket || !application || !application.logChannelId || !application.logMessageId) return;

  try {
    const channel = await interaction.client.channels.fetch(application.logChannelId);
    if (!channel?.isTextBased() || channel.isDMBased()) return;
    const message = await channel.messages.fetch(application.logMessageId);
    await message.edit({ embeds: [buildRecruitmentEmbed(ticket, application)], components: [buildRecruitmentActionRow(ticketId)] });
  } catch (error) {
    logger.error(`Echec de mise a jour du message de suivi pour le ticket ${ticketId}`, error);
  }
}

/** Route une commande slash vers son `Command.execute`, avec gestion d'erreur generique commune a toutes les commandes. */
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

/**
 * Clic sur le bouton "Remplir le formulaire" d'un ticket de recrutement : ouvre un modal
 * avec les 5 questions fixes. Les 2 premieres questions courtes (nom, age) utilisent un
 * champ court, les 3 suivantes (experience, disponibilites, motivation) un champ long.
 */
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

/**
 * Soumission du formulaire de candidature : enregistre les reponses, puis poste le recap
 * complet (avec les boutons "Statut"/"S'assigner") dans le salon de suivi dedie a la guilde
 * si configure, sinon dans le salon du ticket lui-meme. Le candidat recoit juste une
 * confirmation courte, sans le detail de ses reponses republie publiquement.
 */
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

  const application = await saveAnswers(ticket.id, answers);

  const logChannel = await resolveRecruitmentLogChannel(interaction, ticket.channelId);
  if (logChannel) {
    const message = await logChannel.send({
      embeds: [buildRecruitmentEmbed(ticket, application)],
      components: [buildRecruitmentActionRow(ticket.id)],
    });
    await saveLogMessageRef(ticket.id, logChannel.id, message.id);
  }

  await interaction.reply("Formulaire envoye, merci ! Notre equipe va examiner votre candidature.");
}

/**
 * Clic sur "S'assigner" (message de suivi d'une candidature) : assigne l'utilisateur ayant
 * clique comme recruteur (reassignation possible si quelqu'un d'autre etait deja assigne),
 * puis met a jour le message de suivi. Reserve au staff.
 */
async function handleRecruitmentAssign(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isButton()) return;

  if (!(await isStaffInteraction(interaction))) {
    await interaction.reply({ content: "Reserve au staff.", ephemeral: true });
    return;
  }

  await assignRecruiter(ticketId, interaction.user.id);
  await refreshRecruitmentLogMessage(interaction, ticketId);
  await interaction.reply({ content: "Vous etes assigne a cette candidature.", ephemeral: true });
}

/**
 * Clic sur "Statut" (message de suivi d'une candidature) : affiche, en ephemere (visible
 * seulement par le staff qui a clique), un menu deroulant des 4 etapes du pipeline. Reserve
 * au staff.
 */
async function handleRecruitmentStatusButton(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isButton()) return;

  if (!(await isStaffInteraction(interaction))) {
    await interaction.reply({ content: "Reserve au staff.", ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`recruitment:set-status:${ticketId}`)
    .setPlaceholder("Choisir une etape")
    .addOptions(RECRUITMENT_STATUS_CHOICES.map((c) => ({ label: c.name, value: c.value })));

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

/**
 * Selection d'une etape dans le menu deroulant "Statut" : met a jour la candidature et le
 * message de suivi, puis remplace le menu ephemere par une confirmation textuelle (`update`
 * plutot que `reply`, pour editer ce meme message ephemere au lieu d'en empiler un nouveau).
 */
async function handleRecruitmentSetStatus(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isStringSelectMenu()) return;

  if (!(await isStaffInteraction(interaction))) {
    await interaction.reply({ content: "Reserve au staff.", ephemeral: true });
    return;
  }

  const status = interaction.values[0] as (typeof RECRUITMENT_STATUS_CHOICES)[number]["value"];
  await setStatus(ticketId, status);
  await refreshRecruitmentLogMessage(interaction, ticketId);

  await interaction.update({ content: `Statut mis a jour : **${recruitmentStatusLabel(status)}**`, components: [] });
}

/**
 * Selection d'un article dans le menu deroulant du catalogue : construit et affiche un
 * modal dynamique a partir des champs personnalises configures pour cet article par le
 * staff (`CatalogItemField`). Si l'article n'a aucun champ personnalise, affiche un unique
 * champ de confirmation optionnel plutot qu'un modal vide (Discord exige au moins un composant).
 */
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
      // Pas de type de champ "nombre" natif dans les modals Discord : on guide via placeholder,
      // la valeur est parsee et validee cote serveur (voir orderService.addItemFromAnswers).
      if (field.style === "QUANTITY") input.setPlaceholder("Nombre (ex: 1)");
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    }
  }

  await interaction.showModal(modal);
}

/**
 * Soumission du modal d'un article : ajoute la ligne a la commande en cours (creee si besoin),
 * puis repost un embed recapitulatif complet de la commande (tous les articles ajoutes jusque-la,
 * pas seulement celui-ci) avec les boutons pour continuer ("Ajouter un article") ou terminer
 * ("Valider la commande"). Chaque soumission poste un nouveau message plutot que d'editer le
 * precedent, pour rester simple et robuste sans avoir a suivre un id de message entre interactions.
 *
 * @param catalogItemId - extrait du customId du modal par l'appelant (`onInteractionCreate`)
 */
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

/**
 * Clic sur "Ajouter un article" : re-affiche le menu deroulant du catalogue, en reponse
 * ephemere (visible seulement par le client) pour ne pas encombrer le salon d'un nouveau
 * menu a chaque fois.
 */
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
      // Un StringSelectMenu Discord accepte au plus 25 options.
      items.slice(0, 25).map((item) => ({
        label: item.name.slice(0, 100),
        description: `${item.price.toLocaleString("fr-FR")} $`,
        value: item.id,
      }))
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

/**
 * Clic sur "Valider la commande" : etape finale du flux self-service cote client. Ne fait
 * plus aucune saisie du staff — se contente de poster le recap final et de ping les roles
 * staff configures, a charge pour eux de confirmer le paiement (`/order paid`) qui genere
 * la facture. Refuse si la commande est vide (rien a valider).
 */
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

/**
 * Handler de l'evenement `interactionCreate`. Aiguille par type d'interaction puis par
 * `customId` vers le handler correspondant ci-dessus. Les customId parametres (contenant
 * un id de ticket ou de catalogue) utilisent un prefixe fixe suivi de `:<id>`, extrait via
 * `startsWith`/`slice` — Discord ne permet pas de passer d'etat structure entre l'affichage
 * d'un composant et l'interaction qui le declenche, seulement une chaine de 100 caracteres max.
 * Toute exception non geree par un handler est capturee ici (log + reponse d'erreur generique)
 * pour eviter qu'une interaction Discord ne reste "en attente" indefiniment cote client si le
 * bot plante en cours de traitement.
 */
export async function onInteractionCreate(interaction: Interaction): Promise<void> {
  try {
    if (interaction.isChatInputCommand()) {
      await handleChatInputCommand(interaction);
      return;
    }

    if (interaction.isButton()) {
      if (interaction.customId === "recruitment:start-form") return handleRecruitmentStartForm(interaction);
      if (interaction.customId.startsWith("recruitment:assign:")) {
        return handleRecruitmentAssign(interaction, interaction.customId.slice("recruitment:assign:".length));
      }
      if (interaction.customId.startsWith("recruitment:status:")) {
        return handleRecruitmentStatusButton(interaction, interaction.customId.slice("recruitment:status:".length));
      }
      if (interaction.customId === "order:add-more") return handleOrderAddMore(interaction);
      if (interaction.customId === "order:confirm") return handleOrderConfirm(interaction);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === "order:select-item") return handleOrderSelectItem(interaction);
      if (interaction.customId.startsWith("recruitment:set-status:")) {
        return handleRecruitmentSetStatus(interaction, interaction.customId.slice("recruitment:set-status:".length));
      }
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
