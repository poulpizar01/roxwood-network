import { ChannelType, type NonThreadGuildBasedChannel } from "discord.js";
import { getGuildConfig, isTicketCategory } from "../services/guildConfigService.js";
import { trackTicketChannel } from "../services/ticketService.js";
import { logger } from "../utils/logger.js";

export async function onChannelCreate(channel: NonThreadGuildBasedChannel): Promise<void> {
  if (channel.type !== ChannelType.GuildText) return;

  const config = await getGuildConfig(channel.guildId);
  if (!isTicketCategory(config, channel.parentId)) return;

  try {
    await trackTicketChannel(channel, channel.parentId!);
  } catch (error) {
    logger.error(`Erreur lors du suivi du nouveau canal ${channel.id}`, error);
  }
}
