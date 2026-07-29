import { Hono, type Context } from 'hono'

const dubApiUrl = 'https://api.dub.co'

const securityHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow'
} as const

type VerifierContext = Context<{ Bindings: Env }>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : 'Unknown error')

const verifyLink = async (context: VerifierContext) => {
  const requestUrl = new URL(context.req.url)
  const linkUrl = URL.parse(context.env.LINK_URL)
  let key: string

  try {
    key = decodeURIComponent(requestUrl.pathname.slice(1))
  } catch {
    return verificationFailed(context)
  }

  if (!key || key.length > 190) return verificationFailed(context)
  if (linkUrl?.protocol !== 'https:' || linkUrl.origin !== context.env.LINK_URL || !context.env.DUB_KEY)
    return verificationUnavailable(context)

  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${context.env.DUB_KEY}`
  }

  try {
    const linkResponse = await fetch(
      `${dubApiUrl}/links/info?${new URLSearchParams({ domain: linkUrl.hostname, key })}`,
      { cache: 'no-store', headers, redirect: 'manual' }
    )

    if (linkResponse.status === 404) {
      void linkResponse.body?.cancel().catch(() => undefined)
      return verificationFailed(context)
    }

    if (!linkResponse.ok) {
      void linkResponse.body?.cancel().catch(() => undefined)
      throw new Error(`Dub link lookup failed with HTTP ${linkResponse.status}`)
    }

    const link: unknown = await linkResponse.json()
    if (
      !isRecord(link) ||
      typeof link.id !== 'string' ||
      !link.id ||
      typeof link.domain !== 'string' ||
      typeof link.key !== 'string' ||
      typeof link.url !== 'string'
    )
      throw new Error('Dub link lookup returned an invalid response')

    const targetUrl = new URL(requestUrl.origin)
    targetUrl.pathname = `/${link.key}`

    if (
      link.domain !== linkUrl.hostname ||
      link.key !== key ||
      requestUrl.pathname !== targetUrl.pathname ||
      URL.parse(link.url)?.href !== targetUrl.href
    )
      return verificationFailed(context)

    const deletionResponse = await fetch(`${dubApiUrl}/links/${encodeURIComponent(link.id)}`, {
      cache: 'no-store',
      method: 'DELETE',
      headers,
      redirect: 'manual'
    })

    if (deletionResponse.status === 404) {
      void deletionResponse.body?.cancel().catch(() => undefined)
      return verificationFailed(context)
    }

    if (!deletionResponse.ok) {
      void deletionResponse.body?.cancel().catch(() => undefined)
      throw new Error(`Dub link deletion failed with HTTP ${deletionResponse.status}`)
    }

    const deletion: unknown = await deletionResponse.json()
    if (!isRecord(deletion) || deletion.id !== link.id)
      throw new Error('Dub link deletion returned an invalid response')

    return context.text('一验定真，鉴定为原装 Space Time', 200, securityHeaders)
  } catch (error) {
    console.error(`Dub verification failed: ${getErrorMessage(error)}`)
    return verificationUnavailable(context)
  }
}

const methodNotAllowed = (context: VerifierContext) =>
  context.text('Method Not Allowed', 405, { ...securityHeaders, Allow: 'GET' })

const verificationFailed = (context: VerifierContext) =>
  context.text('Verification failed', 404, securityHeaders)

const verificationUnavailable = (context: VerifierContext) =>
  context.text('Verification unavailable', 502, securityHeaders)

export default new Hono<{ Bindings: Env }>()
  .onError((error, context) => {
    console.error(`Unhandled verifier error: ${getErrorMessage(error)}`)
    return context.text('Internal Server Error', 500, securityHeaders)
  })
  .get('/', (context) => context.redirect('https://app.dub.co/spacetime-studio'))
  .all('*', (context) => (context.req.method === 'GET' ? verifyLink(context) : methodNotAllowed(context)))
