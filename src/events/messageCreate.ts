import type { Message } from "discord.js";
import { getGuildConfig, isStaffMember } from "../services/guildConfigService.js";
import { getTicketByChannel, recordActivity, recordFirstStaffReply } from "../services/ticketService.js";
import { findAutoReply } from "../services/autoReplyService.js";
import { logger } from "../utils/logger.js";

/**
 * Handler de l'evenement `messageCreate`, restreint aux canaux qui sont des tickets suivis
 * et encore ouverts. Trois responsabilites :
 * 1. mettre a jour l'activite du ticket (base du calcul d'escalade) ;
 * 2. detecter la premiere reponse d'un membre du staff ;
 * 3. si l'auteur est le client ayant ouvert le ticket, tenter une reponse automatique.
 * Ignore les messages de bots (evite les boucles avec le bot lui-meme ou d'autres bots
 * comme Ticket Tool) et les messages hors guilde (DMs).
 */
export async function onMessageCreate(message: Message): Promise<void> {
  if (message.author.bot || !message.inGuild()) return;

  const ticket = await getTicketByChannel(message.channelId);
  if (!ticket || ticket.status !== "OPEN") return;

  const config = await getGuildConfig(message.guildId);
  const memberRoleIds = message.member ? [...message.member.roles.cache.keys()] : [];
  const authorIsStaff = isStaffMember(config, memberRoleIds);

  await recordActivity(message.channelId);

  if (authorIsStaff) {
    await recordFirstStaffReply(message.channelId);
    return;
  }

  // Seul l'auteur du ticket declenche les reponses automatiques (pas n'importe quel
  // visiteur du salon) ; si l'opener n'a pas pu etre determine, on laisse passer par prudence.
  if (ticket.openerId && message.author.id !== ticket.openerId) return;

  try {
    const reply = await findAutoReply(message.guildId, message.content);
    if (reply) {
      await message.reply(reply);
    }
  } catch (error) {
    logger.error(`Erreur reponse automatique dans ${message.channelId}`, error);
  }
}
