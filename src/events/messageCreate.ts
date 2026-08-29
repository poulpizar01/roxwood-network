import type { Message } from "discord.js";
import { getGuildConfig, isTicketManager } from "../services/guildConfigService.js";
import { getTicketByChannel, recordActivity, recordFirstStaffReply } from "../services/ticketService.js";
import { findAutoReply } from "../services/autoReplyService.js";
import { addAttachment } from "../services/recruitmentService.js";
import { refreshRecruitmentLogMessage } from "../services/recruitmentLogService.js";
import { logger } from "../utils/logger.js";

/**
 * Handler de l'evenement `messageCreate`, restreint aux canaux qui sont des tickets suivis
 * et encore ouverts. Responsabilites :
 * 1. supprimer les messages purement informatifs postes par d'autres bots pour garder le
 *    salon propre autour de notre propre intro — mais jamais un message qui porte un bouton
 *    ou un menu (typiquement le bouton "Close" de Ticket Tool) : impossible de simuler un
 *    clic sur un composant d'un autre bot (Discord ne le permet pas), donc ce bouton reste
 *    le seul moyen reel de fermer un ticket cote Ticket Tool et doit rester accessible au staff ;
 * 2. mettre a jour l'activite du ticket (base du calcul d'escalade) ;
 * 3. detecter la premiere reponse d'un membre du staff ;
 * 4. sur un ticket de recrutement, rattacher les pieces jointes envoyees par le candidat
 *    a sa candidature (les modals Discord ne supportent pas l'upload de fichier) ;
 * 5. si l'auteur est le client ayant ouvert le ticket, tenter une reponse automatique.
 * Ignore les messages hors guilde (DMs).
 */
export async function onMessageCreate(message: Message): Promise<void> {
  if (!message.inGuild()) return;

  const ticket = await getTicketByChannel(message.channelId);
  if (!ticket || ticket.status !== "OPEN") return;

  if (message.author.bot) {
    // Necessite la permission Discord "Gerer les messages" sur le role du bot ; echoue
    // silencieusement (juste logge) sinon.
    if (message.author.id !== message.client.user?.id && message.components.length === 0) {
      await message.delete().catch((error) => logger.warn(`Echec suppression du message de ${message.author.id} dans ${message.channelId}`, error));
    }
    return;
  }

  const config = await getGuildConfig(message.guildId);
  const memberRoleIds = message.member ? [...message.member.roles.cache.keys()] : [];
  const authorIsStaff = isTicketManager(config, ticket.categoryId, memberRoleIds);

  await recordActivity(message.channelId);

  if (authorIsStaff) {
    await recordFirstStaffReply(message.channelId);
    return;
  }

  // Seul l'auteur du ticket declenche les reponses automatiques (pas n'importe quel
  // visiteur du salon) ; si l'opener n'a pas pu etre determine, on laisse passer par prudence.
  if (ticket.openerId && message.author.id !== ticket.openerId) return;

  if (ticket.type === "RECRUITMENT" && message.attachments.size > 0) {
    try {
      for (const attachment of message.attachments.values()) {
        await addAttachment(ticket.id, attachment.url, attachment.name ?? "fichier");
      }
      await refreshRecruitmentLogMessage(message.client, ticket.id);
    } catch (error) {
      logger.error(`Erreur enregistrement piece jointe pour le ticket ${ticket.id}`, error);
    }
  }

  try {
    const reply = await findAutoReply(message.guildId, message.content);
    if (reply) {
      await message.reply(reply);
    }
  } catch (error) {
    logger.error(`Erreur reponse automatique dans ${message.channelId}`, error);
  }
}
