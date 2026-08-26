import type { ApplicationStatus } from "@prisma/client";
import { prisma } from "../db/prisma.js";

/**
 * Service dedie au flux de recrutement : une `RecruitmentApplication` (1:1 avec un `Ticket`
 * de type RECRUITMENT) porte le statut du pipeline, le recruteur assigne, et ses reponses
 * au formulaire (`RecruitmentAnswer[]`).
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
    include: { answers: true },
  });
}

/** Fait avancer la candidature dans le pipeline (PENDING / INTERVIEW / ACCEPTED / REJECTED). */
export async function setStatus(ticketId: string, status: ApplicationStatus) {
  return prisma.recruitmentApplication.update({ where: { ticketId }, data: { status } });
}

/** Assigne un membre du staff comme recruteur responsable de cette candidature. */
export async function assignRecruiter(ticketId: string, recruiterId: string) {
  return prisma.recruitmentApplication.update({ where: { ticketId }, data: { recruiterId } });
}

/** Recupere la candidature d'un ticket avec ses reponses, ou `null` si aucune n'existe. */
export async function getApplication(ticketId: string) {
  return prisma.recruitmentApplication.findUnique({
    where: { ticketId },
    include: { answers: true },
  });
}
