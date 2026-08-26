import type { Message } from "discord.js";
import { getGuildConfig, isStaffMember } from "../services/guildConfigService.js";
import { getTicketByChannel, recordActivity, recordFirstStaffReply } from "../services/ticketService.js";
import { findAutoReply } from "../services/autoReplyService.js";
import { logger } from "../utils/logger.js";

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
