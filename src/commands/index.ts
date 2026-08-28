import type { Command } from "./types.js";
import { configCommand } from "./config.js";
import { ticketCommand } from "./ticket.js";
import { autoreplyCommand } from "./autoreply.js";
import { statsCommand } from "./stats.js";
import { catalogCommand } from "./catalog.js";
import { recruitmentCommand } from "./recruitment.js";

/**
 * Registre central de toutes les commandes slash du bot. `onReady` s'en sert pour les
 * enregistrer aupres de l'API Discord (`commands`), et `onInteractionCreate` pour retrouver
 * le handler a executer a partir du nom de la commande invoquee (`commandsByName`).
 *
 * Le pilotage du pipeline de recrutement (statut de candidature, assignation) et de la
 * commande (statut, paiement, facture, corrections) ne passe pas par des commandes : voir
 * les boutons geres directement dans interactionCreate.ts. `/recruitment status` reste une
 * commande car c'est un interrupteur global par serveur, pas une action liee a un ticket.
 */
export const commands: Command[] = [configCommand, ticketCommand, autoreplyCommand, statsCommand, catalogCommand, recruitmentCommand];

/** Index des commandes par nom (`data.name`), pour une resolution O(1) a chaque interaction. */
export const commandsByName = new Map(commands.map((c) => [c.data.name, c]));
