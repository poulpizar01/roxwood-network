import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type Client } from "discord.js";
import type { MonitoringLogType, PanelMessageKey } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { getGuildConfig } from "./guildConfigService.js";
import { listActiveWithFields } from "./catalogService.js";
import { listQuestions } from "./recruitmentQuestionService.js";
import { listRules } from "./autoReplyService.js";
import { listSubscriptions } from "./webhookSubscriptionService.js";
import { logger } from "../utils/logger.js";

/**
 * Panneau d'administration : messages permanents (avec boutons/menus) postes dans un salon
 * designe par la guilde (`GuildConfig.panelChannelId`), edites en place a chaque changement
 * plutot que reposte — meme principe que `recruitmentLogService`/`orderLogService`, generalise
 * a plusieurs messages distincts identifies par une cle (`PanelMessageKey`).
 */

/**
 * Reaction posee automatiquement sur chaque message dedie (tout sauf ROOT) pour permettre de
 * le supprimer manuellement (voir `messageReactionAdd.ts`). Le message racine ne la porte
 * jamais : c'est le seul point d'entree vers tout le reste du panneau, il ne doit pas pouvoir
 * etre supprime par erreur via la reaction.
 */
export const PANEL_DELETE_EMOJI = "🗑️";

/** Recupere l'enregistrement d'un message du panneau (id du message Discord, active ou non). */
export async function getPanelMessage(guildId: string, key: PanelMessageKey) {
  return prisma.panelMessage.findUnique({ where: { guildId_key: { guildId, key } } });
}

/** Retrouve l'enregistrement du panneau correspondant a un message Discord donne, si c'en est un. */
export async function findPanelMessageByMessageId(guildId: string, messageId: string) {
  return prisma.panelMessage.findFirst({ where: { guildId, messageId } });
}

/** Active/desactive une fonctionnalite du panneau (cree l'enregistrement si premiere activation). */
export async function setPanelEnabled(guildId: string, key: PanelMessageKey, enabled: boolean) {
  return prisma.panelMessage.upsert({
    where: { guildId_key: { guildId, key } },
    create: { guildId, key, enabled },
    update: { enabled },
  });
}

async function saveMessageRef(guildId: string, key: PanelMessageKey, messageId: string) {
  return prisma.panelMessage.upsert({
    where: { guildId_key: { guildId, key } },
    create: { guildId, key, messageId, enabled: true },
    update: { messageId, enabled: true },
  });
}

/**
 * Oublie la reference au message supprime (voir `messageReactionAdd.ts`) et desactive la
 * fonctionnalite : re-cliquer le bouton parent (racine ou "Tickets") la reactivera et
 * repostera un message dedie tout neuf.
 */
export async function clearPanelMessageRef(guildId: string, key: PanelMessageKey) {
  return prisma.panelMessage.update({ where: { guildId_key: { guildId, key } }, data: { messageId: null, enabled: false } });
}

/**
 * Cree ou edite en place le message dedie a une cle du panneau. Si un message existe deja
 * (memorise en base) et est toujours accessible, il est edite en place ; sinon (jamais
 * poste, ou supprime manuellement dans Discord) un nouveau message est envoye et sa
 * reference sauvegardee. Pose la reaction "poubelle" (sauf sur ROOT) a chaque fois — reagir
 * est un no-op cote Discord si deja present, donc pas de cout a le refaire a chaque edition.
 */
export async function upsertPanelMessage(
  client: Client,
  guildId: string,
  key: PanelMessageKey,
  channelId: string,
  payload: { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] }
): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased() || channel.isDMBased()) return;

  const existing = await getPanelMessage(guildId, key);
  if (existing?.messageId) {
    try {
      const message = await channel.messages.fetch(existing.messageId);
      await message.edit(payload);
      if (key !== "ROOT") await message.react(PANEL_DELETE_EMOJI).catch(() => undefined);
      return;
    } catch (error) {
      logger.warn(`Message panneau ${key} (${existing.messageId}) introuvable, nouveau message poste`, error);
    }
  }

  const message = await channel.send(payload);
  if (key !== "ROOT") await message.react(PANEL_DELETE_EMOJI).catch(() => undefined);
  await saveMessageRef(guildId, key, message.id);
}

/** Embed du message racine du panneau : point d'entree vers chaque fonctionnalite. */
export function buildRootPanelEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Panneau d'administration")
    .setDescription("Choisissez une fonctionnalité à configurer.")
    .setColor(0x5865f2);
}

/** Boutons du message racine : un par fonctionnalite de premier niveau. */
export function buildRootPanelRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel:root:tickets").setLabel("Tickets").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel:root:absences").setLabel("Absences").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel:root:faq").setLabel("FAQ").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel:root:monitoring").setLabel("Monitoring").setStyle(ButtonStyle.Primary)
  );
}

/**
 * Embed du message dedie "Tickets" : recapitule, pour chacun des deux types (une seule
 * categorie possible par type — pas de sens metier a en avoir plusieurs), la categorie
 * mappee et ses roles de gestion. Utilise les mentions Discord (`<#id>`/`<@&id>`) pour
 * afficher noms de categorie/role sans avoir a les resoudre via l'API.
 */
export async function buildTicketsPanelEmbed(guildId: string): Promise<EmbedBuilder> {
  const config = await getGuildConfig(guildId);
  const categories = config?.ticketCategories ?? [];

  const describe = (type: "RECRUITMENT" | "SERVICE") => {
    const category = categories.find((c) => c.type === type);
    if (!category) return "Non configurée";
    const roles = category.managerRoleIds.length ? category.managerRoleIds.map((r) => `<@&${r}>`).join(" ") : "aucun rôle";
    return `<#${category.categoryId}>\nGestion : ${roles}`;
  };

  return new EmbedBuilder()
    .setTitle("Tickets")
    .setColor(0x5865f2)
    .addFields(
      { name: "Recrutement", value: describe("RECRUITMENT"), inline: true },
      { name: "Service client", value: describe("SERVICE"), inline: true }
    );
}

/**
 * Boutons du message dedie "Tickets" : gestion des roles (la categorie de chaque type se
 * definit desormais directement depuis les messages "Service client"/"Recrutement", via un
 * bouton Definir/Retirer la categorie — meme principe que le bouton ouvrir/fermer les
 * recrutements), plus deux boutons qui ouvrent ces messages dedies imbriques.
 */
export function buildTicketsPanelRows(): ActionRowBuilder<ButtonBuilder>[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel:tickets:add-role").setLabel("Ajouter un rôle de gestion").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel:tickets:remove-role").setLabel("Retirer un rôle de gestion").setStyle(ButtonStyle.Danger)
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel:tickets:service").setLabel("Service client").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel:tickets:recruitment").setLabel("Recrutement").setStyle(ButtonStyle.Secondary)
  );
  return [row1, row2];
}

/**
 * Embed du message dedie "Absences" : recapitule la configuration (role approbateur, salon
 * de suivi). La declaration elle-meme se fait via `/absence` (commande accessible a tout le
 * monde, pas un bouton ici — ce salon de panneau est reserve a la config, potentiellement
 * invisible aux membres non-staff).
 */
export async function buildAbsencesPanelEmbed(guildId: string): Promise<EmbedBuilder> {
  const config = await getGuildConfig(guildId);
  const role = config?.absenceApproverRoleId ? `<@&${config.absenceApproverRoleId}>` : "Non configuré";
  const channel = config?.absenceReviewChannelId ? `<#${config.absenceReviewChannelId}>` : "Non configuré";
  const ready = Boolean(config?.absenceApproverRoleId && config?.absenceReviewChannelId);

  return new EmbedBuilder()
    .setTitle("Absences")
    .setColor(0x5865f2)
    .addFields({ name: "Rôle approbateur", value: role, inline: true }, { name: "Salon de suivi", value: channel, inline: true })
    .setDescription(
      ready
        ? "Les membres peuvent déclarer une absence avec la commande /absence."
        : "Configurez le rôle approbateur et le salon de suivi ci-dessous avant que /absence ne soit utilisable."
    );
}

/** Boutons de configuration du message dedie "Absences" (role approbateur, salon de suivi). */
export function buildAbsencesPanelRows(): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel:absences:set-approver-role").setLabel("Définir le rôle approbateur").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel:absences:set-review-channel").setLabel("Définir le salon de suivi").setStyle(ButtonStyle.Secondary)
  );
  return [row];
}

/**
 * Embed du message dedie "Service client" : categorie mappee et catalogue actif (nom, prix,
 * photo configuree ou non, champs client). Remplace entierement `/catalog list`/`view`.
 */
export async function buildServicePanelEmbed(guildId: string): Promise<EmbedBuilder> {
  const config = await getGuildConfig(guildId);
  const category = config?.ticketCategories.find((c) => c.type === "SERVICE");
  const items = await listActiveWithFields(guildId);
  const embed = new EmbedBuilder()
    .setTitle("Service client")
    .setColor(0x5865f2)
    .addFields({ name: "Catégorie", value: category ? `<#${category.categoryId}>` : "Non configurée" });

  if (items.length === 0) {
    embed.addFields({ name: "Catalogue", value: "Aucun article configuré." });
  } else {
    embed.addFields({
      name: "Catalogue",
      value: items
        .slice(0, 25)
        .map((item) => {
          const fields = item.fields.length ? item.fields.map((f) => f.label).join(", ") : "aucun";
          return `**${item.name}** — ${item.price.toLocaleString("fr-FR")} $ (photo : ${item.imageUrl ? "oui" : "non"})\nChamps : ${fields}`;
        })
        .join("\n\n"),
    });
  }

  return embed;
}

/**
 * Boutons du message dedie "Service client" : categorie (bouton unique, libelle Definir/Retirer
 * selon l'etat courant — meme principe que le bouton ouvrir/fermer les recrutements), puis
 * gestion des articles (ajout/retrait/photo) et de leurs champs. Remplace entierement
 * `/catalog add`/`remove`/`field-add`/`field-remove`.
 */
export function buildServicePanelRows(categoryId: string | null): ActionRowBuilder<ButtonBuilder>[] {
  const categoryRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(categoryId ? "panel:service:clear-category" : "panel:service:set-category")
      .setLabel(categoryId ? "Retirer la catégorie" : "Définir la catégorie")
      .setStyle(categoryId ? ButtonStyle.Danger : ButtonStyle.Success)
  );
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel:service:add-item").setLabel("Ajouter un article").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("panel:service:remove-item").setLabel("Retirer un article").setStyle(ButtonStyle.Danger)
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel:service:set-image").setLabel("Changer la photo d'un article").setStyle(ButtonStyle.Secondary)
  );
  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel:service:add-field").setLabel("Ajouter un champ").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel:service:remove-field").setLabel("Retirer un champ").setStyle(ButtonStyle.Danger)
  );
  return [categoryRow, row1, row2, row3];
}

/**
 * Embed du message dedie "Recrutement" : categorie mappee, etat (ouvert/ferme) et questions
 * du formulaire (configurees par le staff, ou les 5 questions par defaut si aucune n'est
 * configuree). Remplace entierement `/recruitment status`.
 */
export async function buildRecruitmentPanelEmbed(guildId: string): Promise<EmbedBuilder> {
  const config = await getGuildConfig(guildId);
  const category = config?.ticketCategories.find((c) => c.type === "RECRUITMENT");
  const questions = await listQuestions(guildId);
  const open = config?.recruitmentOpen ?? true;

  const questionsText =
    questions.length > 0
      ? questions.map((q) => `${q.label} (${q.style === "SHORT" ? "court" : "long"})`).join("\n")
      : "Questions par défaut (5) : Nom RP, Âge, Expérience RP, Disponibilités, Motivation";

  return new EmbedBuilder()
    .setTitle("Recrutement")
    .setColor(0x5865f2)
    .addFields(
      { name: "Catégorie", value: category ? `<#${category.categoryId}>` : "Non configurée" },
      { name: "État", value: open ? "**Ouvert**" : "**Fermé**" },
      { name: "Questions du formulaire", value: questionsText }
    );
}

/**
 * Boutons du message dedie "Recrutement" : categorie (bouton unique Definir/Retirer selon
 * l'etat courant), bascule ouvert/ferme (meme principe), et gestion des questions du formulaire.
 */
export function buildRecruitmentPanelRows(open: boolean, categoryId: string | null): ActionRowBuilder<ButtonBuilder>[] {
  const categoryRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(categoryId ? "panel:recruitment:clear-category" : "panel:recruitment:set-category")
      .setLabel(categoryId ? "Retirer la catégorie" : "Définir la catégorie")
      .setStyle(categoryId ? ButtonStyle.Danger : ButtonStyle.Success)
  );
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("panel:recruitment:toggle")
      .setLabel(open ? "Fermer les recrutements" : "Ouvrir les recrutements")
      .setStyle(open ? ButtonStyle.Danger : ButtonStyle.Success)
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel:recruitment:add-question").setLabel("Ajouter une question").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel:recruitment:remove-question").setLabel("Retirer une question").setStyle(ButtonStyle.Danger)
  );
  return [categoryRow, row1, row2];
}

/**
 * Embed du message dedie "FAQ" : recapitule les regles de reponse automatique par mot-cle
 * (declenchees quand le client ouvrant un ticket ecrit un message qui contient le mot-cle).
 * Remplace entierement `/autoreply`.
 */
export async function buildFaqPanelEmbed(guildId: string): Promise<EmbedBuilder> {
  const rules = await listRules(guildId);
  const embed = new EmbedBuilder().setTitle("FAQ").setColor(0x5865f2);

  if (rules.length === 0) {
    embed.setDescription("Aucune règle configurée.");
  } else {
    embed.setDescription(rules.slice(0, 25).map((r) => `**${r.trigger}** → ${r.response}`).join("\n\n"));
  }

  return embed;
}

/** Boutons du message dedie "FAQ" : gestion des regles mot-cle -> reponse. */
export function buildFaqPanelRows(): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel:faq:add-rule").setLabel("Ajouter une règle").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("panel:faq:remove-rule").setLabel("Retirer une règle").setStyle(ButtonStyle.Danger)
  );
  return [row];
}

/** Libelle affichable de chaque type de log de monitoring (boutons, embeds, menus). */
export const MONITORING_TYPE_LABELS: Record<MonitoringLogType, string> = {
  SHIFT: "Prise de service",
  RECRUITMENT: "Recrutement",
  SAFE: "Coffre",
  INVOICE: "Facture",
  SALE: "Vente run",
};

/**
 * Embed du message dedie "Monitoring" : jobId surveille, role "en service", salon configure
 * pour chaque type de log, et abonnements webhook sortants actifs.
 */
export async function buildMonitoringPanelEmbed(guildId: string): Promise<EmbedBuilder> {
  const config = await getGuildConfig(guildId);
  const subscriptions = await listSubscriptions(guildId);

  const channelsText = (Object.keys(MONITORING_TYPE_LABELS) as MonitoringLogType[])
    .map((type) => {
      const channel = config?.monitoringChannels.find((c) => c.type === type);
      return `${MONITORING_TYPE_LABELS[type]} : ${channel ? `<#${channel.channelId}>` : "Non configuré"}`;
    })
    .join("\n");

  const webhooksText = subscriptions.length
    ? subscriptions.map((s) => `\`${s.eventType}\` → ${s.url.slice(0, 60)} (${s.enabled ? "actif" : "inactif"})`).join("\n")
    : "Aucun webhook configuré.";

  return new EmbedBuilder()
    .setTitle("Monitoring")
    .setColor(0x5865f2)
    .addFields(
      { name: "Entreprise (jobId)", value: config?.monitoringJobId ?? "Non configuré", inline: true },
      { name: "Rôle \"en service\"", value: config?.onDutyRoleId ? `<@&${config.onDutyRoleId}>` : "Non configuré", inline: true },
      { name: "Salons surveillés", value: channelsText },
      { name: "Webhooks sortants", value: webhooksText }
    );
}

/**
 * Boutons du message dedie "Monitoring" : jobId (modal), role "en service" (RoleSelectMenu),
 * un bouton par type de log (libelle dynamique Definir/Retirer selon l'etat courant — meme
 * convention que les categories Service/Recrutement), et gestion des webhooks sortants.
 */
export function buildMonitoringPanelRows(config: { monitoringChannels: { type: MonitoringLogType }[] } | null): ActionRowBuilder<ButtonBuilder>[] {
  const configuredTypes = new Set(config?.monitoringChannels.map((c) => c.type) ?? []);
  const types = Object.keys(MONITORING_TYPE_LABELS) as MonitoringLogType[];

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel:monitoring:set-job-id").setLabel("Définir l'entreprise (jobId)").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel:monitoring:set-on-duty-role").setLabel("Définir le rôle \"en service\"").setStyle(ButtonStyle.Secondary)
  );

  const channelButtons = types.map((type) => {
    const configured = configuredTypes.has(type);
    return new ButtonBuilder()
      .setCustomId(configured ? `panel:monitoring:clear-channel:${type}` : `panel:monitoring:set-channel:${type}`)
      .setLabel(configured ? `Retirer salon ${MONITORING_TYPE_LABELS[type]}` : `Salon ${MONITORING_TYPE_LABELS[type]}`)
      .setStyle(configured ? ButtonStyle.Danger : ButtonStyle.Success);
  });
  // Un ActionRow accepte au plus 5 boutons ; 5 types tiennent sur une seule ligne.
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(...channelButtons);

  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panel:monitoring:add-webhook").setLabel("Ajouter un webhook").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel:monitoring:remove-webhook").setLabel("Retirer un webhook").setStyle(ButtonStyle.Danger)
  );

  return [row1, row2, row3];
}

/**
 * Un `refresh*PanelMessage` par cle : reconstruit l'embed/les boutons a partir de l'etat
 * courant de la config et les applique au message dedie (cree ou edite en place). Regroupes
 * ici (plutot que duplique pres de chaque handler d'interaction) pour une seule raison :
 * `refreshAllPanelMessages` (voir plus bas, appelee au demarrage du bot) doit pouvoir
 * rafraichir n'importe quel message existant a partir de sa seule cle, sans dependre du
 * contexte d'une interaction Discord precise.
 */
export async function refreshRootPanelMessage(client: Client, guildId: string, channelId: string): Promise<void> {
  await upsertPanelMessage(client, guildId, "ROOT", channelId, {
    embeds: [buildRootPanelEmbed()],
    components: [buildRootPanelRow()],
  });
}

export async function refreshTicketsPanelMessage(client: Client, guildId: string, channelId: string): Promise<void> {
  await upsertPanelMessage(client, guildId, "TICKETS", channelId, {
    embeds: [await buildTicketsPanelEmbed(guildId)],
    components: buildTicketsPanelRows(),
  });
}

export async function refreshServicePanelMessage(client: Client, guildId: string, channelId: string): Promise<void> {
  const config = await getGuildConfig(guildId);
  const categoryId = config?.ticketCategories.find((c) => c.type === "SERVICE")?.categoryId ?? null;
  await upsertPanelMessage(client, guildId, "SERVICE", channelId, {
    embeds: [await buildServicePanelEmbed(guildId)],
    components: buildServicePanelRows(categoryId),
  });
}

export async function refreshRecruitmentPanelMessage(client: Client, guildId: string, channelId: string): Promise<void> {
  const config = await getGuildConfig(guildId);
  const categoryId = config?.ticketCategories.find((c) => c.type === "RECRUITMENT")?.categoryId ?? null;
  await upsertPanelMessage(client, guildId, "RECRUITMENT", channelId, {
    embeds: [await buildRecruitmentPanelEmbed(guildId)],
    components: buildRecruitmentPanelRows(config?.recruitmentOpen ?? true, categoryId),
  });
}

export async function refreshAbsencesPanelMessage(client: Client, guildId: string, channelId: string): Promise<void> {
  await upsertPanelMessage(client, guildId, "ABSENCES", channelId, {
    embeds: [await buildAbsencesPanelEmbed(guildId)],
    components: buildAbsencesPanelRows(),
  });
}

export async function refreshFaqPanelMessage(client: Client, guildId: string, channelId: string): Promise<void> {
  await upsertPanelMessage(client, guildId, "FAQ", channelId, {
    embeds: [await buildFaqPanelEmbed(guildId)],
    components: buildFaqPanelRows(),
  });
}

export async function refreshMonitoringPanelMessage(client: Client, guildId: string, channelId: string): Promise<void> {
  const config = await getGuildConfig(guildId);
  await upsertPanelMessage(client, guildId, "MONITORING", channelId, {
    embeds: [await buildMonitoringPanelEmbed(guildId)],
    components: buildMonitoringPanelRows(config),
  });
}

const REFRESH_BY_KEY: Record<PanelMessageKey, (client: Client, guildId: string, channelId: string) => Promise<void>> = {
  ROOT: refreshRootPanelMessage,
  TICKETS: refreshTicketsPanelMessage,
  SERVICE: refreshServicePanelMessage,
  RECRUITMENT: refreshRecruitmentPanelMessage,
  ABSENCES: refreshAbsencesPanelMessage,
  FAQ: refreshFaqPanelMessage,
  MONITORING: refreshMonitoringPanelMessage,
};

/**
 * Recharge (edite en place) tous les messages dedies actives d'une guilde a partir du code
 * courant. Appelee au demarrage du bot (voir `refreshAllPanelsAcrossGuilds`) pour qu'une
 * evolution des boutons/embeds cote code (ex: un nouveau bouton ajoute sur le message racine)
 * se propage automatiquement aux messages deja postes sans action manuelle — avant ce
 * correctif, il fallait recliquer chaque bouton (ou relancer `/config set-panel-channel`)
 * pour voir apparaitre les changements, ce que l'utilisateur a signale comme trompeur
 * ("je dois reconfigurer le channel et du coup je perds tout", alors qu'en realite rien
 * n'etait perdu — juste l'affichage qui restait perime).
 */
export async function refreshAllPanelMessages(client: Client, guildId: string): Promise<void> {
  const config = await getGuildConfig(guildId);
  if (!config?.panelChannelId) return;

  const messages = await prisma.panelMessage.findMany({ where: { guildId, enabled: true } });
  for (const message of messages) {
    try {
      await REFRESH_BY_KEY[message.key](client, guildId, config.panelChannelId);
    } catch (error) {
      logger.error(`Echec du rafraichissement du message panneau ${message.key} pour la guilde ${guildId}`, error);
    }
  }
}

/** Rafraichit le panneau de toutes les guildes ayant un salon panneau configure — appelee une seule fois au demarrage du bot. */
export async function refreshAllPanelsAcrossGuilds(client: Client): Promise<void> {
  const configs = await prisma.guildConfig.findMany({ where: { panelChannelId: { not: null } } });
  for (const config of configs) {
    await refreshAllPanelMessages(client, config.guildId);
  }
}
