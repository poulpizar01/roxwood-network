import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import type { Command } from "./types.js";
import { getTicketByChannel } from "../services/ticketService.js";
import { getItem } from "../services/catalogService.js";
import {
  addItem,
  computeTotal,
  getOrderByTicket,
  removeItem,
  setInvoiceNumber,
  setPaymentStatus,
  setStatus,
} from "../services/orderService.js";
import { renderInvoice } from "../services/invoiceImageService.js";

const ORDER_STATUS_CHOICES = [
  { name: "En attente", value: "PENDING" },
  { name: "En preparation", value: "PREPARING" },
  { name: "Livree", value: "DELIVERED" },
  { name: "Annulee", value: "CANCELLED" },
] as const;

async function sendInvoice(
  interaction: ChatInputCommandInteraction,
  ticket: { openerId: string | null },
  order: Awaited<ReturnType<typeof getOrderByTicket>>
) {
  if (!order) return;

  const invoiceNumber = order.invoiceNumber ?? (await setInvoiceNumber(order.id));

  let customerLabel = "Client";
  if (ticket.openerId && interaction.guild) {
    try {
      const member = await interaction.guild.members.fetch(ticket.openerId);
      customerLabel = member.displayName;
    } catch {
      // membre introuvable (parti du serveur) : on garde le libelle par defaut
    }
  }

  const buffer = await renderInvoice({
    invoiceNumber,
    guildName: interaction.guild?.name ?? "Roxwood Network",
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

  if (interaction.channel && interaction.channel.isTextBased() && !interaction.channel.isDMBased()) {
    await interaction.channel.send({ files: [{ attachment: buffer, name: `facture-${invoiceNumber}.png` }] });
  }
}

export const orderCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("order")
    .setDescription("Gerer la commande du ticket courant (corrections staff)")
    .addSubcommand((sub) =>
      sub
        .setName("add-item")
        .setDescription("Ajouter manuellement un article a la commande")
        .addStringOption((opt) => opt.setName("catalog-item").setDescription("Identifiant de l'article catalogue").setRequired(true))
        .addIntegerOption((opt) => opt.setName("quantity").setDescription("Quantite").setMinValue(1).setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove-item")
        .setDescription("Retirer un article de la commande")
        .addStringOption((opt) => opt.setName("order-item").setDescription("Identifiant de la ligne de commande").setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName("status")
        .setDescription("Changer le statut de la commande")
        .addStringOption((opt) =>
          opt.setName("etape").setDescription("Nouveau statut").setRequired(true).addChoices(...ORDER_STATUS_CHOICES)
        )
    )
    .addSubcommand((sub) => sub.setName("paid").setDescription("Marquer la commande comme payee et generer la facture"))
    .addSubcommand((sub) => sub.setName("invoice").setDescription("Regenerer/renvoyer l'image de facture")) as SlashCommandBuilder,

  async execute(interaction) {
    if (!interaction.inGuild()) return;

    const ticket = await getTicketByChannel(interaction.channelId);
    if (!ticket || ticket.type !== "SERVICE") {
      await interaction.reply({ content: "Ce salon n'est pas rattache a une commande.", ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === "add-item") {
      const catalogItemId = interaction.options.getString("catalog-item", true);
      const quantity = interaction.options.getInteger("quantity") ?? 1;
      const item = await getItem(interaction.guildId, catalogItemId);
      if (!item) {
        await interaction.reply({ content: "Article introuvable.", ephemeral: true });
        return;
      }
      const order = await getOrderByTicket(ticket.id);
      if (!order) {
        await interaction.reply({ content: "Aucune commande pour ce ticket.", ephemeral: true });
        return;
      }
      await addItem(order.id, item, quantity);
      await interaction.reply(`Article ajoute : **${item.name}** x${quantity}`);
      return;
    }

    if (sub === "remove-item") {
      const orderItemId = interaction.options.getString("order-item", true);
      await removeItem(orderItemId);
      await interaction.reply({ content: "Article retire de la commande.", ephemeral: true });
      return;
    }

    if (sub === "status") {
      const etape = interaction.options.getString("etape", true) as (typeof ORDER_STATUS_CHOICES)[number]["value"];
      const order = await getOrderByTicket(ticket.id);
      if (!order) {
        await interaction.reply({ content: "Aucune commande pour ce ticket.", ephemeral: true });
        return;
      }
      await setStatus(order.id, etape);
      const label = ORDER_STATUS_CHOICES.find((c) => c.value === etape)?.name ?? etape;
      await interaction.reply(`Commande mise a jour : **${label}**`);
      return;
    }

    if (sub === "paid") {
      const order = await getOrderByTicket(ticket.id);
      if (!order || order.items.length === 0) {
        await interaction.reply({ content: "Aucune commande (ou commande vide) pour ce ticket.", ephemeral: true });
        return;
      }
      await setPaymentStatus(order.id, "PAID");
      await interaction.deferReply();
      const updated = await getOrderByTicket(ticket.id);
      await sendInvoice(interaction, ticket, updated);
      await interaction.editReply(`Commande marquee payee (total : ${computeTotal(order).toLocaleString("fr-FR")} $).`);
      return;
    }

    if (sub === "invoice") {
      const order = await getOrderByTicket(ticket.id);
      if (!order || order.items.length === 0) {
        await interaction.reply({ content: "Aucune commande (ou commande vide) pour ce ticket.", ephemeral: true });
        return;
      }
      await interaction.deferReply();
      await sendInvoice(interaction, ticket, order);
      await interaction.editReply("Facture renvoyee.");
    }
  },
};
