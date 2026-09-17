import { Hono } from 'hono'
import { auth } from '../lib/auth.js'
import { prisma } from '../lib/prisma.js'

export const deviceRoutes = new Hono()

// Registra (ou atualiza) o token de push do aparelho da sessão atual.
//
// O vínculo é com a SESSÃO, não só com o usuário: ao sair da conta, o Better Auth apaga a sessão
// e o token vai junto por cascata — sem isso um aparelho deslogado continuaria recebendo push de
// chamados de quem usou ele antes. Como o token do FCM pode ser rotacionado pelo próprio
// Android, o upsert é pela chave do token; se o mesmo token reaparecer em outra sessão (relogin
// no mesmo aparelho), a linha é reaproveitada trocando de sessão em vez de duplicar.
deviceRoutes.post('/', async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) {
    return c.json({ message: 'Não autenticado' }, 401)
  }

  const { token, platform } = await c.req.json<{ token?: string; platform?: string }>()
  if (!token?.trim()) {
    return c.json({ message: 'Informe o token do dispositivo' }, 400)
  }
  if (platform !== 'android') {
    return c.json({ message: 'Plataforma não suportada' }, 400)
  }

  // Uma sessão só pode ter um token: se esta sessão já tinha outro registrado (token rotacionado
  // pelo Android), o antigo sai antes do novo entrar, senão o aparelho receberia push duplicado
  // num token que não existe mais.
  await prisma.$transaction([
    prisma.deviceToken.deleteMany({ where: { sessionId: session.session.id, token: { not: token.trim() } } }),
    prisma.deviceToken.upsert({
      where: { token: token.trim() },
      create: { token: token.trim(), userId: session.user.id, sessionId: session.session.id, platform },
      update: { userId: session.user.id, sessionId: session.session.id, platform }
    })
  ])

  return c.body(null, 204)
})
