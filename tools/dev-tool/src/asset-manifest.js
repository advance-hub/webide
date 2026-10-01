const path = require('path');

/** Emits the existing worker and CLI asset contracts through Rspack's asset lifecycle. */
class AssetManifestPlugin {
  constructor({ filename = 'manifest.json', entrypoints = false } = {}) {
    this.filename = filename;
    this.entrypoints = entrypoints;
  }

  apply(compiler) {
    const { Compilation, sources } = compiler.webpack;
    compiler.hooks.thisCompilation.tap('AssetManifestPlugin', (compilation) => {
      compilation.hooks.processAssets.tap(
        { name: 'AssetManifestPlugin', stage: Compilation.PROCESS_ASSETS_STAGE_REPORT },
        () => {
          const manifest = {};
          if (this.entrypoints) {
            for (const [name, entrypoint] of compilation.entrypoints) {
              const assets = {};
              for (const file of entrypoint.getFiles()) {
                const extension = path.extname(file).slice(1);
                if (extension !== 'js' && extension !== 'css') {
                  continue;
                }
                assets[extension] = assets[extension] ? [assets[extension], file].flat() : file;
              }
              manifest[name] = assets;
            }
          } else {
            const names = new Map();
            for (const chunk of compilation.chunks) {
              if (chunk.name) {
                for (const file of chunk.files) {
                  names.set(file, `${chunk.name}${path.extname(file)}`);
                }
              }
            }
            for (const { name } of compilation.getAssets()) {
              if (name !== this.filename) {
                manifest[names.get(name) || name] = name;
              }
            }
          }
          compilation.emitAsset(this.filename, new sources.RawSource(`${JSON.stringify(manifest, null, 2)}\n`));
        },
      );
    });
  }
}

module.exports = { AssetManifestPlugin };
