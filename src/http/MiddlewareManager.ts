import { IncomingMessage, ServerResponse } from 'http'
import { Middleware } from './Middleware'

export class MiddlewareManager {
  private globalMiddlewares: Middleware[] = []

  public registerMiddleware(middleware: Middleware[]): void {
    this.globalMiddlewares.push(...middleware)
  }

  public async runMiddlewares(
    req: IncomingMessage,
    res: ServerResponse,
    middlewares: Middleware[],
    finalHandler: () => void
  ): Promise<void> {
    let index = 0

    const next = async (): Promise<void> => {
      if (index < middlewares.length) {
        // eslint-disable-next-line security/detect-object-injection
        const middleware = middlewares[index]
        index++
        await middleware(req, res, next)
      } else {
        finalHandler()
      }
    }

    await next()
  }

  public getGlobalMiddlewares(): Middleware[] {
    return this.globalMiddlewares
  }
}
