import { Hono } from 'hono'
import { auth } from '../lib/auth.js'
import { prisma } from '../lib/prisma.js'
import { getUserTokens, sendToTokens } from '../lib/push.js'
import {
  checkGlpiConnection,
  createTicketForRequester,
  createTicketFollowup,
  findOrCreateUserByEmail,
  getTicket,
  GlpiApiError,
  listTicketFollowups,
  listTicketsForRequester,
  ticketBelongsToRequester,
  type GlpiFollowup
} from '../lib/glpi.js'

export const glpiRoutes = new Hono()

// Endpoint único desta etapa: confirma que o backend consegue autenticar a conta de serviço no
// GLPI, validando a cadeia completa (app → backbone → GLPI) sem ainda expor dados reais do GLPI.
glpiRoutes.get('/status', async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) {
    return c.json({ message: 'Não autenticado' }, 401)
  }

  try {
    await checkGlpiConnection()
    return c.json({ connected: true })
  } catch (error) {
    console.error('Falha ao conectar ao GLPI:', error)
    const message = error instanceof GlpiApiError ? error.message : 'Falha ao conectar ao GLPI'
    return c.json({ connected: false, message }, 502)
  }
})

// Abre um chamado em nome de quem está logado no app. O usuário do app e o do GLPI são contas
// separadas, então o requerente é resolvido (ou criado) pelo e-mail da sessão do Better Auth.
glpiRoutes.post('/tickets', async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) {
    return c.json({ message: 'Não autenticado' }, 401)
  }

  const { name, content } = await c.req.json<{ name?: string; content?: string }>()
  if (!name?.trim() || !content?.trim()) {
    return c.json({ message: 'Informe título e descrição do chamado' }, 400)
  }

  try {
    const requester = await findOrCreateUserByEmail(session.user.email, session.user.name || session.user.email)
    const ticket = await createTicketForRequester({
      requesterUserId: requester.id,
      name: name.trim(),
      content: content.trim()
    })
    return c.json({ id: ticket.id }, 201)
  } catch (error) {
    console.error('Falha ao criar chamado no GLPI:', error)
    const message = error instanceof GlpiApiError ? error.message : 'Falha ao criar chamado no GLPI'
    return c.json({ message }, 502)
  }
})

// Lista os chamados do usuário logado, direto do GLPI (busca por requerente via search.php —
// ver src/lib/glpi.ts). Não depende de o chamado ter sido criado pelo app: um chamado aberto na
// UI do GLPI ou por um técnico em nome do usuário também aparece aqui.
glpiRoutes.get('/tickets', async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) {
    return c.json({ message: 'Não autenticado' }, 401)
  }

  try {
    const requester = await findOrCreateUserByEmail(session.user.email, session.user.name || session.user.email)
    const tickets = await listTicketsForRequester(requester.id)

    // Estado de leitura vem do Postgres daqui (é por usuário do app, não existe no GLPI) e é
    // costurado na resposta do GLPI. Duas consultas pro conjunto todo, não uma por chamado.
    const [unreadCounts, readMarkers] = await Promise.all([
      prisma.unreadFollowup.groupBy({
        by: ['glpiTicketId'],
        where: { userId: session.user.id },
        _count: { followupId: true }
      }),
      prisma.ticketReadMarker.findMany({ where: { userId: session.user.id } })
    ])

    const unreadByTicket = new Map(unreadCounts.map((row) => [row.glpiTicketId, row._count.followupId]))
    const markerByTicket = new Map(readMarkers.map((row) => [row.glpiTicketId, row.lastReadFollowupId]))

    return c.json({
      tickets: tickets.map((ticket) => ({
        ...ticket,
        unreadCount: unreadByTicket.get(ticket.id) ?? 0,
        lastReadFollowupId: markerByTicket.get(ticket.id) ?? null
      }))
    })
  } catch (error) {
    console.error('Falha ao listar chamados no GLPI:', error)
    const message = error instanceof GlpiApiError ? error.message : 'Falha ao listar chamados'
    return c.json({ message }, 502)
  }
})

// Resolve o `User` do GLPI da sessão e confirma que ele é o requerente do chamado, consultando o
// GLPI direto (não uma tabela própria — ver src/lib/glpi.ts). Necessário porque o perfil de
// serviço enxerga TODOS os chamados da entidade, não só os do usuário autenticado: sem essa
// checagem, qualquer usuário logado no app leria/postaria em chamado de terceiros.
async function resolveOwnedTicket(
  session: { user: { id: string; email: string; name: string } },
  ticketIdParam: string
): Promise<{ ticketId: number; requesterId: number } | null> {
  const ticketId = Number(ticketIdParam)
  if (!Number.isInteger(ticketId)) return null

  const requester = await findOrCreateUserByEmail(session.user.email, session.user.name || session.user.email)
  const owns = await ticketBelongsToRequester(ticketId, requester.id)
  return owns ? { ticketId, requesterId: requester.id } : null
}

// Detalhe de um chamado — inclui `content` (a mensagem de abertura), que não é um followup e por
// isso não aparece em GET .../followups. Ficou de fora do escopo inicial (ver NOTES.md) até
// aparecer um uso real: a tela de chat do app precisa mostrar essa mensagem de abertura junto com
// os followups.
glpiRoutes.get('/tickets/:id', async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) {
    return c.json({ message: 'Não autenticado' }, 401)
  }

  const owned = await resolveOwnedTicket(session, c.req.param('id'))
  if (owned === null) {
    return c.json({ message: 'Chamado não encontrado' }, 404)
  }

  try {
    const ticket = await getTicket(owned.ticketId)
    return c.json(ticket)
  } catch (error) {
    console.error(`Falha ao buscar chamado ${owned.ticketId} no GLPI:`, error)
    const message = error instanceof GlpiApiError ? error.message : 'Falha ao buscar chamado'
    return c.json({ message }, 502)
  }
})

// `isMine` é calculado aqui (comparando o `authorId` cru do GLPI com o requerente já resolvido
// pra esta sessão), não deixado pro client comparar `authorEmail`/`authorName` — achado real
// (2026-09-16, chamado #42): usuário de teste anterior à migração tem `firstname` igual ao
// próprio e-mail e nenhum e-mail cadastrado no GLPI, então a comparação por e-mail no client
// falhava mesmo pra mensagens que o próprio usuário mandou. Ver JSDoc de `GlpiFollowup` em
// src/lib/glpi.ts. `authorId` fica de fora da resposta — é detalhe interno, não faz parte do
// contrato combinado com o app.
function toFollowupResponse(followup: GlpiFollowup, requesterId: number) {
  const { authorId, ...rest } = followup
  return { ...rest, isMine: authorId === requesterId }
}

glpiRoutes.get('/tickets/:id/followups', async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) {
    return c.json({ message: 'Não autenticado' }, 401)
  }

  const owned = await resolveOwnedTicket(session, c.req.param('id'))
  if (owned === null) {
    return c.json({ message: 'Chamado não encontrado' }, 404)
  }

  // `?after=<followupId>` devolve só o que chegou depois — o app usa isso pra sincronizar
  // incrementalmente em cima do cache local dele. Sem o parâmetro, devolve a conversa inteira
  // (comportamento de sempre).
  const afterParam = c.req.query('after')
  if (afterParam !== undefined && !Number.isInteger(Number(afterParam))) {
    return c.json({ message: 'Parâmetro "after" inválido' }, 400)
  }
  const after = afterParam !== undefined ? Number(afterParam) : undefined

  try {
    const followups = await listTicketFollowups(owned.ticketId, { after })
    return c.json({ followups: followups.map((f) => toFollowupResponse(f, owned.requesterId)) })
  } catch (error) {
    console.error(`Falha ao listar followups do chamado ${owned.ticketId}:`, error)
    const message = error instanceof GlpiApiError ? error.message : 'Falha ao listar mensagens do chamado'
    return c.json({ message }, 502)
  }
})

glpiRoutes.post('/tickets/:id/followups', async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) {
    return c.json({ message: 'Não autenticado' }, 401)
  }

  const owned = await resolveOwnedTicket(session, c.req.param('id'))
  if (owned === null) {
    return c.json({ message: 'Chamado não encontrado' }, 404)
  }

  const { content } = await c.req.json<{ content?: string }>()
  if (!content?.trim()) {
    return c.json({ message: 'Informe o conteúdo da mensagem' }, 400)
  }

  try {
    const followup = await createTicketFollowup(
      owned.ticketId,
      content.trim(),
      { name: session.user.name || session.user.email, email: session.user.email },
      owned.requesterId
    )
    return c.json(toFollowupResponse(followup, owned.requesterId), 201)
  } catch (error) {
    console.error(`Falha ao criar followup no chamado ${owned.ticketId}:`, error)
    const message = error instanceof GlpiApiError ? error.message : 'Falha ao enviar mensagem no chamado'
    return c.json({ message }, 502)
  }
})

// Marca o chamado como lido até um followup. O marcador só avança (`max` do atual com o
// recebido) — mensagem fora de ordem ou retry do app não "desmarca" o que já estava lido.
glpiRoutes.post('/tickets/:id/read', async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) {
    return c.json({ message: 'Não autenticado' }, 401)
  }

  const owned = await resolveOwnedTicket(session, c.req.param('id'))
  if (owned === null) {
    return c.json({ message: 'Chamado não encontrado' }, 404)
  }

  const { lastReadFollowupId } = await c.req.json<{ lastReadFollowupId?: number }>()
  if (!Number.isInteger(lastReadFollowupId)) {
    return c.json({ message: 'Informe lastReadFollowupId' }, 400)
  }

  const existing = await prisma.ticketReadMarker.findUnique({
    where: { userId_glpiTicketId: { userId: session.user.id, glpiTicketId: owned.ticketId } }
  })
  const marker = Math.max(existing?.lastReadFollowupId ?? 0, lastReadFollowupId as number)

  const [, , unreadCount] = await prisma.$transaction([
    prisma.ticketReadMarker.upsert({
      where: { userId_glpiTicketId: { userId: session.user.id, glpiTicketId: owned.ticketId } },
      create: { userId: session.user.id, glpiTicketId: owned.ticketId, lastReadFollowupId: marker },
      update: { lastReadFollowupId: marker }
    }),
    prisma.unreadFollowup.deleteMany({
      where: { userId: session.user.id, glpiTicketId: owned.ticketId, followupId: { lte: marker } }
    }),
    prisma.unreadFollowup.count({ where: { userId: session.user.id, glpiTicketId: owned.ticketId } })
  ])

  // Avisa os OUTROS aparelhos do usuário pra eles zerarem o badge sozinhos. O aparelho que
  // chamou já sabe — mandar pra ele seria eco redundante.
  const tokens = await getUserTokens(session.user.id, { exceptSessionId: session.session.id })
  void sendToTokens(tokens, {
    type: 'ticket.read',
    ticketId: String(owned.ticketId),
    lastReadFollowupId: String(marker),
    unreadCount: String(unreadCount)
  })

  return c.json({ unreadCount, lastReadFollowupId: marker })
})
