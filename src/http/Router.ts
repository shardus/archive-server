import { IncomingMessage, ServerResponse } from 'http'
import { Middleware } from './Middleware'

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void
type RouteDefinition = {
  handler: RouteHandler
  pattern: string
  middlewares?: Middleware[]
}

export class Router {
  private routes: Record<string, Record<string, RouteDefinition>> = {}

  public registerRoute(method: string, route: string, arg3: any, arg4?: any): void {
    let handler: RouteHandler
    let middlewares: Middleware[] | undefined

    if (Array.isArray(arg3)) {
      middlewares = arg3
      handler = arg4
    } else {
      handler = arg3
    }

    // eslint-disable-next-line security/detect-object-injection
    if (!this.routes[route]) {
      // eslint-disable-next-line security/detect-object-injection
      this.routes[route] = {}
    }
    // eslint-disable-next-line security/detect-object-injection
    this.routes[route][method] = { handler, pattern: route, middlewares }
  }

  public findRoute(method: string, path: string): RouteDefinition | undefined {
    for (const pattern in this.routes) {
      const routeRegex = this.convertPatternToRegex(pattern)
      const match = path.match(routeRegex)

      // eslint-disable-next-line security/detect-object-injection
      if (match && this.routes[pattern][method]) {
        // eslint-disable-next-line security/detect-object-injection
        return this.routes[pattern][method]
      }
    }
    return undefined
  }

  public convertPatternToRegex(pattern: string): RegExp {
    // eslint-disable-next-line security/detect-non-literal-regexp
    return new RegExp('^' + pattern.replace(/:[^\s/]+/g, '([^\\s/]+)') + '$')
  }

  public extractRouteParams(pattern: string, match: RegExpMatchArray): Record<string, string> {
    const paramNames = pattern.match(/:([^/]+)/g)?.map((param) => param.substring(1)) || []
    const params: Record<string, string> = {}

    paramNames.forEach((paramName, index) => {
      // eslint-disable-next-line security/detect-object-injection
      params[paramName] = match[index + 1] || ''
    })

    return params
  }
}
