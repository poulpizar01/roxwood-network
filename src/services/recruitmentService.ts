import type { ApplicationStatus } from "@prisma/client";
import { prisma } from "../db/prisma.js";

/**
 * Service dedie au flux de recrutement : une `RecruitmentApplication` (1:1 avec un `Ticket`
 * de type RECRUITMENT) porte le statut du pipeline, le recruteur assigne, ses reponses
 * au formulaire (`RecruitmentAnswer[]`) et les pieces jointes envoyees par le candidat
 * (`RecruitmentAttachment[]`).
 */

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

  return prisma.recruitmentApplication.update({
    where: { id: application.id },
    data: { submittedAt: new Date() },
    include: { answers: true, attachments: true },
  });
}

/** Fait avancer la candidature dans le pipeline (PENDING / INTERVIEW / ACCEPTED / REJECTED). */
export async function setStatus(ticketId: string, status: ApplicationStatus) {
  return prisma.recruitmentApplication.update({ where: { ticketId }, data: { status } });
}

/** Assigne un membre du staff comme recruteur responsable de cette candidature (reassignation possible). */
export async function assignRecruiter(ticketId: string, recruiterId: string) {
  return prisma.recruitmentApplication.update({ where: { ticketId }, data: { recruiterId } });
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
  return prisma.recruitmentAttachment.create({ data: { applicationId: application.id, data, filename } });
}

/** Recupere la candidature d'un ticket avec ses reponses et pieces jointes, ou `null` si aucune n'existe. */
export async function getApplication(ticketId: string) {
  return prisma.recruitmentApplication.findUnique({
    where: { ticketId },
    include: { answers: true, attachments: true },
  });
}
