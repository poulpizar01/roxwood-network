import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";

/**
 * Rendu de la facture en image PNG (et non PDF, par choix explicite) via `@napi-rs/canvas`.
 * Necessite les polices systeme `fontconfig`/`ttf-dejavu` installees dans l'image Docker
 * (voir Dockerfile) : sans elles, le canvas dessine bien les formes/couleurs mais aucun texte
 * n'apparait, silencieusement (pas d'erreur a l'execution).
 */

/** Une ligne de commande a afficher sur la facture, avec les reponses du client aux champs personnalises. */
export interface InvoiceOrderItem {
  name: string;
  unitPrice: number;
  quantity: number;
  answers: { question: string; answer: string }[];
}

/** Donnees necessaires pour generer une facture ; decouple volontairement des types Prisma (le caller mappe). */
export interface InvoiceData {
  invoiceNumber: string;
  guildName: string;
  customerLabel: string;
  items: InvoiceOrderItem[];
  paymentStatus: "PAID" | "UNPAID";
  createdAt: Date;
}

/** Largeur fixe de l'image generee, en pixels. */
const WIDTH = 900;
/** Hauteur du bandeau d'en-tete (nom de l'entreprise, numero/date/client, badge de paiement). */
const HEADER_HEIGHT = 170;
/** Hauteur de base d'une ligne d'article, avant ajout des lignes de reponses eventuelles. */
const ITEM_ROW_HEIGHT = 56;
/** Hauteur d'une ligne de reponse (question/reponse) affichee sous un article. */
const ANSWER_LINE_HEIGHT = 22;
/** Hauteur du bandeau de pied de page (total). */
const FOOTER_HEIGHT = 110;
/** Marge horizontale appliquee de chaque cote du contenu. */
const MARGIN = 40;

const COLOR_BG = "#1e1f29";
const COLOR_HEADER = "#161720";
const COLOR_ACCENT = "#5865f2";
const COLOR_TEXT = "#f2f3f5";
const COLOR_MUTED = "#9aa0ac";
const COLOR_ROW_ALT = "#242531";

/** Formate un montant en devise in-game (ex: `1 250 $`), avec separateur de milliers fr-FR. */
function formatAmount(amount: number): string {
  return `${amount.toLocaleString("fr-FR")} $`;
}

/**
 * Tronque un texte avec "..." s'il depasse `maxWidth` une fois mesure avec la police/taille
 * courante du contexte. Le canvas ne fait pas de retour a la ligne automatique : necessaire
 * pour eviter qu'un nom d'article trop long ne deborde sur la colonne prix.
 */
function truncate(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 1 && ctx.measureText(`${truncated}...`).width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}...`;
}

/** Hauteur totale occupee par une ligne d'article, incluant ses eventuelles lignes de reponses. */
function itemHeight(item: InvoiceOrderItem): number {
  return ITEM_ROW_HEIGHT + item.answers.length * ANSWER_LINE_HEIGHT;
}

/**
 * Dessine la facture et retourne le PNG encode en Buffer, pret a etre envoye comme piece
 * jointe Discord. La hauteur du canvas est calculee dynamiquement a partir du nombre
 * d'articles et de reponses (pas de canvas de taille fixe : une commande a beaucoup
 * d'articles/reponses doit rester lisible sans rien couper).
 *
 * Mise en page (de haut en bas) :
 * 1. en-tete : nom de l'entreprise, titre "FACTURE", numero/date/client, badge paye/non paye
 * 2. une ligne par article (fond alterne clair/fonce) : nom, quantite x prix = sous-total,
 *    puis les reponses du client aux champs personnalises en petit texte gris
 * 3. pied de page : total
 */
export async function renderInvoice(data: InvoiceData): Promise<Buffer> {
  const itemsHeight = data.items.reduce((sum, item) => sum + itemHeight(item), 0);
  const height = HEADER_HEIGHT + Math.max(itemsHeight, ITEM_ROW_HEIGHT) + FOOTER_HEIGHT;

  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext("2d");

  // Fond general (visible sous le pied de page et entre les eventuelles zones non couvertes).
  ctx.fillStyle = COLOR_BG;
  ctx.fillRect(0, 0, WIDTH, height);

  // Bandeau d'en-tete + fine ligne d'accent en bas de bandeau.
  ctx.fillStyle = COLOR_HEADER;
  ctx.fillRect(0, 0, WIDTH, HEADER_HEIGHT);
  ctx.fillStyle = COLOR_ACCENT;
  ctx.fillRect(0, HEADER_HEIGHT - 4, WIDTH, 4);

  ctx.fillStyle = COLOR_TEXT;
  ctx.font = "bold 32px DejaVu Sans";
  ctx.fillText(data.guildName, MARGIN, 56);

  ctx.font = "bold 24px DejaVu Sans";
  ctx.fillStyle = COLOR_ACCENT;
  ctx.textAlign = "right";
  ctx.fillText("FACTURE", WIDTH - MARGIN, 56);
  ctx.textAlign = "left";

  ctx.font = "16px DejaVu Sans";
  ctx.fillStyle = COLOR_MUTED;
  ctx.fillText(`Numero : ${data.invoiceNumber}`, MARGIN, 90);
  ctx.fillText(`Date : ${data.createdAt.toLocaleDateString("fr-FR")}`, MARGIN, 114);
  ctx.fillText(`Client : ${data.customerLabel}`, MARGIN, 138);

  // Badge de statut paiement, largeur calculee dynamiquement autour du texte ("PAYE" vs "NON PAYE").
  const badgeText = data.paymentStatus === "PAID" ? "PAYE" : "NON PAYE";
  const badgeColor = data.paymentStatus === "PAID" ? "#3ba55d" : "#ed4245";
  ctx.font = "bold 16px DejaVu Sans";
  const badgeWidth = ctx.measureText(badgeText).width + 32;
  ctx.fillStyle = badgeColor;
  ctx.fillRect(WIDTH - MARGIN - badgeWidth, 96, badgeWidth, 32);
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.fillText(badgeText, WIDTH - MARGIN - badgeWidth / 2, 118);
  ctx.textAlign = "left";

  // Une ligne par article, fond alterne pour la lisibilite quand il y en a plusieurs.
  let y = HEADER_HEIGHT;
  data.items.forEach((item, index) => {
    const rowHeight = itemHeight(item);
    ctx.fillStyle = index % 2 === 0 ? COLOR_BG : COLOR_ROW_ALT;
    ctx.fillRect(0, y, WIDTH, rowHeight);

    const subtotal = item.unitPrice * item.quantity;
    ctx.font = "bold 18px DejaVu Sans";
    ctx.fillStyle = COLOR_TEXT;
    ctx.fillText(truncate(ctx, item.name, 420), MARGIN, y + 32);

    ctx.font = "16px DejaVu Sans";
    ctx.fillStyle = COLOR_MUTED;
    ctx.textAlign = "right";
    ctx.fillText(`x${item.quantity}  ·  ${formatAmount(item.unitPrice)}  =  ${formatAmount(subtotal)}`, WIDTH - MARGIN, y + 32);
    ctx.textAlign = "left";

    // Reponses du client aux champs personnalises (ex: date/nombre d'invites), en petit texte indente.
    let answerY = y + 32;
    for (const answer of item.answers) {
      answerY += ANSWER_LINE_HEIGHT;
      ctx.font = "14px DejaVu Sans";
      ctx.fillStyle = COLOR_MUTED;
      ctx.fillText(truncate(ctx, `${answer.question} : ${answer.answer}`, WIDTH - MARGIN * 2), MARGIN + 12, answerY);
    }

    y += rowHeight;
  });

  // Pied de page : total general de la commande.
  const total = data.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  ctx.fillStyle = COLOR_HEADER;
  ctx.fillRect(0, y, WIDTH, FOOTER_HEIGHT);

  ctx.font = "bold 26px DejaVu Sans";
  ctx.fillStyle = COLOR_TEXT;
  ctx.textAlign = "right";
  ctx.fillText(`Total : ${formatAmount(total)}`, WIDTH - MARGIN, y + 60);
  ctx.textAlign = "left";

  return canvas.encode("png");
}
