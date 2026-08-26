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

// Point d'entree du bot : branche chaque evenement Discord ecoute sur son handler dedie
// (un fichier par evenement dans src/events/), puis se connecte a la gateway Discord.

/** Une seule fois au demarrage : enregistre les commandes slash et lance le job d'escalade. */
client.once(Events.ClientReady, onReady);
/** Nouveau canal cree : detecte l'ouverture d'un ticket si sa categorie est suivie. */
client.on(Events.ChannelCreate, onChannelCreate);
/** Canal supprime : signal principal de fermeture d'un ticket suivi. */
client.on(Events.ChannelDelete, onChannelDelete);
/** Canal modifie (ex: renomme) : signal secondaire de fermeture d'un ticket suivi. */
client.on(Events.ChannelUpdate, onChannelUpdate);
/** Nouveau message : suivi d'activite/1ere reponse staff, reponses automatiques. */
client.on(Events.MessageCreate, onMessageCreate);
/** Toute interaction (commande slash, bouton, menu, modal) : routee vers le bon handler. */
client.on(Events.InteractionCreate, onInteractionCreate);

client.login(env.DISCORD_TOKEN).catch((error) => {
  logger.error("Echec de connexion du bot", error);
  process.exit(1);
});
