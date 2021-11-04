import {join} from 'path'
import * as fastify from 'fastify'
import * as fastifyCors from 'fastify-cors'
import {Server, IncomingMessage, ServerResponse} from 'http'
import {overrideDefaultConfig, config} from './Config'
import * as Crypto from './Crypto'
import * as State from './State'
import * as NodeList from './NodeList'
import * as P2P from './P2P'
import * as Storage from './Storage'
import * as Data from './Data/Data'
import * as Cycles from './Data/Cycles'
import * as Utils from './Utils'
import {sendGossip, addHashesGossip} from './Data/Gossip'
import * as Logger from './Logger'
import {P2P as P2PTypes} from 'shardus-types'
import {readFileSync} from 'fs'
import {resolve} from 'path'
import {Readable} from 'stream'
import * as perf from 'shardus-perf-utils'
import * as crypto from './Crypto'

const Profiler = perf.default.Profiler
const NestedCounters = perf.default.NestedCounters
const MemoryReporting = perf.default.MemoryReporting
const Statistics = perf.default.Statistics

// Socket modules
let io: SocketIO.Server

// Override default config params from config file, env vars, and cli args
const file = join(process.cwd(), 'archiver-config.json')
const env = process.env
const args = process.argv
let logDir: string

export let nestedCountersInstance: any
export let profilerInstance: any
export let memoryReportingInstance: any
export let statisticsInstance: any

async function start() {
    overrideDefaultConfig(file, env, args)

    // Set crypto hash key from config
    Crypto.setCryptoHashKey(config.ARCHIVER_HASH_KEY)

    // If no keypair provided, generate one
    if (config.ARCHIVER_SECRET_KEY === '' || config.ARCHIVER_PUBLIC_KEY === '') {
        const keypair = Crypto.core.generateKeypair()
        config.ARCHIVER_PUBLIC_KEY = keypair.publicKey
        config.ARCHIVER_SECRET_KEY = keypair.secretKey
    }

    const logsConfig = JSON.parse(
        readFileSync(resolve(__dirname, '../archiver-log.json'), 'utf8')
    )
    logDir = `archiver-logs/${config.ARCHIVER_IP}_${config.ARCHIVER_PORT}`
    const baseDir = '.'
    logsConfig.dir = logDir
    Logger.initLogger(baseDir, logsConfig)

    // Initialize storage
    await Storage.initStorage(config)

    // Initialize state from config
    await State.initFromConfig(config)

    if (State.isFirst) {
        Logger.mainLogger.debug('We are first archiver. Starting archive-server')
        try {
            io = startServer()
        } catch (e) {
            console.error('Unable to start server', e)
        }
    } else {
        Logger.mainLogger.debug(
            'We are not first archiver. Syncing and starting archive-server'
        )
        syncAndStartServer()
    }
}

function initProfiler(server: fastify.FastifyInstance) {
    nestedCountersInstance = new NestedCounters(crypto)
    memoryReportingInstance = new MemoryReporting(
        null,
        statisticsInstance,
        null,
        null,
        null
    )
    profilerInstance = new Profiler('consensor', config.ARCHIVER_PUBLIC_KEY, config.ARCHIVER_IP, config.ARCHIVER_PORT)
    statisticsInstance = new Statistics(
        logDir,
        config.STATISTICS,
        {
            counters: [],
            watchers: {},
            timers: [],
            manualStats: ['cpuPercent'],
        },
        {}
    )
    memoryReportingInstance.setStatistics(statisticsInstance)
    statisticsInstance.startSnapshots()
    statisticsInstance.on('snapshot', memoryReportingInstance.updateCpuPercent)

    // ========== ENDPOINTS ==========
    try {
        for (let route in profilerInstance.handlers) {
            let handler = profilerInstance.handlers[route]
            server.get(`/${route}`, handler)
        }
        for (let route in nestedCountersInstance.handlers) {
            let handler = nestedCountersInstance.handlers[route]
            server.get(`/${route}`, handler)
        }
        for (let route in memoryReportingInstance.handlers) {
            let handler = memoryReportingInstance.handlers[route]
            server.get(`/${route}`, handler)
        }
    } catch (e) {
        console.error("Unable to register perf listeners", e)
    }
}

async function syncAndStartServer() {
    // If your not the first archiver node, get a nodelist from the others
    let isJoined = false
    let firstTime = true
    let cycleDuration = await Data.getCycleDuration()
    do {
        try {
            // Get active nodes from Archiver
            const nodeList: any = await NodeList.getActiveListFromArchivers(
                State.activeArchivers
            )

            // try to join the network
            isJoined = await Data.joinNetwork(nodeList, firstTime)
        } catch (err: any) {
            Logger.mainLogger.error('Error while joining network:')
            Logger.mainLogger.error(err)
            Logger.mainLogger.error(err.stack)
            Logger.mainLogger.debug(
                `Trying to join again in ${cycleDuration} seconds...`
            )
            await Utils.sleep(cycleDuration * 1000)
        }
        firstTime = false
    } while (!isJoined)

    /**
     * [NOTE] [AS] There's a possibility that we could get stuck in this loop
     * if the joinRequest was sent in the wrong cycle quarter (Q2, Q3, or Q4).
     *
     * Since we've dealt with this problem in shardus-global-server, it might be
     * good to refactor this code to do what shardus-global-server does to join
     * the network.
     */

    Logger.mainLogger.debug('We have successfully joined the network')

    await Data.syncCyclesAndNodeList(State.activeArchivers)

    // Sync all state metadata until no older data is fetched from other archivers
    await Data.syncStateMetaData(State.activeArchivers)
    // Set randomly selected consensors as dataSender
    let randomConsensor = NodeList.getRandomActiveNode()
    Data.addDataSenders({
        nodeInfo: randomConsensor,
        types: [
            P2PTypes.SnapshotTypes.TypeNames.CYCLE,
            P2PTypes.SnapshotTypes.TypeNames.STATE_METADATA,
        ],
    })

    // wait for one cycle before sending data request
    await Utils.sleep(cycleDuration * 1000)

    // start fastify server
    io = startServer()

    // After we've joined, select a consensus node as a dataSender
    const dataRequest = Crypto.sign({
        dataRequestCycle: Data.createDataRequest<Cycles.Cycle>(
            P2PTypes.SnapshotTypes.TypeNames.CYCLE,
            Cycles.getCurrentCycleCounter(),
            randomConsensor.publicKey
        ),
        dataRequestStateMetaData: Data.createDataRequest<P2PTypes.SnapshotTypes.StateMetaData>(
            P2PTypes.SnapshotTypes.TypeNames.STATE_METADATA,
            Cycles.lastProcessedMetaData,
            randomConsensor.publicKey
        ),
        nodeInfo: State.getNodeInfo(),
    })
    const newSender: Data.DataSender = {
        nodeInfo: randomConsensor,
        types: [
            P2PTypes.SnapshotTypes.TypeNames.CYCLE,
            P2PTypes.SnapshotTypes.TypeNames.STATE_METADATA,
        ],
        contactTimeout: Data.createContactTimeout(randomConsensor.publicKey),
        replaceTimeout: Data.createReplaceTimeout(randomConsensor.publicKey),
    }
    Data.sendDataRequest(newSender, dataRequest)
    Data.initSocketClient(randomConsensor)
}

// Define all endpoints, all requests, and start REST server
function startServer() {
    const server: fastify.FastifyInstance<Server,
        IncomingMessage,
        ServerResponse> = fastify({
        logger: false,
    })

    server.register(fastifyCors)
    // server.register(require('fastify-rate-limit'), {
    //   max: config.RATE_LIMIT,
    //   timeWindow: 1000,
    // })

    // Socket server instance
    io = require('socket.io')(server.server)
    Data.initSocketServer(io)

    initProfiler(server)

    /**
     * ENTRY POINT: New Shardus network
     *
     * Consensus node zero (CZ) posts IP and port to archiver node zero (AZ).
     *
     * AZ adds CZ to nodelist, sets CZ as dataSender, and responds with
     * nodelist + archiver join request
     *
     * CZ adds AZ's join reqeuest to cycle zero and sets AZ as cycleRecipient
     */
    server.post('/nodelist', (request, reply) => {
        profilerInstance.profileSectionStart('post_nodelist')
        nestedCountersInstance.countEvent('consensor', 'post_nodelist', 1)
        try {
            const signedFirstNodeInfo: P2P.FirstNodeInfo & Crypto.SignedMessage =
                request.body

            if (State.isFirst && NodeList.isEmpty()) {
                try {
                    const isSignatureValid = Crypto.verify(signedFirstNodeInfo)
                    if (!isSignatureValid) {
                        Logger.mainLogger.error('Invalid signature', signedFirstNodeInfo)
                        return
                    }
                } catch (e) {
                    Logger.mainLogger.error(e)
                }
                const ip = signedFirstNodeInfo.nodeInfo.externalIp
                const port = signedFirstNodeInfo.nodeInfo.externalPort
                const publicKey = signedFirstNodeInfo.nodeInfo.publicKey

                const firstNode: NodeList.ConsensusNodeInfo = {
                    ip,
                    port,
                    publicKey,
                }

                Data.initSocketClient(firstNode)

                // Add first node to NodeList
                NodeList.addNodes(NodeList.Statuses.SYNCING, 'bogus', [firstNode])

                // Set first node as dataSender
                Data.addDataSenders({
                    nodeInfo: firstNode,
                    types: [
                        P2PTypes.SnapshotTypes.TypeNames.CYCLE,
                        P2PTypes.SnapshotTypes.TypeNames.STATE_METADATA,
                    ],
                    replaceTimeout: Data.createReplaceTimeout(firstNode.publicKey),
                })

                const res = Crypto.sign<P2P.FirstNodeResponse>({
                    nodeList: NodeList.getList(),
                    joinRequest: P2P.createArchiverJoinRequest(),
                    dataRequestCycle: Data.createDataRequest<Cycles.Cycle>(
                        P2PTypes.SnapshotTypes.TypeNames.CYCLE,
                        Cycles.currentCycleCounter,
                        publicKey
                    ),
                    dataRequestStateMetaData: Data.createDataRequest<P2PTypes.SnapshotTypes.StateMetaData>(
                        P2PTypes.SnapshotTypes.TypeNames.STATE_METADATA,
                        Cycles.lastProcessedMetaData,
                        publicKey
                    ),
                })

                reply.send(res)
            } else {
                const cacheUpdatedTime = NodeList.cacheUpdatedTimes.get('/nodelist')
                const realUpdatedTime = NodeList.realUpdatedTimes.get('/nodelist')
                const cached = NodeList.cache.get('/nodelist')
                if (
                    cached &&
                    cacheUpdatedTime &&
                    realUpdatedTime &&
                    cacheUpdatedTime > realUpdatedTime
                ) {
                    // cache is hot, send cache

                    reply.send(cached)
                } else {
                    // cache is cold, remake cache

                    let nodeList = NodeList.getActiveList()
                    // If we dont have any active nodes, send back the first node in our list
                    if (nodeList.length < 1) {
                        nodeList = NodeList.getList().slice(0, 1)
                    }
                    const res = Crypto.sign({
                        nodeList: nodeList.sort((a: any, b: any) => (a.id > b.id ? 1 : -1)),
                    })

                    // Update cache
                    if (NodeList.realUpdatedTimes.get('/nodelist') === undefined) {
                        NodeList.realUpdatedTimes.set('/nodelist', 0)
                    }
                    NodeList.cache.set('/nodelist', res)
                    NodeList.cacheUpdatedTimes.set('/nodelist', Date.now())

                    reply.send(res)
                }
            }
        } finally {
            profilerInstance.profileSectionEnd('post_nodelist')
        }
    })

    server.get('/nodelist', (_request, reply) => {
        profilerInstance.profileSectionStart('get_nodelist')
        nestedCountersInstance.countEvent('consensor', 'get_nodelist')
        try {
            let nodeList = NodeList.getActiveList()
            if (nodeList.length < 1) {
                nodeList = NodeList.getList().slice(0, 1)
            }
            let sortedNodeList = [...nodeList].sort((a: any, b: any) =>
                a.id > b.id ? 1 : -1
            )
            const res = Crypto.sign({
                nodeList: sortedNodeList,
            })
            reply.send(res)
        } finally {
            profilerInstance.profileSectionEnd('get_nodelist')
        }

    })

    server.get('/full-nodelist', (_request, reply) => {
        const activeNodeList = NodeList.getActiveList()
        const syncingNodeList = NodeList.getSyncingList()
        const fullNodeList = activeNodeList.concat(syncingNodeList)
        const res = Crypto.sign({
            nodeList: fullNodeList,
        })
        reply.send(res)
    })

    server.get('/full-archive', async (_request, reply) => {
        let err = Utils.validateTypes(_request.query, {start: 's', end: 's'})
        if (err) {
            reply.send(Crypto.sign({success: false, error: err}))
            return
        }
        let {start, end} = _request.query
        let from = parseInt(start)
        let to = parseInt(end)
        if (!(from >= 0 && to >= from) || Number.isNaN(from) || Number.isNaN(to)) {
            reply.send(
                Crypto.sign({success: false, error: `Invalid start and end counters`})
            )
            return
        }
        let count = to - from
        if (count > 100) {
            reply.send(
                Crypto.sign({
                    success: false,
                    error: `Exceed maximum limit of 100 cycles`,
                })
            )
            return
        }
        let archivedCycles: any[]
        archivedCycles = await Storage.queryAllArchivedCyclesBetween(from, to)
        const res = Crypto.sign({
            archivedCycles,
        })
        reply.send(res)
    })

    server.get('/lost', async (_request, reply) => {
        profilerInstance.profileSectionStart('get_lost')
        try {
            let {start, end} = _request.query
            if (!start) start = 0
            if (!end) end = Cycles.currentCycleCounter

            let from = parseInt(start)
            let to = parseInt(end)
            if (!(from >= 0 && to >= from) || Number.isNaN(from) || Number.isNaN(to)) {
                reply.send(
                    Crypto.sign({success: false, error: `Invalid start and end counters`})
                )
                return
            }
            let lostNodes = []
            lostNodes = Cycles.getLostNodes(from, to)
            const res = Crypto.sign({
                lostNodes,
            })
            reply.send(res)

        } finally {
            profilerInstance.profileSectionEnd('get_lost')
        }

    })

    server.get('/full-archive/:count', async (_request, reply) => {
        let err = Utils.validateTypes(_request.params, {count: 's'})
        if (err) {
            reply.send(Crypto.sign({success: false, error: err}))
            return
        }

        let count: number = parseInt(_request.params.count)
        if (count <= 0 || Number.isNaN(count)) {
            reply.send(Crypto.sign({success: false, error: `Invalid count`}))
            return
        }
        if (count > 100) {
            reply.send(Crypto.sign({success: false, error: `Max count is 100`}))
            return
        }
        const archivedCycles = await Storage.queryAllArchivedCycles(count)
        const res = Crypto.sign({
            archivedCycles,
        })
        reply.send(res)
    })

    server.get('/nodeinfo', (_request, reply) => {
        reply.send({
            publicKey: config.ARCHIVER_PUBLIC_KEY,
            ip: config.ARCHIVER_IP,
            port: config.ARCHIVER_PORT,
            time: Date.now(),
        })
    })

    server.get('/cycleinfo', async (_request, reply) => {
        let {start, end, download} = _request.query
        if (!start) start = 0
        if (!end) end = Cycles.currentCycleCounter
        let from = parseInt(start)
        let to = parseInt(end)
        let isDownload: boolean = download === 'true'

        if (!(from >= 0 && to >= from) || Number.isNaN(from) || Number.isNaN(to)) {
            Logger.mainLogger.error(`Invalid start and end counters`)
            reply.send(
                Crypto.sign({success: false, error: `Invalid start and end counters`})
            )
            return
        }
        let cycleInfo = []
        cycleInfo = await Storage.queryCycleRecordsBetween(from, to)
        if (isDownload) {
            let dataInBuffer = Buffer.from(JSON.stringify(cycleInfo), 'utf-8')
            // @ts-ignore
            let dataInStream = Readable.from(dataInBuffer)
            let filename = `cycle_records_from_${from}_to_${to}`

            reply.headers({
                'content-disposition': `attachment; filename="${filename}"`,
                'content-type': 'application/octet-stream',
            })
            reply.send(dataInStream)
        } else {
            const res = Crypto.sign({
                cycleInfo,
            })
            reply.send(res)
        }
    })

    server.get('/cycleinfo/:count', async (_request, reply) => {
        let err = Utils.validateTypes(_request.params, {count: 's'})
        if (err) {
            reply.send(Crypto.sign({success: false, error: err}))
            return
        }
        let count: number = parseInt(_request.params.count)
        if (count <= 0 || Number.isNaN(count)) {
            reply.send(Crypto.sign({success: false, error: `Invalid count`}))
            return
        }
        if (count > 100) count = 100 // return max 100 cycles

        let cycleInfo = await Storage.queryLatestCycleRecords(count)
        const res = Crypto.sign({
            cycleInfo,
        })
        reply.send(res)
    })

    server.post('/gossip-hashes', async (_request, reply) => {
        profilerInstance.profileSectionStart('post_gossip_hashes')
        try {
            let gossipMessage = _request.body
            Logger.mainLogger.debug('Gossip received', JSON.stringify(gossipMessage))
            addHashesGossip(gossipMessage.sender, gossipMessage.data)
            const res = Crypto.sign({
                success: true,
            })
            reply.send(res)
        } finally {
            profilerInstance.profileSectionEnd('post_gossip_hashes')
        }
    })

    server.get('/archiverlist', async (_request, reply) => {
        profilerInstance.profileSectionStart('archiverlist')
        try {
            reply.send({
                archivers: State.activeArchivers
            })
        } finally {
            profilerInstance.profileSectionEnd('archiverlist')
        }
    })
    // [TODO] Remove this before production
    // server.get('/exit', (_request, reply) => {
    //   reply.send('Shutting down...')
    //   process.exit()
    // })

    // [TODO] Remove this before production
    server.get('/nodeids', (_request, reply) => {
        reply.send(NodeList.byId)
    })

    // Start server and bind to port on all interfaces
    server.listen(config.ARCHIVER_PORT, '0.0.0.0', (err, _address) => {
        Logger.mainLogger.debug('Listening3')
        if (err) {
            server.log.error(err)
            process.exit(1)
        }
        Logger.mainLogger.debug('Archive-server has started.')
        State.addSigListeners()
    })
    return io
}

start()
