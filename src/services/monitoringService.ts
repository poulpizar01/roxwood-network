import type { Message } from "discord.js";
import type { MonitoringLogType } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { getGuildConfig } from "./guildConfigService.js";
import { findLatestRecruitmentTicketByOpener } from "./ticketService.js";
import { getApplication, setStatus as setApplicationStatus } from "./recruitmentService.js";
import { refreshRecruitmentLogMessage } from "./recruitmentLogService.js";
import { recordSafeMovement } from "./monitoringSafeService.js";
import { dispatchWebhook, type WebhookEventType } from "./webhookDispatcher.js";
import {
  parseInvoice,
  parseRecruitment,
  parseSafe,
  parseSale,
  parseShift,
  type RecruitmentParseResult,
  type SafeParseResult,
  type ShiftParseResult,
} from "./monitoringParsers.js";
import { logger } from "../utils/logger.js";

/**
 * Ingestion des logs webhook FiveM (voir `MonitoringChannelConfig`) : detecte si un message
 * arrive dans un salon de monitoring configure, parse son embed, applique les effets de bord
 * specifiques au type (role "en service", finalisation de candidature, ledger de coffre), et
 * relaie toujours l'evenement brut (stockage + webhook sortant) meme quand le parsing du
 * texte libre echoue — voir le detail des motifs geres dans `monitoringParsers.ts`.
 */

const WEBHOOK_EVENT_BY_TYPE: Record<MonitoringLogType, WebhookEventType> = {
  SHIFT: "monitoring.shift",
  RECRUITMENT: "monitoring.recruitment",
  SAFE: "monitoring.safe",
  INVOICE: "monitoring.invoice",
  SALE: "monitoring.sale",
};

/**
 * Point d'entree appele par `messageCreate.ts` avant toute logique de ticket (un salon de
 * monitoring n'est jamais un salon de ticket). Retourne `true` si le message a ete reconnu
 * comme un log de monitoring (que le parsing/les effets de bord aient reussi ou non) — dans
 * ce cas l'appelant doit s'arreter la, `false` sinon (laisser le traitement normal continuer).
 *
 * Toute la fonction est enveloppee dans un try/catch : `messageCreate` est un listener
 * d'evenement discord.js, et une exception non rattrapee ici tuerait tout le process (voir
 * le correctif `captureRejections` dans `index.ts`) — mieux vaut logger et ignorer ce log
 * precis que de faire planter le bot pour toutes les guildes.
 */
export async function ingestMonitoringMessage(message: Message<true>): Promise<boolean> {
  try {
    const config = await getGuildConfig(message.guildId);
    if (!config || !config.monitoringJobId) return false;

    const channelConfig = config.monitoringChannels.find((c) => c.channelId === message.channelId);
    if (!channelConfig) return false;

    const embed = message.embeds[0];
    if (!embed) return false;

    const description = embed.description ?? "";
    const fields = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));

    if (fields.jobId !== config.monitoringJobId) return false;

    const parsed = parseByType(channelConfig.type, description);
    if (!parsed) {
      logger.warn(`Log de monitoring ${channelConfig.type} non reconnu (guilde ${message.guildId}) : "${description}"`);
    }

    await prisma.monitoringEvent.create({
      data: {
        guildId: message.guildId,
        type: channelConfig.type,
        rawFields: { ...fields, description, parsed: parsed ?? null },
      },
    });

    if (parsed) {
      await applySideEffect(message, config, channelConfig.type, fields, parsed);
    }

    await dispatchWebhook(message.guildId, WEBHOOK_EVENT_BY_TYPE[channelConfig.type], {
      ...fields,
      description,
      parsed: parsed ?? null,
    });

    return true;
  } catch (error) {
    logger.error(`Erreur lors de l'ingestion d'un log de monitoring dans ${message.channelId}`, error);
    return true;
  }
}

function parseByType(type: MonitoringLogType, description: string) {
  switch (type) {
    case "SHIFT":
      return parseShift(description);
    case "RECRUITMENT":
      return parseRecruitment(description);
    case "SAFE":
      return parseSafe(description);
    case "INVOICE":
      return parseInvoice(description);
    case "SALE":
      return parseSale(description);
  }
}

async function applySideEffect(
  message: Message<true>,
  config: NonNullable<Awaited<ReturnType<typeof getGuildConfig>>>,
  type: MonitoringLogType,
  fields: Record<string, string>,
  parsed: NonNullable<ReturnType<typeof parseByType>>
): Promise<void> {
  // `type` (deduit du salon, voir `ingestMonitoringMessage`) et `parsed` (issu de
  // `parseByType(type, ...)`) sont deux parametres distincts du point de vue de TypeScript,
  // qui ne peut pas prouver leur correlation — on force le type ici plutot que de compter sur
  // un narrowing structurel par `in`, la correlation etant garantie par construction (meme
  // `type` utilise dans `parseByType` juste avant l'appel).
  if (type === "SHIFT") {
    const shift = parsed as ShiftParseResult;
    if (!config.onDutyRoleId || !fields.playerDiscord) return;
    try {
      const member = await message.guild.members.fetch(fields.playerDiscord);
      if (shift.direction === "in") await member.roles.add(config.onDutyRoleId);
      else await member.roles.remove(config.onDutyRoleId);
    } catch (error) {
      logger.warn(`Echec de bascule du role "en service" pour ${fields.playerDiscord}`, error);
    }
    return;
  }

  if (type === "RECRUITMENT") {
    const recruitment = parsed as RecruitmentParseResult;
    if (recruitment.action !== "hired" || !fields.targetPlayerDiscord) return;

    const ticket = await findLatestRecruitmentTicketByOpener(message.guildId, fields.targetPlayerDiscord);
    if (!ticket) return;

    const application = await getApplication(ticket.id);
    if (!application || application.status === "ACCEPTED") return;

    await setApplicationStatus(ticket.id, "ACCEPTED");
    await refreshRecruitmentLogMessage(message.client, ticket.id);
    return;
  }

  if (type === "SAFE") {
    const safe = parsed as SafeParseResult;
    if (!fields.targetPosition || !fields.itemId) return;
    const signedQuantity = safe.direction === "in" ? safe.quantity : -safe.quantity;
    await recordSafeMovement(message.guildId, fields.targetPosition, fields.itemId, signedQuantity, {
      discordId: fields.playerDiscord,
      name: fields.playerName,
    });
  }
}
