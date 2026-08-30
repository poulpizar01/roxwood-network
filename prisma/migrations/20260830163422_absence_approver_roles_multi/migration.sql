/*
  Warnings:

  - You are about to drop the column `absenceApproverRoleId` on the `GuildConfig` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "GuildConfig" DROP COLUMN "absenceApproverRoleId",
ADD COLUMN     "absenceApproverRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
