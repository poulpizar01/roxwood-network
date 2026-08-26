import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";

export interface InvoiceOrderItem {
  name: string;
  unitPrice: number;
  quantity: number;
  answers: { question: string; answer: string }[];
}

export interface InvoiceData {
  invoiceNumber: string;
  guildName: string;
  customerLabel: string;
  items: InvoiceOrderItem[];
  paymentStatus: "PAID" | "UNPAID";
  createdAt: Date;
}

const WIDTH = 900;
const HEADER_HEIGHT = 170;
const ITEM_ROW_HEIGHT = 56;
const ANSWER_LINE_HEIGHT = 22;
const FOOTER_HEIGHT = 110;
const MARGIN = 40;

const COLOR_BG = "#1e1f29";
const COLOR_HEADER = "#161720";
const COLOR_ACCENT = "#5865f2";
const COLOR_TEXT = "#f2f3f5";
const COLOR_MUTED = "#9aa0ac";
const COLOR_ROW_ALT = "#242531";

function formatAmount(amount: number): string {
  return `${amount.toLocaleString("fr-FR")} $`;
}

function truncate(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 1 && ctx.measureText(`${truncated}...`).width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}...`;
}

function itemHeight(item: InvoiceOrderItem): number {
  return ITEM_ROW_HEIGHT + item.answers.length * ANSWER_LINE_HEIGHT;
}

export async function renderInvoice(data: InvoiceData): Promise<Buffer> {
  const itemsHeight = data.items.reduce((sum, item) => sum + itemHeight(item), 0);
  const height = HEADER_HEIGHT + Math.max(itemsHeight, ITEM_ROW_HEIGHT) + FOOTER_HEIGHT;

  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = COLOR_BG;
  ctx.fillRect(0, 0, WIDTH, height);

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

    let answerY = y + 32;
    for (const answer of item.answers) {
      answerY += ANSWER_LINE_HEIGHT;
      ctx.font = "14px DejaVu Sans";
      ctx.fillStyle = COLOR_MUTED;
      ctx.fillText(truncate(ctx, `${answer.question} : ${answer.answer}`, WIDTH - MARGIN * 2), MARGIN + 12, answerY);
    }

    y += rowHeight;
  });

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
