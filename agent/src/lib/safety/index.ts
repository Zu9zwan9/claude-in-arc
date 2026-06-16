/*
 * lib/safety — the safety layer (NOT implemented in M1).
 * -----------------------------------------------------------------------------
 * Architectural rule (Phase 1): page / tab / selection content is untrusted
 * DATA and is NEVER placed in the instruction channel. System + operator
 * instructions and page data travel in structurally separate slots.
 *
 * This file is a scaffold that names the pieces the later milestones fill in.
 * Nothing here is wired up in M1.
 *
 *   - sanitize:   strip scripts, hidden / off-screen / aria-hidden nodes;
 *                 main-content (Readability-style) + a11y roles/names only.   (M2/M5)
 *   - blocklist:  default sensitive-domain blocklist (banking/email/gov/health);
 *                 agent disabled on match unless explicitly overridden.        (M5)
 *   - budget:     hard caps on chars/nodes per turn; enforced before any
 *                 provider call.                                               (M2)
 *   - separation: keep page DATA out of the instruction slot; mark untrusted.  (M2)
 * -----------------------------------------------------------------------------
 */

export {};
