import * as crypto from '../Crypto'
import { ArchiverReceipt, SignedReceipt, Receipt } from '../dbstore/receipts'
import { verifyPayload } from '../types/ajv/Helpers'
import { AJVSchemaEnum } from '../types/enum/AJVSchemaEnum'
import { verifyGlobalTxAccountChange } from './verifyGlobalTxReceipt'

// Reference: https://github.com/Liberdus/server/blob/84f80564c45b06343df9bed4fe66a1628052a4cc/src/index.ts#L349
export const calculateAccountHash = (account: any): string => {
  account.hash = '' // Not sure this is really necessary
  account.hash = crypto.hashObj(account)
  return account.hash
}

export const verifyAccountHash = (
  receipt: ArchiverReceipt | Receipt,
  failedReasons = [],
  nestedCounterMessages = []
): boolean => {
  try {
    let globalReceiptValidationErrors // This is used to store the validation errors of the globalTxReceipt
    try {
      globalReceiptValidationErrors = verifyPayload(AJVSchemaEnum.GlobalTxReceipt, receipt?.signedReceipt)
    } catch (error) {
      globalReceiptValidationErrors = true
      failedReasons.push(
        `Invalid Global Tx Receipt error: ${error}. txId ${receipt.tx.txId} , cycle ${receipt.cycle} , timestamp ${receipt.tx.timestamp}`
      )
      nestedCounterMessages.push(
        `Invalid Global Tx Receipt error: ${error}. txId ${receipt.tx.txId} , cycle ${receipt.cycle} , timestamp ${receipt.tx.timestamp}`
      )
      return false
    }
    if (!globalReceiptValidationErrors) {
      const result = verifyGlobalTxAccountChange(receipt, failedReasons, nestedCounterMessages)
      if (!result) return false
      return true
    }
    const signedReceipt = receipt.signedReceipt as SignedReceipt
    const { accountIDs, afterStateHashes, beforeStateHashes } = signedReceipt.proposal
    if (accountIDs.length !== afterStateHashes.length) {
      failedReasons.push(
        `Modified account count specified in the receipt and the actual updated account count does not match! ${receipt.tx.txId} , ${receipt.cycle} , ${receipt.tx.timestamp}`
      )
      nestedCounterMessages.push(
        `Modified account count specified in the receipt and the actual updated account count does not match!`
      )
      return false
    }
    if (beforeStateHashes.length !== afterStateHashes.length) {
      failedReasons.push(
        `Account state hash before and after count does not match! ${receipt.tx.txId} , ${receipt.cycle} , ${receipt.tx.timestamp}`
      )
      nestedCounterMessages.push(`Account state hash before and after count does not match!`)
      return false
    }
    for (const [index, accountId] of accountIDs.entries()) {
      const accountData = receipt.afterStates.find((acc) => acc.accountId === accountId)
      if (accountData === undefined) {
        failedReasons.push(
          `Account not found in the receipt's afterStates | Acc-ID: ${accountId}, txId: ${receipt.tx.txId}, Cycle: ${receipt.cycle}, timestamp: ${receipt.tx.timestamp}`
        )
        nestedCounterMessages.push(`Account not found in the receipt`)
        return false
      }
      const calculatedAccountHash = calculateAccountHash(accountData.data)
      // eslint-disable-next-line security/detect-object-injection
      const expectedAccountHash = afterStateHashes[index]
      if (calculatedAccountHash !== expectedAccountHash) {
        failedReasons.push(
          `Account hash does not match | Acc-ID: ${accountId}, txId: ${receipt.tx.txId}, Cycle: ${receipt.cycle}, timestamp: ${receipt.tx.timestamp}`
        )
        nestedCounterMessages.push(`Account hash does not match`)
        return false
      }
    }
    return true
  } catch (e) {
    console.error(`Error in verifyAccountHash`, e)
    failedReasons.push(`Error in verifyAccountHash ${e}`)
    nestedCounterMessages.push('Error in verifyAccountHash')
    return false
  }
}
