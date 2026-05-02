/** Build a composite key from instanceId and modelId */
export const makeCompositeKey = (instanceId: string, modelId: string) =>
  `${instanceId}::${modelId}`;

/** Parse a composite key back into instanceId and modelId */
export const parseCompositeKey = (key: string) => {
  const sep = key.indexOf('::');
  return { instanceId: key.slice(0, sep), modelId: key.slice(sep + 2) };
};
