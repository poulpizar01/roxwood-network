import { ChannelType, type DMChannel, type NonThreadGuildBasedChannel } from "discord.js";
import { markTicketClosed } from "../services/ticketService.js";
import { logger } from "../utils/logger.js";

export async function onChannelDelete(channel: DMChannel | NonThreadGuildBasedChannel): Promise<void> {
  if (channel.type !== ChannelType.GuildText) return;

  try {
    await markTicketClosed(channel.id, channel.guildId);
  } catch (error) {
    logger.error(`Erreur lors de la fermeture du ticket ${channel.id}`, error);
  }
}
