import type { ApplicationStatus } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { getTicketById } from "./ticketService.js";
import { dispatchWebhook } from "./webhookDispatcher.js";

/**
 * Service dedie au flux de recrutement : une `RecruitmentApplication` (1:1 avec un `Ticket`
 * de type RECRUITMENT) porte le statut du pipeline, le recruteur assigne, ses reponses
 * au formulaire (`RecruitmentAnswer[]`) et les pieces jointes envoyees par le candidat
 * (`RecruitmentAttachment[]`).
 */

/**
 * Envoie l'etat complet et courant d'une candidature sur l'unique evenement
 * `recruitment.updated` — meme principe que `absence.updated`/`order.updated` : un recepteur
 * n'a qu'un seul type d'evenement a ecouter pour toujours avoir la derniere version d'une
 * candidature, sans fusionner plusieurs evenements lui-meme. Les octets des pieces jointes ne
 * sont jamais inclus (juste leur nom) : le JSON du webhook n'est pas fait pour transporter du
 * binaire, seul le nom permet au recepteur de savoir qu'un fichier existe. No-op silencieux
 * si le ticket/la candidature n'existe plus (ne devrait pas arriver en usage normal).
 */
async function dispatchRecruitmentUpdated(ticketId: string): Promise<void> {
  const ticket = await getTicketById(ticketId);
  const application = await getApplication(ticketId);
  if (!ticket || !application) return;

  await dispatchWebhook(ticket.guildId, "recruitment.updated", {
    ticketId,
    channelId: ticket.channelId,
    candidateId: ticket.openerId,
    status: application.status,
    recruiterId: application.recruiterId,
    submittedAt: application.submittedAt?.toISOString() ?? null,
    answers: application.answers.map((a) => ({ question: a.question, answer: a.answer })),
    attachments: application.attachments.map((a) => ({ filename: a.filename })),
  });
}

/**
 * Cree la candidature associee a un ticket, juste apres sa detection (voir `onChannelCreate`).
 * Statut initial PENDING par defaut (valeur par defaut du schema Prisma).
 */
export async function createApplication(ticketId: string) {
  return prisma.recruitmentApplication.create({ data: { ticketId } });
}

/**
 * Enregistre les reponses du candidat au formulaire (modal Discord) et marque la candidature
 * comme soumise (`submittedAt`). Suppose que la candidature existe deja (creee a l'ouverture
 * du ticket) : leve une erreur sinon (`findUniqueOrThrow`), ce qui ne devrait arriver que si
 * le canal n'a pas ete correctement suivi comme ticket RECRUITMENT.
 *
 * @param ticketId - id du ticket (pas le channelId Discord)
 * @param answers - paires question/reponse dans l'ordre du formulaire
 */
export async function saveAnswers(ticketId: string, answers: { question: string; answer: string }[]) {
  const application = await prisma.recruitmentApplication.findUniqueOrThrow({ where: { ticketId } });

  await prisma.recruitmentAnswer.createMany({
    data: answers.map((a) => ({ applicationId: application.id, question: a.question, answer: a.answer })),
  });

  const updated = await prisma.recruitmentApplication.update({
    where: { id: application.id },
    data: { submittedAt: new Date() },
    include: { answers: true, attachments: true },
  });
  await dispatchRecruitmentUpdated(ticketId);
  return updated;
}

/** Fait avancer la candidature dans le pipeline (PENDING / INTERVIEW / ACCEPTED / REJECTED). */
export async function setStatus(ticketId: string, status: ApplicationStatus) {
  const updated = await prisma.recruitmentApplication.update({ where: { ticketId }, data: { status } });
  await dispatchRecruitmentUpdated(ticketId);
  return updated;
}

/** Assigne un membre du staff comme recruteur responsable de cette candidature (reassignation possible). */
export async function assignRecruiter(ticketId: string, recruiterId: string) {
  const updated = await prisma.recruitmentApplication.update({ where: { ticketId }, data: { recruiterId } });
  await dispatchRecruitmentUpdated(ticketId);
  return updated;
}

/**
 * Memorise ou vit le message de suivi (recap + boutons Statut/S'assigner), pour pouvoir
 * le retrouver et l'editer en place lors d'un changement de statut ou d'assignation.
 */
export async function saveLogMessageRef(ticketId: string, logChannelId: string, logMessageId: string) {
  return prisma.recruitmentApplication.update({ where: { ticketId }, data: { logChannelId, logMessageId } });
}

/**
 * Rattache une piece jointe (image, document) envoyee par le candidat en message classique
 * dans le salon du ticket — les modals Discord ne supportent pas l'upload de fichier, c'est
 * donc le seul moyen technique de joindre des fichiers a une candidature. Les octets (deja
 * telecharges par l'appelant depuis l'URL CDN Discord, voir `messageCreate.ts`) sont stockes
 * directement plutot que cette URL, qui est signee et expire.
 */
export async function addAttachment(ticketId: string, data: Buffer, filename: string) {
  const application = await prisma.recruitmentApplication.findUniqueOrThrow({ where: { ticketId } });
  const attachment = await prisma.recruitmentAttachment.create({ data: { applicationId: application.id, data, filename } });
  await dispatchRecruitmentUpdated(ticketId);
  return attachment;
}

/** Recupere la candidature d'un ticket avec ses reponses et pieces jointes, ou `null` si aucune n'existe. */
export async function getApplication(ticketId: string) {
  return prisma.recruitmentApplication.findUnique({
    where: { ticketId },
    include: { answers: true, attachments: true },
  });
}
