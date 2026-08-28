import type { CatalogFieldStyle } from "@prisma/client";
import { prisma } from "../db/prisma.js";

/**
 * Service de gestion du catalogue produits/services (`CatalogItem`) et de ses champs
 * personnalises (`CatalogItemField`) — ce que le staff configure en amont pour que le
 * client puisse ensuite composer sa commande lui-meme (voir `orderService.ts`).
 * Toutes les fonctions sont scopees par `guildId` pour l'isolation multi-serveur.
 */

/**
 * Nombre maximum de champs personnalises par article. Contrainte technique de Discord :
 * un modal (formulaire) ne peut afficher que 5 `TextInputComponent` au plus.
 */
const MAX_FIELDS_PER_ITEM = 5;

/** Cree un nouvel article de catalogue (actif par defaut). L'image est obligatoire cote commande slash. */
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

/** Supprime un article du catalogue. No-op si l'id n'existe pas ou n'appartient pas a cette guilde. */
export async function removeItem(guildId: string, id: string) {
  await prisma.catalogItem.deleteMany({ where: { id, guildId } });
}

/** Liste les articles actifs d'une guilde, dans l'ordre de creation (utilise pour le menu deroulant client). */
export async function listActive(guildId: string) {
  return prisma.catalogItem.findMany({
    where: { guildId, active: true },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Recupere un article (avec ses champs personnalises, ordonnes par `position`) en verifiant
 * qu'il appartient bien a la guilde donnee — evite qu'un id d'article d'un autre serveur
 * puisse etre utilise par erreur ou malveillance.
 */
export async function getItem(guildId: string, id: string) {
  return prisma.catalogItem.findFirst({
    where: { id, guildId },
    include: { fields: { orderBy: { position: "asc" } } },
  });
}

/**
 * Ajoute un champ personnalise a un article (ce que le client devra remplir en le commandant).
 * La `position` est deduite du nombre de champs existants, pour preserver l'ordre d'ajout
 * dans le modal genere dynamiquement.
 *
 * @throws si l'article n'existe pas, s'il a deja atteint `MAX_FIELDS_PER_ITEM`, ou si on
 *   tente d'ajouter un 2e champ de style QUANTITY (au plus un par article : sa reponse
 *   alimente directement `OrderItem.quantity`, en avoir deux serait ambigu).
 */
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
    throw new Error("Cet article a déjà un champ de type quantité.");
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

/**
 * Supprime un champ personnalise. Le filtre `catalogItem: { guildId }` empeche de supprimer
 * un champ appartenant a un article d'une autre guilde meme si son id est devine/reutilise.
 */
export async function removeField(guildId: string, fieldId: string) {
  await prisma.catalogItemField.deleteMany({
    where: { id: fieldId, catalogItem: { guildId } },
  });
}

/** Liste les champs personnalises d'un article (tableau vide si l'article n'existe pas). */
export async function listFields(guildId: string, itemId: string) {
  const item = await getItem(guildId, itemId);
  return item?.fields ?? [];
}
