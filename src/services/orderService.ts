import type { CatalogItem, CatalogItemField, OrderStatus, PaymentStatus } from "@prisma/client";
import { prisma } from "../db/prisma.js";

/**
 * Service de gestion de la commande (`ServiceOrder`, 1:1 avec un `Ticket` de type SERVICE)
 * et de ses lignes (`OrderItem`). Composition initiale cote client (self-service : select
 * menu + modal), pilotage ensuite via les boutons du message "Commande validee" (statut,
 * paiement, facture, corrections) — voir `orderLogService.ts` et `interactionCreate.ts`.
 */

/**
 * Recupere la commande d'un ticket, ou la cree si elle n'existe pas encore (statut
 * PENDING/UNPAID par defaut). Appele des l'ouverture d'un ticket SERVICE, avant meme
 * que le client n'ait ajoute le moindre article.
 */
export async function getOrCreateOrder(ticketId: string) {
  const existing = await prisma.serviceOrder.findUnique({ where: { ticketId } });
  if (existing) return existing;

  return prisma.serviceOrder.create({ data: { ticketId } });
}

/**
 * Ajoute une ligne de commande a partir des reponses du client au modal dynamique genere
 * pour un article de catalogue. Separe la reponse du champ QUANTITY (si present) des autres :
 * la premiere alimente `OrderItem.quantity` (utilise dans le calcul du prix), les secondes
 * sont stockees telles quelles comme `OrderItemAnswer` (affichees ensuite sur la facture).
 * `name`/`unitPrice` sont copies (snapshot) depuis le catalogue au moment de la commande,
 * pour que le prix facture reste correct meme si l'article catalogue change ensuite.
 *
 * @param orderId - commande a laquelle rattacher la ligne
 * @param catalogItem - article choisi par le client
 * @param answers - reponses du client, chacune associee au `CatalogItemField` correspondant
 */
export async function addItemFromAnswers(
  orderId: string,
  catalogItem: CatalogItem,
  answers: { field: CatalogItemField; value: string }[]
) {
  const quantityAnswer = answers.find((a) => a.field.style === "QUANTITY");
  // parseInt peut renvoyer NaN sur une saisie non numerique ; on retombe alors sur 1 plutot
  // que de propager NaN dans le calcul du total.
  const quantity = quantityAnswer ? Math.max(1, parseInt(quantityAnswer.value, 10) || 1) : 1;
  const otherAnswers = answers.filter((a) => a.field.style !== "QUANTITY");

  return prisma.orderItem.create({
    data: {
      orderId,
      catalogItemId: catalogItem.id,
      name: catalogItem.name,
      unitPrice: catalogItem.price,
      quantity,
      answers: {
        create: otherAnswers.map((a) => ({ question: a.field.label, answer: a.value })),
      },
    },
    include: { answers: true },
  });
}

/**
 * Ajoute une ligne de commande manuellement (sans passer par le formulaire client), pour
 * le cas exceptionnel ou le staff doit corriger/completer une commande depuis `/order add-item`.
 * Ne cree aucune `OrderItemAnswer` (pas de reponses a des champs personnalises dans ce cas).
 */
export async function addItem(orderId: string, catalogItem: CatalogItem, quantity = 1) {
  return prisma.orderItem.create({
    data: {
      orderId,
      catalogItemId: catalogItem.id,
      name: catalogItem.name,
      unitPrice: catalogItem.price,
      quantity: Math.max(1, quantity),
    },
  });
}

/** Retire une ligne de commande (correction staff, bouton "Retirer un article"). */
export async function removeItem(orderItemId: string) {
  await prisma.orderItem.delete({ where: { id: orderItemId } });
}

/**
 * Memorise l'id de l'unique message de commande dans le salon du ticket, pour pouvoir
 * l'editer en place a chaque changement plutot que d'en reposter un nouveau.
 */
export async function saveConfirmationMessageId(orderId: string, messageId: string) {
  return prisma.serviceOrder.update({ where: { id: orderId }, data: { confirmationMessageId: messageId } });
}

/**
 * Marque la commande comme validee par le client (clic sur "Valider la commande") — bascule
 * le message de commande de son style "composition" vers son style "suivi/facturation" pour
 * tout ajout ulterieur d'article (voir `orderLogService.upsertOrderMessage`).
 */
export async function markConfirmed(orderId: string) {
  return prisma.serviceOrder.update({ where: { id: orderId }, data: { confirmed: true } });
}

/** Change le statut logistique de la commande (PENDING / PREPARING / DELIVERED / CANCELLED). */
export async function setStatus(orderId: string, status: OrderStatus) {
  return prisma.serviceOrder.update({ where: { id: orderId }, data: { status } });
}

/** Change le statut de paiement (UNPAID / PAID). Passer a PAID declenche la generation de facture (voir order.ts). */
export async function setPaymentStatus(orderId: string, paymentStatus: PaymentStatus) {
  return prisma.serviceOrder.update({ where: { id: orderId }, data: { paymentStatus } });
}

/** Recupere une commande par son id, avec ses lignes et les reponses de chacune. */
export async function getOrderWithItems(orderId: string) {
  return prisma.serviceOrder.findUnique({
    where: { id: orderId },
    include: { items: { include: { answers: true } } },
  });
}

/** Recupere la commande d'un ticket par son id de ticket, avec ses lignes et reponses. */
export async function getOrderByTicket(ticketId: string) {
  return prisma.serviceOrder.findUnique({
    where: { ticketId },
    include: { items: { include: { answers: true } } },
  });
}

/** Calcule le total d'une commande (somme de `unitPrice * quantity` sur toutes les lignes). */
export function computeTotal(order: { items: { unitPrice: number; quantity: number }[] }): number {
  return order.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
}

/**
 * Genere et persiste un numero de facture unique pour la commande, base sur l'horodatage
 * courant encode en base 36 (compact, lisible, sans avoir besoin d'un compteur transactionnel
 * partage entre guildes). Format : `INV-<timestamp base36 majuscule>`.
 */
export async function setInvoiceNumber(orderId: string): Promise<string> {
  const invoiceNumber = `INV-${Date.now().toString(36).toUpperCase()}`;
  await prisma.serviceOrder.update({ where: { id: orderId }, data: { invoiceNumber } });
  return invoiceNumber;
}
