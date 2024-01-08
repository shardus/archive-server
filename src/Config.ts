import { readFileSync } from 'fs'
import * as Logger from './Logger'
import * as merge from 'deepmerge'
import * as minimist from 'minimist'
import { join } from 'path'

export interface Config {
  [index: string]: object | string | number | boolean
  ARCHIVER_IP: string
  ARCHIVER_PORT: number
  ARCHIVER_HASH_KEY: string
  ARCHIVER_PUBLIC_KEY: string
  ARCHIVER_SECRET_KEY: string
  ARCHIVER_DB: string
  DATASENDER_TIMEOUT: number
  RATE_LIMIT: number // number of allowed request per second,
  N_NODE_REJECT_PERCENT: number
  N_NODELIST: number
  N_RANDOM_NODELIST_BUCKETS: number // Number of random node lists in the NodeList cache
  STATISTICS: {
    save: boolean
    interval: number
  }
  MODE: string
  DEBUG: {
    hashedDevAuth?: string
    devPublicKey?: string
  }
  dataLogWrite: boolean
  dataLogWriter: {
    dirName: string
    maxLogFiles: number
    maxReceiptEntries: number
    maxCycleEntries: number
    maxOriginalTxEntries: number
  }
  experimentalSnapshot: boolean
  VERBOSE: boolean
  useSerialization: boolean
  useSyncV2: boolean
  sendActiveMessage: boolean
  globalNetworkAccount: string
  maxValidatorsToServe: number
  minValidatorCount: number
}

let config: Config = {
  ARCHIVER_IP: '127.0.0.1',
  ARCHIVER_PORT: 4000,
  ARCHIVER_HASH_KEY: '',
  ARCHIVER_PUBLIC_KEY: '',
  ARCHIVER_SECRET_KEY: '',
  ARCHIVER_LOGS: 'archiver-logs',
  ARCHIVER_DB: 'archiver-db',
  DATASENDER_TIMEOUT: 1000 * 60 * 5,
  RATE_LIMIT: 100, // 100 req per second,
  N_NODE_REJECT_PERCENT: 5, // Percentage of old nodes to remove from nodelist
  N_NODELIST: 30, // number of active node list GET /nodelist should emit but if the total active nodelist is less than said value it will emit all the node list.
  N_RANDOM_NODELIST_BUCKETS: 10,
  STATISTICS: {
    save: true,
    interval: 1,
  },
  MODE: 'debug', // 'debug'/'release'
  DEBUG: {
    hashedDevAuth: '',
    devPublicKey: '',
  },
  dataLogWrite: true,
  dataLogWriter: {
    dirName: 'data-logs',
    maxLogFiles: 10,
    maxReceiptEntries: 10000, // Should be >= max TPS experienced by the network.
    maxCycleEntries: 500,
    maxOriginalTxEntries: 10000, // Should be >= max TPS experienced by the network.
  },
  experimentalSnapshot: true,
  VERBOSE: false,
  useSerialization: true,
  useSyncV2: true,
  sendActiveMessage: false,
  globalNetworkAccount: process.env.GLOBAL_ACCOUNT || '0'.repeat(64), //this address will change in the future
  maxValidatorsToServe: 10, // max number of validators to serve accounts data during restore mode
  minValidatorCount: 5, // min number of validators suggested for the network
}
// Override default config params from config file, env vars, and cli args
export function overrideDefaultConfig(env: NodeJS.ProcessEnv, args: string[]): string {
  let file = ''

  // Override config from config file
  try {
    file = join(process.cwd(), 'archiver-config.json')
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const fileConfig = JSON.parse(readFileSync(file, { encoding: 'utf8' }))
    const overwriteMerge = (target: [], source: []): [] => source
    config = merge(config, fileConfig, { arrayMerge: overwriteMerge })
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.warn('Failed to parse config file:', err)
    }
    return ''
  }

  // Override config from env vars
  for (const param in config) {
    /* eslint-disable security/detect-object-injection */
    if (env[param]) {
      switch (typeof config[param]) {
        case 'number': {
          config[param] = Number(env[param])
          break
        }
        case 'string': {
          config[param] = String(env[param])
          break
        }
        case 'object': {
          try {
            const parameterStr = env[param]
            if (parameterStr) {
              const parameterObj = JSON.parse(parameterStr)
              config[param] = parameterObj
            }
          } catch (e) {
            Logger.mainLogger.error(e)
            Logger.mainLogger.error('Unable to JSON parse', env[param])
          }
          break
        }
        case 'boolean': {
          config[param] = String(env[param]).toLowerCase() === 'true'
          break
        }
        default: {
          break
        }
      }
    }
    /* eslint-enable security/detect-object-injection */

    return file
  }

  // Override config from cli args
  const parsedArgs = minimist(args.slice(2))
  for (const param of Object.keys(config)) {
    /* eslint-disable security/detect-object-injection */
    if (parsedArgs[param]) {
      switch (typeof config[param]) {
        case 'number': {
          config[param] = Number(parsedArgs[param])
          break
        }
        case 'string': {
          config[param] = String(parsedArgs[param])
          break
        }
        case 'boolean': {
          if (typeof parsedArgs[param] === 'boolean') {
            config[param] = parsedArgs[param]
          } else {
            config[param] = String(parsedArgs[param]).toLowerCase() === 'true'
          }
          break
        }
        default: {
          break
        }
      }
    }
    /* eslint-enable security/detect-object-injection */
  }

  return file
}

export { config }
