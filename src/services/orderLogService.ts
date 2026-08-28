import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type Client } from "discord.js";
import { computeTotal, getOrderByTicket, saveConfirmationMessageId, setInvoiceNumber } from "./orderService.js";
import { getTicketById } from "./ticketService.js";
import { renderInvoice } from "./invoiceImageService.js";
import { logger } from "../utils/logger.js";

/**
 * Construction et mise a jour de l'unique message de commande dans le salon du ticket :
 * un embed "en cours" pendant que le client compose sa commande, puis un embed "suivi"
 * (recap + boutons Statut/Marquer payee/Facture/Ajouter/Retirer) une fois validee. Le
 * meme message est edite en place tout du long (voir `upsertOrderMessage`) plutot que
 * reposte a chaque article ajoute. Regroupe ici pour etre reutilisable a la fois par les
 * boutons (`interactionCreate.ts`) sans dependre d'un type d'interaction precis (juste un `Client`).
 */

/** Statuts logistiques disponibles pour une commande (independants du statut de paiement). */
export const ORDER_STATUS_CHOICES = [
  { name: "En attente", value: "PENDING" },
  { name: "En préparation", value: "PREPARING" },
  { name: "Livrée", value: "DELIVERED" },
  { name: "Annulée", value: "CANCELLED" },
] as const;

/** Libelle affichable d'un statut de commande (fallback sur la valeur brute si inconnue). */
export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_CHOICES.find((c) => c.value === status)?.name ?? status;
}

type OrderWithItems = NonNullable<Awaited<ReturnType<typeof getOrderByTicket>>>;

/** Embed affiche pendant que le client compose sa commande (avant "Valider la commande"). */
function buildOrderInProgressEmbed(order: OrderWithItems): EmbedBuilder {
  const total = computeTotal(order);
  return new EmbedBuilder()
    .setTitle("Commande en cours")
    .setColor(0x5865f2)
    .setDescription(
      order.items.map((i) => `**${i.name}** x${i.quantity} — ${(i.unitPrice * i.quantity).toLocaleString("fr-FR")} $`).join("\n") ||
        "Aucun article"
    )
    .addFields({ name: "Total", value: `${total.toLocaleString("fr-FR")} $` });
}

/** Boutons affiches pendant la composition : continuer d'ajouter, ou valider. */
function buildOrderInProgressRow(): ActionRowBuilder<ButtonBuilder> {
  const addMore = new ButtonBuilder().setCustomId("order:add-more").setLabel("Ajouter un article").setStyle(ButtonStyle.Secondary);
  const confirm = new ButtonBuilder().setCustomId("order:confirm").setLabel("Valider la commande").setStyle(ButtonStyle.Success);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(addMore, confirm);
}

/** Construit l'embed recapitulatif d'une commande validee (articles, statut, paiement, total). */
function buildOrderEmbed(order: OrderWithItems): EmbedBuilder {
  const total = computeTotal(order);

  return new EmbedBuilder()
    .setTitle("Commande")
    .setColor(order.paymentStatus === "PAID" ? 0x57f287 : 0x5865f2)
    .setDescription(
      order.items.map((i) => `**${i.name}** x${i.quantity} — ${(i.unitPrice * i.quantity).toLocaleString("fr-FR")} $`).join("\n") ||
        "Aucun article"
    )
    .addFields(
      { name: "Statut", value: `**${orderStatusLabel(order.status)}**`, inline: true },
      { name: "Paiement", value: order.paymentStatus === "PAID" ? "**Payée** ✅" : "**Non payée**", inline: true },
      { name: "Total", value: `${total.toLocaleString("fr-FR")} $`, inline: true }
    );
}

/**
 * Boutons du message de commande validee. Ligne 1 : suivi (statut, paiement, facture).
 * Ligne 2 : corrections manuelles exceptionnelles ("Ajouter un article" reutilise le
 * meme bouton/flux que le client, "Retirer un article" ouvre un menu des lignes existantes).
 */
function buildOrderActionRows(ticketId: string): ActionRowBuilder<ButtonBuilder>[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`order:status:${ticketId}`).setLabel("Statut").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`order:mark-paid:${ticketId}`).setLabel("Marquer payée").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`order:invoice:${ticketId}`).setLabel("Facture").setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("order:add-more").setLabel("Ajouter un article").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`order:remove-item:${ticketId}`).setLabel("Retirer un article").setStyle(ButtonStyle.Danger)
  );
  return [row1, row2];
}

/**
 * Cree l'unique message de commande d'un ticket s'il n'existe pas encore, ou l'edite en
 * place sinon — evite de reposter un nouveau message a chaque article ajoute. Choisit
 * automatiquement le style "en cours" ou "valide" selon `order.confirmed`. Si le message
 * memorise n'est plus accessible (supprime manuellement), en reposte un nouveau et met a
 * jour la reference.
 */
export async function upsertOrderMessage(client: Client, ticketId: string): Promise<void> {
  const ticket = await getTicketById(ticketId);
  const order = await getOrderByTicket(ticketId);
  if (!ticket || !order) return;

  const payload = order.confirmed
    ? { embeds: [buildOrderEmbed(order)], components: buildOrderActionRows(ticketId) }
    : { embeds: [buildOrderInProgressEmbed(order)], components: [buildOrderInProgressRow()] };

  const channel = await client.channels.fetch(ticket.channelId);
  if (!channel?.isTextBased() || channel.isDMBased()) return;

  if (order.confirmationMessageId) {
    try {
      const message = await channel.messages.fetch(order.confirmationMessageId);
      await message.edit(payload);
      return;
    } catch (error) {
      logger.warn(`Message de commande ${order.confirmationMessageId} introuvable, nouveau message poste`, error);
    }
  }

  const message = await channel.send(payload);
  await saveConfirmationMessageId(order.id, message.id);
}

/**
 * Alias de `upsertOrderMessage` utilise apres un changement qui ne touche pas aux lignes
 * de la commande (statut, paiement...), pour un nom explicite au point d'appel.
 */
export const refreshOrderMessage = upsertOrderMessage;

/**
 * Genere l'image de facture et la poste dans le salon du ticket. Reutilise le numero de
 * facture existant s'il y en a deja un, pour eviter que renvoyer la facture n'en change
 * le numero. Resout le pseudo affiche du client (fallback "Client" si le membre a quitte
 * le serveur ou si l'opener n'a pas pu etre determine a l'ouverture du ticket).
 */
export async function sendInvoiceForOrder(
  client: Client,
  guildId: string,
  ticket: { channelId: string; openerId: string | null },
  order: OrderWithItems
): Promise<void> {
  const invoiceNumber = order.invoiceNumber ?? (await setInvoiceNumber(order.id));

  let guildName = "Roxwood Network";
  let customerLabel = "Client";
  try {
    const guild = await client.guilds.fetch(guildId);
    guildName = guild.name;
    if (ticket.openerId) {
      try {
        const member = await guild.members.fetch(ticket.openerId);
        customerLabel = member.displayName;
      } catch {
        // membre introuvable (parti du serveur) : on garde le libelle par defaut
      }
    }
  } catch (error) {
    logger.warn(`Impossible de recuperer la guilde ${guildId} pour la facture`, error);
  }

  const buffer = await renderInvoice({
    invoiceNumber,
    guildName,
    customerLabel,
    items: order.items.map((i) => ({
      name: i.name,
      unitPrice: i.unitPrice,
      quantity: i.quantity,
      answers: i.answers.map((a) => ({ question: a.question, answer: a.answer })),
    })),
    paymentStatus: order.paymentStatus,
    createdAt: order.createdAt,
  });

  const channel = await client.channels.fetch(ticket.channelId);
  if (channel?.isTextBased() && !channel.isDMBased()) {
    await channel.send({ files: [{ attachment: buffer, name: `facture-${invoiceNumber}.png` }] });
  }
}
