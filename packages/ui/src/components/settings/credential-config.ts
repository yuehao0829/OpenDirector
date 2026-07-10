import type { CredentialFieldDef } from '@opendirector/core/types/provider-system';

/**
 * Blank every password-type credential field in `config` in place. Secrets
 * live only in the encrypted .enc file, so the persisted instance config
 * stores them as ''. Shared by AddProvider (new save) and EditProvider (after
 * merging updates into the .enc) so the clear rule can't drift between them.
 */
export function clearSecretFields(
  config: Record<string, string>,
  credFields: CredentialFieldDef[],
): void {
  for (const field of credFields) {
    if (field.type === 'password') config[field.key] = '';
  }
}
