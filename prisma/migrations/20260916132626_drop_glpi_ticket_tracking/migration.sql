-- DropForeignKey
ALTER TABLE "glpi_ticket" DROP CONSTRAINT "glpi_ticket_userId_fkey";

-- DropTable
DROP TABLE "glpi_ticket";
