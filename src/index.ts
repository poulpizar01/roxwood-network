import { Events } from "discord.js";
import { env } from "./config/env.js";
import { client } from "./client.js";
import { onReady } from "./events/ready.js";
import { onChannelCreate } from "./events/channelCreate.js";
import { onChannelDelete } from "./events/channelDelete.js";
import { onChannelUpdate } from "./events/channelUpdate.js";
import { onMessageCreate } from "./events/messageCreate.js";
import { onInteractionCreate } from "./events/interactionCreate.js";
import { logger } from "./utils/logger.js";

client.once(Events.ClientReady, onReady);
client.on(Events.ChannelCreate, onChannelCreate);
client.on(Events.ChannelDelete, onChannelDelete);
client.on(Events.ChannelUpdate, onChannelUpdate);
client.on(Events.MessageCreate, onMessageCreate);
client.on(Events.InteractionCreate, onInteractionCreate);

client.login(env.DISCORD_TOKEN).catch((error) => {
  logger.error("Echec de connexion du bot", error);
  process.exit(1);
});
