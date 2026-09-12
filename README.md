Backend Hono (template Vercel) com [Better Auth](https://www.better-auth.com), pronto para servir um app Expo.

- **Auth:** email/senha (com verificação obrigatória via OTP), OTP por email (login sem senha), OAuth Microsoft, bearer tokens
- **DB:** PostgreSQL via Prisma ORM 7 (driver adapter `@prisma/adapter-pg`)
- **Email:** Resend
- **Mobile:** plugin `@better-auth/expo` já habilitado no servidor

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

## Conectando o app Expo

No projeto Expo:

```
npx expo install expo-secure-store
npm install better-auth @better-auth/expo
```

```ts
// lib/auth-client.ts
import { createAuthClient } from "better-auth/react";
import { expoClient } from "@better-auth/expo/client";
import * as SecureStore from "expo-secure-store";

export const authClient = createAuthClient({
  baseURL: "http://localhost:3000", // ou a URL de produção
  plugins: [
    expoClient({
      scheme: "myapp", // mesmo valor de EXPO_SCHEME no backend
      storagePrefix: "myapp",
      storage: SecureStore,
    }),
  ],
});
```

Garanta que `scheme` em `app.json`/`app.config.ts` do Expo bate com `EXPO_SCHEME` do backend (usado em `trustedOrigins`).

Para usar login por OTP (`emailOTP`) no client, adicione o plugin `emailOTPClient()` de `better-auth/client/plugins`. O plugin `expoClient` já cuida da sessão via cookie/SecureStore — o plugin `bearer()` do servidor é só um fallback para chamar a API com header `Authorization: Bearer <token>` fora do client (ex: testes, um painel web).

## Deploy

```
vc deploy
```

O build da Vercel roda `prisma generate` automaticamente via `postinstall`.
