import {
  ActionRowBuilder,
  ModalBuilder,
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
import { getItem, listActive } from "../services/catalogService.js";
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
 *   "order:submit-item:<catalogItemId>" -> boutons "order:add-more" / "order:confirm", puis
 *   pilotage staff par boutons "order:status:<ticketId>" / "order:mark-paid:<ticketId>" /
 *   "order:invoice:<ticketId>" / "order:remove-item:<ticketId>"
 */

/** Questions fixes du formulaire de candidature (limite Discord : 5 champs max par modal). */
const RECRUITMENT_QUESTIONS = ["Nom RP", "Âge", "Expérience RP", "Disponibilités", "Motivation"];

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
 * Message affiche quand `isStaffInteraction` refuse un clic. Explicite la cause (droits
 * insuffisants, pas juste "ca ne marche pas") et l'action corrective, pour ne pas laisser
 * un admin de test se demander pourquoi ses propres boutons ne repondent pas.
 */
const NOT_STAFF_MESSAGE =
  "Tu n'as pas les droits suffisants pour cette action : elle est réservée au staff. " +
  "Demande à un administrateur de t'ajouter un rôle staff avec `/config set-staff-role`.";

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
 * si configure, sinon dans le salon du ticket lui-meme. Le candidat recoit une confirmation
 * qui l'invite aussi a envoyer d'eventuelles pieces jointes directement en message dans le
 * salon (les modals Discord ne supportent pas l'upload de fichier).
 */
async function handleRecruitmentSubmitForm(interaction: Interaction): Promise<void> {
  if (!interaction.isModalSubmit() || !interaction.channelId) return;

  const ticket = await getTicketByChannel(interaction.channelId);
  if (!ticket || ticket.type !== "RECRUITMENT") {
    await interaction.reply({ content: "Ce salon n'est pas rattaché à une candidature.", ephemeral: true });
    return;
  }

  const answers = RECRUITMENT_QUESTIONS.map((question, index) => ({
    question,
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
 * puis met a jour le message de suivi. Reserve au staff.
 */
async function handleRecruitmentAssign(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isButton()) return;

  if (!(await isStaffInteraction(interaction))) {
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
 * au staff.
 */
async function handleRecruitmentStatusButton(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isButton()) return;

  if (!(await isStaffInteraction(interaction))) {
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

  if (!(await isStaffInteraction(interaction))) {
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
 * le message de commande vers son style "suivi" (boutons staff) et ping les roles staff
 * configures separement (un `content` modifie par edition ne notifie personne sur Discord,
 * contrairement a un nouveau message). Refuse si la commande est vide.
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
  const mentions = (config?.staffRoleIds ?? []).map((roleId) => `<@&${roleId}>`).join(" ");
  if (interaction.channel?.isTextBased() && !interaction.channel.isDMBased()) {
    await interaction.channel.send(mentions ? `${mentions} Nouvelle commande à traiter.` : "Nouvelle commande à traiter.");
  }
  await interaction.reply({ content: "Commande validée, le staff a été notifié.", ephemeral: true });
}

/**
 * Clic sur "Statut" (message de suivi d'une commande) : affiche, en ephemere, un menu
 * deroulant des 4 statuts logistiques. Reserve au staff.
 */
async function handleOrderStatusButton(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isButton()) return;

  if (!(await isStaffInteraction(interaction))) {
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

/** Selection d'un statut dans le menu deroulant "Statut" d'une commande. Reserve au staff. */
async function handleOrderSetStatus(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isStringSelectMenu()) return;

  if (!(await isStaffInteraction(interaction))) {
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
 * et genere/poste automatiquement la facture. Reserve au staff. `deferReply` : le rendu de
 * l'image (canvas) + son upload peuvent depasser le delai de 3s avant lequel Discord attend
 * une premiere reponse a l'interaction.
 */
async function handleOrderMarkPaid(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isButton()) return;

  if (!(await isStaffInteraction(interaction))) {
    await interaction.reply({ content: NOT_STAFF_MESSAGE, ephemeral: true });
    return;
  }

  const ticket = await getTicketById(ticketId);
  const order = await getOrderByTicket(ticketId);
  if (!ticket || !order || order.items.length === 0) {
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
 * facture sans changer le statut de paiement. Reserve au staff.
 */
async function handleOrderInvoiceButton(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isButton()) return;

  if (!(await isStaffInteraction(interaction))) {
    await interaction.reply({ content: NOT_STAFF_MESSAGE, ephemeral: true });
    return;
  }

  const ticket = await getTicketById(ticketId);
  const order = await getOrderByTicket(ticketId);
  if (!ticket || !order || order.items.length === 0) {
    await interaction.reply({ content: "Commande introuvable ou vide.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  await sendInvoiceForOrder(interaction.client, ticket.guildId, ticket, order);
  await interaction.editReply("Facture renvoyée.");
}

/**
 * Clic sur "Retirer un article" (message de suivi d'une commande) : affiche, en ephemere,
 * un menu deroulant des lignes actuelles de la commande. Reserve au staff.
 */
async function handleOrderRemoveItemButton(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isButton()) return;

  if (!(await isStaffInteraction(interaction))) {
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

/** Selection d'un article a retirer dans le menu deroulant "Retirer un article". Reserve au staff. */
async function handleOrderRemoveItemSelect(interaction: Interaction, ticketId: string): Promise<void> {
  if (!interaction.isStringSelectMenu()) return;

  if (!(await isStaffInteraction(interaction))) {
    await interaction.reply({ content: NOT_STAFF_MESSAGE, ephemeral: true });
    return;
  }

  await removeOrderItem(interaction.values[0]);
  await upsertOrderMessage(interaction.client, ticketId);

  await interaction.update({ content: "Article retiré de la commande.", components: [] });
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

    if (interaction.isAutocomplete()) {
      const command = commandsByName.get(interaction.commandName);
      await command?.autocomplete?.(interaction);
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
      if (interaction.customId.startsWith("order:status:")) {
        return handleOrderStatusButton(interaction, interaction.customId.slice("order:status:".length));
      }
      if (interaction.customId.startsWith("order:mark-paid:")) {
        return handleOrderMarkPaid(interaction, interaction.customId.slice("order:mark-paid:".length));
      }
      if (interaction.customId.startsWith("order:invoice:")) {
        return handleOrderInvoiceButton(interaction, interaction.customId.slice("order:invoice:".length));
      }
      if (interaction.customId.startsWith("order:remove-item:")) {
        return handleOrderRemoveItemButton(interaction, interaction.customId.slice("order:remove-item:".length));
      }
      return;
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === "order:select-item") return handleOrderSelectItem(interaction);
      if (interaction.customId.startsWith("recruitment:set-status:")) {
        return handleRecruitmentSetStatus(interaction, interaction.customId.slice("recruitment:set-status:".length));
      }
      if (interaction.customId.startsWith("order:set-status:")) {
        return handleOrderSetStatus(interaction, interaction.customId.slice("order:set-status:".length));
      }
      if (interaction.customId.startsWith("order:remove-item-select:")) {
        return handleOrderRemoveItemSelect(interaction, interaction.customId.slice("order:remove-item-select:".length));
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
