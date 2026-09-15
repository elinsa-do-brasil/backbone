import { Hono } from 'hono'
import { auth } from '../lib/auth.js'
import {
  checkGlpiConnection,
  createTicketForRequester,
  findOrCreateUserByEmail,
  GlpiApiError
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
