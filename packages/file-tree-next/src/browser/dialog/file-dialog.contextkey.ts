import { Autowired, Injectable } from '@opensumi/di';
import { IContextKey, IContextKeyService } from '@opensumi/ide-core-browser';
import { FileDialogViewVisibleContext } from '@opensumi/ide-core-browser/contextkeys';

@Injectable()
export class FileDialogContextKey {
  @Autowired(IContextKeyService)
  private readonly globalContextKeyService: IContextKeyService;

  public fileDialogViewVisibleContext: IContextKey<boolean>;
  private _contextKeyService: IContextKeyService;

  initScopedContext(dom: HTMLDivElement) {
    this._contextKeyService = this.globalContextKeyService.createScoped(dom);
    this.fileDialogViewVisibleContext = FileDialogViewVisibleContext.bind(this._contextKeyService);
  }

  get service() {
    return this._contextKeyService;
  }
}
