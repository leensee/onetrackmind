// ============================================================
// OTM Tools — PO Sequence Allocator
// Owns the per-user PO sequence contract. Orchestrator calls
// allocateNext(userId) once per po_generate call; the value is
// consumed whether the approval gate resolves approved, rejected,
// or timeout. Gaps in PO numbers are a feature of this contract,
// not a bug — the previous "decrement on reject" workaround
// (OT-5) existed only because the counter was in-process memory.
//
// Implementations MUST guarantee:
//   (a) concurrent allocateNext calls for the same userId return
//       distinct, strictly monotonic values
//   (b) sequence resumes from persisted state across process
//       restarts (real implementations only — see stub caveat)
//   (c) sequences are independent per userId
//
// Resolves audit finding 2026-04-16-OT-4 (RED) by moving the
// sequence source out of module-level mutable state.
// ============================================================

// ── Narrow DB Interface ───────────────────────────────────────

export interface PoSequenceDbClient {
  allocateNext(userId: string): Promise<number>;
}

// ── In-Memory Placeholder ─────────────────────────────────────
// TODO(phase-7-db): Replace with Supabase-backed implementation.
// Phase 7 owns the po_sequence schema, migration, and durable
// persistence. Until then, this in-memory store is the drop-in
// that satisfies PoSequenceDbClient in bootstrap + tests.
//
// Caveats (do NOT deploy as production sequence source):
//   - counter is lost on process restart (will restart at 1)
//   - counter is per-process (multi-process deploys will collide)
// Those are the exact failure modes OT-4 flagged — the stub
// preserves the interface so Phase 7 can swap in a real
// implementation without touching orchestratorTools.ts.

export function createInMemoryPoSequenceStore(
  seed?: Record<string, number>
): PoSequenceDbClient {
  const counters = new Map<string, number>(
    seed ? Object.entries(seed) : []
  );
  let warnedAboutPlaceholder = false;

  return {
    async allocateNext(userId: string): Promise<number> {
      if (!warnedAboutPlaceholder && process.env.NODE_ENV === 'production') {
        warnedAboutPlaceholder = true;
        console.warn(
          '[poSequence] Using in-memory placeholder — counter will ' +
          'reset on process restart and does not span processes. ' +
          'TODO(phase-7-db): swap for DB-backed PoSequenceDbClient.'
        );
      }
      const current = counters.get(userId) ?? 0;
      const next = current + 1;
      counters.set(userId, next);
      return next;
    },
  };
}
