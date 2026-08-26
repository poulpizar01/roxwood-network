import type { Command } from "./types.js";
import { configCommand } from "./config.js";
import { ticketCommand } from "./ticket.js";
import { autoreplyCommand } from "./autoreply.js";
import { statsCommand } from "./stats.js";
import { recruitmentCommand } from "./recruitment.js";
import { catalogCommand } from "./catalog.js";
import { orderCommand } from "./order.js";

export const commands: Command[] = [
  configCommand,
  ticketCommand,
  autoreplyCommand,
  statsCommand,
  recruitmentCommand,
  catalogCommand,
  orderCommand,
];
export const commandsByName = new Map(commands.map((c) => [c.data.name, c]));
