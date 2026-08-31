import { AttachmentBuilder } from "discord.js";

/**
 * Construit une piece jointe Discord a partir d'octets stockes en base (voir
 * `CatalogItem.imageData`/`GuildConfig.shopBannerData`) et l'URL `attachment://` a donner a
 * `EmbedBuilder.setImage`/`setThumbnail` pour l'afficher — le fichier doit etre inclus dans le
 * `files` du meme message que l'embed pour que la reference resolve. Uploader a nouveau les
 * octets a chaque envoi (plutot que de reutiliser une URL CDN Discord) evite toute dependance
 * a la duree de vie d'un message anterieur, qui pourrait avoir ete supprime.
 */
export function buildImageAttachment(data: Buffer, filename: string): { attachment: AttachmentBuilder; url: string } {
  return {
    attachment: new AttachmentBuilder(data, { name: filename }),
    url: `attachment://${filename}`,
  };
}
