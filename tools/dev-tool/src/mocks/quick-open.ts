import { Injectable } from '@opensumi/di';
import { VALIDATE_TYPE } from '@opensumi/ide-core-browser/components';
import { HideReason } from '@opensumi/ide-core-browser/quick-open';
import { QuickOpenModel, QuickOpenOptions, QuickOpenService } from '@opensumi/ide-quick-open';

@Injectable()
export class MockQuickOpenService implements QuickOpenService {
  refresh(): void {
    throw new Error('Method not implemented.');
  }

  open(model: QuickOpenModel, options?: QuickOpenOptions): void {
    throw new Error('Method not implemented.');
  }
  hide(reason?: HideReason): void {
    throw new Error('Method not implemented.');
  }
  showDecoration(type: VALIDATE_TYPE): void {
    throw new Error('Method not implemented.');
  }
  hideDecoration(): void {
    throw new Error('Method not implemented.');
  }
  updateOptions(options: QuickOpenOptions): void {
    throw new Error('Method not implemented.');
  }
}
