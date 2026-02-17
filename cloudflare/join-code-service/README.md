# Join Code Service (Cloudflare Worker)

This service maps a 5-digit join code to a host signaling URL.

## Endpoints
- `GET /health`
- `POST /register` body: `{ "wsUrl": "wss://.../signal", "roomId": "jayde-room", "ttlSeconds": 900 }`
- `POST /resolve` body: `{ "code": "12345" }`

## Deploy
1. Authenticate:
   - `npx wrangler login`
   - or set `CLOUDFLARE_API_TOKEN`
2. Create KV namespace:
   - `npm run code-service:kv:create`
3. Copy the generated `id` and `preview_id` into `cloudflare/join-code-service/wrangler.toml`.
4. Deploy:
   - `npm run code-service:deploy`
5. Use the deployed Worker URL in app field `Code service URL`.

## Local dev
- `npm run code-service:dev`
