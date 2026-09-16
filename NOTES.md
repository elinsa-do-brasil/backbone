## Integração com o GLPI (helpdesk.elinsadobrasil.com.br)

- **Proxy via backend, não o app direto**: as credenciais do GLPI (`GLPI_APP_CLIENT_SECRET`, senha da conta de serviço) não podem ficar no dispositivo/APK. O app (`filament`) chama `/api/glpi/*` aqui no `backbone`, autenticado com o mesmo bearer token do Better Auth; quem fala com o GLPI é só este backend.
- **⚠️ Desde a etapa 4 (2026-09-16), a integração usa a API REST legada (`apirest.php`), não mais a v2.** As seções abaixo sobre a v2 (OAuth2, `/Assistance/Ticket`, etc.) ficam como registro histórico de decisões e achados — várias ainda são relevantes (ex.: direitos do perfil Bot, formato de erro geral), mas o client atual (`src/lib/glpi.ts`) não fala mais v2. Ver "Migração pra API legada (etapa 4)" no fim deste arquivo pro estado atual.
- **Conta de serviço única, grant `password`**: o grant `client_credentials` do GLPI só cobre o escopo `inventory` — acessar recursos gerais (`User`, `Ticket`) exige autenticar um usuário real via grant `password` (`client_id` + `client_secret` do cliente OAuth2 registrado, mais usuário/senha de uma conta técnica). Em vez de mapear login do app → login do GLPI (são sistemas diferentes), todas as chamadas usam essa conta de serviço única. Quando a feature de chamados for implementada, o requerente de cada ticket será resolvido buscando/criando um `User` no GLPI pelo e-mail do usuário logado no app — ainda não implementado.
- **Token por chamada, sem cache**: `src/lib/glpi.ts` pede um `access_token` novo a cada `glpiRequest`/`checkGlpiConnection`. Proposital — deploy serverless na Vercel não tem estado confiável entre invocações pra cachear o token com segurança, e o grant `password` não retorna `refresh_token` (só o grant `authorization_code`, que exige login interativo e não serve pra conta de serviço).
- Endpoint desta etapa: `GET /api/glpi/status` (`src/routes/glpi.ts`), só confirma que o backend consegue autenticar a conta de serviço no GLPI. Nenhum dado real do GLPI é exposto ainda.
- **Conta de serviço: perfil dedicado, direitos mínimos.** O grant `password` usa a senha real dessa conta (não um token pessoal revogável como na API legada) — se vazar, dá pra logar na UI do GLPI inteira como esse usuário, não só via API. Por isso: usuário técnico dedicado (não reaproveitar conta de funcionário), perfil próprio sem direitos de Config/Admin, restrito à(s) Entidade(s) corretas, senha só como secret (nunca no repo).
### Shapes reais da API v2 (conferidos no OpenAPI da própria instância, `GET /api.php/doc.json`)

A doc pública não cobre o shape completo da v2; o spec que a instância serve, sim. Achados que valem lembrar:

- **Recursos são namespaced**: `/Administration/User`, `/Assistance/Ticket`, `/Assistance/Ticket/{id}/TeamMember` — não `/User`/`/Ticket` soltos como na API legada.
- **`User`**: o login é `username` (não `name`); e-mails ficam na relação aninhada `emails: [{email, is_default, is_dynamic}]`. Filtro RSQL por e-mail: `?filter=emails.email==<email>`.
- **`Ticket`**: `name`, `content` (html), `entity: {id}`, `urgency`/`impact`/`priority` (1–5), `user_recipient: {id}` = quem *registrou*, que **não** é o requerente.
- **Requerente é sub-recurso**: `POST /Assistance/Ticket/{id}/TeamMember` com `{type: "User", id: <users_id>, role: "requester"}`.

### Atribuição de requerente — validado em teste real (2026-09-14)

Teste de escrita real contra a instância (chamado #34, usuário #17 criados — limpar manualmente):

| Passo | Resultado |
|---|---|
| `GET /Administration/User?filter=emails.email==<email>` | **200**, array direto — filtro por e-mail confirmado |
| `POST /Administration/User` (`username`/`firstname`/`emails[]`) | **201** `{id, href}` — criação de usuário confirmada |
| `POST /Assistance/Ticket` (`name`/`content`) | **201** `{id, href}` — criação de chamado confirmada |
| `GET /Assistance/Ticket/{id}/TeamMember` (logo após criar) | **200 `[]`** — o GLPI **não** coloca a conta de serviço como requerente por padrão; o chamado nasce **sem ator nenhum** |
| `POST .../TeamMember` **antes** dos direitos | **403 `ERROR_RIGHT_MISSING`** |
| `POST .../TeamMember` **depois** dos direitos | **201** com `{type:"User", id, role:"requester"}` ✅ |

**Direitos necessários no perfil "Bot"** (Administração > Perfis): além de criar/ver chamados, precisa de "Adicionar (requerente)" em Acompanhamentos/Tarefas e dos direitos de atribuição (Ver atribuído / Atribuir / Apropriar / Ficar encarregado). Sem isso, o `POST .../TeamMember` dá 403 e o chamado fica sem requerente.

**Nome do campo — cuidado:** o campo que identifica o usuário é **`id`**, e o schema auto-gerado do GLPI marca esse `id` como `readOnly` (isto é, a doc diz que não é aceito na escrita — a doc está errada). Testados na mesma instância: `items_id` → **500**, `users_id` → **500**, `id` → **201**. Não trocar por `items_id` "pra seguir o padrão do resto da API" sem testar.

### `POST /Administration/User` ignora o array `emails` (silenciosamente)

Descoberto no teste ponta a ponta pelo app (2026-09-14). Mandar `emails: [{email, is_default: true}]` no corpo da criação **não grava nada**: o GLPI responde **201** normalmente, mas o usuário nasce com `emails: []`. Comparação na mesma instância: usuário criado pela UI do GLPI tem `emails:[{...}]`; usuários criados pela API (#17, #18) têm `emails: []`.

E a API v2 **não tem** endpoint pra definir o e-mail de outro usuário — existe só `/Administration/User/Me/Email`, que age sobre o próprio usuário autenticado (a conta de serviço).

**Impacto, se não tratado:** `findUserByEmail` buscava só por `emails.email==`, nunca achava quem a própria integração tinha criado, e **cada chamado novo criaria um usuário duplicado** no GLPI.

**Como está tratado:** `findUserByEmail` tenta em duas etapas — `emails.email==` (acha funcionários cadastrados pela UI, que têm e-mail de verdade) e, se não achar, `username==` (acha quem esta integração criou, já que `createUser` grava o e-mail no `username`).

**Limitação que fica de pé:** usuário auto-provisionado fica **sem endereço de e-mail** no GLPI, então o GLPI não consegue mandar notificação de chamado pra ele. Resolver depois por outro caminho (preencher na UI, LDAP/sync, ou algum import).
- **GET não pode levar `Content-Type: application/json`**: o GLPI tenta ler o corpo vazio como JSON e responde 400 "Corpo JSON inválido". `glpiRequest()` só manda o header quando há corpo.

### Implementado (etapa 2)

- `findUserByEmail` / `createUser` / `findOrCreateUserByEmail` e `createTicketForRequester` em `src/lib/glpi.ts`.
- `POST /api/glpi/tickets` (`src/routes/glpi.ts`): exige sessão Better Auth, resolve/cria o `User` do GLPI pelo e-mail da sessão e abre o chamado com esse requerente.

### Fora de escopo / não implementado

- **Update/Delete de `Ticket`**: o perfil "Bot" só tem criar/ver. Precisa mexer nos direitos no GLPI antes, não é questão de código.
- **`GET /api/glpi/tickets/{id}` (detalhe de um chamado)**: cogitado, mas o app (client Android/Filament) não precisou — o nome do chamado pra tela de chat já vem do item clicado na listagem. Fora de escopo até que apareça um uso real.

### Implementado (etapa 3, 2026-09-16) — listagem de chamados e followups (chat)

Trabalho combinado por mensagem entre esta sessão (backbone) e duas sessões do app Android
(Filament): uma implementando a UI de listagem/chat, outra testando na rede local. Contrato de
API foi acertado entre as sessões antes de codar aqui.

- **`GlpiTicket` no Prisma** (`prisma/schema.prisma`, migração `20260916120047_add_glpi_ticket_tracking`): tabela própria `(userId, glpiId, name, createdAt)` com `@@unique([userId, glpiId])`. Existe porque a API v2 do GLPI **não permite listar `Ticket` filtrando pelo ator** — `?filter=team.id==`/`?filter=team.role==` responde HTTP 500 (achado antigo, ainda válido). `POST /api/glpi/tickets` agora grava um registro aqui logo após criar o chamado no GLPI. `name` fica duplicado do GLPI só como fallback pra listagem.
- **`GET /api/glpi/tickets`**: lê os vínculos da tabela própria pro usuário da sessão, enriquece cada um chamando `GET /Assistance/Ticket/{id}` no GLPI (best-effort — Promise.allSettled implícito via try/catch por item; se a consulta individual falhar, devolve `{id, name, status: null, date/date_mod: createdAt da tabela própria}` em vez de derrubar a listagem). Resposta: `{"tickets": [{id, name, status, date, date_mod}]}`.
- **⚠️ Correção ao contrato combinado com o app: `status` não é int/string opaco.** Confirmado contra a instância real (`GET /Assistance/Ticket/{id}`): `status` vem como **objeto** `{"id": 1, "name": "Novo"}` — `id` é a constante ITIL numérica (1=Novo, 2=Processando/atribuído, 3=Processando/planejado, 4=Pendente, 5=Solucionado, 6=Fechado, 7=Aceito, 8=Observado, 10=Aprovação — via `CommonITILObject`, não documentado na doc pública da API), `name` já vem traduzido pelo GLPI (idioma default do usuário, ou `Accept-Language` se enviado). O client Android precisa parsear como `JSONObject`, não como primitivo.
- **`GET`/`POST /api/glpi/tickets/{id}/followups`**: implementados em `listTicketFollowups`/`createTicketFollowup` (`src/lib/glpi.ts`) e nas rotas correspondentes. Path real confirmado contra a instância (2026-09-16): **`/Assistance/Ticket/{id}/Timeline/Followup`** — não `/Assistance/Ticket/{id}/ITILFollowup` (o padrão de `TeamMember` não se repete aqui; achado só dava pra confirmar consultando `GET /api.php/doc.json` da própria instância).
- **⚠️ Segunda correção ao schema: a coleção vem envelopada, não plana.** `GET /Assistance/Ticket/{id}/Timeline/Followup` devolve `[{type: "Followup", item: {id, content, is_private, user, ...}}]`, não `[{id, content, ...}]` direto como o `doc.json` sugere. Só deu pra confirmar depois que o direito de leitura foi concedido (ver abaixo) — até lá a coleção sempre vinha vazia e escondia o shape real. `listTicketFollowups` já desembrulha (`entry.item`); é fácil reintroduzir esse bug lendo campo direto na raiz do item.
- **Autorização por posse**: as duas rotas de followups (e só elas, por enquanto) checam se o `(userId da sessão, ticketId)` existe na tabela `GlpiTicket` antes de falar com o GLPI — 404 se não. Necessário porque o perfil de serviço "Bot" enxerga **todos os chamados da entidade** (`ver todos os chamados`, não só os do próprio usuário do app), então sem essa checagem qualquer usuário autenticado no app conseguiria ler/postar followups em chamados de terceiros só incrementando o id na URL.
- **`authorEmail` em cada followup é best-effort**: o schema do `Followup` só embute `user: {id, name}`, sem e-mail. Pra cada autor único na lista, `listTicketFollowups` faz uma segunda chamada a `GET /Administration/User/{id}` (deduplicada, uma por autor distinto, não por followup) e usa o e-mail default. Falha nessa segunda chamada não derruba a listagem — só aquele item fica com `authorEmail: null`. Pra requerentes auto-provisionados (ver seção acima sobre `POST /Administration/User` ignorar `emails`) sempre vai vir `null`, porque esses usuários nascem sem e-mail no GLPI — limitação conhecida, não bug daqui.
- **Atribuição do followup ao requerente, não à conta de serviço**: `createTicketFollowup` manda `user: {id: requesterUserId}` no corpo do `POST` (resolvido antes via `findOrCreateUserByEmail`, mesma função usada na criação do chamado). Sem isso, confirmado contra a instância real: o GLPI atribui o followup a quem está autenticado na API (a conta de serviço "filament"), não ao requerente — qualquer leitor veria o followup como se o bot tivesse escrito, não a pessoa. `user.id` não está marcado `readOnly` no schema published, e funciona como passado (mesma classe de achado do `id` do `TeamMember`, ver etapa 2).
- **`POST /api/glpi/tickets/{id}/followups` não relê o followup criado no GLPI** — monta a resposta localmente a partir da sessão do Better Auth (`authorName`/`authorEmail` de quem está postando) e do `content` enviado. Isso é mais rápido (uma chamada em vez de duas) mas pode divergir de uma releitura posterior: pra requerentes auto-provisionados, o `user.name` que o GLPI devolve num `GET` é o `username` (aqui, o próprio e-mail), não o nome de exibição — então `authorName` pode aparecer como "Fulano de Tal" no eco local do envio e como "fulano@empresa.com" numa releitura. Esperado, não bug.

### ✅ Bloqueio de direitos de leitura de followups — RESOLVIDO (2026-09-16)

Detectado e corrigido no mesmo dia. Testado ponta a ponta contra a instância real (chamados
#34, #36, #37, #38; usuários GLPI #17, #18, #21, #23 — **limpar manualmente**, o perfil "Bot"
não tem direito de excluir):

| Passo | Resultado (antes da correção) |
|---|---|
| `POST /Assistance/Ticket/{id}/Timeline/Followup` (público) | **201**, retorna `{id, href}` — criação confirmada |
| `GET /Assistance/Ticket/{id}/Timeline/Followup` logo em seguida | **200 `[]`** — vazio, mesmo com followups reais recém-criados |
| `GET .../Timeline/Followup/{subitem_id}` do item recém-criado | **404 `ERROR_ITEM_NOT_FOUND`** |
| Forçar `GLPI-Profile: 10` (Bot) no header | mesmo resultado — não era o perfil ativo default sendo outro (a conta `filament` tem dois perfis: `9` "Padrão Elinsa" e `10` "Bot", confirmado via `GET /Session`) |

**Diagnóstico:** o perfil "Bot" tinha direito de **criar** followups (a mesma seção "Acompanhamentos/Tarefas" citada na etapa da atribuição de requerente, onde só "Adicionar (requerente)" estava marcado), mas não tinha direito de **ver**. O GLPI não retorna 403 nesse caso — filtra silenciosamente os itens que o perfil não pode ver, tanto na coleção quanto no item individual. Ou seja, não tinha como o código distinguir "chamado sem followups" de "sem direito de ver followups" — os dois casos respondiam `200 {"followups": []}`.

**Corrigido pelo usuário diretamente no GLPI** (direito de Ver em Acompanhamentos concedido ao perfil Bot). Reconfirmado no mesmo dia relendo os followups de teste: a coleção passou a devolver os itens reais, incluindo o envelope `{type, item}` (ver acima) e a exclusão correta de um followup privado de teste (`is_private: true` nunca aparece na resposta da API).

**Chamados de teste criados que precisam limpeza manual no GLPI:** #36 (followups #5 público, #6 privado), #37 (followup #7 público), #38 (followups #8/#10/#11 públicos, #9 privado). Usuários de teste: `backbone-glpi-followup-test@example.invalid` (#21), `backbone-e2e-test-2@example.invalid` (#23).

### Status (2026-09-14)

- **Cliente OAuth2 "Filament" já criado no GLPI** (ID 1): grants Senha + Credenciais do cliente + Código de autorização; escopos `email`, `user`, `api`, `status`. Sem restrição de IP (necessário — Vercel não tem IP de saída estável).
- **Conta de serviço já criada**: perfil "Bot" (ID 10) com só Usuários (ler, criar) e Chamados (criar, ver meu chamado, ver todos os chamados) marcados; usuário `filament` (ID 16), autorização na entidade "Elinsa do Brasil", não-recursivo. Se a Elinsa criar sub-entidades que também precisem de chamados via essa integração, revisitar o "não-recursivo".
- **`GLPI_APP_CLIENT_ID`/`SECRET` e `GLPI_SERVICE_ACCOUNT_USERNAME`/`PASSWORD` já preenchidos no `.env` real** (não commitado, `.env*` é gitignored).
- **Testado de ponta a ponta**: grant `password` contra o GLPI real retornou `access_token` (HTTP 200) com essas credenciais. `GET /api/glpi/status` sem sessão retorna 401 corretamente (rota montada, gate do Better Auth funcionando). Ainda não testado com uma sessão real (esperado retornar `{connected: true}`).
- **`src/index.ts` — montagem de `app.route('/api/glpi', glpiRoutes)` feita localmente mas AINDA NÃO COMMITADA**: esse arquivo está compartilhado com outro trabalho em andamento no mesmo checkout (native-app-schemes/passkey, de outra sessão), então o commit da integração GLPI não inclui essa linha pra não empacotar código alheio ainda não revisado. Quem for continuar precisa adicionar essas duas linhas a `src/index.ts` (import de `glpiRoutes` de `./routes/glpi.js` + `app.route('/api/glpi', glpiRoutes)` logo após `app.all('/api/auth/*', ...)`) — ou commitar depois que o outro trabalho for commitado primeiro.
- Próximo passo natural: busca/auto-provisionamento de `User` por e-mail e CRUD de `Ticket` (ainda fora de escopo).

## Migração pra API legada (etapa 4, 2026-09-16)

**Motivo:** a v2 nunca resolveu listar `Ticket` filtrando pelo ator (HTTP 500), o que forçava uma
tabela própria no Postgres (`GlpiTicket`, etapa 3) — que por sua vez nunca mostrava chamados
abertos fora do app (UI do GLPI, técnico em nome do usuário). Avaliado trocar pra API legada
(`apirest.php`) especificamente por causa disso: ela expõe o motor de busca (`search.php`) que a
própria UI do GLPI usa, com meta-critérios entre itemtypes — resolve o filtro por ator de
verdade. Confirmado empiricamente ponta a ponta antes de migrar (não só pela doc — este projeto
já foi mordido por doc errada da v2 mais de uma vez).

De brinde, a legada também resolveu outros atritos que a v2 tinha (todos confirmados contra a
instância real, chamados/usuários de teste #40/#41, #24 — **limpar manualmente**, perfil Bot sem
direito de excluir):

| Problema na v2 | Como a legada resolve |
|---|---|
| Requerente exigia 2 chamadas (`Ticket` + `TeamMember`) | `_users_id_requester` no input do `POST /Ticket` já atribui numa chamada só |
| `POST /Administration/User` ignorava `emails[]` silenciosamente | `_useremails` no input do `POST /User` grava de verdade (confirmado via `GET /User/{id}/UserEmail`) — usuário auto-provisionado passa a ter e-mail real no GLPI |
| Followup exigia atribuição indireta, senão virava a conta de serviço | `users_id` no input do `POST /ITILFollowup` atribui direto |
| Coleção de followup vinha envelopada (`{type, item}`), não documentado | `GET /Ticket/{id}/ITILFollowup` é uma lista plana, como a doc diz |
| Sem filtro de `Ticket` por ator (500) | `search/Ticket` com `criteria[field=4]` (ver abaixo) |

### Autenticação: `initSession`/`Session-Token`, não mais OAuth2

- `POST apirest.php/initSession` com `Authorization: Basic base64(username:password)` (reaproveita
  `GLPI_SERVICE_ACCOUNT_USERNAME`/`PASSWORD`, já existiam) + header `App-Token` (novo:
  `GLPI_V1_API_KEY`, gerado em Configurar > Geral > API > Cliente API REST). Existe também a opção
  `user_token` (gerado no perfil do próprio usuário, revogável sem trocar senha — mais seguro que
  Basic Auth com a senha real) — não usada por ora, mas é uma melhoria futura fácil se quiser
  reduzir a exposição da senha da conta de serviço.
- **A API legada precisou ser habilitada manualmente** (Configurar > Geral > API) — vinha
  desativada por padrão nesta instância (`GET /initSession` sem isso responde 400
  `["ERROR","API desativada"]`).
- **Uma sessão por operação, não por chamada individual.** `withGlpiSession()` em `src/lib/glpi.ts`
  abre uma sessão, compartilha ela entre todas as chamadas que uma função de alto nível precisa
  (ex.: `findUserByEmail` faz duas buscas na mesma sessão), e sempre fecha com `killSession` no
  final (best-effort — falha ao fechar não derruba o resultado). Ainda sem cache de sessão entre
  invocações — mesmo motivo de sempre: serverless na Vercel não tem estado confiável pra isso.
- **Formato de erro mudou**: a legada devolve `["ERROR_CODE", "mensagem"]` (array de 2 posições)
  em vez do `{message: "..."}"`/`{error_description: "..."}` da v2. `legacyFetch()` já trata isso.

### `search/Ticket` — o motivo real da migração

- Campo de requerente descoberto via `GET /listSearchOptions/Ticket`: **`field=4`**
  (`Ticket.Ticket_User.User.name`, tabela `glpi_users`). Outros campos usados:
  `1`=Título, `2`=ID, `12`=Status (código cru, sem tradução), `15`=Data de abertura (`date`),
  `19`=Última atualização (`date_mod`).
- Query: `GET /search/Ticket?criteria[0][field]=4&criteria[0][searchtype]=equals&criteria[0][value]=<id>&forcedisplay[...]`.
  **Cuidado com a serialização da query** — tem que ser array-style de PHP
  (`criteria[0][field]=...`), não uma string JSON num query param; e os *valores* (não as chaves)
  precisam de `encodeURIComponent`, senão a instância responde **500 com página HTML de erro**
  (não JSON) — foi assim que descobri os dois bugs, um de cada vez.
- **`searchtype=equals` não funciona em campos dropdown/itemlink** (`Ticket.status`,
  `User.name`, `User.UserEmail.email`) — confirmado contra a instância real, devolve `totalcount:0`
  mesmo pra valor existente (parece comparar contra o id resolvido internamente, não o texto).
  Usa `searchtype=contains` (funciona) e filtra client-side por igualdade exata — só `field=4`
  (Ticket.Ticket_User, não itemlink em si) aceita `equals` de verdade, confirmado com resultado
  correto.
- **Chamados na lixeira (`is_deleted=1`) não aparecem em `search` por padrão** — comportamento
  normal do GLPI (mesmo que a UI), não bug. Se algum dia precisar buscar incluindo lixeira, manda
  `&is_deleted=1` na query.
- `status` (searchoption 12) vem como **código numérico cru**, sem tradução — diferente da v2 que
  dava `{id, name}` de graça. A tradução agora é responsabilidade daqui (`TICKET_STATUS_NAMES` em
  `src/lib/glpi.ts`, os mesmos códigos ITIL já documentados na etapa 3).
- Datas (`date`/`date_mod`) vêm como string "naive" (`"2026-09-16 10:07:37"`, sem timezone) —
  `toIsoDateTime()` assume `-03:00` (América/São_Paulo, mesmo timezone que a v2 sempre devolveu
  explícito, e o Brasil não usa mais horário de verão desde 2019).

### Tabela `GlpiTicket` removida (migração `20260916132626_drop_glpi_ticket_tracking`)

Não é mais necessária — `listTicketsForRequester`/`ticketBelongsToRequester` consultam o GLPI
direto via `search/Ticket`. Isso também **corrige** a limitação da etapa 3 (chamado fora do app
não aparecia na listagem): agora qualquer chamado onde o usuário é requerente aparece, não importa
como foi criado.

### `authorName` dos followups agora mais correto

A legada não embute nome/e-mail no followup (só `users_id`), então `listTicketFollowups` ainda
precisa de uma segunda consulta por autor único (`GET /User/{id}` + `GET /User/{id}/UserEmail`,
em paralelo) — mesmo padrão best-effort da etapa 3. Mas como `createUser` agora grava `firstname`
+ `_useremails` de verdade, `authorName` prioriza `firstname`+`realname` e só cai pro `username`
(e-mail) se nenhum dos dois existir — resolve o problema documentado na etapa 3 (autor aparecia
com o e-mail cru numa releitura).

### Variáveis de ambiente

- **Removidas** (não usadas mais): `GLPI_APP_CLIENT_ID`, `GLPI_APP_CLIENT_SECRET`.
- **Nova**: `GLPI_V1_API_KEY` (App-Token do Cliente API REST, Configurar > Geral > API).
- **Reaproveitadas**: `GLPI_URL_API` (só pra derivar a raiz — `LEGACY_ROOT` em `glpi.ts` tira o
  sufixo de versão e o `/api.php`), `GLPI_SERVICE_ACCOUNT_USERNAME`/`PASSWORD` (agora via Basic
  Auth em `initSession`, antes eram o grant `password` do OAuth2).

### Testado ponta a ponta (2026-09-16)

Sessão real do Better Auth, dois usuários de teste pra confirmar isolamento: criação de chamado
com requerente correto numa chamada, listagem específica por usuário (chamado de A não aparece
pra B), 404 de posse pra followups (B não lê nem posta no chamado de A), followup público
criado e relido com autor/e-mail corretos, followup privado corretamente excluído da listagem.
