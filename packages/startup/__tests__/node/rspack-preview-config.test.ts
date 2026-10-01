import { execFileSync } from 'node:child_process';
import path from 'node:path';

describe('preview Rspack outputs', () => {
  it('keeps the nested webview output when the parent dist compiler cleans', () => {
    expect.hasAssertions();

    const configPath = path.join(__dirname, '../../rspack.preview.config.js');
    const webOutputPath = path.join(__dirname, '../../dist');
    const webviewOutputPath = path.join(webOutputPath, 'webview');
    const probe = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '-e',
          `console.log = () => {};
const configs = require(${JSON.stringify(configPath)});
const web = configs.find((config) => config.output && config.output.path === ${JSON.stringify(webOutputPath)});
const webview = configs.find((config) => config.output && config.output.path === ${JSON.stringify(webviewOutputPath)});
const keep = web && web.output.clean && web.output.clean.keep;
process.stdout.write(JSON.stringify({
  hasWebview: Boolean(webview),
  keepsWebviewDirectory: keep instanceof RegExp && keep.test('webview'),
  keepsWebviewAsset: keep instanceof RegExp && keep.test('webview/webview.js'),
  keepsParentAsset: keep instanceof RegExp && keep.test('bundle.js'),
}));`,
        ],
        { encoding: 'utf8' },
      ),
    );

    expect(probe).toEqual({
      hasWebview: true,
      keepsWebviewDirectory: true,
      keepsWebviewAsset: true,
      keepsParentAsset: false,
    });
  });
});
