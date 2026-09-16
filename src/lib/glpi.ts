// Client HTTP mínimo pra API REST legada do GLPI (apirest.php), sem lib externa — `fetch` já é
// nativo no runtime do Hono/Node.
//
// Migrado da API v2 (api.php/v2.3, OAuth2) pra esta (etapa 4, 2026-09-16). Motivo: a v2 não
// permite listar `Ticket` filtrando pelo ator (`?filter=team.id==` responde HTTP 500), então a
// listagem dependia de uma tabela própria no Postgres — que nunca mostrava chamados abertos fora
// do app (UI do GLPI, técnico). A legada resolve isso de verdade via `search.php` com
// meta-critérios (o mesmo motor que a própria UI do GLPI usa), então a fonte de verdade passa a
// ser sempre o GLPI, sem estado duplicado aqui. De brinde, ela também resolve outros atritos da
// v2 (ver comentários nas funções abaixo): criar chamado com requerente numa chamada só, `emails`
// gravado de verdade no usuário, followup sem envelope não documentado.
//
// Toda validação abaixo foi feita contra a instância real (helpdesk.elinsadobrasil.com.br,
// 2026-09-16) — a doc pública da legada (`apirest.md`) cobre o formato geral, mas não os ids de
// searchoption nem alguns comportamentos específicos desta instância.

export class GlpiApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message)
  }
}

const GLPI_URL_API = process.env.GLPI_URL_API
const GLPI_APP_TOKEN = process.env.GLPI_V1_API_KEY
const GLPI_SERVICE_ACCOUNT_USERNAME = process.env.GLPI_SERVICE_ACCOUNT_USERNAME
const GLPI_SERVICE_ACCOUNT_PASSWORD = process.env.GLPI_SERVICE_ACCOUNT_PASSWORD

// GLPI_URL_API aponta pro root versionado da v2 (.../api.php/v2.3) por razões históricas (era o
// necessário quando o projeto usava só a v2). A legada mora em .../apirest.php, uma raiz
// irmã de .../api.php — daí o strip dos dois sufixos.
const LEGACY_ROOT = GLPI_URL_API?.replace(/\/v[\d.]+\/?$/, '').replace(/\/api\.php\/?$/, '') + '/apirest.php'

async function legacyFetch(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init)
  const text = await response.text()

  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      // Erros inesperados (ex.: query malformada) podem vir como página HTML de erro do GLPI,
      // não JSON — guarda o texto truncado em vez de estourar no JSON.parse.
      body = text.slice(0, 500)
    }
  }

  if (!response.ok) {
    // Erros da API legada vêm como array de 2 posições: ["ERROR_CODE", "mensagem"]. Confirmado
    // contra a instância real, inclusive pra erros de direito (ERROR_GLPI_DELETE) e de API
    // desativada (["ERROR","API desativada"]).
    const message = Array.isArray(body) && typeof body[1] === 'string' ? body[1] : typeof body === 'string' ? body : `HTTP ${response.status}`
    throw new GlpiApiError(response.status, message)
  }

  return body
}

async function initSession(): Promise<string> {
  const basicAuth = Buffer.from(`${GLPI_SERVICE_ACCOUNT_USERNAME}:${GLPI_SERVICE_ACCOUNT_PASSWORD}`).toString('base64')
  const body = (await legacyFetch(`${LEGACY_ROOT}/initSession`, {
    method: 'GET',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      ...(GLPI_APP_TOKEN ? { 'App-Token': GLPI_APP_TOKEN } : {})
    }
  })) as { session_token?: string }

  if (!body.session_token) {
    throw new GlpiApiError(502, 'GLPI não retornou session_token')
  }
  return body.session_token
}

async function killSession(sessionToken: string): Promise<void> {
  await legacyFetch(`${LEGACY_ROOT}/killSession`, {
    method: 'GET',
    headers: {
      'Session-Token': sessionToken,
      ...(GLPI_APP_TOKEN ? { 'App-Token': GLPI_APP_TOKEN } : {})
    }
  })
}

type GlpiCall = (method: string, path: string, opts?: { body?: unknown }) => Promise<unknown>

/**
 * Abre uma sessão (`initSession`), executa `fn` com uma função `call` já autenticada com ela, e
 * garante o `killSession` no final (best-effort — se o encerramento falhar, só loga, não derruba
 * o resultado de `fn`). Uma sessão por operação (não por chamada individual): funções que
 * precisam de mais de uma chamada ao GLPI (ex. [findUserByEmail], [listTicketFollowups])
 * compartilham a mesma sessão internamente em vez de abrir uma nova a cada requisição.
 *
 * Sem cache de sessão entre invocações — mesmo raciocínio documentado desde a v2: deploy
 * serverless na Vercel não tem estado confiável entre requests pra isso ser seguro.
 */
async function withGlpiSession<T>(fn: (call: GlpiCall) => Promise<T>): Promise<T> {
  const sessionToken = await initSession()
  const call: GlpiCall = (method, path, opts) =>
    legacyFetch(`${LEGACY_ROOT}${path}`, {
      method,
      headers: {
        'Session-Token': sessionToken,
        ...(GLPI_APP_TOKEN ? { 'App-Token': GLPI_APP_TOKEN } : {}),
        ...(opts?.body ? { 'Content-Type': 'application/json' } : {})
      },
      body: opts?.body ? JSON.stringify(opts.body) : undefined
    })

  try {
    return await fn(call)
  } finally {
    await killSession(sessionToken).catch((error) => console.error('Falha ao encerrar sessão do GLPI (não crítico):', error))
  }
}

/** Pede uma sessão só pra confirmar que a conta de serviço consegue autenticar. */
export async function checkGlpiConnection(): Promise<boolean> {
  await withGlpiSession(async () => {})
  return true
}

// GLPI devolve datetime "naive" (sem timezone), ex. "2026-09-16 10:07:37" — assume-se o timezone
// configurado na instância (América/São_Paulo, -03:00). Confirmado indiretamente: os timestamps
// da v2 (que devolvia ISO-8601 completo) sempre vinham com esse offset, e o Brasil não usa mais
// horário de verão desde 2019, então o offset fixo é seguro aqui.
function toIsoDateTime(glpiDatetime: string | null | undefined): string | null {
  if (!glpiDatetime) return null
  return `${glpiDatetime.replace(' ', 'T')}-03:00`
}

/**
 * Busca um usuário do GLPI pelo e-mail, em duas tentativas (mesma lógica da v2, ainda necessária
 * aqui): `UserEmail` (searchoption 5) acha quem foi cadastrado pelo GLPI (funcionários de
 * verdade); `User.name`/username (searchoption 1) acha quem foi criado por esta integração —
 * diferente da v2, `createUser` aqui GRAVA o e-mail de verdade (ver [createUser]), mas o
 * `username` continua sendo o e-mail por convenção, então a segunda tentativa ainda serve de
 * fallback caso o e-mail não tenha sido gravado por algum motivo.
 *
 * `searchtype=equals` não funciona pra estes campos nesta instância (campos dropdown/itemlink —
 * "equals" parece comparar contra o id resolvido, não o texto; confirmado com resultado vazio
 * mesmo pra valor existente). Usa `contains` (funciona) e filtra client-side por igualdade exata
 * (case-insensitive) pra evitar falso positivo de substring.
 */
export async function findUserByEmail(email: string): Promise<{ id: number } | null> {
  return withGlpiSession(async (call) => {
    const encoded = encodeURIComponent(email)
    const normalized = email.toLowerCase()

    const byEmail = (await call(
      'GET',
      `/search/User?criteria[0][field]=5&criteria[0][searchtype]=contains&criteria[0][value]=${encoded}&forcedisplay[0]=2&forcedisplay[1]=5`
    )) as { data?: Array<{ '2': number; '5': string }> }
    const emailMatch = byEmail.data?.find((row) => row['5']?.toLowerCase() === normalized)
    if (emailMatch) return { id: emailMatch['2'] }

    const byUsername = (await call(
      'GET',
      `/search/User?criteria[0][field]=1&criteria[0][searchtype]=contains&criteria[0][value]=${encoded}&forcedisplay[0]=2&forcedisplay[1]=1`
    )) as { data?: Array<{ '2': number; '1': string }> }
    const usernameMatch = byUsername.data?.find((row) => row['1']?.toLowerCase() === normalized)
    return usernameMatch ? { id: usernameMatch['2'] } : null
  })
}

/**
 * Cria um usuário no GLPI a partir do e-mail. Sem senha de propósito: essa conta nunca é usada
 * pra login — existe só pra o chamado ter o requerente certo em vez da conta de serviço.
 *
 * **Diferente da v2**: `_useremails` aqui GRAVA o e-mail de verdade (confirmado contra a
 * instância real via `GET /User/{id}/UserEmail`), diferente do `POST /Administration/User` da v2
 * que ignorava o array `emails` silenciosamente. Isso resolve a limitação que a v2 tinha
 * (requerente auto-provisionado sem e-mail, sem notificação do GLPI) — usuários criados por esta
 * função a partir de agora têm e-mail de verdade.
 */
export async function createUser(params: { email: string; displayName: string }): Promise<{ id: number }> {
  return withGlpiSession(async (call) => {
    const created = (await call('POST', '/User', {
      body: { input: { name: params.email, firstname: params.displayName, _useremails: [params.email] } }
    })) as { id: number }
    return { id: created.id }
  })
}

export async function findOrCreateUserByEmail(email: string, displayName: string): Promise<{ id: number }> {
  return (await findUserByEmail(email)) ?? (await createUser({ email, displayName }))
}

/**
 * Cria um chamado já atribuído ao requerente, numa única chamada — `_users_id_requester` no
 * input do `Ticket` faz o GLPI criar o ator numa tacada só. **Diferente da v2**, que exigia uma
 * segunda chamada (`POST .../TeamMember`) porque a API v2 trata o ator como sub-recurso separado;
 * confirmado contra a instância real que `_users_id_requester` funciona (`GET .../Ticket_User`
 * mostra `type:1` — requerente — com o `users_id` certo).
 */
export async function createTicketForRequester(params: {
  requesterUserId: number
  name: string
  content: string
}): Promise<{ id: number }> {
  return withGlpiSession(async (call) => {
    const created = (await call('POST', '/Ticket', {
      body: { input: { name: params.name, content: params.content, _users_id_requester: params.requesterUserId } }
    })) as { id: number }
    return { id: created.id }
  })
}

export interface GlpiTicketSummary {
  id: number
  name: string
  status: { id: number; name: string }
  date: string | null
  date_mod: string | null
}

// Nomes traduzidos dos status ITIL padrão (constantes de `CommonITILObject`, confirmadas contra
// a instância real na etapa anterior). A legada devolve só o código numérico no `search`
// (searchoption 12, datatype "specific" — sem tradução automática, diferente da v2 que já
// devolvia `{id, name}` pronto), então a tradução agora é responsabilidade daqui.
const TICKET_STATUS_NAMES: Record<number, string> = {
  1: 'Novo',
  2: 'Processando (atribuído)',
  3: 'Processando (planejado)',
  4: 'Pendente',
  5: 'Solucionado',
  6: 'Fechado',
  7: 'Aceito',
  8: 'Observado',
  10: 'Aprovação'
}

/**
 * Lista os chamados de um requerente via `search/Ticket` com o searchoption 4 ("Requerente",
 * `Ticket.Ticket_User.User.name`) — o mesmo motor de busca que a UI do GLPI usa, confirmado
 * contra a instância real que filtra corretamente por ator. Substitui a tabela `GlpiTicket` que
 * existia no Postgres só por causa da limitação da v2 (ver histórico no topo do arquivo): agora
 * o GLPI é sempre a fonte de verdade, então chamados abertos fora do app também aparecem.
 *
 * `range=0-499` é um teto pragmático (sem paginação real) — suficiente pro volume esperado de um
 * único requerente; revisitar se algum usuário passar disso.
 */
export async function listTicketsForRequester(requesterUserId: number): Promise<GlpiTicketSummary[]> {
  return withGlpiSession(async (call) => {
    const qs =
      `criteria[0][field]=4&criteria[0][searchtype]=equals&criteria[0][value]=${requesterUserId}` +
      `&forcedisplay[0]=2&forcedisplay[1]=1&forcedisplay[2]=12&forcedisplay[3]=15&forcedisplay[4]=19&range=0-499`
    const result = (await call('GET', `/search/Ticket?${qs}`)) as { data?: Array<Record<string, string | number>> }

    return (result.data ?? []).map((row) => {
      const statusId = Number(row['12'])
      return {
        id: Number(row['2']),
        name: String(row['1']),
        status: { id: statusId, name: TICKET_STATUS_NAMES[statusId] ?? String(statusId) },
        date: toIsoDateTime(row['15'] as string),
        date_mod: toIsoDateTime(row['19'] as string)
      }
    })
  })
}

export interface GlpiTicketDetail extends GlpiTicketSummary {
  content: string
}

/**
 * Busca o registro completo de um chamado via `GET /Ticket/{id}` — usado pra tela de chat mostrar
 * a mensagem de abertura (`content`), que **não é um followup**: é o campo `content` do próprio
 * `Ticket`, gravado uma vez na criação (ver [createTicketForRequester]) e nunca mais alterado por
 * esta integração. Igual a [listTicketsForRequester], `status` vem cru daqui e é traduzido aqui
 * dentro — a legada não traduz `Ticket.status` automaticamente.
 */
export async function getTicket(ticketId: number): Promise<GlpiTicketDetail> {
  return withGlpiSession(async (call) => {
    const ticket = (await call('GET', `/Ticket/${ticketId}`)) as {
      id: number
      name: string
      content: string
      status: number
      date: string | null
      date_mod: string | null
    }
    return {
      id: ticket.id,
      name: ticket.name,
      content: ticket.content,
      status: { id: ticket.status, name: TICKET_STATUS_NAMES[ticket.status] ?? String(ticket.status) },
      date: toIsoDateTime(ticket.date),
      date_mod: toIsoDateTime(ticket.date_mod)
    }
  })
}

/**
 * Confirma se um chamado pertence a um requerente, via `search/Ticket` com dois critérios (id do
 * chamado E requerente). Substitui a checagem de posse que antes vinha da tabela própria no
 * Postgres — agora consulta o GLPI direto, então não depende de o chamado ter sido criado pelo
 * app. Usada como gate de autorização nas rotas de followups (ver `src/routes/glpi.ts`): o perfil
 * de serviço enxerga todos os chamados da entidade, então sem essa checagem qualquer usuário
 * autenticado no app leria/postaria em chamado de terceiros.
 */
export async function ticketBelongsToRequester(ticketId: number, requesterUserId: number): Promise<boolean> {
  return withGlpiSession(async (call) => {
    const qs =
      `criteria[0][field]=2&criteria[0][searchtype]=equals&criteria[0][value]=${ticketId}` +
      `&criteria[1][link]=AND&criteria[1][field]=4&criteria[1][searchtype]=equals&criteria[1][value]=${requesterUserId}`
    const result = (await call('GET', `/search/Ticket?${qs}`)) as { totalcount?: number }
    return (result.totalcount ?? 0) > 0
  })
}

export interface GlpiFollowup {
  id: number
  content: string
  date: string | null
  authorId: number | null
  authorName: string | null
  authorEmail: string | null
  isPrivate: boolean
}

/**
 * Lista os followups públicos de um chamado via `GET /Ticket/{id}/ITILFollowup`.
 *
 * **Diferente da v2**: a coleção vem plana (`[{id, content, is_private, users_id, ...}]`), sem o
 * envelope `{type, item}` não documentado que a v2 tinha. E o mesmo direito de leitura
 * (Acompanhamentos > Ver, concedido ao perfil "Bot" na etapa anterior) vale aqui — é o mesmo
 * sistema de permissões por baixo das duas APIs, confirmado sem bloqueio novo.
 *
 * `authorName`/`authorEmail` exigem uma segunda (e terceira) chamada por autor único — o
 * followup só traz `users_id` (número), sem nome nem e-mail embutidos. `authorName` prioriza
 * `firstname`+`realname` (mais legível) e cai pro `name` (username) se nenhum dos dois existir —
 * pra requerentes auto-provisionados isso já é o nome de exibição real (ver [createUser]), não
 * mais o e-mail cru como acontecia na v2. Falha na busca de um autor não derruba a listagem
 * inteira, só deixa aquele item com `authorName`/`authorEmail` nulos.
 *
 * **`authorId` existe pra dar ao chamador um jeito confiável de saber "essa mensagem é minha?"**
 * — não use `authorName`/`authorEmail` pra isso. Achado real (2026-09-16, chamado #42): um
 * usuário de teste criado **antes** da migração pra API legada tem `firstname` igual ao próprio
 * e-mail (o Better Auth desse usuário nunca teve nome de exibição, então
 * [createUser]/[findOrCreateUserByEmail] gravou o e-mail como `firstname` também) e `emails: []`
 * no GLPI (era auto-provisionado pela v2, que ignorava `emails[]` — ver etapa 2/4). Resultado:
 * `authorName` vem como o e-mail cru (dado real do GLPI, não bug) e `authorEmail` vem `null`
 * (usuário sem e-mail cadastrado, dado real também) — comparar `authorEmail` com o e-mail da
 * sessão pra decidir "é minha bolha" quebra nesse caso, porque não bate com nada. `authorId`
 * (o `users_id` cru do GLPI) não depende de nome/e-mail estarem bem preenchidos — é a mesma
 * fonte que autoriza a escrita (ver `resolveOwnedTicket`/`ticketBelongsToRequester` em
 * `src/routes/glpi.ts`), então é estável mesmo quando os dados de exibição do usuário não são.
 */
export async function listTicketFollowups(ticketId: number): Promise<GlpiFollowup[]> {
  return withGlpiSession(async (call) => {
    const raw = (await call('GET', `/Ticket/${ticketId}/ITILFollowup`)) as Array<{
      id: number
      content: string
      date: string
      is_private: number | boolean
      users_id: number
    }> | null

    const publicFollowups = (raw ?? []).filter((followup) => !followup.is_private)

    const authorIds = [...new Set(publicFollowups.map((followup) => followup.users_id).filter((id) => id > 0))]
    const authorById = new Map<number, { name: string | null; email: string | null }>()
    await Promise.all(
      authorIds.map(async (authorId) => {
        try {
          const [user, emails] = await Promise.all([
            call('GET', `/User/${authorId}`) as Promise<{ name?: string; firstname?: string | null; realname?: string | null }>,
            call('GET', `/User/${authorId}/UserEmail`) as Promise<Array<{ email: string; is_default?: number | boolean }> | null>
          ])
          const displayName = [user.firstname, user.realname].filter(Boolean).join(' ').trim() || user.name || null
          const email = emails?.find((e) => e.is_default)?.email ?? emails?.[0]?.email ?? null
          authorById.set(authorId, { name: displayName, email })
        } catch (error) {
          console.error(`Falha ao buscar autor ${authorId} do followup:`, error)
          authorById.set(authorId, { name: null, email: null })
        }
      })
    )

    return publicFollowups.map((followup) => ({
      id: followup.id,
      content: followup.content,
      date: toIsoDateTime(followup.date),
      authorId: followup.users_id > 0 ? followup.users_id : null,
      authorName: authorById.get(followup.users_id)?.name ?? null,
      authorEmail: authorById.get(followup.users_id)?.email ?? null,
      isPrivate: false
    }))
  })
}

/**
 * Cria um followup público num chamado, atribuído ao requerente. **Diferente da v2**:
 * `users_id` no input do `POST /ITILFollowup` já atribui certo numa chamada só, sem o trâmite
 * que a v2 precisava. Confirmado contra a instância real (`GET .../ITILFollowup` mostra o
 * `users_id` certo, não a conta de serviço).
 *
 * A resposta é montada localmente a partir da sessão do Better Auth (`authorName`/`authorEmail`
 * do próprio usuário que está postando) em vez de reler o followup criado — mais rápido (uma
 * chamada em vez de duas). Assim como documentado antes: pode divergir um pouco de uma releitura
 * posterior via [listTicketFollowups], que usa `firstname`/`realname` do GLPI em vez do nome da
 * sessão do app — normalmente o mesmo texto, já que [createUser] grava o `firstname` a partir daí.
 */
export async function createTicketFollowup(
  ticketId: number,
  content: string,
  author: { name: string; email: string },
  requesterUserId: number
): Promise<GlpiFollowup> {
  return withGlpiSession(async (call) => {
    const created = (await call('POST', '/ITILFollowup', {
      body: { input: { itemtype: 'Ticket', items_id: ticketId, content, users_id: requesterUserId } }
    })) as { id: number }

    return {
      id: created.id,
      content,
      date: new Date().toISOString(),
      authorId: requesterUserId,
      authorName: author.name,
      authorEmail: author.email,
      isPrivate: false
    }
  })
}
