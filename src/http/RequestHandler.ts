import { IncomingMessage, ServerResponse } from 'http'
import { MiddlewareManager } from './MiddlewareManager'
import { Router } from './Router'
import { Middleware } from './Middleware'

export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void

export class RequestHandler {
  private router: Router
  private middlewareManager: MiddlewareManager

  constructor(middlewareManager: MiddlewareManager) {
    this.router = new Router()
    this.middlewareManager = middlewareManager
  }

  public registerRoute(
    method: string,
    path: string,
    handler: RouteHandler,
    middlewares: Middleware[] = []
  ): void {
    this.router.registerRoute(method, path, middlewares, handler)
  }

  public async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { method, url } = req
    const path = url.split('?')[0]
    const routeDefinition = this.router.findRoute(method, path)

    if (routeDefinition) {
      const routeParams = this.router.extractRouteParams(
        routeDefinition.pattern,
        path.match(this.router.convertPatternToRegex(routeDefinition.pattern))
      )
      req.params = routeParams

      const middlewares = [
        ...this.middlewareManager.getGlobalMiddlewares(),
        ...(routeDefinition.middlewares || []),
      ]

      await this.middlewareManager.runMiddlewares(req, res, middlewares, () => {
        routeDefinition.handler(req, res)
      })
    } else {
      res.statusCode = 404
      res.end('Not Found')
    }
  }
}
