import {
  ActionRowBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Interaction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { commandsByName } from "../commands/index.js";
import { getTicketByChannel, getTicketById, markTicketClosed } from "../services/ticketService.js";
import { assignRecruiter, saveAnswers, saveLogMessageRef, setStatus as setApplicationStatus } from "../services/recruitmentService.js";
import {
  RECRUITMENT_STATUS_CHOICES,
  buildRecruitmentActionRow,
  buildRecruitmentEmbed,
  recruitmentStatusLabel,
  refreshRecruitmentLogMessage,
  resolveRecruitmentLogChannel,
} from "../services/recruitmentLogService.js";
import {
  addField,
  addItem,
  getItem,
  listActive,
  listActiveWithFields,
  removeField,
  removeItem as removeCatalogItem,
  setItemImage,
} from "../services/catalogService.js";
import {
  addItemFromAnswers,
  getOrCreateOrder,
  getOrderByTicket,
  markConfirmed,
  removeItem as removeOrderItem,
  setPaymentStatus,
  setStatus as setOrderStatus,
} from "../services/orderService.js";
import { ORDER_STATUS_CHOICES, orderStatusLabel, sendInvoiceForOrder, upsertOrderMessage } from "../services/orderLogService.js";
import {
  addCategoryManagerRole,
  clearCategoryForType,
  clearMonitoringChannel,
  getGuildConfig,
  isAbsenceApprover,
  isTicketManager,
  removeCategoryManagerRole,
  setAbsenceApproverRole,
  setAbsenceReviewChannel,
  setCategoryForType,
  setMonitoringChannel,
  setMonitoringJobId,
  setOnDutyRole,
  setRecruitmentOpen,
} from "../services/guildConfigService.js";
import {
  addQuestion as addRecruitmentQuestion,
  getEffectiveQuestions,
  listQuestions as listRecruitmentQuestions,
  removeQuestion as removeRecruitmentQuestion,
} from "../services/recruitmentQuestionService.js";
import { addRule as addFaqRule, listRules as listFaqRules, removeRule as removeFaqRule } from "../services/autoReplyService.js";
import {
  MONITORING_TYPE_LABELS,
  refreshAbsencesPanelMessage,
  refreshFaqPanelMessage,
  refreshMonitoringPanelMessage,
  refreshRecruitmentPanelMessage,
  refreshServicePanelMessage,
  refreshTicketsPanelMessage,
  setPanelEnabled,
} from "../services/panelService.js";
import { createAbsenceRequest, formatFrenchDate, getAbsenceRequest, parseFrenchDate, resolveAbsenceRequest } from "../services/absenceService.js";
import { postAbsenceRequest, refreshAbsenceMessage } from "../services/absenceLogService.js";
import { MONITORING_WEBHOOK_EVENT_TYPES, type WebhookEventType } from "../services/webhookDispatcher.js";
import { createSubscription, listSubscriptions, removeSubscription } from "../services/webhookSubscriptionService.js";
import type { MonitoringLogType } from "@prisma/client";
import { logger } from "../utils/logger.js";

/**
 * Point d'entree unique pour toutes les interactions Discord (commandes slash, boutons,
 * menus deroulants, soumissions de modal). Route chaque interaction vers son handler dedie
 * en fonction de son type et de son `customId`. C'est ici que vivent les trois flux
 * conversationnels a plusieurs etapes du bot :
 * - Recrutement : bouton "recruitment:start-form" -> modal -> "recruitment:submit-form",
 *   puis pilotage staff par boutons "recruitment:assign:<ticketId>" / "recruitment:status:<ticketId>"
 *   -> menu "recruitment:set-status:<ticketId>"
 * - Commande self-service : select "order:select-item" -> modal dynamique ->
 *   "order:submit-item:<catalogItemId>" -> boutons "order:add-more" / "order:confirm", puis
 *   pilotage staff par boutons "order:status:<ticketId>" / "order:mark-paid:<ticketId>" /
 *   "order:invoice:<ticketId>" / "order:remove-item:<ticketId>"
 * - Panneau d'administration (prefixe "panel:") : boutons du message racine ->
 *   "panel:root:tickets"/"absences"/"faq", puis pour Tickets une serie de mini-flux
 *   select-puis-select (categorie/role) decrits pres de chaque handler `handlePanelTickets*`.
 */

/**
 * Verifie que l'utilisateur a l'origine d'une interaction sur un composant (bouton, menu)
 * fait partie des roles de gestion de la categorie de ticket donnee. `interaction.member`
 * est soit un `GuildMember` complet (roles exposes via un `RoleManager.cache`), soit un
 * objet API brut non-cache (roles directement en `string[]`) — les deux formes sont geres
 * ici pour eviter un appel reseau supplementaire (`guild.members.fetch`) a chaque clic.
 */
async function isStaffInteraction(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  categoryId: string
): Promise<boolean> {
  if (!interaction.guildId || !interaction.member) return false;
  const config = await getGuildConfig(interaction.guildId);
  const roles = interaction.member.roles;
  const roleIds = Array.isArray(roles) ? roles : [...roles.cache.keys()];
  return isTicketManager(config, categoryId, roleIds);
}

/**
 * Message affiche quand `isStaffInteraction` refuse un clic. Explicite la cause (droits
 * insuffisants, pas juste "ca ne marche pas") et l'action corrective, pour ne pas laisser
 * un admin de test se demander pourquoi ses propres boutons ne repondent pas.
 */
const NOT_STAFF_MESSAGE =
  "Tu n'as pas les droits suffisants pour cette action : elle est réservée aux gestionnaires de cette catégorie. " +
  "Demande à un administrateur de t'ajouter via le panneau (bouton Tickets → Ajouter un rôle de gestion).";

/** Route une commande slash vers son `Command.execute`, avec gestion d'erreur generique commune a toutes les commandes. */
async function handleChatInputCommand(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand()) return;

  const command = commandsByName.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (error) {
    logger.error(`Erreur lors de l'execution de /${interaction.commandName}`, error);
    const payload = { content: "Une erreur est survenue lors de l'exécution de la commande.", ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  }
}

/**
 * Clic sur le bouton "Remplir le formulaire" d'un ticket de recrutement : ouvre un modal
 * avec les questions configurees par le staff (panneau "Recrutement"), ou les 5 questions
 * par defaut si aucune n'est configuree — voir `getEffectiveQuestions`.
 */
async function handleRecruitmentStartForm(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId) return;

  const questions = await getEffectiveQuestions(interaction.guildId);
  const modal = new ModalBuilder().setCustomId("recruitment:submit-form").setTitle("Formulaire de candidature");
  const rows = questions.map((question, index) => {
    const input = new TextInputBuilder()
      .setCustomId(`q${index}`)
      .setLabel(question.label)
      .setStyle(question.style === "PARAGRAPH" ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(true);
    return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
  });
  modal.addComponents(...rows);

  await interaction.showModal(modal);
}

/**
 * Soumission du formulaire de candidature : enregistre les reponses, puis poste le recap
 * complet (avec les boutons "Statut"/"S'assigner") dans le salon de suivi dedie a la guilde
 * si configure, sinon dans le salon du ticket lui-meme. Le candidat recoit une confirmation
 * qui l'invite aussi a envoyer d'eventuelles pieces jointes directement en message dans le
 * salon (les modals Discord ne supportent pas l'upload de fichier).
 *
 * Relit les questions "effectives" au moment de la soumission (pas de correlation stockee
 * avec celles affichees a l'ouverture du modal) : dans le cas rare ou le staff modifie le
 * formulaire pendant qu'un candidat le remplit, les libelles enregistres peuvent differer de
 * ceux vus par le candidat — compromis accepte, coherent avec le reste du code (pas d'etat de
 * session par interaction).
 */
async function handleRecruitmentSubmitForm(interaction: Interaction): Promise<void> {
  if (!interaction.isModalSubmit() || !interaction.channelId || !interaction.guildId) return;

  const ticket = await getTicketByChannel(interaction.channelId);
  if (!ticket || ticket.type !== "RECRUITMENT") {
    await interaction.reply({ content: "Ce salon n'est pas rattaché à une candidature.", ephemeral: true });
    return;
  }

  const questions = await getEffectiveQuestions(interaction.guildId);
  const answers = questions.map((question, index) => ({
    question: question.label,
    answer: interaction.fields.getTextInputValue(`q${index}`),
  }));

  const application = await saveAnswers(ticket.id, answers);

  const logChannel = await resolveRecruitmentLogChannel(interaction.client, interaction.guildId, ticket.channelId);
  if (logChannel) {
    const message = await logChannel.send({
      embeds: [buildRecruitmentEmbed(ticket, application)],
      components: [buildRecruitmentActionRow(ticket.id)],
    });
    await saveLogMessageRef(ticket.id, logChannel.id, message.id);
  }

  await interaction.reply(
    "Formulaire envoyé, merci ! Notre équipe va examiner votre candidature. " +
      "Vous pouvez aussi envoyer des photos ou documents directement dans ce salon si besoin."
  );
}

/**
 * Clic sur "S'assigner" (message de suivi d'une candidature) : assigne l'utilisateur ayant
 * clique comme recruteur (reassignation possible si quelqu'un d'autre etait deja assigne),
 * puis met a jour le message de suivi. Reserve aux gestionnaires de la categorie du ticket.
 */
async function handleRecruitmentAssign(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isButton()) return;

  const ticket = await getTicketById(ticketId);
  if (!ticket) {
    await interaction.reply({ content: "Candidature introuvable.", ephemeral: true });
    return;
  }
  if (!(await isStaffInteraction(interaction, ticket.categoryId))) {
    await interaction.reply({ content: NOT_STAFF_MESSAGE, ephemeral: true });
    return;
  }

  await assignRecruiter(ticketId, interaction.user.id);
  await refreshRecruitmentLogMessage(interaction.client, ticketId);
  await interaction.reply({ content: "Vous êtes assigné à cette candidature.", ephemeral: true });
}

/**
 * Clic sur "Statut" (message de suivi d'une candidature) : affiche, en ephemere (visible
 * seulement par le staff qui a clique), un menu deroulant des 4 etapes du pipeline. Reserve
 * aux gestionnaires de la categorie du ticket.
 */
async function handleRecruitmentStatusButton(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isButton()) return;

  const ticket = await getTicketById(ticketId);
  if (!ticket) {
    await interaction.reply({ content: "Candidature introuvable.", ephemeral: true });
    return;
  }
  if (!(await isStaffInteraction(interaction, ticket.categoryId))) {
    await interaction.reply({ content: NOT_STAFF_MESSAGE, ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`recruitment:set-status:${ticketId}`)
    .setPlaceholder("Choisir une étape")
    .addOptions(RECRUITMENT_STATUS_CHOICES.map((c) => ({ label: c.name, value: c.value })));

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

/**
 * Selection d'une etape dans le menu deroulant "Statut" : met a jour la candidature et le
 * message de suivi, puis remplace le menu ephemere par une confirmation textuelle (`update`
 * plutot que `reply`, pour editer ce meme message ephemere au lieu d'en empiler un nouveau).
 * Un passage a REFUSÉ clôture aussi le ticket (voir `closeTicketIfRejected`).
 */
async function handleRecruitmentSetStatus(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isStringSelectMenu()) return;

  const ticket = await getTicketById(ticketId);
  if (!ticket) {
    await interaction.reply({ content: "Candidature introuvable.", ephemeral: true });
    return;
  }
  if (!(await isStaffInteraction(interaction, ticket.categoryId))) {
    await interaction.reply({ content: NOT_STAFF_MESSAGE, ephemeral: true });
    return;
  }

  const status = interaction.values[0] as (typeof RECRUITMENT_STATUS_CHOICES)[number]["value"];
  await setApplicationStatus(ticketId, status);
  await refreshRecruitmentLogMessage(interaction.client, ticketId);

  if (status === "REJECTED") {
    await closeTicketIfRejected(interaction, ticketId);
  }

  await interaction.update({ content: `Statut mis à jour : **${recruitmentStatusLabel(status)}**`, components: [] });
}

/**
 * Marque le ticket comme clôturé côté suivi (statut CLOSED, arrête l'escalade et les stats
 * "ouverts") quand une candidature passe à REFUSÉ, et invite le staff à fermer le salon
 * cote Ticket Tool. Fermeture reellement automatisee testee et abandonnee : ni `channel.send`
 * (le bot) ni un message via webhook de salon ne declenchent le `$close` de Ticket Tool —
 * confirme empiriquement que Ticket Tool ignore tout message qui n'est pas poste par un vrai
 * utilisateur humain (bot ou webhook, meme resultat). Cliquer le bouton "Close" de Ticket
 * Tool a la place d'un humain n'est de toute facon pas possible (Discord ne permet pas a un
 * bot de simuler l'interaction d'un autre bot) — donc pas d'alternative automatisee restante,
 * et le bouton natif de Ticket Tool doit rester intact (voir le filtre sur les messages a
 * composants dans `messageCreate.ts`, pour ne pas le supprimer par erreur). No-op si le
 * ticket est deja ferme (evite un message en double si le statut est change plusieurs fois).
 */
async function closeTicketIfRejected(interaction: ButtonInteraction | StringSelectMenuInteraction, ticketId: string): Promise<void> {
  const ticket = await getTicketById(ticketId);
  if (!ticket || ticket.status !== "OPEN") return;

  await markTicketClosed(ticket.channelId, ticket.guildId);

  try {
    const channel = await interaction.client.channels.fetch(ticket.channelId);
    if (channel?.isTextBased() && !channel.isDMBased()) {
      await channel.send(
        "Cette candidature a été refusée : le ticket est marqué comme clôturé côté suivi. " +
          "Le staff peut maintenant fermer ce salon via le bouton \"Close\" de Ticket Tool."
      );
    }
  } catch (error) {
    logger.error(`Echec notification de cloture pour le ticket ${ticketId}`, error);
  }
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
 * puis cree ou edite en place l'unique message de commande du ticket (voir
 * `orderLogService.upsertOrderMessage`) — plus de spam d'un nouveau message a chaque article.
 *
 * @param catalogItemId - extrait du customId du modal par l'appelant (`onInteractionCreate`)
 */
async function handleOrderSubmitItem(interaction: Interaction, catalogItemId: string): Promise<void> {
  if (!interaction.isModalSubmit() || !interaction.channelId) return;

  const ticket = await getTicketByChannel(interaction.channelId);
  if (!ticket || ticket.type !== "SERVICE") {
    await interaction.reply({ content: "Ce salon n'est pas rattaché à une commande.", ephemeral: true });
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
  await upsertOrderMessage(interaction.client, ticket.id);

  await interaction.reply({ content: "Article ajouté à la commande.", ephemeral: true });
}

/**
 * Clic sur "Ajouter un article" : re-affiche le menu deroulant du catalogue, en reponse
 * ephemere (visible seulement par celui qui clique) pour ne pas encombrer le salon d'un
 * nouveau menu a chaque fois. Utilise a la fois par le client (avant validation) et par le
 * staff (correction apres validation, meme bouton reutilise sur le message de suivi).
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
 * Clic sur "Valider la commande" : etape finale du flux self-service cote client. Bascule
 * le message de commande vers son style "suivi" (boutons staff) et ping les roles de gestion
 * de la categorie du ticket separement (un `content` modifie par edition ne notifie personne
 * sur Discord, contrairement a un nouveau message). Refuse si la commande est vide.
 */
async function handleOrderConfirm(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;

  const ticket = await getTicketByChannel(interaction.channelId);
  if (!ticket || ticket.type !== "SERVICE") {
    await interaction.reply({ content: "Ce salon n'est pas rattaché à une commande.", ephemeral: true });
    return;
  }

  const order = await getOrderByTicket(ticket.id);
  if (!order || order.items.length === 0) {
    await interaction.reply({ content: "La commande est vide, ajoutez au moins un article.", ephemeral: true });
    return;
  }

  await markConfirmed(order.id);
  await upsertOrderMessage(interaction.client, ticket.id);

  const config = await getGuildConfig(ticket.guildId);
  const category = config?.ticketCategories.find((c) => c.categoryId === ticket.categoryId);
  const mentions = (category?.managerRoleIds ?? []).map((roleId) => `<@&${roleId}>`).join(" ");
  if (interaction.channel?.isTextBased() && !interaction.channel.isDMBased()) {
    await interaction.channel.send(mentions ? `${mentions} Nouvelle commande à traiter.` : "Nouvelle commande à traiter.");
  }
  await interaction.reply({ content: "Commande validée, le staff a été notifié.", ephemeral: true });
}

/**
 * Clic sur "Statut" (message de suivi d'une commande) : affiche, en ephemere, un menu
 * deroulant des 4 statuts logistiques. Reserve aux gestionnaires de la categorie du ticket.
 */
async function handleOrderStatusButton(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isButton()) return;

  const ticket = await getTicketById(ticketId);
  if (!ticket) {
    await interaction.reply({ content: "Commande introuvable.", ephemeral: true });
    return;
  }
  if (!(await isStaffInteraction(interaction, ticket.categoryId))) {
    await interaction.reply({ content: NOT_STAFF_MESSAGE, ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`order:set-status:${ticketId}`)
    .setPlaceholder("Choisir un statut")
    .addOptions(ORDER_STATUS_CHOICES.map((c) => ({ label: c.name, value: c.value })));

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

/** Selection d'un statut dans le menu deroulant "Statut" d'une commande. Reserve aux gestionnaires de la categorie du ticket. */
async function handleOrderSetStatus(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isStringSelectMenu()) return;

  const ticket = await getTicketById(ticketId);
  if (!ticket) {
    await interaction.reply({ content: "Commande introuvable.", ephemeral: true });
    return;
  }
  if (!(await isStaffInteraction(interaction, ticket.categoryId))) {
    await interaction.reply({ content: NOT_STAFF_MESSAGE, ephemeral: true });
    return;
  }

  const order = await getOrderByTicket(ticketId);
  if (!order) {
    await interaction.reply({ content: "Commande introuvable.", ephemeral: true });
    return;
  }

  const status = interaction.values[0] as (typeof ORDER_STATUS_CHOICES)[number]["value"];
  await setOrderStatus(order.id, status);
  await upsertOrderMessage(interaction.client, ticketId);

  await interaction.update({ content: `Statut mis à jour : **${orderStatusLabel(status)}**`, components: [] });
}

/**
 * Clic sur "Marquer payée" (message de suivi d'une commande) : bascule le paiement a PAID
 * et genere/poste automatiquement la facture. Reserve aux gestionnaires de la categorie du
 * ticket. `deferReply` : le rendu de l'image (canvas) + son upload peuvent depasser le delai
 * de 3s avant lequel Discord attend une premiere reponse a l'interaction.
 */
async function handleOrderMarkPaid(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isButton()) return;

  const ticket = await getTicketById(ticketId);
  if (!ticket) {
    await interaction.reply({ content: "Commande introuvable.", ephemeral: true });
    return;
  }
  if (!(await isStaffInteraction(interaction, ticket.categoryId))) {
    await interaction.reply({ content: NOT_STAFF_MESSAGE, ephemeral: true });
    return;
  }

  const order = await getOrderByTicket(ticketId);
  if (!order || order.items.length === 0) {
    await interaction.reply({ content: "Commande introuvable ou vide.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  await setPaymentStatus(order.id, "PAID");
  await upsertOrderMessage(interaction.client, ticketId);

  const updated = await getOrderByTicket(ticketId);
  if (updated) await sendInvoiceForOrder(interaction.client, ticket.guildId, ticket, updated);

  await interaction.editReply("Commande marquée payée, facture générée.");
}

/**
 * Clic sur "Facture" (message de suivi d'une commande) : regenere/renvoie l'image de
 * facture sans changer le statut de paiement. Reserve aux gestionnaires de la categorie du ticket.
 */
async function handleOrderInvoiceButton(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isButton()) return;

  const ticket = await getTicketById(ticketId);
  if (!ticket) {
    await interaction.reply({ content: "Commande introuvable.", ephemeral: true });
    return;
  }
  if (!(await isStaffInteraction(interaction, ticket.categoryId))) {
    await interaction.reply({ content: NOT_STAFF_MESSAGE, ephemeral: true });
    return;
  }

  const order = await getOrderByTicket(ticketId);
  if (!order || order.items.length === 0) {
    await interaction.reply({ content: "Commande introuvable ou vide.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  await sendInvoiceForOrder(interaction.client, ticket.guildId, ticket, order);
  await interaction.editReply("Facture renvoyée.");
}

/**
 * Clic sur "Retirer un article" (message de suivi d'une commande) : affiche, en ephemere,
 * un menu deroulant des lignes actuelles de la commande. Reserve aux gestionnaires de la categorie du ticket.
 */
async function handleOrderRemoveItemButton(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isButton()) return;

  const ticket = await getTicketById(ticketId);
  if (!ticket) {
    await interaction.reply({ content: "Commande introuvable.", ephemeral: true });
    return;
  }
  if (!(await isStaffInteraction(interaction, ticket.categoryId))) {
    await interaction.reply({ content: NOT_STAFF_MESSAGE, ephemeral: true });
    return;
  }

  const order = await getOrderByTicket(ticketId);
  if (!order || order.items.length === 0) {
    await interaction.reply({ content: "Aucun article dans cette commande.", ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`order:remove-item-select:${ticketId}`)
    .setPlaceholder("Choisir l'article a retirer")
    .addOptions(
      order.items.slice(0, 25).map((item) => ({
        label: `${item.name} x${item.quantity}`.slice(0, 100),
        description: `${(item.unitPrice * item.quantity).toLocaleString("fr-FR")} $`,
        value: item.id,
      }))
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

/** Selection d'un article a retirer dans le menu deroulant "Retirer un article". Reserve aux gestionnaires de la categorie du ticket. */
async function handleOrderRemoveItemSelect(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isStringSelectMenu()) return;

  const ticket = await getTicketById(ticketId);
  if (!ticket) {
    await interaction.reply({ content: "Commande introuvable.", ephemeral: true });
    return;
  }
  if (!(await isStaffInteraction(interaction, ticket.categoryId))) {
    await interaction.reply({ content: NOT_STAFF_MESSAGE, ephemeral: true });
    return;
  }

  await removeOrderItem(interaction.values[0]);
  await upsertOrderMessage(interaction.client, ticketId);

  await interaction.update({ content: "Article retiré de la commande.", components: [] });
}

/**
 * Clic sur un bouton du message racine du panneau ("Tickets"/"Absences"/"FAQ") : active la
 * fonctionnalite et cree/rafraichit son message dedie dans le meme salon. Pour Absences/FAQ,
 * la Phase A ne pose qu'un message minimal ("bientot disponible") — leur contenu complet
 * (declaration d'absence, gestion FAQ) arrive dans une phase ulterieure.
 */
async function handlePanelRootButton(interaction: Interaction, key: "TICKETS" | "ABSENCES" | "FAQ" | "MONITORING"): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId || !interaction.channelId) return;

  await setPanelEnabled(interaction.guildId, key, true);

  if (key === "TICKETS") {
    await refreshTicketsPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  } else if (key === "ABSENCES") {
    await refreshAbsencesPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  } else if (key === "FAQ") {
    await refreshFaqPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  } else {
    await refreshMonitoringPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  }

  await interaction.reply({ content: "Fonctionnalité activée, voir le message ci-dessus.", ephemeral: true });
}

/** Clic sur "Service client"/"Recrutement" dans le message dedie "Tickets" : messages dedies imbriques (Phase A : placeholder). */
async function handlePanelTicketsNested(interaction: Interaction, key: "SERVICE" | "RECRUITMENT"): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId || !interaction.channelId) return;

  await setPanelEnabled(interaction.guildId, key, true);

  if (key === "SERVICE") {
    await refreshServicePanelMessage(interaction.client, interaction.guildId, interaction.channelId);
    await interaction.reply({ content: "Service client activé, voir le message ci-dessus.", ephemeral: true });
    return;
  }

  await refreshRecruitmentPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.reply({ content: "Recrutement activé, voir le message ci-dessus.", ephemeral: true });
}

/**
 * Clic sur "Ajouter un rôle de gestion" : d'abord choisir le type concerne (au plus 2 —
 * Recrutement/Service — puisqu'un seul mapping existe par type). La valeur transmise reste
 * la `categoryId` (cle technique du `TicketCategoryConfig`), seul le libelle affiche change.
 */
async function handlePanelTicketsAddRole(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId) return;

  const config = await getGuildConfig(interaction.guildId);
  const categories = config?.ticketCategories ?? [];
  if (categories.length === 0) {
    await interaction.reply({ content: "Aucune catégorie configurée, configurez Recrutement ou Service client d'abord.", ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("panel:tickets:add-role-category")
    .setPlaceholder("Choisir un type")
    .addOptions(
      categories.map((c) => ({
        label: c.type === "RECRUITMENT" ? "Recrutement" : "Service client",
        value: c.categoryId,
      }))
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

/** Categorie choisie : menu natif Discord (RoleSelectMenu) pour choisir le role a ajouter. */
async function handlePanelTicketsAddRoleCategory(interaction: Interaction): Promise<void> {
  if (!interaction.isStringSelectMenu()) return;

  const categoryId = interaction.values[0];
  const select = new RoleSelectMenuBuilder().setCustomId(`panel:tickets:add-role-select:${categoryId}`).setPlaceholder("Choisir un rôle");

  const row = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(select);
  await interaction.update({ content: "Quel rôle ajouter comme gestionnaire ?", components: [row] });
}

async function handlePanelTicketsAddRoleSelect(interaction: Interaction, categoryId: string): Promise<void> {
  if (!interaction.isRoleSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  const roleId = interaction.values[0];
  await addCategoryManagerRole(interaction.guildId, categoryId, roleId);
  await refreshTicketsPanelMessage(interaction.client, interaction.guildId, interaction.channelId);

  await interaction.update({ content: `Rôle <@&${roleId}> ajouté comme gestionnaire.`, components: [] });
}

/** Clic sur "Retirer un rôle de gestion" : d'abord choisir le type (ceux qui ont au moins un role). */
async function handlePanelTicketsRemoveRole(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId) return;

  const config = await getGuildConfig(interaction.guildId);
  const categories = (config?.ticketCategories ?? []).filter((c) => c.managerRoleIds.length > 0);
  if (categories.length === 0) {
    await interaction.reply({ content: "Aucun rôle de gestion configuré pour le moment.", ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("panel:tickets:remove-role-category")
    .setPlaceholder("Choisir un type")
    .addOptions(
      categories.map((c) => ({
        label: c.type === "RECRUITMENT" ? "Recrutement" : "Service client",
        value: c.categoryId,
      }))
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

/**
 * Categorie choisie : liste ses roles de gestion actuels sous forme de `StringSelectMenu`
 * (pas de `RoleSelectMenu` ici : on doit filtrer aux roles deja assignes a cette categorie,
 * ce qu'un menu de roles natif ne permet pas — il proposerait tous les roles de la guilde).
 */
async function handlePanelTicketsRemoveRoleCategory(interaction: Interaction): Promise<void> {
  if (!interaction.isStringSelectMenu() || !interaction.guildId || !interaction.guild) return;

  const categoryId = interaction.values[0];
  const config = await getGuildConfig(interaction.guildId);
  const roleIds = config?.ticketCategories.find((c) => c.categoryId === categoryId)?.managerRoleIds ?? [];
  if (roleIds.length === 0) {
    await interaction.update({ content: "Aucun rôle de gestion sur cette catégorie.", components: [] });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`panel:tickets:remove-role-select:${categoryId}`)
    .setPlaceholder("Choisir un rôle à retirer")
    .addOptions(
      roleIds.map((roleId) => ({
        label: (interaction.guild!.roles.cache.get(roleId)?.name ?? roleId).slice(0, 100),
        value: roleId,
      }))
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.update({ content: "Quel rôle retirer ?", components: [row] });
}

async function handlePanelTicketsRemoveRoleSelect(interaction: Interaction, categoryId: string): Promise<void> {
  if (!interaction.isStringSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  const roleId = interaction.values[0];
  await removeCategoryManagerRole(interaction.guildId, categoryId, roleId);
  await refreshTicketsPanelMessage(interaction.client, interaction.guildId, interaction.channelId);

  await interaction.update({ content: "Rôle retiré.", components: [] });
}

/**
 * Soumission du formulaire de declaration : valide les dates (format + coherence), cree la
 * demande, la poste dans le salon de suivi (ping du role approbateur) et confirme au demandeur.
 */
async function handleAbsenceSubmitForm(interaction: Interaction): Promise<void> {
  if (!interaction.isModalSubmit() || !interaction.guildId) return;

  const startRaw = interaction.fields.getTextInputValue("startDate");
  const endRaw = interaction.fields.getTextInputValue("endDate");
  const reason = interaction.fields.getTextInputValue("reason");

  const startDate = parseFrenchDate(startRaw);
  const endDate = parseFrenchDate(endRaw);
  if (!startDate || !endDate) {
    await interaction.reply({ content: "Format de date invalide, attendu JJ/MM/AAAA.", ephemeral: true });
    return;
  }
  if (endDate < startDate) {
    await interaction.reply({ content: "La date de fin ne peut pas être avant la date de début.", ephemeral: true });
    return;
  }

  const request = await createAbsenceRequest(interaction.guildId, interaction.user.id, startDate, endDate, reason);
  const posted = await postAbsenceRequest(interaction.client, interaction.guildId, request);

  await interaction.reply({
    content: posted
      ? `Demande d'absence envoyée (${formatFrenchDate(startDate)} → ${formatFrenchDate(endDate)}), en attente de validation.`
      : "Demande enregistrée, mais le salon de suivi n'est pas configuré ou plus accessible — préviens un administrateur.",
    ephemeral: true,
  });
}

/** Clic sur "Définir le rôle approbateur" : menu natif Discord (RoleSelectMenu). */
async function handlePanelAbsencesSetApproverRole(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;

  const select = new RoleSelectMenuBuilder().setCustomId("panel:absences:set-approver-role-select").setPlaceholder("Choisir un rôle");
  const row = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

async function handlePanelAbsencesSetApproverRoleSelect(interaction: Interaction): Promise<void> {
  if (!interaction.isRoleSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  const roleId = interaction.values[0];
  await setAbsenceApproverRole(interaction.guildId, roleId);
  await refreshAbsencesPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.update({ content: `Rôle approbateur défini sur <@&${roleId}>.`, components: [] });
}

/** Clic sur "Définir le salon de suivi" : menu natif Discord filtre aux salons textuels. */
async function handlePanelAbsencesSetReviewChannel(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;

  const select = new ChannelSelectMenuBuilder()
    .setCustomId("panel:absences:set-review-channel-select")
    .setPlaceholder("Choisir un salon")
    .addChannelTypes(ChannelType.GuildText);
  const row = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

async function handlePanelAbsencesSetReviewChannelSelect(interaction: Interaction): Promise<void> {
  if (!interaction.isChannelSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  const channelId = interaction.values[0];
  await setAbsenceReviewChannel(interaction.guildId, channelId);
  await refreshAbsencesPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.update({ content: `Salon de suivi défini sur <#${channelId}>.`, components: [] });
}

/**
 * Clic sur "Accepter"/"Refuser" du message de suivi d'une demande d'absence : reserve au
 * role approbateur configure (verification directe, pas via `isStaffInteraction` qui est
 * scopee par categorie de ticket — les absences ne sont pas liees a un ticket).
 */
async function handleAbsenceResolve(interaction: Interaction, requestId: string, status: "ACCEPTED" | "REFUSED"): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId || !interaction.member) return;

  const config = await getGuildConfig(interaction.guildId);
  const roles = interaction.member.roles;
  const roleIds = Array.isArray(roles) ? roles : [...roles.cache.keys()];
  if (!isAbsenceApprover(config, roleIds)) {
    await interaction.reply({
      content: "Tu n'as pas les droits suffisants : seul le rôle approbateur configuré peut traiter les demandes d'absence.",
      ephemeral: true,
    });
    return;
  }

  const request = await getAbsenceRequest(requestId);
  if (!request || request.status !== "PENDING") {
    await interaction.reply({ content: "Cette demande a déjà été traitée.", ephemeral: true });
    return;
  }

  await resolveAbsenceRequest(requestId, interaction.user.id, status);
  await refreshAbsenceMessage(interaction.client, requestId);
  await interaction.reply({ content: status === "ACCEPTED" ? "Demande acceptée." : "Demande refusée.", ephemeral: true });
}

/** Clic sur "Définir la catégorie" (Service client) : menu natif Discord pour choisir la catégorie. */
async function handlePanelServiceSetCategory(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;

  const select = new ChannelSelectMenuBuilder()
    .setCustomId("panel:service:set-category-select")
    .setPlaceholder("Choisir une catégorie")
    .addChannelTypes(ChannelType.GuildCategory);
  const row = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

async function handleServiceSetCategorySelect(interaction: Interaction): Promise<void> {
  if (!interaction.isChannelSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  const categoryId = interaction.values[0];
  await setCategoryForType(interaction.guildId, "SERVICE", categoryId);
  await refreshServicePanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.update({ content: `Catégorie définie sur <#${categoryId}>.`, components: [] });
}

/** Clic sur "Retirer la catégorie" (Service client) : retire directement, un seul mapping possible par type. */
async function handlePanelServiceClearCategory(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId || !interaction.channelId) return;

  await clearCategoryForType(interaction.guildId, "SERVICE");
  await refreshServicePanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.reply({ content: "Catégorie retirée.", ephemeral: true });
}

/** Options d'un `StringSelectMenu` listant les articles actifs (tronque a 25 — limite Discord). */
async function buildItemOptions(guildId: string) {
  const items = await listActive(guildId);
  return items.slice(0, 25).map((item) => ({
    label: item.name.slice(0, 100),
    description: `${item.price.toLocaleString("fr-FR")} $`,
    value: item.id,
  }));
}

/** Clic sur "Ajouter un article" : modal (nom, prix, description). La photo se fait ensuite via "Changer la photo". */
async function handlePanelServiceAddItem(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;

  const modal = new ModalBuilder().setCustomId("panel:service:add-item-modal").setTitle("Ajouter un article");
  const nameInput = new TextInputBuilder().setCustomId("name").setLabel("Nom").setStyle(TextInputStyle.Short).setRequired(true);
  const priceInput = new TextInputBuilder().setCustomId("price").setLabel("Prix").setStyle(TextInputStyle.Short).setRequired(true);
  const descriptionInput = new TextInputBuilder()
    .setCustomId("description")
    .setLabel("Description")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(priceInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(descriptionInput)
  );
  await interaction.showModal(modal);
}

async function handleServiceAddItemModal(interaction: Interaction): Promise<void> {
  if (!interaction.isModalSubmit() || !interaction.guildId || !interaction.channelId) return;

  const name = interaction.fields.getTextInputValue("name");
  const priceRaw = interaction.fields.getTextInputValue("price");
  const description = interaction.fields.getTextInputValue("description") || undefined;

  const price = Number(priceRaw);
  if (!Number.isInteger(price) || price < 0) {
    await interaction.reply({ content: "Prix invalide : entre un nombre entier positif.", ephemeral: true });
    return;
  }

  await addItem(interaction.guildId, { name, price, description });
  await refreshServicePanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.reply({
    content: `Article **${name}** créé. Utilise "Changer la photo d'un article" pour lui ajouter une image.`,
    ephemeral: true,
  });
}

/** Clic sur "Retirer un article" : menu natif des articles actifs. */
async function handlePanelServiceRemoveItem(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId) return;

  const options = await buildItemOptions(interaction.guildId);
  if (options.length === 0) {
    await interaction.reply({ content: "Aucun article configuré.", ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder().setCustomId("panel:service:remove-item-select").setPlaceholder("Choisir un article").addOptions(options);
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

async function handleServiceRemoveItemSelect(interaction: Interaction): Promise<void> {
  if (!interaction.isStringSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  await removeCatalogItem(interaction.guildId, interaction.values[0]);
  await refreshServicePanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.update({ content: "Article retiré.", components: [] });
}

/** Clic sur "Changer la photo d'un article" : menu natif des articles actifs. */
async function handlePanelServiceSetImage(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId) return;

  const options = await buildItemOptions(interaction.guildId);
  if (options.length === 0) {
    await interaction.reply({ content: "Aucun article configuré.", ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder().setCustomId("panel:service:set-image-select").setPlaceholder("Choisir un article").addOptions(options);
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

/**
 * Article choisi : attend un message avec piece jointe dans ce salon (60s) — les modals
 * Discord ne supportent pas l'upload de fichier, c'est donc le seul moyen technique de
 * recuperer une image (meme contournement que les pieces jointes de candidature).
 */
async function handleServiceSetImageSelect(interaction: Interaction): Promise<void> {
  if (!interaction.isStringSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  const channel = await interaction.client.channels.fetch(interaction.channelId);
  if (!channel?.isTextBased() || channel.isDMBased()) return;

  const itemId = interaction.values[0];
  await interaction.update({ content: "Envoie la photo de l'article en message dans ce salon (60 secondes)...", components: [] });

  const collected = await channel
    .awaitMessages({
      filter: (m) => m.author.id === interaction.user.id && m.attachments.size > 0,
      max: 1,
      time: 60_000,
    })
    .catch(() => null);

  const photoMessage = collected?.first();
  const attachment = photoMessage?.attachments.first();
  if (!photoMessage || !attachment) {
    await interaction.editReply({ content: "Aucune image reçue à temps, réessaie avec le bouton." });
    return;
  }

  await setItemImage(interaction.guildId, itemId, attachment.url);
  await photoMessage.delete().catch((error: unknown) => logger.warn("Echec suppression du message photo dans le panneau", error));
  await refreshServicePanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.editReply({ content: "Photo mise à jour." });
}

/** Clic sur "Ajouter un champ" : d'abord choisir l'article concerne. */
async function handlePanelServiceAddField(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId) return;

  const options = await buildItemOptions(interaction.guildId);
  if (options.length === 0) {
    await interaction.reply({ content: "Aucun article configuré, ajoutez-en un d'abord.", ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder().setCustomId("panel:service:add-field-item").setPlaceholder("Choisir un article").addOptions(options);
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

/** Article choisi : ensuite le type de champ (texte court/long/quantité). */
async function handleServiceAddFieldItem(interaction: Interaction): Promise<void> {
  if (!interaction.isStringSelectMenu()) return;

  const itemId = interaction.values[0];
  const select = new StringSelectMenuBuilder()
    .setCustomId(`panel:service:add-field-style:${itemId}`)
    .setPlaceholder("Choisir un type")
    .addOptions(
      { label: "Texte court", value: "SHORT" },
      { label: "Texte long", value: "PARAGRAPH" },
      { label: "Quantité", value: "QUANTITY" }
    );
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.update({ content: "Quel type de champ ?", components: [row] });
}

/** Type choisi : modal pour l'intitule et si le champ est obligatoire. */
async function handleServiceAddFieldStyle(interaction: Interaction, itemId: string): Promise<void> {
  if (!interaction.isStringSelectMenu()) return;

  const style = interaction.values[0];
  const modal = new ModalBuilder().setCustomId(`panel:service:add-field-modal:${itemId}:${style}`).setTitle("Ajouter un champ");
  const labelInput = new TextInputBuilder().setCustomId("label").setLabel("Intitulé du champ").setStyle(TextInputStyle.Short).setRequired(true);
  const requiredInput = new TextInputBuilder()
    .setCustomId("required")
    .setLabel("Obligatoire ? (oui/non, par défaut oui)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(labelInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(requiredInput)
  );
  await interaction.showModal(modal);
}

async function handleServiceAddFieldModal(interaction: Interaction, itemId: string, style: string): Promise<void> {
  if (!interaction.isModalSubmit() || !interaction.guildId || !interaction.channelId) return;

  const label = interaction.fields.getTextInputValue("label");
  const required = interaction.fields.getTextInputValue("required").trim().toLowerCase() !== "non";

  try {
    // addField valide les regles metier (max 5 champs, au plus un QUANTITY) et leve une
    // Error au message deja redige pour l'utilisateur : on le relaie tel quel.
    await addField(interaction.guildId, itemId, { label, style: style as "SHORT" | "PARAGRAPH" | "QUANTITY", required });
    await refreshServicePanelMessage(interaction.client, interaction.guildId, interaction.channelId);
    await interaction.reply({ content: `Champ ajouté : **${label}**`, ephemeral: true });
  } catch (error) {
    await interaction.reply({ content: error instanceof Error ? error.message : "Erreur.", ephemeral: true });
  }
}

/** Clic sur "Retirer un champ" : d'abord choisir l'article (ceux qui ont au moins un champ). */
async function handlePanelServiceRemoveField(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId) return;

  const items = (await listActiveWithFields(interaction.guildId)).filter((i) => i.fields.length > 0);
  if (items.length === 0) {
    await interaction.reply({ content: "Aucun champ configuré pour le moment.", ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("panel:service:remove-field-item")
    .setPlaceholder("Choisir un article")
    .addOptions(items.slice(0, 25).map((i) => ({ label: i.name.slice(0, 100), value: i.id })));
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

/** Article choisi : liste ses champs sous forme de `StringSelectMenu`. */
async function handleServiceRemoveFieldItem(interaction: Interaction): Promise<void> {
  if (!interaction.isStringSelectMenu() || !interaction.guildId) return;

  const item = await getItem(interaction.guildId, interaction.values[0]);
  if (!item || item.fields.length === 0) {
    await interaction.update({ content: "Aucun champ sur cet article.", components: [] });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("panel:service:remove-field-select")
    .setPlaceholder("Choisir un champ à retirer")
    .addOptions(item.fields.map((f) => ({ label: `${f.label} (${f.style})`.slice(0, 100), value: f.id })));
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.update({ content: "Quel champ retirer ?", components: [row] });
}

async function handleServiceRemoveFieldSelect(interaction: Interaction): Promise<void> {
  if (!interaction.isStringSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  await removeField(interaction.guildId, interaction.values[0]);
  await refreshServicePanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.update({ content: "Champ retiré.", components: [] });
}

/** Clic sur "Définir la catégorie" (Recrutement) : menu natif Discord pour choisir la catégorie. */
async function handlePanelRecruitmentSetCategory(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;

  const select = new ChannelSelectMenuBuilder()
    .setCustomId("panel:recruitment:set-category-select")
    .setPlaceholder("Choisir une catégorie")
    .addChannelTypes(ChannelType.GuildCategory);
  const row = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

async function handleRecruitmentSetCategorySelect(interaction: Interaction): Promise<void> {
  if (!interaction.isChannelSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  const categoryId = interaction.values[0];
  await setCategoryForType(interaction.guildId, "RECRUITMENT", categoryId);
  await refreshRecruitmentPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.update({ content: `Catégorie définie sur <#${categoryId}>.`, components: [] });
}

/** Clic sur "Retirer la catégorie" (Recrutement) : retire directement, un seul mapping possible par type. */
async function handlePanelRecruitmentClearCategory(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId || !interaction.channelId) return;

  await clearCategoryForType(interaction.guildId, "RECRUITMENT");
  await refreshRecruitmentPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.reply({ content: "Catégorie retirée.", ephemeral: true });
}

/** Clic sur le bouton (libelle dynamique) : bascule l'etat ouvert/ferme des recrutements. Remplace `/recruitment status`. */
async function handlePanelRecruitmentToggle(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId || !interaction.channelId) return;

  const config = await getGuildConfig(interaction.guildId);
  const nextOpen = !(config?.recruitmentOpen ?? true);
  await setRecruitmentOpen(interaction.guildId, nextOpen);
  await refreshRecruitmentPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.reply({
    content: nextOpen
      ? "Recrutements ouverts : les nouveaux tickets affichent le formulaire de candidature."
      : "Recrutements fermés : les nouveaux tickets afficheront un message \"fermé\" au lieu du formulaire.",
    ephemeral: true,
  });
}

/** Clic sur "Ajouter une question" : d'abord choisir le type de champ (court/long). */
async function handlePanelRecruitmentAddQuestion(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;

  const select = new StringSelectMenuBuilder()
    .setCustomId("panel:recruitment:add-question-style")
    .setPlaceholder("Choisir un type")
    .addOptions({ label: "Texte court", value: "SHORT" }, { label: "Texte long", value: "PARAGRAPH" });
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

/** Type choisi : modal pour l'intitule de la question. */
async function handleRecruitmentAddQuestionStyle(interaction: Interaction): Promise<void> {
  if (!interaction.isStringSelectMenu()) return;

  const style = interaction.values[0];
  const modal = new ModalBuilder().setCustomId(`panel:recruitment:add-question-modal:${style}`).setTitle("Ajouter une question");
  const labelInput = new TextInputBuilder().setCustomId("label").setLabel("Intitulé de la question").setStyle(TextInputStyle.Short).setRequired(true);
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(labelInput));
  await interaction.showModal(modal);
}

async function handleRecruitmentAddQuestionModal(interaction: Interaction, style: string): Promise<void> {
  if (!interaction.isModalSubmit() || !interaction.guildId || !interaction.channelId) return;

  const label = interaction.fields.getTextInputValue("label");

  try {
    // addQuestion valide la limite (5 max, contrainte Discord) et leve une Error au message
    // deja redige pour l'utilisateur : on le relaie tel quel.
    await addRecruitmentQuestion(interaction.guildId, label, style as "SHORT" | "PARAGRAPH");
    await refreshRecruitmentPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
    await interaction.reply({ content: `Question ajoutée : **${label}**`, ephemeral: true });
  } catch (error) {
    await interaction.reply({ content: error instanceof Error ? error.message : "Erreur.", ephemeral: true });
  }
}

/** Clic sur "Retirer une question" : menu natif des questions configurees (aucune = repli sur les questions par defaut, rien a retirer). */
async function handlePanelRecruitmentRemoveQuestion(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId) return;

  const questions = await listRecruitmentQuestions(interaction.guildId);
  if (questions.length === 0) {
    await interaction.reply({
      content: "Aucune question personnalisée configurée — le formulaire par défaut (5 questions) est utilisé.",
      ephemeral: true,
    });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("panel:recruitment:remove-question-select")
    .setPlaceholder("Choisir une question à retirer")
    .addOptions(questions.map((q) => ({ label: q.label.slice(0, 100), value: q.id })));
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

async function handleRecruitmentRemoveQuestionSelect(interaction: Interaction): Promise<void> {
  if (!interaction.isStringSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  await removeRecruitmentQuestion(interaction.guildId, interaction.values[0]);
  await refreshRecruitmentPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.update({ content: "Question retirée.", components: [] });
}


/** Clic sur "Ajouter une règle" : modal (mot-clé, réponse). */
async function handlePanelFaqAddRule(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;

  const modal = new ModalBuilder().setCustomId("panel:faq:add-rule-modal").setTitle("Ajouter une règle");
  const triggerInput = new TextInputBuilder().setCustomId("trigger").setLabel("Mot-clé déclencheur").setStyle(TextInputStyle.Short).setRequired(true);
  const responseInput = new TextInputBuilder()
    .setCustomId("response")
    .setLabel("Réponse envoyée")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true);
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(triggerInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(responseInput)
  );
  await interaction.showModal(modal);
}

async function handleFaqAddRuleModal(interaction: Interaction): Promise<void> {
  if (!interaction.isModalSubmit() || !interaction.guildId || !interaction.channelId) return;

  const trigger = interaction.fields.getTextInputValue("trigger");
  const response = interaction.fields.getTextInputValue("response");

  await addFaqRule(interaction.guildId, trigger, response);
  await refreshFaqPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.reply({ content: `Règle ajoutée : **${trigger}**`, ephemeral: true });
}

/** Clic sur "Retirer une règle" : menu natif des règles configurées. */
async function handlePanelFaqRemoveRule(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId) return;

  const rules = await listFaqRules(interaction.guildId);
  if (rules.length === 0) {
    await interaction.reply({ content: "Aucune règle configurée.", ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("panel:faq:remove-rule-select")
    .setPlaceholder("Choisir une règle à retirer")
    .addOptions(rules.slice(0, 25).map((r) => ({ label: r.trigger.slice(0, 100), value: r.id })));
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

async function handleFaqRemoveRuleSelect(interaction: Interaction): Promise<void> {
  if (!interaction.isStringSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  await removeFaqRule(interaction.guildId, interaction.values[0]);
  await refreshFaqPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.update({ content: "Règle retirée.", components: [] });
}

/** Clic sur "Définir l'entreprise (jobId)" : modal (texte libre, pas d'entite Discord a selectionner). */
async function handlePanelMonitoringSetJobId(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;

  const modal = new ModalBuilder().setCustomId("panel:monitoring:set-job-id-modal").setTitle("Définir l'entreprise");
  const jobIdInput = new TextInputBuilder()
    .setCustomId("jobId")
    .setLabel("jobId (identifiant côté script FiveM)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(jobIdInput));
  await interaction.showModal(modal);
}

async function handleMonitoringSetJobIdModal(interaction: Interaction): Promise<void> {
  if (!interaction.isModalSubmit() || !interaction.guildId || !interaction.channelId) return;

  const jobId = interaction.fields.getTextInputValue("jobId").trim();
  await setMonitoringJobId(interaction.guildId, jobId);
  await refreshMonitoringPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.reply({ content: `Entreprise définie sur jobId \`${jobId}\`.`, ephemeral: true });
}

/** Clic sur "Définir le rôle en service" : menu natif Discord (RoleSelectMenu). */
async function handlePanelMonitoringSetOnDutyRole(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;

  const select = new RoleSelectMenuBuilder().setCustomId("panel:monitoring:set-on-duty-role-select").setPlaceholder("Choisir un rôle");
  const row = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

async function handleMonitoringSetOnDutyRoleSelect(interaction: Interaction): Promise<void> {
  if (!interaction.isRoleSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  const roleId = interaction.values[0];
  await setOnDutyRole(interaction.guildId, roleId);
  await refreshMonitoringPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.update({ content: `Rôle "en service" défini sur <@&${roleId}>.`, components: [] });
}

/** Clic sur "Salon <type>" : menu natif Discord pour choisir le salon webhook a surveiller. */
async function handlePanelMonitoringSetChannel(interaction: Interaction, type: MonitoringLogType): Promise<void> {
  if (!interaction.isButton()) return;

  const select = new ChannelSelectMenuBuilder()
    .setCustomId(`panel:monitoring:set-channel-select:${type}`)
    .setPlaceholder("Choisir un salon")
    .addChannelTypes(ChannelType.GuildText);
  const row = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

async function handleMonitoringSetChannelSelect(interaction: Interaction, type: MonitoringLogType): Promise<void> {
  if (!interaction.isChannelSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  const channelId = interaction.values[0];
  await setMonitoringChannel(interaction.guildId, type, channelId);
  await refreshMonitoringPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.update({ content: `Salon ${MONITORING_TYPE_LABELS[type]} défini sur <#${channelId}>.`, components: [] });
}

/** Clic sur "Retirer salon <type>" : retire directement, un seul salon possible par type. */
async function handlePanelMonitoringClearChannel(interaction: Interaction, type: MonitoringLogType): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId || !interaction.channelId) return;

  await clearMonitoringChannel(interaction.guildId, type);
  await refreshMonitoringPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.reply({ content: `Salon ${MONITORING_TYPE_LABELS[type]} retiré.`, ephemeral: true });
}

/** Clic sur "Ajouter un webhook" : d'abord choisir le type d'evenement concerne. */
async function handlePanelMonitoringAddWebhook(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;

  const options = MONITORING_WEBHOOK_EVENT_TYPES.map((eventType) => {
    const type = eventType.replace("monitoring.", "").toUpperCase() as MonitoringLogType;
    return { label: MONITORING_TYPE_LABELS[type], value: eventType };
  });
  const select = new StringSelectMenuBuilder().setCustomId("panel:monitoring:add-webhook-type").setPlaceholder("Choisir un type").addOptions(options);
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

/** Type choisi : modal pour l'URL de destination. */
async function handleMonitoringAddWebhookType(interaction: Interaction): Promise<void> {
  if (!interaction.isStringSelectMenu()) return;

  const eventType = interaction.values[0];
  const modal = new ModalBuilder().setCustomId(`panel:monitoring:add-webhook-modal:${eventType}`).setTitle("Ajouter un webhook");
  const urlInput = new TextInputBuilder().setCustomId("url").setLabel("URL de destination").setStyle(TextInputStyle.Short).setRequired(true);
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(urlInput));
  await interaction.showModal(modal);
}

/**
 * Soumission de l'URL : cree l'abonnement et affiche le secret en clair — dernière fois qu'il
 * sera visible, il sert a l'externe pour verifier la signature HMAC des POST recus.
 */
async function handleMonitoringAddWebhookModal(interaction: Interaction, eventType: string): Promise<void> {
  if (!interaction.isModalSubmit() || !interaction.guildId || !interaction.channelId) return;

  const url = interaction.fields.getTextInputValue("url").trim();
  const { secret } = await createSubscription(interaction.guildId, eventType as WebhookEventType, url);
  await refreshMonitoringPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.reply({
    content:
      `Webhook \`${eventType}\` ajouté vers ${url}.\n` +
      `Secret de signature (header \`X-Signature-256\`, HMAC-SHA256) — **note-le, il ne sera plus jamais affiché** :\n\`${secret}\``,
    ephemeral: true,
  });
}

/** Clic sur "Retirer un webhook" : menu natif des abonnements existants. */
async function handlePanelMonitoringRemoveWebhook(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() || !interaction.guildId) return;

  const subscriptions = await listSubscriptions(interaction.guildId);
  if (subscriptions.length === 0) {
    await interaction.reply({ content: "Aucun webhook configuré.", ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("panel:monitoring:remove-webhook-select")
    .setPlaceholder("Choisir un webhook à retirer")
    .addOptions(subscriptions.slice(0, 25).map((s) => ({ label: `${s.eventType} — ${s.url}`.slice(0, 100), value: s.id })));
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ components: [row], ephemeral: true });
}

async function handleMonitoringRemoveWebhookSelect(interaction: Interaction): Promise<void> {
  if (!interaction.isStringSelectMenu() || !interaction.guildId || !interaction.channelId) return;

  await removeSubscription(interaction.guildId, interaction.values[0]);
  await refreshMonitoringPanelMessage(interaction.client, interaction.guildId, interaction.channelId);
  await interaction.update({ content: "Webhook retiré.", components: [] });
}

/**
 * Handler de l'evenement `interactionCreate`. Aiguille par type d'interaction puis par
 * `customId` vers le handler correspondant ci-dessus. Les customId parametres (contenant
 * un id de ticket, de catalogue ou de categorie) utilisent un prefixe fixe suivi de `:<id>`,
 * extrait via `startsWith`/`slice` — Discord ne permet pas de passer d'etat structure entre
 * l'affichage d'un composant et l'interaction qui le declenche, seulement une chaine de 100
 * caracteres max. Toute exception non geree par un handler est capturee ici (log + reponse
 * d'erreur generique) pour eviter qu'une interaction Discord ne reste "en attente"
 * indefiniment cote client si le bot plante en cours de traitement.
 */
export async function onInteractionCreate(interaction: Interaction): Promise<void> {
  try {
    if (interaction.isChatInputCommand()) {
      await handleChatInputCommand(interaction);
      return;
    }

    if (interaction.isAutocomplete()) {
      const command = commandsByName.get(interaction.commandName);
      await command?.autocomplete?.(interaction);
      return;
    }

    if (interaction.isButton()) {
      if (interaction.customId === "recruitment:start-form") return await handleRecruitmentStartForm(interaction);
      if (interaction.customId.startsWith("recruitment:assign:")) {
        return await handleRecruitmentAssign(interaction, interaction.customId.slice("recruitment:assign:".length));
      }
      if (interaction.customId.startsWith("recruitment:status:")) {
        return await handleRecruitmentStatusButton(interaction, interaction.customId.slice("recruitment:status:".length));
      }
      if (interaction.customId === "order:add-more") return await handleOrderAddMore(interaction);
      if (interaction.customId === "order:confirm") return await handleOrderConfirm(interaction);
      if (interaction.customId.startsWith("order:status:")) {
        return await handleOrderStatusButton(interaction, interaction.customId.slice("order:status:".length));
      }
      if (interaction.customId.startsWith("order:mark-paid:")) {
        return await handleOrderMarkPaid(interaction, interaction.customId.slice("order:mark-paid:".length));
      }
      if (interaction.customId.startsWith("order:invoice:")) {
        return await handleOrderInvoiceButton(interaction, interaction.customId.slice("order:invoice:".length));
      }
      if (interaction.customId.startsWith("order:remove-item:")) {
        return await handleOrderRemoveItemButton(interaction, interaction.customId.slice("order:remove-item:".length));
      }
      if (interaction.customId === "panel:root:tickets") return await handlePanelRootButton(interaction, "TICKETS");
      if (interaction.customId === "panel:root:absences") return await handlePanelRootButton(interaction, "ABSENCES");
      if (interaction.customId === "panel:root:faq") return await handlePanelRootButton(interaction, "FAQ");
      if (interaction.customId === "panel:root:monitoring") return await handlePanelRootButton(interaction, "MONITORING");
      if (interaction.customId === "panel:tickets:service") return await handlePanelTicketsNested(interaction, "SERVICE");
      if (interaction.customId === "panel:tickets:recruitment") return await handlePanelTicketsNested(interaction, "RECRUITMENT");
      if (interaction.customId === "panel:tickets:add-role") return await handlePanelTicketsAddRole(interaction);
      if (interaction.customId === "panel:tickets:remove-role") return await handlePanelTicketsRemoveRole(interaction);
      if (interaction.customId === "panel:absences:set-approver-role") return await handlePanelAbsencesSetApproverRole(interaction);
      if (interaction.customId === "panel:absences:set-review-channel") return await handlePanelAbsencesSetReviewChannel(interaction);
      if (interaction.customId.startsWith("absence:accept:")) {
        return await handleAbsenceResolve(interaction, interaction.customId.slice("absence:accept:".length), "ACCEPTED");
      }
      if (interaction.customId.startsWith("absence:refuse:")) {
        return await handleAbsenceResolve(interaction, interaction.customId.slice("absence:refuse:".length), "REFUSED");
      }
      if (interaction.customId === "panel:service:set-category") return await handlePanelServiceSetCategory(interaction);
      if (interaction.customId === "panel:service:clear-category") return await handlePanelServiceClearCategory(interaction);
      if (interaction.customId === "panel:service:add-item") return await handlePanelServiceAddItem(interaction);
      if (interaction.customId === "panel:service:remove-item") return await handlePanelServiceRemoveItem(interaction);
      if (interaction.customId === "panel:service:set-image") return await handlePanelServiceSetImage(interaction);
      if (interaction.customId === "panel:service:add-field") return await handlePanelServiceAddField(interaction);
      if (interaction.customId === "panel:service:remove-field") return await handlePanelServiceRemoveField(interaction);
      if (interaction.customId === "panel:recruitment:set-category") return await handlePanelRecruitmentSetCategory(interaction);
      if (interaction.customId === "panel:recruitment:clear-category") return await handlePanelRecruitmentClearCategory(interaction);
      if (interaction.customId === "panel:recruitment:toggle") return await handlePanelRecruitmentToggle(interaction);
      if (interaction.customId === "panel:recruitment:add-question") return await handlePanelRecruitmentAddQuestion(interaction);
      if (interaction.customId === "panel:recruitment:remove-question") return await handlePanelRecruitmentRemoveQuestion(interaction);
      if (interaction.customId === "panel:faq:add-rule") return await handlePanelFaqAddRule(interaction);
      if (interaction.customId === "panel:faq:remove-rule") return await handlePanelFaqRemoveRule(interaction);
      if (interaction.customId === "panel:monitoring:set-job-id") return await handlePanelMonitoringSetJobId(interaction);
      if (interaction.customId === "panel:monitoring:set-on-duty-role") return await handlePanelMonitoringSetOnDutyRole(interaction);
      if (interaction.customId.startsWith("panel:monitoring:set-channel:")) {
        return await handlePanelMonitoringSetChannel(
          interaction,
          interaction.customId.slice("panel:monitoring:set-channel:".length) as MonitoringLogType
        );
      }
      if (interaction.customId.startsWith("panel:monitoring:clear-channel:")) {
        return await handlePanelMonitoringClearChannel(
          interaction,
          interaction.customId.slice("panel:monitoring:clear-channel:".length) as MonitoringLogType
        );
      }
      if (interaction.customId === "panel:monitoring:add-webhook") return await handlePanelMonitoringAddWebhook(interaction);
      if (interaction.customId === "panel:monitoring:remove-webhook") return await handlePanelMonitoringRemoveWebhook(interaction);
      return;
    }

    if (interaction.isChannelSelectMenu()) {
      if (interaction.customId === "panel:service:set-category-select") return await handleServiceSetCategorySelect(interaction);
      if (interaction.customId === "panel:recruitment:set-category-select") return await handleRecruitmentSetCategorySelect(interaction);
      if (interaction.customId === "panel:absences:set-review-channel-select") return await handlePanelAbsencesSetReviewChannelSelect(interaction);
      if (interaction.customId.startsWith("panel:monitoring:set-channel-select:")) {
        return await handleMonitoringSetChannelSelect(
          interaction,
          interaction.customId.slice("panel:monitoring:set-channel-select:".length) as MonitoringLogType
        );
      }
      return;
    }

    if (interaction.isRoleSelectMenu()) {
      if (interaction.customId.startsWith("panel:tickets:add-role-select:")) {
        return await handlePanelTicketsAddRoleSelect(interaction, interaction.customId.slice("panel:tickets:add-role-select:".length));
      }
      if (interaction.customId === "panel:absences:set-approver-role-select") return await handlePanelAbsencesSetApproverRoleSelect(interaction);
      if (interaction.customId === "panel:monitoring:set-on-duty-role-select") return await handleMonitoringSetOnDutyRoleSelect(interaction);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === "order:select-item") return await handleOrderSelectItem(interaction);
      if (interaction.customId.startsWith("recruitment:set-status:")) {
        return await handleRecruitmentSetStatus(interaction, interaction.customId.slice("recruitment:set-status:".length));
      }
      if (interaction.customId.startsWith("order:set-status:")) {
        return await handleOrderSetStatus(interaction, interaction.customId.slice("order:set-status:".length));
      }
      if (interaction.customId.startsWith("order:remove-item-select:")) {
        return await handleOrderRemoveItemSelect(interaction, interaction.customId.slice("order:remove-item-select:".length));
      }
      if (interaction.customId === "panel:tickets:add-role-category") return await handlePanelTicketsAddRoleCategory(interaction);
      if (interaction.customId === "panel:tickets:remove-role-category") return await handlePanelTicketsRemoveRoleCategory(interaction);
      if (interaction.customId.startsWith("panel:tickets:remove-role-select:")) {
        return await handlePanelTicketsRemoveRoleSelect(interaction, interaction.customId.slice("panel:tickets:remove-role-select:".length));
      }
      if (interaction.customId === "panel:service:remove-item-select") return await handleServiceRemoveItemSelect(interaction);
      if (interaction.customId === "panel:service:set-image-select") return await handleServiceSetImageSelect(interaction);
      if (interaction.customId === "panel:service:add-field-item") return await handleServiceAddFieldItem(interaction);
      if (interaction.customId.startsWith("panel:service:add-field-style:")) {
        return await handleServiceAddFieldStyle(interaction, interaction.customId.slice("panel:service:add-field-style:".length));
      }
      if (interaction.customId === "panel:service:remove-field-item") return await handleServiceRemoveFieldItem(interaction);
      if (interaction.customId === "panel:service:remove-field-select") return await handleServiceRemoveFieldSelect(interaction);
      if (interaction.customId === "panel:recruitment:add-question-style") return await handleRecruitmentAddQuestionStyle(interaction);
      if (interaction.customId === "panel:recruitment:remove-question-select") return await handleRecruitmentRemoveQuestionSelect(interaction);
      if (interaction.customId === "panel:faq:remove-rule-select") return await handleFaqRemoveRuleSelect(interaction);
      if (interaction.customId === "panel:monitoring:add-webhook-type") return await handleMonitoringAddWebhookType(interaction);
      if (interaction.customId === "panel:monitoring:remove-webhook-select") return await handleMonitoringRemoveWebhookSelect(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === "recruitment:submit-form") return await handleRecruitmentSubmitForm(interaction);
      if (interaction.customId === "absence:submit-form") return await handleAbsenceSubmitForm(interaction);
      if (interaction.customId === "panel:service:add-item-modal") return await handleServiceAddItemModal(interaction);
      if (interaction.customId.startsWith("panel:service:add-field-modal:")) {
        const [itemId, style] = interaction.customId.slice("panel:service:add-field-modal:".length).split(":");
        return await handleServiceAddFieldModal(interaction, itemId, style);
      }
      if (interaction.customId.startsWith("panel:recruitment:add-question-modal:")) {
        return await handleRecruitmentAddQuestionModal(interaction, interaction.customId.slice("panel:recruitment:add-question-modal:".length));
      }
      if (interaction.customId === "panel:faq:add-rule-modal") return await handleFaqAddRuleModal(interaction);
      if (interaction.customId === "panel:monitoring:set-job-id-modal") return await handleMonitoringSetJobIdModal(interaction);
      if (interaction.customId.startsWith("panel:monitoring:add-webhook-modal:")) {
        return await handleMonitoringAddWebhookModal(interaction, interaction.customId.slice("panel:monitoring:add-webhook-modal:".length));
      }
      if (interaction.customId.startsWith("order:submit-item:")) {
        const catalogItemId = interaction.customId.slice("order:submit-item:".length);
        return await handleOrderSubmitItem(interaction, catalogItemId);
      }
    }
  } catch (error) {
    logger.error("Erreur lors du traitement d'une interaction", error);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "Une erreur est survenue.", ephemeral: true }).catch(() => undefined);
    }
  }
}
