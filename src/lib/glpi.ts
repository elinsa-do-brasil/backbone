// Client HTTP mínimo pra API REST v2 do GLPI (api.php/v2.3), sem lib externa — `fetch` já é
// nativo no runtime do Hono/Node. Autenticação verificada via Context7 (`/glpi-project/glpi`,
// resources/api_doc.MD): OAuth2, grant `client_credentials` só cobre o escopo `inventory` — pra
// acessar recursos gerais (User, Ticket, ...) é obrigatório o grant `password`, autenticando uma
// conta de usuário real. Por isso a conta de serviço precisa de usuário+senha no GLPI, não só de
// um client_id/client_secret.
//
// Cada chamada pede um access_token novo (POST /api.php/token) e o usa direto — proposital: o
// deploy é serverless na Vercel, sem estado persistente confiável entre invocações, então
// cachear o token entre requests não é seguro. A doc do grant `password` não retorna
// `refresh_token` (só o grant `authorization_code`, que exige login interativo do usuário e não
// serve pra uma conta de serviço), então não há o que renovar — só pedir de novo.

export class GlpiApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message)
  }
}

const GLPI_URL_API = process.env.GLPI_URL_API
const GLPI_APP_CLIENT_ID = process.env.GLPI_APP_CLIENT_ID
const GLPI_APP_CLIENT_SECRET = process.env.GLPI_APP_CLIENT_SECRET
const GLPI_SERVICE_ACCOUNT_USERNAME = process.env.GLPI_SERVICE_ACCOUNT_USERNAME
const GLPI_SERVICE_ACCOUNT_PASSWORD = process.env.GLPI_SERVICE_ACCOUNT_PASSWORD

// GLPI_URL_API aponta pro root versionado dos recursos (.../api.php/v2.3), mas o endpoint de
// token é a raiz não-versionada (.../api.php/token) — daí o strip do sufixo de versão aqui.
const GLPI_API_ROOT = GLPI_URL_API?.replace(/\/v[\d.]+\/?$/, '')

function resourceUrl(path: string): string {
  return `${GLPI_URL_API}${path}`
}

function authUrl(path: string): string {
  return `${GLPI_API_ROOT}${path}`
}

async function glpiFetch(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init)
  const text = await response.text()
  const body = text ? JSON.parse(text) : null

  if (!response.ok) {
    // Erros OAuth2 vêm como {"error": "...", "error_description": "..."}; erros dos recursos da
    // API, como {"message": "..."}.
    const message =
      (body && typeof body === 'object' && ('error_description' in body || 'message' in body)
        ? String(
            (body as Record<string, unknown>).error_description ?? (body as Record<string, unknown>).message
          )
        : undefined) ?? text.trim() ?? `HTTP ${response.status}`
    throw new GlpiApiError(response.status, message)
  }

  return body
}

async function getAccessToken(): Promise<string> {
  const body = (await glpiFetch(authUrl('/token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'password',
      client_id: GLPI_APP_CLIENT_ID,
      client_secret: GLPI_APP_CLIENT_SECRET,
      username: GLPI_SERVICE_ACCOUNT_USERNAME,
      password: GLPI_SERVICE_ACCOUNT_PASSWORD,
      scope: 'api'
    })
  })) as { access_token?: string }

  if (!body.access_token) {
    throw new GlpiApiError(502, 'GLPI não retornou access_token')
  }
  return body.access_token
}

/** Pede um access_token só pra confirmar que a conta de serviço consegue autenticar. */
export async function checkGlpiConnection(): Promise<boolean> {
  await getAccessToken()
  return true
}

/**
 * Executa uma chamada autenticada contra a API REST v2 do GLPI. `path` é relativo a
 * `GLPI_URL_API` e os recursos são namespaced (ex.: `/Administration/User`, `/Assistance/Ticket`),
 * não nomes soltos como na API legada.
 *
 * `Content-Type` só vai quando há corpo: em requisição sem corpo o GLPI tenta interpretar o corpo
 * vazio como JSON e responde 400 "Corpo JSON inválido" (confirmado contra a instância real).
 */
export async function glpiRequest(method: string, path: string, opts?: { body?: unknown }): Promise<unknown> {
  const accessToken = await getAccessToken()
  return glpiFetch(resourceUrl(path), {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(opts?.body ? { 'Content-Type': 'application/json' } : {})
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined
  })
}

/** Busca um usuário do GLPI pelo e-mail. `emails` é a relação aninhada filtrável via RSQL. */
export async function findUserByEmail(email: string): Promise<{ id: number } | null> {
  const results = (await glpiRequest(
    'GET',
    `/Administration/User?filter=emails.email==${encodeURIComponent(email)}&limit=1`
  )) as Array<{ id: number }> | null
  return results?.[0] ?? null
}

/**
 * Cria um usuário no GLPI a partir do e-mail. Sem senha de propósito: essa conta nunca é usada
 * pra login — existe só pra o chamado ter o requerente certo em vez da conta de serviço.
 */
export async function createUser(params: { email: string; displayName: string }): Promise<{ id: number }> {
  return (await glpiRequest('POST', '/Administration/User', {
    body: {
      username: params.email,
      firstname: params.displayName,
      emails: [{ email: params.email, is_default: true }]
    }
  })) as { id: number }
}

export async function findOrCreateUserByEmail(email: string, displayName: string): Promise<{ id: number }> {
  return (await findUserByEmail(email)) ?? (await createUser({ email, displayName }))
}

/**
 * Cria um chamado e atribui o requerente numa segunda chamada — no GLPI o ator é um sub-recurso
 * (`TeamMember`), não um campo do próprio ticket. Sem isso o chamado sairia como se a conta de
 * serviço fosse a pessoa que pediu.
 *
 * O campo que identifica o usuário é `id` — confirmado em teste real. O schema auto-gerado do
 * GLPI marca esse `id` como `readOnly` (ou seja, a doc diz que ele não é aceito na escrita), mas
 * é justamente ele que funciona: `items_id` e `users_id`, que seriam o padrão do resto da API,
 * respondem **500**. Não "corrigir" isso pra items_id sem testar de novo contra a instância.
 *
 * O chamado é criado antes desta segunda chamada, então uma falha aqui deixa um chamado sem
 * requerente no GLPI (o GLPI não atribui a conta de serviço por padrão — o chamado nasce sem
 * ator nenhum) e o erro sobe pro app.
 */
export async function createTicketForRequester(params: {
  requesterUserId: number
  name: string
  content: string
}): Promise<{ id: number }> {
  const ticket = (await glpiRequest('POST', '/Assistance/Ticket', {
    body: { name: params.name, content: params.content }
  })) as { id: number }

  await glpiRequest('POST', `/Assistance/Ticket/${ticket.id}/TeamMember`, {
    body: { type: 'User', id: params.requesterUserId, role: 'requester' }
  })

  return ticket
}
