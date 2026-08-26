import { createHmac } from "node:crypto";
import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";

export type WebhookEventType = "ticket.created" | "ticket.closed" | "ticket.escalated";

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export async function dispatchWebhook(
  guildId: string,
  eventType: WebhookEventType,
  payload: Record<string, unknown>
): Promise<void> {
  const subscriptions = await prisma.webhookSubscription.findMany({
    where: { guildId, eventType, enabled: true },
  });

  if (subscriptions.length === 0) return;

  const body = JSON.stringify({ eventType, payload, sentAt: new Date().toISOString() });

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
