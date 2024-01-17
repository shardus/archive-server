import { IncomingMessage, ServerResponse } from 'http'

type SyncMiddleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void
type AsyncMiddleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => Promise<void>
export type Middleware = SyncMiddleware | AsyncMiddleware

export const corsMiddleware: SyncMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void
): void => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  next()
}

export const rateLimitMiddleware: SyncMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void
): void => {
  const RATE_LIMIT = 100
  const allowList: string[] = []
  const requestCount: Record<string, number[]> = {}

  const clientIp = req.socket.remoteAddress
  const currentTime = Date.now()

  if (!allowList.includes(clientIp)) {
    // eslint-disable-next-line security/detect-object-injection
    requestCount[clientIp] = requestCount[clientIp] || []
    // eslint-disable-next-line security/detect-object-injection
    requestCount[clientIp] = requestCount[clientIp].filter(
      (timestamp) => timestamp >= currentTime - 10 * 60 * 1000
    )

    // eslint-disable-next-line security/detect-object-injection
    if (requestCount[clientIp].length > RATE_LIMIT) {
      res.writeHead(429, { 'Content-Type': 'text/plain' })
      res.end('Rate limit exceeded')
      return
    }

    // eslint-disable-next-line security/detect-object-injection
    requestCount[clientIp].push(currentTime)
  }

  next()
}

export const getBodyMiddleware: AsyncMiddleware = async (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void
): Promise<void> => {
  if (req.method === 'POST' || req.method === 'PUT') {
    await req.getBody()
  }
  next()
}

export const getQueryStringMiddleware: SyncMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void
): void => {
  req.getQueryString()
  next()
}
