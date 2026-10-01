import { Injectable } from '@opensumi/di';
import { Emitter, Event, MaybePromise, Schemes, URI } from '@opensumi/ide-core-common';

import type { IEditorDocumentModelContentProvider } from '@opensumi/ide-editor/browser';

@Injectable()
export class MockWalkThroughSnippetSchemeDocumentProvider implements IEditorDocumentModelContentProvider {
  handlesScheme(scheme: string) {
    return scheme === Schemes.walkThroughSnippet;
  }

  provideEditorDocumentModelContent(_uri: URI): MaybePromise<string> {
    return 'test';
  }

  isReadonly(): MaybePromise<boolean> {
    return false;
  }

  private _onDidChangeContent: Emitter<URI> = new Emitter();
  onDidChangeContent: Event<URI> = this._onDidChangeContent.event;

  preferLanguageForUri() {
    return 'plaintext';
  }
}
