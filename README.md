Backend Hono (template Vercel) com [Better Auth](https://www.better-auth.com), centralizado para servir múltiplos clientes — um app Next.js (web) e um app Kotlin (Android).

- **Auth:** email/senha (com verificação obrigatória via OTP), OTP por email (login sem senha), OAuth Microsoft, bearer tokens
- **DB:** PostgreSQL via Prisma ORM 7 (driver adapter `@prisma/adapter-pg`)
- **Email:** Resend
- **Clientes:** qualquer cliente HTTP pode consumir `/api/auth/*` — via cookie de sessão no browser (`better-auth/react`, usado pelo Next.js) ou via bearer token em clientes nativos (Kotlin/Android, scripts, etc.)

## Setup

Prerequisites:

- [Vercel CLI](https://vercel.com/docs/cli) installed globally
- [Docker](https://docs.docker.com/get-docker/) com Docker Compose

```
cp .env.example .env   # preencha DATABASE_URL, BETTER_AUTH_SECRET, etc.
pnpm install
pnpm db:up
pnpm db:migrate --name init
```

O `pnpm db:up` inicia um PostgreSQL local em `localhost:5432`, com os dados
persistidos no volume Docker `backbone-postgres`. Para parar o container sem
apagar os dados, use `pnpm db:down`. Para acompanhar os logs, use
`pnpm db:logs`.

Se preferir usar Neon, Vercel Postgres ou Supabase, mantenha o fluxo acima e
substitua apenas `DATABASE_URL` no `.env`.

> No Prisma 7, `DATABASE_URL` é lido em `prisma.config.ts` (via `prisma/config`'s `env()`) e é exigido por **qualquer** comando do CLI, inclusive `prisma generate` — que roda automaticamente no `postinstall`. Por isso o `.env` precisa existir *antes* do `pnpm install`.

To develop locally:

```
pnpm dev
```

ou, para simular o ambiente Vercel:

```
vc dev
```

## Variáveis de ambiente

Veja [.env.example](.env.example). Depois de mudar `src/lib/auth.ts` (ex: adicionar plugin), regenere o schema do Prisma com:

```
pnpm auth:generate
pnpm prisma migrate dev
```

## Endpoints

Todas as rotas do Better Auth ficam montadas em `/api/auth/*` (ex: `/api/auth/sign-up/email`, `/api/auth/sign-in/email`, `/api/auth/callback/microsoft`).

## Conectando o app Next.js

No projeto Next.js:

```
npm install better-auth
```

```ts
// lib/auth-client.ts
import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: "http://localhost:3000", // ou a URL de produção do backend
  plugins: [emailOTPClient()],
});
```

Como o Next.js roda numa origem diferente do backend, adicione a URL do app em `TRUSTED_ORIGINS` — ela é usada tanto pelo CORS quanto pelo `trustedOrigins` do Better Auth. Em desenvolvimento local, rode o Next.js numa porta diferente da do backend (ex: `next dev -p 3001`), já que os dois usam a porta 3000 por padrão.

O client já envia cookies em requisições cross-origin (`credentials: "include"`), então a sessão funciona sem configuração extra.

### Produção: Next.js no domínio raiz, backend em subdomínio

Com o Next.js em `https://seudominio.com` e este backend em `https://auth.seudominio.com`:

- Defina `COOKIE_DOMAIN=.seudominio.com` (nota o ponto no início) nas variáveis de ambiente do backend. Isso habilita `advanced.crossSubDomainCookies` no Better Auth, fazendo o cookie de sessão setado pelo backend valer também no domínio raiz.
- `TRUSTED_ORIGINS=https://seudominio.com` (a origem do Next.js).
- `BETTER_AUTH_URL=https://auth.seudominio.com` (a URL pública deste backend).

Com isso, o middleware do Next.js pode checar a existência da sessão direto pelo cookie, sem chamar o backend:

```ts
// middleware.ts
import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

export async function middleware(request: NextRequest) {
  const sessionCookie = getSessionCookie(request);
  if (!sessionCookie && request.nextUrl.pathname.startsWith("/dashboard")) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
```

`getSessionCookie` só verifica se o cookie existe (é uma checagem otimista, mais rápida, mas falsificável) — ele **não** valida a sessão no banco. Páginas e ações protegidas ainda devem validar a sessão de verdade chamando `authClient.getSession()` (ou `GET /api/auth/get-session`) no server.

O plugin `bearer()` do servidor continua disponível para chamar a API com header `Authorization: Bearer <token>` fora do browser (ex: testes, um painel admin).

## Conectando o app Kotlin (Android)

Não há client oficial do Better Auth para Kotlin. O app deve chamar as rotas REST em `/api/auth/*` diretamente com qualquer HTTP client (Ktor, OkHttp, Retrofit etc.), usando o plugin `bearer()` já habilitado no servidor:

1. Login: `POST /api/auth/sign-in/email` (ou `/sign-in/email-otp` para OTP) com `{ email, password }` no corpo.
2. Leia o header de resposta `set-auth-token` e guarde o valor com segurança (ex: `EncryptedSharedPreferences` / Android Keystore).
3. Nas próximas chamadas, envie `Authorization: Bearer <token>`.
4. `GET /api/auth/get-session` valida o token e retorna a sessão/usuário atual.
5. `POST /api/auth/sign-out` encerra a sessão.

O app aponta direto para a URL deste backend (o mesmo host de `BETTER_AUTH_URL`) — em produção, `https://auth.seudominio.com`. Ele não tem relação com o domínio raiz do Next.js nem com `COOKIE_DOMAIN`: isso é tudo mecanismo de cookie, que só existe para clientes browser. Por ser um cliente nativo (não-browser), ele também não envia header `Origin` — não precisa constar em `TRUSTED_ORIGINS`. No emulador Android, use `http://10.0.2.2:3000` para acessar o backend rodando no host (em vez de `localhost`).

## Deploy

```
vc deploy
```

O build da Vercel roda `prisma generate` automaticamente via `postinstall`.
