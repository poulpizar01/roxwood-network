import type { Command } from "./types.js";
import { configCommand } from "./config.js";
import { ticketCommand } from "./ticket.js";
import { autoreplyCommand } from "./autoreply.js";
import { statsCommand } from "./stats.js";
import { recruitmentCommand } from "./recruitment.js";
import { catalogCommand } from "./catalog.js";
import { orderCommand } from "./order.js";

/**
 * Registre central de toutes les commandes slash du bot. `onReady` s'en sert pour les
 * enregistrer aupres de l'API Discord (`commands`), et `onInteractionCreate` pour retrouver
 * le handler a executer a partir du nom de la commande invoquee (`commandsByName`).
 */
export const commands: Command[] = [
  configCommand,
  ticketCommand,
  autoreplyCommand,
  statsCommand,
  recruitmentCommand,
  catalogCommand,
  orderCommand,
];

/** Index des commandes par nom (`data.name`), pour une resolution O(1) a chaque interaction. */
export const commandsByName = new Map(commands.map((c) => [c.data.name, c]));
