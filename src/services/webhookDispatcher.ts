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
  | "monitoring.shift"
  | "monitoring.recruitment"
  | "monitoring.safe"
  | "monitoring.invoice"
  | "monitoring.sale"
  | "absence.updated"
  | "order.updated"
  | "custom";

/**
 * Libelle affichable de chaque type d'evenement, et source de verite de la liste complete —
 * tous les abonnements webhook se gerent depuis le panneau "Monitoring", quel que soit le
 * domaine de l'evenement (choix explicite de l'utilisateur : un seul endroit centralise
 * plutot qu'un bouton "Ajouter un webhook" disperse sur chaque panneau concerne).
 */
export const WEBHOOK_EVENT_LABELS: Record<WebhookEventType, string> = {
  "monitoring.shift": "Prise de service (Monitoring)",
  "monitoring.recruitment": "Recrutement (Monitoring)",
  "monitoring.safe": "Coffre (Monitoring)",
  "monitoring.invoice": "Facture (Monitoring)",
  "monitoring.sale": "Vente run (Monitoring)",
  "absence.updated": "Absences",
  "order.updated": "Commandes",
  custom: "Personnalisé (contenu au choix)",
};

/**
 * Libelle affichable d'un abonnement dans une liste (embed, menu de suppression...) : le
 * `label` libre s'il existe (abonnements "custom", potentiellement plusieurs par guilde —
 * voir le schema), sinon le type d'evenement seul suffit deja a l'identifier.
 */
export function describeSubscription(sub: { eventType: string; label: string | null }): string {
  return sub.label ? `${sub.label} (${sub.eventType})` : sub.eventType;
}

/**
 * Signe le corps de la requete en HMAC-SHA256 avec le secret propre a chaque abonnement,
 * pour que le service externe puisse verifier l'authenticite de l'appel (header `X-Signature-256`).
 */
function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** Signe et envoie un unique POST JSON a un abonnement donne ; logge sans jamais lancer d'exception. */
async function post(sub: { id: string; url: string; secret: string }, body: string, eventType: string): Promise<void> {
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

  await Promise.all(subscriptions.map((sub) => post(sub, body, eventType)));
}

/**
 * Envoie un contenu libre a **un seul** abonnement "custom" choisi explicitement par le staff
 * (pas de fanout par type — plusieurs abonnements custom d'une meme guilde, ex: un par Google
 * Sheet, doivent pouvoir recevoir des contenus completement differents sans se marcher dessus).
 * Retourne `false` sans rien envoyer si l'abonnement n'existe pas/plus ou n'appartient pas a
 * cette guilde (verification d'isolation, meme raisonnement que `dispatchWebhook`).
 */
export async function dispatchCustomWebhook(
  guildId: string,
  subscriptionId: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  const sub = await prisma.webhookSubscription.findFirst({
    where: { id: subscriptionId, guildId, enabled: true },
  });
  if (!sub) return false;

  const body = JSON.stringify({ guildId, eventType: sub.eventType, label: sub.label, payload, sentAt: new Date().toISOString() });
  await post(sub, body, sub.eventType);
  return true;
}
