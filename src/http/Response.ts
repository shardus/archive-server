import * as http from 'http'

declare module 'http' {
  interface ServerResponse {
    send(data: any, statusCode?: number): void
    sendJson(data: any, statusCode?: number): void
  }
}

http.ServerResponse.prototype.send = function (data, statusCode = 200): void {
  this.writeHead(statusCode)
  console.log('data', data)
  this.end(data)
}

http.ServerResponse.prototype.sendJson = function (data, statusCode = 200): void {
  const body = JSON.stringify(data)
  this.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  })
  this.end(body)
}
