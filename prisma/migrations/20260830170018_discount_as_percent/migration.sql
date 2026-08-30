/*
  Warnings:

  - You are about to drop the column `discount` on the `ServiceOrder` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "ServiceOrder" DROP COLUMN "discount",
ADD COLUMN     "discountPercent" INTEGER NOT NULL DEFAULT 0;
