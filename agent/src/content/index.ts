/*
 * content/ — page-context content script (NOT implemented in M1).
 * -----------------------------------------------------------------------------
 * Injected just-in-time via activeTab/scripting in a later milestone to perform
 * bounded, sanitized DOM + a11y capture, selection reads, and (optionally) the
 * single consent-gated write tool. It NEVER receives model instructions; it
 * only returns untrusted page DATA back to the service worker.
 *
 * M1 ships no content script and registers none in the manifest.
 * -----------------------------------------------------------------------------
 */

export {};
