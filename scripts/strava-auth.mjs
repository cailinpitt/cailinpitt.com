#!/usr/bin/env node
// One-time Strava OAuth, to get the refresh token the Worker needs.
//
//   npm run moving:auth
//
// Needs STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET in .env, from
// https://www.strava.com/settings/api. Set that app's "Authorization Callback
// Domain" to `localhost` — this opens a local server on PORT to catch the
// redirect, so nothing has to be pasted back by hand.
//
// Strava rotates the refresh token on every exchange, so the value printed here
// is only a seed: after the Worker's first run, D1 holds the current one.

import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
try {
  process.loadEnvFile(path.join(ROOT, '.env'))
} catch {
  /* fall back to the ambient environment */
}

const CLIENT_ID = process.env.STRAVA_CLIENT_ID
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET
const PORT = 8721
const REDIRECT = `http://localhost:${PORT}/exchange_token`

// read_all so private activities are included; without it a ride marked
// private is invisible to the API and would silently miss from the archive.
const SCOPE = 'read,activity:read_all'

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('✗ Missing STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET in .env')
  process.exit(1)
}

const authorizeUrl =
  `https://www.strava.com/oauth/authorize?client_id=${CLIENT_ID}` +
  `&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT)}` +
  `&approval_prompt=force&scope=${encodeURIComponent(SCOPE)}`

async function exchange(code) {
  const res = await fetch('https://www.strava.com/api/v3/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
    }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(JSON.stringify(body))
  return body
}

console.log('\nOpen this in a browser and click Authorize:\n')
console.log(`  ${authorizeUrl}\n`)
console.log(`Waiting for the redirect on ${REDIRECT} …`)

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  if (url.pathname !== '/exchange_token') {
    res.writeHead(404).end('Not found')
    return
  }

  const error = url.searchParams.get('error')
  if (error) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end(`Strava returned: ${error}`)
    console.error(`\n✗ ${error}`)
    server.close()
    process.exit(1)
  }

  const code = url.searchParams.get('code')
  const granted = url.searchParams.get('scope') ?? ''
  try {
    const token = await exchange(code)
    res
      .writeHead(200, { 'content-type': 'text/plain' })
      .end('Authorized. You can close this tab and return to the terminal.')

    if (!granted.includes('activity:read_all')) {
      console.warn('\n! activity:read_all was not granted — private activities will be missing.')
    }

    console.log(`\n✓ Authorized as ${token.athlete?.firstname ?? 'athlete'}\n`)
    console.log('Add to .env:\n')
    console.log(`  STRAVA_REFRESH_TOKEN=${token.refresh_token}\n`)
    console.log('Then store the three on the Worker:\n')
    console.log('  cd worker-moving')
    console.log('  npx wrangler secret put STRAVA_CLIENT_ID')
    console.log('  npx wrangler secret put STRAVA_CLIENT_SECRET')
    console.log('  npx wrangler secret put STRAVA_REFRESH_TOKEN\n')
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end('Token exchange failed.')
    console.error(`\n✗ Token exchange failed: ${err.message}`)
    server.close()
    process.exit(1)
  }
  server.close()
  process.exit(0)
})

server.listen(PORT)
