import type { PingMessage } from './pingMessage'

// Best effort: runs after the response is sent, and a failure is only logged.
export async function sendPing(env: Env, message: PingMessage): Promise<void> {
  if (!env.PING || !env.PING_TOKEN) return
  try {
    const res = await env.PING.fetch('https://ping.cailin.link/comments', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.PING_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(message),
    })
    if (!res.ok) console.log(JSON.stringify({ level: 'warn', ping: res.status }))
  } catch (e) {
    console.log(JSON.stringify({ level: 'warn', ping: String(e) }))
  }
}
