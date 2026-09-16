-- CreateTable
CREATE TABLE "glpi_ticket" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "glpiId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "glpi_ticket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "glpi_ticket_userId_glpiId_key" ON "glpi_ticket"("userId", "glpiId");

-- AddForeignKey
ALTER TABLE "glpi_ticket" ADD CONSTRAINT "glpi_ticket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
