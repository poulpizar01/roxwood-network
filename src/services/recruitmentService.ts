import type { ApplicationStatus } from "@prisma/client";
import { prisma } from "../db/prisma.js";

export async function createApplication(ticketId: string) {
  return prisma.recruitmentApplication.create({ data: { ticketId } });
}

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

export async function setStatus(ticketId: string, status: ApplicationStatus) {
  return prisma.recruitmentApplication.update({ where: { ticketId }, data: { status } });
}

export async function assignRecruiter(ticketId: string, recruiterId: string) {
  return prisma.recruitmentApplication.update({ where: { ticketId }, data: { recruiterId } });
}

export async function getApplication(ticketId: string) {
  return prisma.recruitmentApplication.findUnique({
    where: { ticketId },
    include: { answers: true },
  });
}
