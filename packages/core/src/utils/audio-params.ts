import type { CapabilityParams } from '../types/provider-system';

/**
 * Resolve the sample-rate options available for a given audio format. When the provider
 * supplies a format→rate map, use the rates for the selected format (falling back to the
 * default key); otherwise use the flat sampleRates list.
 */
export function ratesForFormat(
  sampleRateByFormat: CapabilityParams['sampleRateByFormat'],
  sampleRates: CapabilityParams['sampleRates'],
  format: string,
): string[] | undefined {
  return sampleRateByFormat
    ? (sampleRateByFormat[format] ?? sampleRateByFormat.default)
    : sampleRates;
}

/**
 * Pick a valid sample rate from rates, preferring preferred (e.g. the model's
 * default) when present, then the highest numeric rate, then the first available rate.
 */
export function pickSampleRate(rates: string[], preferred?: string): string {
  if (preferred && rates.includes(preferred)) return preferred;
  const sorted = [...rates].sort((a, b) => Number(b) - Number(a));
  return sorted[0] ?? rates[0];
}
