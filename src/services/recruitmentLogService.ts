import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type Client } from "discord.js";
import { getApplication } from "./recruitmentService.js";
import { getTicketById } from "./ticketService.js";
import { getGuildConfig, setRecruitmentStatusMessageId } from "./guildConfigService.js";
import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";

/**
 * Construction et mise a jour du message de suivi d'une candidature (recap + boutons
 * Statut/S'assigner). Regroupe ici plutot que dans `interactionCreate.ts` car ce message
 * doit pouvoir etre rafraichi depuis deux endroits distincts : un clic sur bouton/menu
 * (`ButtonInteraction`/`StringSelectMenuInteraction`) et un message classique du candidat
 * contenant une piece jointe (`Message`, voir `messageCreate.ts`) — les deux exposent un
 * `.client` (`Client`) mais pas le meme type d'objet Discord.js.
 */

/** Etapes du pipeline de recrutement proposees dans le menu deroulant "Statut". */
export const RECRUITMENT_STATUS_CHOICES = [
  { name: "En attente", value: "PENDING" },
  { name: "Entretien", value: "INTERVIEW" },
  { name: "Accepté", value: "ACCEPTED" },
  { name: "Refusé", value: "REJECTED" },
] as const;

/** Libelle affichable d'un statut de candidature (fallback sur la valeur brute si inconnue). */
export function recruitmentStatusLabel(status: string): string {
  return RECRUITMENT_STATUS_CHOICES.find((c) => c.value === status)?.name ?? status;
}

/**
 * Construit l'embed de suivi d'une candidature (candidat, salon, statut, recruteur,
 * reponses au formulaire, pieces jointes). Reutilise a la fois pour le premier envoi et
 * pour la mise a jour du message apres un changement de statut/assignation/piece jointe.
 */
export function buildRecruitmentEmbed(
  ticket: { channelId: string; openerId: string | null },
  application: {
    status: string;
    recruiterId: string | null;
    answers: { question: string; answer: string }[];
    attachments: { url: string; filename: string }[];
  }
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("Candidature")
    .setColor(0x5865f2)
    .addFields(
      { name: "Candidat", value: ticket.openerId ? `<@${ticket.openerId}>` : "inconnu", inline: true },
      { name: "Ticket", value: `<#${ticket.channelId}>`, inline: true },
      { name: "Statut", value: `**${recruitmentStatusLabel(application.status)}**`, inline: true },
      { name: "Recruteur", value: application.recruiterId ? `<@${application.recruiterId}>` : "non assigné", inline: true },
      ...application.answers.map((a) => ({ name: a.question, value: a.answer || "-" }))
    );

  if (application.attachments.length > 0) {
    embed.addFields({
      name: "Pièces jointes",
      value: application.attachments.map((a, i) => `[${a.filename || `Fichier ${i + 1}`}](${a.url})`).join("\n"),
    });
    // Un embed n'affiche qu'une seule image en grand : on prend la 1ere piece jointe qui en est une.
    const firstImage = application.attachments.find((a) => /\.(png|jpe?g|gif|webp)($|\?)/i.test(a.url));
    if (firstImage) embed.setImage(firstImage.url);
  }

  return embed;
}

/** Boutons "Statut" et "S'assigner" affiches sous le message de suivi d'une candidature. */
export function buildRecruitmentActionRow(ticketId: string): ActionRowBuilder<ButtonBuilder> {
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
export async function resolveRecruitmentLogChannel(client: Client, guildId: string | null, ticketChannelId: string) {
  const config = guildId ? await getGuildConfig(guildId) : null;
  const configuredChannelId = config?.recruitmentLogChannelId;

  if (configuredChannelId) {
    try {
      const channel = await client.channels.fetch(configuredChannelId);
      if (channel?.isTextBased() && !channel.isDMBased()) return channel;
    } catch (error) {
      logger.warn(`Salon de suivi recrutement ${configuredChannelId} inaccessible, repli sur le salon du ticket`, error);
    }
  }

  const fallback = await client.channels.fetch(ticketChannelId);
  return fallback?.isTextBased() && !fallback.isDMBased() ? fallback : null;
}

/**
 * Recharge le ticket/la candidature depuis la base et met a jour en place le message de
 * suivi (embed + boutons), apres un changement de statut, d'assignation, ou l'ajout d'une
 * piece jointe. No-op silencieux si le message de suivi n'a jamais ete envoye (candidature
 * pas encore soumise) ou n'est plus accessible (salon/message supprime) — journalise mais
 * ne fait pas echouer l'action qui a declenche la mise a jour.
 */
export async function refreshRecruitmentLogMessage(client: Client, ticketId: string): Promise<void> {
  const ticket = await getTicketById(ticketId);
  const application = await getApplication(ticketId);
  if (!ticket || !application || !application.logChannelId || !application.logMessageId) return;

  try {
    const channel = await client.channels.fetch(application.logChannelId);
    if (!channel?.isTextBased() || channel.isDMBased()) return;
    const message = await channel.messages.fetch(application.logMessageId);
    await message.edit({ embeds: [buildRecruitmentEmbed(ticket, application)], components: [buildRecruitmentActionRow(ticketId)] });
  } catch (error) {
    logger.error(`Echec de mise a jour du message de suivi pour le ticket ${ticketId}`, error);
  }
}

/**
 * Applique les effets de bord declenches quand une candidature passe a ACCEPTED (voir
 * `panel:recruitment:set-accepted-category`/`-role`) : deplace le salon du ticket vers la
 * categorie configuree et/ou ajoute le role configure au candidat. Chaque effet est
 * independant et optionnel (`null` = desactive) ; un echec sur l'un (permissions, hierarchie
 * de roles, salon/membre introuvable) est journalise sans bloquer l'autre. Appelee a la fois
 * depuis le changement de statut manuel (bouton "Statut") et l'auto-acceptation par le
 * monitoring RECRUITMENT ("embauche"), pour ne jamais dupliquer cette logique.
 */
export async function applyRecruitmentAcceptance(client: Client, ticketId: string): Promise<void> {
  const ticket = await getTicketById(ticketId);
  if (!ticket) return;

  const config = await getGuildConfig(ticket.guildId);
  if (!config) return;

  if (config.recruitmentAcceptedCategoryId) {
    try {
      const channel = await client.channels.fetch(ticket.channelId);
      if (channel && "setParent" in channel) {
        await channel.setParent(config.recruitmentAcceptedCategoryId, { lockPermissions: false });
      }
    } catch (error) {
      logger.warn(`Echec du deplacement du salon ${ticket.channelId} vers la categorie d'acceptation`, error);
    }
  }

  if (config.recruitmentAcceptedRoleId && ticket.openerId) {
    try {
      const guild = await client.guilds.fetch(ticket.guildId);
      const member = await guild.members.fetch(ticket.openerId);
      await member.roles.add(config.recruitmentAcceptedRoleId);
    } catch (error) {
      logger.warn(`Echec de l'ajout du role d'acceptation a ${ticket.openerId}`, error);
    }
  }
}

/**
 * Construit/met a jour en place le message permanent affichant l'etat ouvert/ferme des
 * recrutements dans le salon configure (`recruitmentStatusChannelId`) — distinct du panneau
 * d'administration, potentiellement visible par tout le monde (ex: annonce publique "on
 * recrute"). No-op si aucun salon n'est configure. Si le message precedent n'est plus
 * accessible (supprime manuellement), en reposte un nouveau plutot que d'echouer.
 */
export async function refreshRecruitmentStatusMessage(client: Client, guildId: string): Promise<void> {
  const config = await getGuildConfig(guildId);
  if (!config?.recruitmentStatusChannelId) return;

  const embed = new EmbedBuilder()
    .setTitle("Recrutement")
    .setColor(config.recruitmentOpen ? 0x57f287 : 0xed4245)
    .setDescription(config.recruitmentOpen ? "**Les recrutements sont ouverts.**" : "**Les recrutements sont actuellement fermés.**");

  try {
    const channel = await client.channels.fetch(config.recruitmentStatusChannelId);
    if (!channel?.isTextBased() || channel.isDMBased()) return;

    if (config.recruitmentStatusMessageId) {
      try {
        const message = await channel.messages.fetch(config.recruitmentStatusMessageId);
        await message.edit({ embeds: [embed] });
        return;
      } catch {
        // Message supprime ou inaccessible : on retombe sur le repost ci-dessous.
      }
    }

    const message = await channel.send({ embeds: [embed] });
    await setRecruitmentStatusMessageId(guildId, message.id);
  } catch (error) {
    logger.error(`Echec de mise a jour du message de statut recrutement pour la guilde ${guildId}`, error);
  }
}

/**
 * Rafraichit le message de statut recrutement de toutes les guildes qui en ont configure un —
 * appelee au demarrage du bot (voir `ready.ts`), meme raisonnement que
 * `refreshAllPanelsAcrossGuilds` : une mise a jour du bot (libelle, couleur...) se propage
 * ainsi automatiquement sans reconfiguration manuelle.
 */
export async function refreshAllRecruitmentStatusMessages(client: Client): Promise<void> {
  const configs = await prisma.guildConfig.findMany({ where: { recruitmentStatusChannelId: { not: null } } });
  for (const config of configs) {
    await refreshRecruitmentStatusMessage(client, config.guildId);
  }
}
