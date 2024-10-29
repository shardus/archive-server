import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'

interface TxData {
  nodeId: string
  publicKey: string
  startTime?: number
  start?: number
  endTime?: number
  end?: number
}

interface Tx {
  cycle: number
  hash: string
  priority: number
  subQueueKey: string
  txData: TxData
  type: string
}

interface TransactionEntry {
  hash: string
  tx: Tx
}

interface NewNodeReward {
  hash: string
  tx: Tx
}

function findUnmatchedNodeInitRewards(
  transactions: TransactionEntry[],
  endCycle: number,
  endTime: number
): NewNodeReward[] {
  const unmatchedRewards: NewNodeReward[] = []
  const nodeInitRewardMap = new Map<string, TransactionEntry>()

  console.log('Mapping nodeInitRewards by nodeId and start cycle...')
  for (const transaction of transactions) {
    if (transaction.tx.type === 'nodeInitReward' && transaction.tx.txData.startTime) {
      const key = `${transaction.tx.txData.nodeId}-${transaction.tx.cycle}`
      nodeInitRewardMap.set(key, transaction)
      console.log(
        `Mapped nodeInitReward - Node ID: ${transaction.tx.txData.nodeId}, Cycle: ${transaction.tx.cycle}`
      )
    }
  }

  console.log('Identifying nodeInitRewards without matching nodeRewards...')
  for (const transaction of transactions) {
    if (transaction.tx.type === 'nodeReward' && transaction.tx.txData.start !== undefined) {
      const key = `${transaction.tx.txData.nodeId}-${transaction.tx.txData.start}`
      if (nodeInitRewardMap.has(key)) {
        console.log(
          `Found matching nodeReward for Node ID: ${transaction.tx.txData.nodeId}, Start Cycle: ${transaction.tx.txData.start}`
        )
        nodeInitRewardMap.delete(key)
      }
    }
  }

  console.log('Generating new nodeReward entries for unmatched nodeInitRewards...')
  for (const [key, transaction] of nodeInitRewardMap) {
    const { nodeId, publicKey, startTime } = transaction.tx.txData
    const newHash = generateHash(nodeId + startTime + endCycle)

    const newNodeReward: NewNodeReward = {
      hash: newHash,
      tx: {
        cycle: endCycle,
        hash: newHash,
        priority: transaction.tx.priority,
        subQueueKey: transaction.tx.subQueueKey,
        txData: {
          nodeId,
          publicKey,
          start: transaction.tx.cycle,
          end: endCycle,
          endTime: endTime,
        },
        type: 'nodeReward',
      },
    }
    unmatchedRewards.push(newNodeReward)
    console.log(
      `Created new nodeReward - Node ID: ${nodeId}, Start Cycle: ${transaction.tx.cycle}, End Cycle: ${endCycle}`
    )
  }

  console.log(`Total unmatched nodeInitRewards found: ${unmatchedRewards.length}`)
  return unmatchedRewards
}

function generateHash(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

async function main() {
  const filePath = path.join(__dirname, '..', 'tx-list-restore.json')
  const endCycle = Number(process.argv[2])
  const endTime = Number(process.argv[3])

  if (!endCycle || !endTime) {
    console.error('Please provide endCycle and endTime as arguments.')
    process.exit(1)
  }

  console.log(`Reading data from ${filePath}...`)
  const rawData = fs.readFileSync(filePath, 'utf-8')
  const transactions: TransactionEntry[] = JSON.parse(rawData)
  console.log(`Successfully read ${transactions.length} transactions.`)

  const newRewards = findUnmatchedNodeInitRewards(transactions, endCycle, endTime)

  const updatedTransactions = [...transactions, ...newRewards]
  console.log(`Appending ${newRewards.length} new nodeReward entries to the data.`)

  fs.writeFileSync(filePath, JSON.stringify(updatedTransactions, null, 2), 'utf-8')
  console.log(`Successfully added ${newRewards.length} new nodeReward entries and saved to ${filePath}.`)
}

main()
