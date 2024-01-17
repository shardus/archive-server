import * as http from 'http'
import './Request'
import './Response'
import { Middleware } from './Middleware'

import { MiddlewareManager } from './MiddlewareManager'
import { RequestHandler } from './RequestHandler'

export class Server {
  public server: http.Server
  private middlewareManager = new MiddlewareManager()
  private requestHandler = new RequestHandler(this.middlewareManager)
  private port: number

  constructor(port: number) {
    this.server = http.createServer((req, res) => this.requestHandler.handle(req, res))
    this.port = port
  }

  public registerMiddleware(middleware: Middleware[]): void {
    this.middlewareManager.registerMiddleware(middleware)
  }

  public registerRoute(method: string, route: string, arg3: any, arg4?: any): void {
    if (Array.isArray(arg3)) {
      this.requestHandler.registerRoute(method, route, arg4, arg3)
    } else {
      this.requestHandler.registerRoute(method, route, arg3)
    }
  }

  public start(successCallback?: () => void, errorCallback?: (error: Error) => void): void {
    this.server.listen(this.port, () => {
      if (successCallback) {
        successCallback()
      }
    })

    this.server.on('error', (error: Error) => {
      if (errorCallback) {
        errorCallback(error)
      }
    })
  }
}
