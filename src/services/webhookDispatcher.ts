import { createHmac } from "node:crypto";
import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";

/**
 * Point de branchement generique vers des systemes externes (CRM, site web...) : chaque
 * guilde peut abonner des URLs a des types d'evenements via `WebhookSubscription`. Aucune
 * integration specifique n'est codee en dur ici, volontairement.
 */

/** Types d'evenements pouvant declencher l'envoi d'un webhook. */
export type WebhookEventType =
  | "ticket.created"
  | "ticket.closed"
  | "monitoring.shift"
  | "monitoring.recruitment"
  | "monitoring.safe"
  | "monitoring.invoice"
  | "monitoring.sale";

/** Types d'evenements "monitoring.*" geres par le panneau (voir `panelService.buildMonitoringPanelRows`). */
export const MONITORING_WEBHOOK_EVENT_TYPES: WebhookEventType[] = [
  "monitoring.shift",
  "monitoring.recruitment",
  "monitoring.safe",
  "monitoring.invoice",
  "monitoring.sale",
];

/**
 * Signe le corps de la requete en HMAC-SHA256 avec le secret propre a chaque abonnement,
 * pour que le service externe puisse verifier l'authenticite de l'appel (header `X-Signature-256`).
 */
function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Envoie `payload` (en POST JSON signe) a tous les webhooks actifs de la guilde abonnes
 * a ce type d'evenement. Les envois sont paralleles et independants : l'echec d'un
 * abonnement (timeout, 4xx/5xx, exception reseau) est logge mais n'empeche pas les autres
 * d'etre notifies, et ne fait jamais echouer l'appelant (pas de throw).
 *
 * @param guildId - guilde d'origine de l'evenement
 * @param eventType - type d'evenement (voir `WebhookEventType`)
 * @param payload - donnees specifiques a l'evenement, serialisees telles quelles dans le body
 */
export async function dispatchWebhook(
  guildId: string,
  eventType: WebhookEventType,
  payload: Record<string, unknown>
): Promise<void> {
  const subscriptions = await prisma.webhookSubscription.findMany({
    where: { guildId, eventType, enabled: true },
  });

  if (subscriptions.length === 0) return;

  // `guildId` est inclus explicitement dans le corps envoye : si le recepteur utilise la
  // meme URL pour plusieurs guildes (plutot qu'une URL dediee par guilde), c'est le seul
  // moyen pour lui de savoir de quel serveur Discord provient l'evenement — sans ca, rien
  // dans la requete ne permettrait de les distinguer.
  const body = JSON.stringify({ guildId, eventType, payload, sentAt: new Date().toISOString() });

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        const response = await fetch(sub.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Signature-256": sign(sub.secret, body),
          },
          body,
        });
        if (!response.ok) {
          logger.warn(`Webhook ${sub.id} (${eventType}) a repondu ${response.status}`);
        }
      } catch (error) {
        logger.error(`Echec d'envoi du webhook ${sub.id} (${eventType})`, error);
      }
    })
  );
}
