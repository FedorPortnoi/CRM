/**
 * Where the configured model provider sits, and what may lawfully be sent to it.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * ФЗ-152 does not forbid processing a client's name. It forbids sending it
 * abroad without the separate legal basis that ст. 12 requires. Today the only
 * `createCompletion` in the backend talks to Yandex Foundation Models, inside
 * `ru-central1`, so contact names reach a domestic processor and the assistant
 * can say «у Иванова две сделки» lawfully.
 *
 * "Wave A" is the planned repoint of that seam to a non-domestic provider. The
 * moment it happens, every contact name in a prompt becomes a cross-border
 * transfer of personal data. Four session records described the missing piece as
 * "contact-name masking is not built", which framed it as a feature. It is not.
 * The precondition is that the unsafe state must be UNREACHABLE — a repoint
 * should be impossible to perform without the masking, rather than merely
 * accompanied by a reminder to add it.
 *
 * So this module is a gate, not a setting. `assertPersonalNamesMayBeSent()`
 * throws unless the configured provider is one we have positively declared
 * domestic. An unrecognised provider is treated as foreign, because the failure
 * direction has to be "the assistant stops working" rather than "client names
 * quietly leave the country".
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT DO
 * -----------------------------------------------------------------------------
 * It does not mask anything. Masking lives in contact-alias.ts. Keeping the
 * decision (may names go?) apart from the mechanism (how are they hidden?) is
 * what lets the mechanism be tested against a foreign provider today, while the
 * live path still runs unmasked against the domestic one.
 */

/** Providers we have positively established process data inside Russia. */
const DOMESTIC_PROVIDERS: ReadonlySet<string> = new Set([
  // Yandex Foundation Models. The endpoint is llm.api.cloud.yandex.net and the
  // folder is pinned to ru-central1 — see yandex-gpt.ts.
  'yandex_foundation_models',
]);

export type ModelProvider = string;

/**
 * The provider the backend is currently configured to call.
 *
 * Read from the environment rather than hardcoded so that a repoint is a config
 * change the gate below can SEE. If it were hardcoded, Wave A would be a code
 * edit that silently bypasses this file.
 */
export function currentModelProvider(): ModelProvider {
  return (process.env.MODEL_PROVIDER?.trim() || 'yandex_foundation_models').toLowerCase();
}

/**
 * True only for providers on the domestic list. Unknown names are foreign:
 * a provider nobody has assessed is exactly the one that must not receive names.
 */
export function isDomesticProvider(provider: ModelProvider = currentModelProvider()): boolean {
  return DOMESTIC_PROVIDERS.has(provider);
}

/**
 * May a real person's name be placed in a prompt for this provider?
 *
 * This is the single question the rest of the backend should ask. It covers a
 * CONTACT's name; operator ФИО is stripped unconditionally at the MCP boundary
 * regardless of jurisdiction (see model-projection.ts) because that is a
 * minimisation decision, not a border one.
 */
export function personalNamesMayBeSent(provider: ModelProvider = currentModelProvider()): boolean {
  return isDomesticProvider(provider);
}

export class CrossBorderPersonalDataError extends Error {
  readonly code = 'CROSS_BORDER_PERSONAL_DATA';
  constructor(provider: ModelProvider) {
    super(
      `Refusing to send personal names to "${provider}": it is not a declared domestic ` +
        'processor. Alias the names via contact-alias.ts, or add the provider to ' +
        'DOMESTIC_PROVIDERS once its data residency has actually been established.',
    );
    this.name = 'CrossBorderPersonalDataError';
  }
}

/**
 * Hard gate. Call this on any path that is about to put a real name in a prompt.
 *
 * Throws rather than returning a boolean on purpose: a caller that ignores a
 * boolean still sends the name, whereas a caller that ignores an exception does
 * not exist. The thrown error is caught by the assistant's normal provider-error
 * path, so the user sees a failed request instead of a silent transfer.
 */
export function assertPersonalNamesMayBeSent(provider: ModelProvider = currentModelProvider()): void {
  if (!personalNamesMayBeSent(provider)) {
    throw new CrossBorderPersonalDataError(provider);
  }
}
