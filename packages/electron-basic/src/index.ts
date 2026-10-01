// The package root is deliberately limited to runtime-neutral integration contracts.
// Keep this list explicit so adding a browser implementation does not silently widen the public API.
export { IElectronHeaderService } from './common/header';
