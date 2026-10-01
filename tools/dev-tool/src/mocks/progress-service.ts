import { Injectable } from '@opensumi/di';
import { IProgressIndicator, IProgressService } from '@opensumi/ide-core-browser/progress';
import {
  IDisposable,
  IProgress,
  IProgressCompositeOptions,
  IProgressNotificationOptions,
  IProgressOptions,
  IProgressStep,
  IProgressWindowOptions,
} from '@opensumi/ide-core-common';

@Injectable()
export class MockProgressService implements IProgressService {
  registerProgressIndicator(location: string, indicator?: IProgressIndicator): IDisposable {
    return {
      dispose() {},
    };
  }
  getIndicator(location: string): IProgressIndicator | undefined {
    return;
  }
  async withProgress<R>(
    options: IProgressOptions | IProgressNotificationOptions | IProgressWindowOptions | IProgressCompositeOptions,
    task: (progress: IProgress<IProgressStep>) => Promise<R>,
    onDidCancel?: (choice?: number) => void,
  ): Promise<R> {
    return await task({
      report() {},
    });
  }
}
