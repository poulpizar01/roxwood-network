import type { CatalogFieldStyle } from "@prisma/client";
import { prisma } from "../db/prisma.js";

const MAX_FIELDS_PER_ITEM = 5;

export async function addItem(
  guildId: string,
  data: { name: string; price: number; imageUrl?: string; description?: string }
) {
  return prisma.catalogItem.create({
    data: {
      guildId,
      name: data.name,
      price: data.price,
      imageUrl: data.imageUrl,
      description: data.description,
    },
  });
}

export async function removeItem(guildId: string, id: string) {
  await prisma.catalogItem.deleteMany({ where: { id, guildId } });
}

export async function listActive(guildId: string) {
  return prisma.catalogItem.findMany({
    where: { guildId, active: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function getItem(guildId: string, id: string) {
  return prisma.catalogItem.findFirst({
    where: { id, guildId },
    include: { fields: { orderBy: { position: "asc" } } },
  });
}

export async function addField(
  guildId: string,
  itemId: string,
  data: { label: string; style: CatalogFieldStyle; required: boolean }
) {
  const item = await getItem(guildId, itemId);
  if (!item) throw new Error("Article introuvable.");
  if (item.fields.length >= MAX_FIELDS_PER_ITEM) {
    throw new Error(`Un article ne peut pas avoir plus de ${MAX_FIELDS_PER_ITEM} champs (limite Discord).`);
  }
  if (data.style === "QUANTITY" && item.fields.some((f) => f.style === "QUANTITY")) {
    throw new Error("Cet article a deja un champ de type quantite.");
  }

  return prisma.catalogItemField.create({
    data: {
      catalogItemId: itemId,
      label: data.label,
      style: data.style,
      required: data.required,
      position: item.fields.length,
    },
  });
}

export async function removeField(guildId: string, fieldId: string) {
  await prisma.catalogItemField.deleteMany({
    where: { id: fieldId, catalogItem: { guildId } },
  });
}

export async function listFields(guildId: string, itemId: string) {
  const item = await getItem(guildId, itemId);
  return item?.fields ?? [];
}
