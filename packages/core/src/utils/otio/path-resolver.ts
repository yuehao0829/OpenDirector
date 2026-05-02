import type { Asset, Project } from '../../types';

export type OtioAssetPathResolver = (asset: Asset) => string | undefined;

export function buildProjectAssetPathResolver(project: Project): OtioAssetPathResolver {
  return (asset) => {
    if (project.folderPath && asset.relativePath) {
      return `${project.folderPath}/${asset.relativePath}`;
    }
    if (asset.sourcePath) {
      return asset.sourcePath;
    }
    if (asset.url && !asset.url.startsWith('asset:')) {
      return asset.url;
    }
    return undefined;
  };
}

export function toOtioTargetUrl(inputPath: string): string {
  if (inputPath.startsWith('\\\\')) {
    const unc = inputPath.replace(/^\\\\+/, '').replace(/\\/g, '/');
    return `file://${encodePathSegments(unc)}`;
  }

  const normalized = inputPath.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `file:///${encodePathSegments(normalized)}`;
  }

  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(inputPath)) {
    return inputPath;
  }

  if (normalized.startsWith('/')) {
    return `file://${encodePathSegments(normalized)}`;
  }

  return `file://${encodePathSegments(normalized)}`;
}

export function fromOtioTargetUrl(targetUrl: string): string {
  if (!targetUrl.startsWith('file://')) {
    return decodeURIComponent(targetUrl);
  }

  const withoutScheme = decodeURIComponent(targetUrl.slice('file://'.length));
  if (withoutScheme.startsWith('/')) {
    return withoutScheme.replace(/^\/([A-Za-z]:\/)/, '$1');
  }

  return `//${withoutScheme.replace(/^\/+/, '')}`;
}

function encodePathSegments(path: string): string {
  return path
    .split('/')
    .map((segment, index) => {
      if (index === 0 && /^[A-Za-z]:$/.test(segment)) {
        return segment;
      }
      return encodeURIComponent(segment);
    })
    .join('/');
}
