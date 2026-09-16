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

/**
 * Busca um usuário do GLPI pelo e-mail, em duas tentativas — e as duas são necessárias:
 *
 * 1. `emails.email==` acha quem foi cadastrado pelo GLPI (funcionários de verdade), que têm o
 *    e-mail na relação `emails`.
 * 2. `username==` acha quem foi criado por esta integração. Motivo: o `POST /Administration/User`
 *    **ignora silenciosamente** o array `emails` do corpo — responde 201 como se tivesse gravado,
 *    mas o usuário nasce com `emails: []` (confirmado em teste real). E a API v2 não expõe
 *    endpoint pra definir o e-mail de outro usuário (só `/User/Me/Email`, do próprio autenticado).
 *    Como [createUser] grava o e-mail no `username`, é por ele que dá pra reencontrar.
 *
 * Sem a segunda tentativa, a busca nunca acha quem a própria integração criou e cada chamado
 * novo geraria um usuário duplicado no GLPI.
 */
export async function findUserByEmail(email: string): Promise<{ id: number } | null> {
  const encoded = encodeURIComponent(email)

  const byEmail = (await glpiRequest(
    'GET',
    `/Administration/User?filter=emails.email==${encoded}&limit=1`
  )) as Array<{ id: number }> | null
  if (byEmail?.[0]) return byEmail[0]

  const byUsername = (await glpiRequest(
    'GET',
    `/Administration/User?filter=username==${encoded}&limit=1`
  )) as Array<{ id: number }> | null
  return byUsername?.[0] ?? null
}

/**
 * Cria um usuário no GLPI a partir do e-mail. Sem senha de propósito: essa conta nunca é usada
 * pra login — existe só pra o chamado ter o requerente certo em vez da conta de serviço.
 *
 * O `username` recebe o e-mail porque é o único campo que a API grava de fato (ver [findUserByEmail]).
 * Consequência conhecida: o usuário fica **sem endereço de e-mail** no GLPI, então o GLPI não
 * consegue notificá-lo por e-mail sobre o chamado — quem for atender precisa preencher isso na UI,
 * ou o e-mail precisa vir de outra fonte (LDAP/sync).
 */
export async function createUser(params: { email: string; displayName: string }): Promise<{ id: number }> {
  return (await glpiRequest('POST', '/Administration/User', {
    body: { username: params.email, firstname: params.displayName }
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

export interface GlpiTicketSummary {
  id: number
  name: string
  status: unknown
  date: string
  date_mod: string
}

/**
 * Busca um chamado pelo id. Usado pra enriquecer a listagem (que vem da tabela própria no
 * Postgres, não do GLPI — ver NOTES.md) com os dados atuais do GLPI: status, datas.
 *
 * `status` é devolvido como veio do GLPI — na instância real é um objeto `{id, name}` (id é a
 * constante ITIL numérica: 1=Novo, 2=Processando/atribuído, 3=Processando/planejado, 4=Pendente,
 * 5=Solucionado, 6=Fechado; `name` já vem traduzido pelo GLPI), não um valor opaco int/string.
 * Confirmado contra a instância real (2026-09-16), não documentado na doc pública da API.
 */
export async function getTicket(id: number): Promise<GlpiTicketSummary> {
  return (await glpiRequest('GET', `/Assistance/Ticket/${id}`)) as GlpiTicketSummary
}

export interface GlpiFollowup {
  id: number
  content: string
  date: string
  authorName: string | null
  authorEmail: string | null
  isPrivate: boolean
}

/**
 * Lista os followups (acompanhamentos) públicos de um chamado.
 *
 * Path real confirmado contra a instância (2026-09-16): `/Assistance/Ticket/{id}/Timeline/Followup`
 * — não `/Assistance/Ticket/{id}/ITILFollowup` (o padrão usado por `TeamMember` não se repete
 * aqui). O schema published (`GET /api.php/doc.json`) chama o recurso de `Followup`
 * (`x-itemtype: ITILFollowup`).
 *
 * **Cada item vem envelopado, não plano** — `[{type: "Followup", item: {id, content, is_private,
 * user, ...}}]`, não `[{id, content, ...}]` direto como o schema do `doc.json` sugere. Só foi
 * possível confirmar isso depois que o direito de leitura foi concedido no perfil "Bot" (ver
 * histórico abaixo) — até lá a coleção sempre vinha vazia e não dava pra ver o shape real. Ler o
 * campo errado (ex.: `followup.is_private` em vez de `followup.item.is_private`) dá `undefined`,
 * que passa no filtro de privacidade sem erro — ou seja, um followup **privado vazaria pro
 * requerente**. Cuidado ao mexer aqui: testar sempre com um followup privado de verdade na
 * resposta, não só checar o `status` HTTP.
 *
 * `authorEmail` é best-effort: o followup só embute `user: {id, name}` (sem e-mail), então pra
 * cada autor único é feita uma segunda chamada a `/Administration/User/{id}`. Falha nessa segunda
 * chamada não derruba a listagem inteira — só aquele item fica com `authorEmail: null`. E pra
 * requerentes auto-provisionados (ver [findOrCreateUserByEmail]) sempre vai vir `null`, porque
 * esses usuários nascem sem e-mail no GLPI — limitação conhecida, não bug daqui.
 *
 * **Histórico do bloqueio de direitos (2026-09-16, resolvido):** o perfil "Bot" tinha direito de
 * criar followup (herdado do direito de Chamados) mas não de ver — só "Adicionar (requerente)"
 * estava marcado na aba Chamados > Acompanhamentos/Tarefas, não "Ver". `POST` respondia 201
 * normalmente, mas `GET` da coleção devolvia `[]` mesmo com followups reais gravados, e
 * `GET .../Timeline/Followup/{subitem_id}` do item recém-criado respondia 404
 * `ERROR_ITEM_NOT_FOUND` — o GLPI filtra silenciosamente o que o perfil não pode ver, não dá 403.
 * Corrigido no GLPI (perfil Bot, direito de Ver em Acompanhamentos concedido) — confirmado
 * funcionando no mesmo dia, relendo os followups de teste criados durante a investigação.
 */
export async function listTicketFollowups(ticketId: number): Promise<GlpiFollowup[]> {
  const raw = (await glpiRequest('GET', `/Assistance/Ticket/${ticketId}/Timeline/Followup`)) as Array<{
    type: string
    item: {
      id: number
      content: string
      date: string
      is_private: boolean
      user?: { id: number; name: string | null } | null
    }
  }>

  const publicFollowups = (raw ?? []).map((entry) => entry.item).filter((followup) => !followup.is_private)

  const authorIds = [
    ...new Set(publicFollowups.map((followup) => followup.user?.id).filter((id): id is number => typeof id === 'number'))
  ]

  const emailByAuthorId = new Map<number, string | null>()
  await Promise.all(
    authorIds.map(async (authorId) => {
      try {
        const user = (await glpiRequest('GET', `/Administration/User/${authorId}`)) as {
          emails?: Array<{ email: string; is_default?: boolean }>
        }
        const email = user.emails?.find((e) => e.is_default)?.email ?? user.emails?.[0]?.email ?? null
        emailByAuthorId.set(authorId, email)
      } catch (error) {
        console.error(`Falha ao buscar e-mail do autor ${authorId} do followup:`, error)
        emailByAuthorId.set(authorId, null)
      }
    })
  )

  return publicFollowups.map((followup) => ({
    id: followup.id,
    content: followup.content,
    date: followup.date,
    authorName: followup.user?.name ?? null,
    authorEmail: followup.user?.id != null ? (emailByAuthorId.get(followup.user.id) ?? null) : null,
    isPrivate: false
  }))
}

/**
 * Cria um followup público num chamado, atribuído ao requerente (não à conta de serviço).
 *
 * `user: {id: requesterUserId}` no corpo é necessário — sem ele, o GLPI atribui o followup a quem
 * está autenticado na API (a conta de serviço "filament"), então o followup apareceria de volta
 * pra qualquer outro leitor como se o bot tivesse escrito, não o requerente. Confirmado contra a
 * instância real (2026-09-16): sem o campo, `GET` mostra `user: {id: 16, name: "filament"}`;
 * com o campo, mostra o usuário certo. `requesterUserId` é o mesmo id resolvido por
 * [findOrCreateUserByEmail] (o `User` do GLPI correspondente ao e-mail da sessão do app).
 *
 * A resposta é montada localmente a partir da sessão do Better Auth (`authorName`/`authorEmail`
 * do próprio usuário que está postando) em vez de reler o followup criado no GLPI — mantém o
 * `POST` rápido (uma chamada em vez de duas) e não depende de o `GET` de followups estar
 * funcionando. Note que isso pode divergir do que um `GET` posterior mostra: pra requerentes
 * auto-provisionados (sem e-mail gravado no GLPI, ver [findOrCreateUserByEmail]), o `user.name`
 * que o GLPI devolve na releitura é o `username` (que aqui é o próprio e-mail), não o nome de
 * exibição — então `authorName` pode aparecer como "Fulano de Tal" logo após o envio (eco local)
 * e como "fulano@empresa.com" numa releitura posterior (vindo do GLPI). Comportamento esperado,
 * não bug — documentado também em [listTicketFollowups].
 */
export async function createTicketFollowup(
  ticketId: number,
  content: string,
  author: { name: string; email: string },
  requesterUserId: number
): Promise<GlpiFollowup> {
  const created = (await glpiRequest('POST', `/Assistance/Ticket/${ticketId}/Timeline/Followup`, {
    body: { content, user: { id: requesterUserId } }
  })) as { id: number }

  return {
    id: created.id,
    content,
    date: new Date().toISOString(),
    authorName: author.name,
    authorEmail: author.email,
    isPrivate: false
  }
}
