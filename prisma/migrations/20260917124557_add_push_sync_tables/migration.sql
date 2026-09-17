-- CreateTable
CREATE TABLE "device_token" (
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_token_pkey" PRIMARY KEY ("token")
);

-- CreateTable
CREATE TABLE "ticket_read_marker" (
    "userId" TEXT NOT NULL,
    "glpiTicketId" INTEGER NOT NULL,
    "lastReadFollowupId" INTEGER NOT NULL,

    CONSTRAINT "ticket_read_marker_pkey" PRIMARY KEY ("userId","glpiTicketId")
);

-- CreateTable
CREATE TABLE "unread_followup" (
    "userId" TEXT NOT NULL,
    "glpiTicketId" INTEGER NOT NULL,
    "followupId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unread_followup_pkey" PRIMARY KEY ("userId","followupId")
);

-- CreateTable
CREATE TABLE "glpi_ticket_state" (
    "glpiTicketId" INTEGER NOT NULL,
    "statusId" INTEGER NOT NULL,
    "lastFollowupId" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "glpi_ticket_state_pkey" PRIMARY KEY ("glpiTicketId")
);

-- CreateIndex
CREATE UNIQUE INDEX "device_token_sessionId_key" ON "device_token"("sessionId");

-- CreateIndex
CREATE INDEX "device_token_userId_idx" ON "device_token"("userId");

-- CreateIndex
CREATE INDEX "unread_followup_userId_glpiTicketId_idx" ON "unread_followup"("userId", "glpiTicketId");

-- AddForeignKey
ALTER TABLE "device_token" ADD CONSTRAINT "device_token_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_token" ADD CONSTRAINT "device_token_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_read_marker" ADD CONSTRAINT "ticket_read_marker_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unread_followup" ADD CONSTRAINT "unread_followup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
