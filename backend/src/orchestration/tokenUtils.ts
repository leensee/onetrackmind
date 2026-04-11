// ============================================================
// OTM Orchestration — Token Estimation
// Character-based estimation. ±10% accuracy.
// Used for context window management only — not billed tokens.
// ============================================================

const CHARS_PER_TOKEN = 4; // conservative average for English prose

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessagesTokens(
  messages: Array<{ role: string; content: string }>
): number {
  return messages.reduce((sum, msg) => {
    // ~4 tokens overhead per message for role + formatting
    return sum + estimateTokens(msg.content) + 4;
  }, 0);
}
