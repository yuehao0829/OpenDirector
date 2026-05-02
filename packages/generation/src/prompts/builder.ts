interface PromptBuilderOptions {
  basePrompt?: string;
  characterDescriptions?: string[];
  sceneDescription?: string;
  style?: string;
  negativePrompt?: string;
}

export function buildPrompt(options: PromptBuilderOptions): string {
  const parts: string[] = [];

  // Add character descriptions
  if (options.characterDescriptions?.length) {
    for (const desc of options.characterDescriptions) {
      parts.push(desc);
    }
  }

  // Add scene description
  if (options.sceneDescription) {
    parts.push(options.sceneDescription);
  }

  // Add style
  if (options.style) {
    parts.push(`${options.style} style`);
  }

  // Add base prompt (user's main description)
  if (options.basePrompt) {
    parts.push(options.basePrompt);
  }

  return parts.join(', ');
}

export function buildNegativePrompt(
  baseNegative?: string,
  additionalTerms?: string[]
): string {
  const defaultNegative = [
    'blurry',
    'low quality',
    'distorted',
    'watermark',
    'text',
    'logo',
  ];

  const terms = [...defaultNegative];

  if (baseNegative) {
    terms.unshift(baseNegative);
  }

  if (additionalTerms) {
    terms.push(...additionalTerms);
  }

  return terms.join(', ');
}

