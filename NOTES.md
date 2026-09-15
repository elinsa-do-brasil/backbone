## Integração com o GLPI (helpdesk.elinsadobrasil.com.br)

- **Proxy via backend, não o app direto**: as credenciais do GLPI (`GLPI_APP_CLIENT_SECRET`, senha da conta de serviço) não podem ficar no dispositivo/APK. O app (`filament`) chama `/api/glpi/*` aqui no `backbone`, autenticado com o mesmo bearer token do Better Auth; quem fala com o GLPI é só este backend.
- **API v2 do GLPI (`api.php/v2.3`), OAuth2** — não a API legada (`apirest.php`, `App-Token`/`user_token`). Verificado via Context7 (`/glpi-project/glpi`).
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
- **Listar os chamados de um usuário**: filtrar a coleção `Ticket` pelo ator (`?filter=team.id==`, `?filter=team.role==`) faz o GLPI responder **HTTP 500**. Duas saídas quando for a hora: (a) achar o filtro certo/corrigir do lado do GLPI, ou (b) guardar o par `(usuário do app, id do ticket)` numa tabela própria no Postgres daqui ao criar o chamado, e listar a partir dela.
- UI de chamados no app além do formulário de abertura (a listagem depende do item acima).

### Status (2026-09-14)

- **Cliente OAuth2 "Filament" já criado no GLPI** (ID 1): grants Senha + Credenciais do cliente + Código de autorização; escopos `email`, `user`, `api`, `status`. Sem restrição de IP (necessário — Vercel não tem IP de saída estável).
- **Conta de serviço já criada**: perfil "Bot" (ID 10) com só Usuários (ler, criar) e Chamados (criar, ver meu chamado, ver todos os chamados) marcados; usuário `filament` (ID 16), autorização na entidade "Elinsa do Brasil", não-recursivo. Se a Elinsa criar sub-entidades que também precisem de chamados via essa integração, revisitar o "não-recursivo".
- **`GLPI_APP_CLIENT_ID`/`SECRET` e `GLPI_SERVICE_ACCOUNT_USERNAME`/`PASSWORD` já preenchidos no `.env` real** (não commitado, `.env*` é gitignored).
- **Testado de ponta a ponta**: grant `password` contra o GLPI real retornou `access_token` (HTTP 200) com essas credenciais. `GET /api/glpi/status` sem sessão retorna 401 corretamente (rota montada, gate do Better Auth funcionando). Ainda não testado com uma sessão real (esperado retornar `{connected: true}`).
- **`src/index.ts` — montagem de `app.route('/api/glpi', glpiRoutes)` feita localmente mas AINDA NÃO COMMITADA**: esse arquivo está compartilhado com outro trabalho em andamento no mesmo checkout (native-app-schemes/passkey, de outra sessão), então o commit da integração GLPI não inclui essa linha pra não empacotar código alheio ainda não revisado. Quem for continuar precisa adicionar essas duas linhas a `src/index.ts` (import de `glpiRoutes` de `./routes/glpi.js` + `app.route('/api/glpi', glpiRoutes)` logo após `app.all('/api/auth/*', ...)`) — ou commitar depois que o outro trabalho for commitado primeiro.
- Próximo passo natural: busca/auto-provisionamento de `User` por e-mail e CRUD de `Ticket` (ainda fora de escopo).
