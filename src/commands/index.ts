import type { Command } from "./types.js";
import { configCommand } from "./config.js";
import { ticketCommand } from "./ticket.js";
import { autoreplyCommand } from "./autoreply.js";
import { statsCommand } from "./stats.js";

export const commands: Command[] = [configCommand, ticketCommand, autoreplyCommand, statsCommand];
export const commandsByName = new Map(commands.map((c) => [c.data.name, c]));
