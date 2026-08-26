import type { CatalogItem, CatalogItemField, OrderStatus, PaymentStatus } from "@prisma/client";
import { prisma } from "../db/prisma.js";

export async function getOrCreateOrder(ticketId: string) {
  const existing = await prisma.serviceOrder.findUnique({ where: { ticketId } });
  if (existing) return existing;

  return prisma.serviceOrder.create({ data: { ticketId } });
}

export async function addItemFromAnswers(
  orderId: string,
  catalogItem: CatalogItem,
  answers: { field: CatalogItemField; value: string }[]
) {
  const quantityAnswer = answers.find((a) => a.field.style === "QUANTITY");
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

export async function removeItem(orderItemId: string) {
  await prisma.orderItem.delete({ where: { id: orderItemId } });
}

export async function setStatus(orderId: string, status: OrderStatus) {
  return prisma.serviceOrder.update({ where: { id: orderId }, data: { status } });
}

export async function setPaymentStatus(orderId: string, paymentStatus: PaymentStatus) {
  return prisma.serviceOrder.update({ where: { id: orderId }, data: { paymentStatus } });
}

export async function getOrderWithItems(orderId: string) {
  return prisma.serviceOrder.findUnique({
    where: { id: orderId },
    include: { items: { include: { answers: true } } },
  });
}

export async function getOrderByTicket(ticketId: string) {
  return prisma.serviceOrder.findUnique({
    where: { ticketId },
    include: { items: { include: { answers: true } } },
  });
}

export function computeTotal(order: { items: { unitPrice: number; quantity: number }[] }): number {
  return order.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
}

export async function setInvoiceNumber(orderId: string): Promise<string> {
  const invoiceNumber = `INV-${Date.now().toString(36).toUpperCase()}`;
  await prisma.serviceOrder.update({ where: { id: orderId }, data: { invoiceNumber } });
  return invoiceNumber;
}
