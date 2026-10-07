// Ingest: every 128bit app (and anything else holding an API key) POSTs
// envelopes here. Everything lands on the timeline; known types also update
// the Library or habit trackers so the record stays in sync on its own.
import { normalizeEnvelope } from '../domain/events.js';
import { applyPlayEvent } from './play.js';
import { applyFamilyEvent } from './family.js';
import { tx } from '../db/index.js';

export function ingest(ctx, raw, { defaultSource } = {}) {
  const ev = normalizeEnvelope(raw, { defaultSource });
  if (ev.source === '128bittracker') {
    // Tracker's own events are emitted internally, never accepted from outside.
    return { id: ev.id, status: 'rejected', reason: 'source 128bittracker is reserved' };
  }
  // Atomic: if a side effect fails, the event isn't stored, so a corrected
  // retry with the same id still goes through.
  return tx(ctx.db, () => {
    if (!ctx.events.record(ev)) return { id: ev.id, status: 'duplicate' };
    const effects = [
      ...(ev.source === '128bitplay' ? applyPlayEvent(ctx, ev) : []),
      ...applyFamilyEvent(ctx, ev),
    ];
    return { id: ev.id, status: 'accepted', effects };
  });
}

export function ingestBatch(ctx, list, opts) {
  return list.map((raw) => {
    try {
      return ingest(ctx, raw, opts);
    } catch (err) {
      return { id: raw?.id ?? null, status: 'error', error: err.message };
    }
  });
}
