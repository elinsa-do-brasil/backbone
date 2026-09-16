import { Hono } from 'hono'
import { auth } from '../lib/auth.js'
import { prisma } from '../lib/prisma.js'
import {
  checkGlpiConnection,
  createTicketForRequester,
  createTicketFollowup,
  findOrCreateUserByEmail,
  getTicket,
  GlpiApiError,
  listTicketFollowups
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
    // A API v2 do GLPI não permite listar chamados filtrando pelo ator (ver NOTES.md), então o
    // vínculo (usuário do app, chamado do GLPI) é gravado aqui pra alimentar GET /tickets depois.
    await prisma.glpiTicket.create({
      data: { userId: session.user.id, glpiId: ticket.id, name: name.trim() }
    })
    return c.json({ id: ticket.id }, 201)
  } catch (error) {
    console.error('Falha ao criar chamado no GLPI:', error)
    const message = error instanceof GlpiApiError ? error.message : 'Falha ao criar chamado no GLPI'
    return c.json({ message }, 502)
  }
})

// Lista os chamados do usuário logado. A coleção vem da tabela própria (não do GLPI, que não
// permite filtrar Ticket pelo ator — ver NOTES.md), enriquecida best-effort com status/datas
// atuais do GLPI: se a consulta a um chamado específico falhar, devolve o que já tem gravado
// aqui em vez de derrubar a listagem inteira.
glpiRoutes.get('/tickets', async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) {
    return c.json({ message: 'Não autenticado' }, 401)
  }

  const links = await prisma.glpiTicket.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: 'desc' }
  })

  const tickets = await Promise.all(
    links.map(async (link) => {
      try {
        const ticket = await getTicket(link.glpiId)
        return { id: ticket.id, name: ticket.name, status: ticket.status, date: ticket.date, date_mod: ticket.date_mod }
      } catch (error) {
        console.error(`Falha ao buscar chamado ${link.glpiId} no GLPI:`, error)
        const fallbackDate = link.createdAt.toISOString()
        return { id: link.glpiId, name: link.name, status: null, date: fallbackDate, date_mod: fallbackDate }
      }
    })
  )

  return c.json({ tickets })
})

// Segue o mesmo formato de autorização das rotas de followups abaixo: só quem abriu o chamado
// pelo app (dono do vínculo na tabela própria) pode ver/postar nele. Necessário porque o perfil
// de serviço do GLPI enxerga TODOS os chamados da entidade, não só os do usuário autenticado.
async function findOwnedTicketId(userId: string, ticketIdParam: string): Promise<number | null> {
  const ticketId = Number(ticketIdParam)
  if (!Number.isInteger(ticketId)) return null

  const link = await prisma.glpiTicket.findUnique({
    where: { userId_glpiId: { userId, glpiId: ticketId } }
  })
  return link ? ticketId : null
}

glpiRoutes.get('/tickets/:id/followups', async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) {
    return c.json({ message: 'Não autenticado' }, 401)
  }

  const ticketId = await findOwnedTicketId(session.user.id, c.req.param('id'))
  if (ticketId === null) {
    return c.json({ message: 'Chamado não encontrado' }, 404)
  }

  try {
    const followups = await listTicketFollowups(ticketId)
    return c.json({ followups })
  } catch (error) {
    console.error(`Falha ao listar followups do chamado ${ticketId}:`, error)
    const message = error instanceof GlpiApiError ? error.message : 'Falha ao listar mensagens do chamado'
    return c.json({ message }, 502)
  }
})

glpiRoutes.post('/tickets/:id/followups', async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) {
    return c.json({ message: 'Não autenticado' }, 401)
  }

  const ticketId = await findOwnedTicketId(session.user.id, c.req.param('id'))
  if (ticketId === null) {
    return c.json({ message: 'Chamado não encontrado' }, 404)
  }

  const { content } = await c.req.json<{ content?: string }>()
  if (!content?.trim()) {
    return c.json({ message: 'Informe o conteúdo da mensagem' }, 400)
  }

  try {
    const requester = await findOrCreateUserByEmail(session.user.email, session.user.name || session.user.email)
    const followup = await createTicketFollowup(
      ticketId,
      content.trim(),
      { name: session.user.name || session.user.email, email: session.user.email },
      requester.id
    )
    return c.json(followup, 201)
  } catch (error) {
    console.error(`Falha ao criar followup no chamado ${ticketId}:`, error)
    const message = error instanceof GlpiApiError ? error.message : 'Falha ao enviar mensagem no chamado'
    return c.json({ message }, 502)
  }
})
