// It is still left to apply in shardFunctions.ts
export function addressNumberToPartition(
  numPartitions: number,
  addressNum: number
): number {
  // 2^32  4294967296 or 0xFFFFFFFF + 1
  let size = Math.round((0xffffffff + 1) / numPartitions)
  let homePartition = Math.floor(addressNum / size)
  if (homePartition === numPartitions) {
    homePartition = homePartition - 1
  }

  return homePartition
}
