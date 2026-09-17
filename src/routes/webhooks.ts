import { createHmac, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { prisma } from '../lib/prisma.js'
import { getUserTokens, sendToTokens, fitContentToPayload } from '../lib/push.js'
import { getFollowup, getTicket, getTicketRequesterEmails, getUserInfo } from '../lib/glpi.js'

export const webhookRoutes = new Hono()

const GLPI_WEBHOOK_SECRET = process.env.GLPI_WEBHOOK_SECRET

// Janela de tolerância do timestamp. Assinatura válida mas antiga é reenvio (replay) — o GLPI
// entrega por fila e pode atrasar, mas não minutos a fio.
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60

function hmacHex(data: string): string {
  return createHmac('sha256', GLPI_WEBHOOK_SECRET ?? '').update(data).digest('hex')
}

function signatureMatches(expected: string, received: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(received, 'utf8')
  // timingSafeEqual estoura se os tamanhos diferem — o check de tamanho antes não vaza nada
  // relevante (o tamanho da assinatura é fixo e público).
  return a.length === b.length && timingSafeEqual(a, b)
}

// Desafio de validação da URL (CRA): ao salvar/testar o webhook, o GLPI faz um GET com
// `?crc_token=<assinatura>` e espera receber de volta, em texto puro, o HMAC-SHA256 desse token
// com o mesmo segredo. Confirmado no fonte do GLPI (`Webhook::validateCRAChallenge`, branch
// 11.0) — não estava na especificação combinada com o app, mas sem isso o GLPI marca a URL como
// inválida.
webhookRoutes.get('/glpi', (c) => {
  if (!GLPI_WEBHOOK_SECRET) {
    console.error('GLPI_WEBHOOK_SECRET não configurado — desafio do webhook recusado')
    return c.text('Webhook não configurado', 503)
  }

  const crcToken = c.req.query('crc_token')
  if (!crcToken) {
    return c.text('crc_token ausente', 400)
  }

  return c.text(hmacHex(crcToken))
})

/**
 * Recebe as entregas do GLPI. Sem Better Auth de propósito: quem chama é o GLPI, não um usuário
 * do app — a autenticação aqui é a assinatura HMAC.
 *
 * O corpo é usado **só como gatilho** (que itemtype/id mudou). Todo dado que vira push ou vai pro
 * banco é relido da API legada, que já aplica os filtros certos (followup privado, atores do
 * chamado). Dois motivos: o corpo segue o shape da API v2, que este projeto já viu mentir mais de
 * uma vez (envelope não documentado, campo silenciosamente ignorado), e a entrega é assíncrona —
 * pode chegar defasada.
 */
webhookRoutes.post('/glpi', async (c) => {
  if (!GLPI_WEBHOOK_SECRET) {
    console.error('GLPI_WEBHOOK_SECRET não configurado — entrega recusada')
    return c.json({ message: 'Webhook não configurado' }, 503)
  }

  const rawBody = await c.req.text()
  const signature = c.req.header('X-GLPI-signature')
  const timestamp = c.req.header('X-GLPI-timestamp')

  // Entrega recusada é logada, não só respondida com 401: sem isso, segredo divergente entre o
  // GLPI e o `.env` fica indistinguível de "o GLPI não está enviando nada" — os dois casos não
  // deixam rastro no banco.
  if (!signature || !timestamp) {
    console.warn('[webhook glpi] recusado: assinatura ou timestamp ausente')
    return c.json({ message: 'Assinatura ausente' }, 401)
  }

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp))
  if (!Number.isFinite(age) || age > TIMESTAMP_TOLERANCE_SECONDS) {
    console.warn(`[webhook glpi] recusado: timestamp fora da janela (${age}s de diferença)`)
    return c.json({ message: 'Timestamp fora da janela permitida' }, 401)
  }

  // A assinatura do GLPI é sobre corpo + timestamp concatenados, nessa ordem.
  if (!signatureMatches(hmacHex(rawBody + timestamp), signature)) {
    console.warn('[webhook glpi] recusado: assinatura inválida — conferir se GLPI_WEBHOOK_SECRET bate com o segredo cadastrado no webhook do GLPI')
    return c.json({ message: 'Assinatura inválida' }, 401)
  }

  let trigger: WebhookTrigger
  try {
    trigger = extractTrigger(rawBody)
  } catch (error) {
    console.error('Corpo do webhook do GLPI não pôde ser interpretado:', error, rawBody.slice(0, 500))
    return c.json({ message: 'Corpo inválido' }, 400)
  }

  console.log(
    `[webhook glpi] ${trigger.kind}/${trigger.event ?? '?'} ` +
      `id=${'id' in trigger ? trigger.id : '?'} (atraso da fila: ${age}s)`
  )

  // Responde rápido e processa o resto sem segurar a conexão: o GLPI entrega por fila e trata
  // resposta lenta como falha. Erro no processamento é logado, não devolvido — reentregar não
  // ajudaria, já que a releitura é sempre do estado atual.
  void handleTrigger(trigger).catch((error) => console.error('Falha ao processar webhook do GLPI:', error, trigger))

  return c.json({ ok: true })
})

type WebhookTrigger =
  | { kind: 'followup'; id: number; event?: string }
  | { kind: 'ticket'; id: number; event?: string }
  | { kind: 'unknown'; event?: string }

/**
 * Descobre o que veio na entrega: qual tipo de item e qual id.
 *
 * **Armadilha do formato, custou um bug aqui (2026-09-17):** o corpo de um followup traz
 * `item.itemtype: "Ticket"`, que **não** é o tipo do item entregue — é a coluna do próprio
 * `ITILFollowup` dizendo a que tipo de objeto ele está anexado. Ler esse campo como "o tipo do
 * item" faz um followup ser processado como se fosse um chamado, com o id do followup no lugar do
 * id do chamado. Exemplo real recebido:
 *
 * ```json
 * { "item": { "id": 25, "itemtype": "Ticket", "items_id": 42, "content": "...", ... },
 *   "event": "new",
 *   "parent_item": { "id": 42, "name": "...", ... } }
 * ```
 * (`id` = followup, `items_id`/`parent_item.id` = chamado)
 *
 * O discriminador confiável é a **presença de `parent_item`**: o GLPI só adiciona esse campo
 * quando o item entregue é filho de outro (`CommonDBChild`/`CommonITILTask`) — um `Ticket` cai no
 * `else { return; }` e nunca tem. Confirmado no fonte (`Webhook::addParentItemData`, branch 11.0),
 * ou seja, é fato estrutural e não heurística sobre nomes de campo.
 */
function extractTrigger(rawBody: string): WebhookTrigger {
  const parsed = JSON.parse(rawBody) as Record<string, unknown>
  const item = (parsed.item ?? {}) as Record<string, unknown>
  const event = parsed.event as string | undefined

  const id = Number(item.id)
  if (!Number.isInteger(id)) return { kind: 'unknown', event }

  if (parsed.parent_item !== undefined) {
    // Item filho. Só tratamos filhos de chamado — followup de Change/Problem não interessa aqui.
    if (item.itemtype !== 'Ticket') return { kind: 'unknown', event }
    return { kind: 'followup', id, event }
  }

  return { kind: 'ticket', id, event }
}

async function handleTrigger(trigger: WebhookTrigger): Promise<void> {
  switch (trigger.kind) {
    case 'followup':
      // Se o filho não for um followup (uma tarefa, um documento anexado), a releitura devolve
      // null e o evento é ignorado — falha segura, sem precisar adivinhar o tipo pelo corpo.
      await handleFollowupEvent(trigger.id)
      return
    case 'ticket':
      await handleTicketEvent(trigger.id)
      return
    case 'unknown':
      console.warn('Webhook do GLPI que não deu pra classificar, ignorado:', trigger)
  }
}

/** Usuários do app que são requerentes do chamado, casados por e-mail (case-insensitive). */
async function findAppUsersForTicket(ticketId: number): Promise<Array<{ id: string; email: string }>> {
  const emails = await getTicketRequesterEmails(ticketId)
  if (emails.length === 0) return []

  return prisma.user.findMany({
    where: { email: { in: emails, mode: 'insensitive' } },
    select: { id: true, email: true }
  })
}

async function handleFollowupEvent(followupId: number): Promise<void> {
  const followup = await getFollowup(followupId)
  if (!followup) return

  // Followup privado é nota interna entre técnicos — nunca vira push nem não lida pro requerente.
  if (followup.isPrivate) return

  const [ticket, appUsers] = await Promise.all([
    getTicket(followup.ticketId),
    findAppUsersForTicket(followup.ticketId)
  ])
  if (appUsers.length === 0) return

  // `lastFollowupId` é marca d'água (só avança): a entrega do GLPI é assíncrona e pode chegar
  // fora de ordem, e gravar o último processado faria o valor regredir — o que reprocessaria
  // followups já vistos se ele for usado como ponto de partida.
  //
  // `statusId` só é gravado na criação da linha, nunca atualizado aqui: quem cuida de transição
  // de status é [handleTicketEvent]. Se este handler mexesse nele, uma mudança automática de
  // status disparada pelo próprio followup (novo → em atendimento, por exemplo) já chegaria
  // gravada quando o evento de Ticket fosse processado, e o push de "status mudou" sumiria.
  await prisma.glpiTicketState.upsert({
    where: { glpiTicketId: followup.ticketId },
    create: { glpiTicketId: followup.ticketId, statusId: ticket.status.id, lastFollowupId: followup.id },
    update: {}
  })
  await prisma.glpiTicketState.updateMany({
    where: { glpiTicketId: followup.ticketId, lastFollowupId: { lt: followup.id } },
    data: { lastFollowupId: followup.id }
  })

  // Resolve o autor uma vez só (não por usuário do app): é ele que dá o `authorName` do push e
  // quem diz, comparando e-mails, se o push é "minha própria mensagem" pra cada destinatário.
  const author = followup.authorId !== null ? await getUserInfo(followup.authorId) : null

  for (const appUser of appUsers) {
    const isAuthor = author?.emails.includes(appUser.email.toLowerCase()) ?? false

    if (!isAuthor) {
      const marker = await prisma.ticketReadMarker.findUnique({
        where: { userId_glpiTicketId: { userId: appUser.id, glpiTicketId: followup.ticketId } }
      })
      // Só conta como não lida se for mais nova que o marcador — entrega repetida ou atrasada
      // não "desmarca" o que o usuário já leu. O PK composto (userId, followupId) garante o
      // resto da idempotência.
      if (followup.id > (marker?.lastReadFollowupId ?? 0)) {
        await prisma.unreadFollowup.upsert({
          where: { userId_followupId: { userId: appUser.id, followupId: followup.id } },
          create: { userId: appUser.id, glpiTicketId: followup.ticketId, followupId: followup.id },
          update: {}
        })
      }
    }

    const unreadCount = await prisma.unreadFollowup.count({
      where: { userId: appUser.id, glpiTicketId: followup.ticketId }
    })

    // O autor também recebe push (com isMine=true) — é o que sincroniza os OUTROS aparelhos dele
    // quando ele responde por um deles ou pela UI do GLPI.
    const base = {
      type: 'followup.created',
      ticketId: String(followup.ticketId),
      ticketTitle: ticket.name,
      followupId: String(followup.id),
      sentAt: followup.date ?? new Date().toISOString(),
      authorName: author?.displayName ?? '',
      isMine: String(isAuthor),
      unreadCount: String(unreadCount)
    }
    const { content, contentTruncated } = fitContentToPayload(base, followup.content)

    const tokens = await getUserTokens(appUser.id)
    await sendToTokens(tokens, { ...base, content, contentTruncated: String(contentTruncated) })
  }
}

async function handleTicketEvent(ticketId: number): Promise<void> {
  const ticket = await getTicket(ticketId)

  const previous = await prisma.glpiTicketState.findUnique({ where: { glpiTicketId: ticketId } })

  await prisma.glpiTicketState.upsert({
    where: { glpiTicketId: ticketId },
    create: { glpiTicketId: ticketId, statusId: ticket.status.id },
    update: { statusId: ticket.status.id }
  })

  // Primeira vez que este backend vê o chamado: só registra o estado. Sem isso, o primeiro
  // webhook de qualquer chamado antigo viraria um push de "status mudou" que nunca mudou.
  if (!previous) return
  if (previous.statusId === ticket.status.id) return

  const appUsers = await findAppUsersForTicket(ticketId)
  for (const appUser of appUsers) {
    const tokens = await getUserTokens(appUser.id)
    await sendToTokens(tokens, {
      type: 'ticket.status_changed',
      ticketId: String(ticketId),
      ticketTitle: ticket.name,
      statusId: String(ticket.status.id),
      statusName: ticket.status.name,
      dateMod: ticket.date_mod ?? ''
    })
  }
}
