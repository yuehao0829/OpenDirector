import { tauriBridge, type TOSValidationResult } from '@opendirector/core/services/tauri-bridge';

/**
 * Validate TOS (HeadBucket) credentials when both `tos_endpoint` and
 * `tos_bucket` are present. typeId-agnostic: gated on field existence, not on
 * a specific provider (only Volcengine declares these today).
 *
 * Returns `{ valid: true, message: '' }` when the TOS fields are absent
 * (nothing to validate); otherwise the bridge's `validateTosCredentials`
 * result. Trims ak/sk/region/tos_endpoint/tos_bucket consistently so
 * whitespace-padded input validates identically in every caller — shared so
 * the Add and Edit dialogs can't drift apart on the trim logic or error shape.
 */
export async function validateTosIfPresent(
  creds: Record<string, string>,
): Promise<TOSValidationResult> {
  const tosEndpoint = creds.tos_endpoint?.trim();
  const tosBucket = creds.tos_bucket?.trim();
  if (!(tosEndpoint && tosBucket)) {
    return { valid: true, message: '' };
  }

  return tauriBridge.tosApi.validateTosCredentials(
    creds.ak?.trim() ?? '',
    creds.sk?.trim() ?? '',
    tosBucket,
    tosEndpoint,
    creds.region?.trim() ?? '',
  );
}
