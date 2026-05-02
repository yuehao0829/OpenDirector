/**
 * Services module
 */

export * from './project-io';
export * from './autosave';
export * from './asset-import';
export {
  type XmemlExportParams,
  exportXmemlToFile,
  type XmemlImportParams,
  importXmeml,
} from './xmeml-io';
export * from './project-cleanup';
export * from './project-defaults';
export * from './project-hydration';
export * from './project-media-metadata';
export * from './project-service';
export { tauriBridge } from './tauri-bridge';
export { applyReference, type ApplyReferenceOptions, type ApplyReferenceResult } from './reference-processor';
export { autoProcessReferences, type AutoProcessOptions, type AutoProcessResult } from './reference-auto-processor';
export { runMediaPipeline, cropRectToAssetProcessParams, type MediaPipelineParams, type MediaPipelineResult } from './media-pipeline';
export {
  buildTimelinePreviewSnapshot,
  isNativeTimelinePreviewDebugPresentSurfaceEnabled,
  isNativeTimelinePreviewEnabled,
  PreviewSessionController,
  type BuildTimelinePreviewSnapshotOptions,
} from './preview-session';
export {
  registerNativePreviewStepFrameHandler,
  requestNativePreviewStepFrame,
  type NativePreviewStepFrameDirection,
} from '../stores/timelineStore';
export {
  buildTimelineRenderRequest,
  buildProjectTimelineRenderRequest,
  type BuildTimelineRenderRequestOptions,
  type BuildProjectTimelineRenderRequestOptions,
} from './timeline-render';
export {
  exportOtio,
  exportOtioToFile,
  importOtioFromFile,
  importOtio,
  otioIo,
  resolveDefaultOtioPath,
  resolveProjectAssetPath,
  type ExportOtioToFileParams,
  type ImportOtioFromFileParams,
} from './otio-io';
export {
  exportXges,
  importXges,
  exportXgesToFile,
  importXgesFromFile,
  xgesIo,
  type ExportXgesToFileParams,
  type ImportXgesFromFileParams,
} from './xges-io';
export * from './service-locator';
