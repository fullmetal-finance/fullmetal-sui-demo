/* Serializes every server-side transaction signed with the OPS key.

   The oracle ticks (~1.5s), breach cranks, cure recalls, maker quotes, and gas
   top-ups all sign with the same key from concurrent route invocations. Two
   in-flight transactions built on the same gas-coin version EQUIVOCATE — the
   validators lock the coin to the first and reject the second with
   "Transaction is rejected as invalid by more than 1/3 of validators by stake
   (non-retriable)" (observed live 2026-07-17 during crash drills). One
   module-level promise chain per server process fixes it: each ops write waits
   for the previous one's finality before building. */

let chain: Promise<unknown> = Promise.resolve();

/** Run `fn` after every previously-enqueued ops transaction has settled. */
export function opsTx<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn); // predecessor failures don't block the queue
  chain = next.catch(() => {});
  return next;
}
