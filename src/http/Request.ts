import * as http from 'http'

declare module 'http' {
  interface IncomingMessage {
    params: Record<string, string>
    query: Record<string, string>
    body: string
    getQueryString(): void
    getBody(): Promise<void>
  }
}

http.IncomingMessage.prototype.getQueryString = function (
  this: http.IncomingMessage
): Record<string, string> {
  this.query = this.query || {}

  const urlParts = this.url.split('?')
  const queryString = urlParts[1]

  if (queryString) {
    const queryParams = new URLSearchParams(queryString)
    for (const [key, value] of queryParams.entries()) {
      // eslint-disable-next-line security/detect-object-injection
      this.query[key] = value
    }
  }
  return this.query
}

http.IncomingMessage.prototype.getBody = function (this: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    if (this.body) {
      resolve(this.body)
    }
    let body = ''

    this.on('data', (chunk) => {
      body += chunk
    })

    this.on('end', () => {
      try {
        this.body = JSON.parse(body)
        resolve(this.body)
      } catch (error) {
        reject(error)
      }
    })

    this.on('error', (error) => {
      reject(error)
    })
  })
}
