import { ChannelType, type DMChannel, type NonThreadGuildBasedChannel } from "discord.js";
import { markTicketClosed } from "../services/ticketService.js";
import { logger } from "../utils/logger.js";

// Heuristique secondaire : certaines configs Ticket Tool renomment le canal
// (ex: prefixe "closed-" / "ferme-") au lieu de le supprimer. A confirmer sur le vrai serveur.
const CLOSED_NAME_PREFIXES = ["closed-", "ferme-", "fermé-"];

export async function onChannelUpdate(
  oldChannel: DMChannel | NonThreadGuildBasedChannel,
  newChannel: DMChannel | NonThreadGuildBasedChannel
): Promise<void> {
  if (newChannel.type !== ChannelType.GuildText) return;
  if (oldChannel.type !== ChannelType.GuildText) return;
  if (oldChannel.name === newChannel.name) return;

  const looksClosed = CLOSED_NAME_PREFIXES.some((prefix) => newChannel.name.toLowerCase().startsWith(prefix));
  if (!looksClosed) return;

  try {
    await markTicketClosed(newChannel.id, newChannel.guildId);
  } catch (error) {
    logger.error(`Erreur lors de la fermeture (renommage) du ticket ${newChannel.id}`, error);
  }
}
