import { openDatabase } from '../../persistence/src/db.js'
import { P7Ledger } from '../../persistence/src/p7-ledger.js'
import { snapshot } from './p7-fixtures.js'

/** 独立进程共享同一文件库 父进程同时发令制造真实写竞争 */
const db = openDatabase(process.argv[2]!)
const ledger = new P7Ledger(db)
process.send?.('ready')
process.once('message', () => {
  try {
    ledger.reserve(
      {
        callId: `child-${process.pid}`,
        operationId: `op-${process.pid}`,
        runId: 'shared-run',
        purpose: 'main_agent',
        attempt: 1,
      },
      snapshot(),
      60000000,
    )
    process.send?.('reserved')
  } catch (error) {
    process.send?.(error instanceof Error ? error.message : 'unexpected')
  } finally {
    db.close()
    process.disconnect()
  }
})
