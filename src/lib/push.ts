// Envio de push via FCM (data-only) pro app Android.
//
// Data-only de propósito: quem monta a notificação é o app, não o servidor — assim a mesma
// mensagem serve pra notificar E pra sincronizar estado em background (o app é offline-first,
// guarda tudo em Room). Notification-messages do FCM não chegam no handler do app quando ele
// está em background, o que quebraria a sincronização.
//
// Push nunca é crítico: qualquer falha aqui é logada e engolida. O estado de verdade está no
// GLPI e no Postgres, e o app sincroniza por conta própria ao abrir — um push perdido atrasa a
// notificação, não corrompe nada.

import { readFileSync } from 'node:fs'
import { cert, getApps, initializeApp, type App } from 'firebase-admin/app'
import { getMessaging } from 'firebase-admin/messaging'
import { prisma } from './prisma.js'

const FIREBASE_SERVICE_ACCOUNT_FILE = process.env.FIREBASE_SERVICE_ACCOUNT_FILE

// Limite de payload de uma mensagem data-only do FCM. O `content` do followup é o único campo
// de tamanho imprevisível (HTML do GLPI), então é ele que é truncado pra caber.
const FCM_DATA_LIMIT_BYTES = 4096
const TRUNCATION_MARGIN_BYTES = 256

let firebaseApp: App | null | undefined

function getFirebaseApp(): App | null {
  if (firebaseApp !== undefined) return firebaseApp

  if (!FIREBASE_SERVICE_ACCOUNT_FILE) {
    console.warn('FIREBASE_SERVICE_ACCOUNT_FILE não configurado — push desativado')
    firebaseApp = null
    return null
  }

  try {
    const existing = getApps()[0]
    firebaseApp =
      existing ?? initializeApp({ credential: cert(JSON.parse(readFileSync(FIREBASE_SERVICE_ACCOUNT_FILE, 'utf8'))) })
  } catch (error) {
    console.error('Falha ao inicializar o Firebase Admin — push desativado:', error)
    firebaseApp = null
  }
  return firebaseApp
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/**
 * Trunca `content` pra mensagem inteira caber no limite do FCM, contando o peso dos outros
 * campos. Devolve também se truncou, porque o app precisa saber se deve buscar o texto completo
 * pela API em vez de exibir o que veio no push.
 */
export function fitContentToPayload(
  data: Record<string, string>,
  content: string
): { content: string; contentTruncated: boolean } {
  const overhead = Object.entries(data).reduce((sum, [key, value]) => sum + byteLength(key) + byteLength(value), 0)
  const budget = FCM_DATA_LIMIT_BYTES - overhead - TRUNCATION_MARGIN_BYTES

  if (budget <= 0) return { content: '', contentTruncated: true }
  if (byteLength(content) <= budget) return { content, contentTruncated: false }

  // Corta por bytes (não por caracteres) pra não estourar o limite com acentuação/emoji, e
  // descarta um possível caractere partido na borda.
  const truncated = Buffer.from(content, 'utf8').subarray(0, budget).toString('utf8').replace(/�$/, '')
  return { content: truncated, contentTruncated: true }
}

/**
 * Manda uma mensagem data-only pros tokens informados. Tokens que o FCM reportar como
 * desregistrados (app desinstalado, token rotacionado) são apagados do banco — sem isso a tabela
 * acumula tokens mortos e todo envio desperdiça chamada.
 */
export async function sendToTokens(tokens: string[], data: Record<string, string>): Promise<void> {
  if (tokens.length === 0) return

  const app = getFirebaseApp()
  if (!app) return

  try {
    const response = await getMessaging(app).sendEachForMulticast({
      tokens,
      data,
      android: { priority: 'high' }
    })

    const staleTokens = response.responses
      .map((result, index) => ({ result, token: tokens[index]! }))
      .filter(({ result }) => result.error?.code === 'messaging/registration-token-not-registered')
      .map(({ token }) => token)

    if (staleTokens.length > 0) {
      await prisma.deviceToken.deleteMany({ where: { token: { in: staleTokens } } })
      console.warn(`Removidos ${staleTokens.length} token(s) de push desregistrado(s)`)
    }

    const otherFailures = response.responses.filter(
      (result) => result.error && result.error.code !== 'messaging/registration-token-not-registered'
    )
    for (const failure of otherFailures) {
      console.error('Falha ao enviar push:', failure.error)
    }
  } catch (error) {
    console.error('Falha ao enviar push (lote inteiro):', error)
  }
}

/** Tokens de um usuário, opcionalmente pulando o aparelho da sessão que originou a ação. */
export async function getUserTokens(userId: string, opts?: { exceptSessionId?: string }): Promise<string[]> {
  const rows = await prisma.deviceToken.findMany({
    where: { userId, ...(opts?.exceptSessionId ? { sessionId: { not: opts.exceptSessionId } } : {}) },
    select: { token: true }
  })
  return rows.map((row) => row.token)
}
