import { Injectable } from '@opensumi/di';
import { IMergeEditorEditor } from '@opensumi/ide-core-browser/editor';
import { MonacoService, ServiceNames } from '@opensumi/ide-monaco';
import { IDiffEditorConstructionOptions } from '@opensumi/monaco-editor-core/esm/vs/editor/browser/editorBrowser';

import { createMockedMonaco } from './monaco/index';

@Injectable()
export class MockedMonacoService implements MonacoService {
  private mockedMonaco = createMockedMonaco();

  constructor() {
    (global as any).monaco = this.mockedMonaco;
  }
  public createMergeEditor(
    monacoContainer: HTMLElement,
    options?: IDiffEditorConstructionOptions | undefined,
    overrides?: { [key: string]: any } | undefined,
  ): IMergeEditorEditor {
    return this.mockedMonaco.editor.createMergeEditor(monacoContainer, options);
  }

  public createCodeEditor(monacoContainer: HTMLElement, options) {
    return this.mockedMonaco.editor.create(monacoContainer, options);
  }
  public createDiffEditor(monacoContainer: HTMLElement, options) {
    return this.mockedMonaco.editor.createDiffEditor(monacoContainer, options);
  }
  public createMultiDiffEditorWidget(
    _monacoContainer: HTMLElement,
    _overrides?: { [key: string]: any },
  ): ReturnType<MonacoService['createMultiDiffEditorWidget']> {
    throw new Error('Multi-diff widgets require an explicit test implementation.');
  }
  public registerOverride(serviceName: ServiceNames, service: any): void {}
  public testTokenize(line: string, languageId: string) {}

  public getOverride(serviceName: ServiceNames) {}
}
