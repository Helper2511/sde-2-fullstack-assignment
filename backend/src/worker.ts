import { Worker } from 'bullmq';
import { bullConnection } from './config/redis';
import { SEND_QUEUE } from './sequences/scheduler';
import { processSendJob, reapStuckProcessing } from './worker/processor';

const worker = new Worker(SEND_QUEUE, processSendJob, {
  connection: bullConnection,
  concurrency: 4,
});

worker.on('completed', (job) => {
  console.log(`[worker] job ${job.id} ok`);
});

worker.on('failed', (job, err) => {
  console.warn(`[worker] job ${job?.id} failed: ${err.message}`);
});

// Periodically recover rows stuck in 'processing' from a crashed worker.
const REAP_INTERVAL_MS = 60_000;
async function runReaper(): Promise<void> {
  try {
    const n = await reapStuckProcessing();
    if (n > 0) console.log(`[worker] reaped ${n} stuck processing row(s)`);
  } catch (err) {
    console.warn('[worker] reaper error:', (err as Error).message);
  }
}
const reaperTimer = setInterval(runReaper, REAP_INTERVAL_MS);
reaperTimer.unref(); // don't keep the process alive just for the reaper
void runReaper(); // run once on startup

console.log('[worker] listening on queue', SEND_QUEUE);
