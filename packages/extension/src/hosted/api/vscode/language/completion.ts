import { Cache, DisposableStore, Uri as URI } from '@opensumi/ide-core-common';

import {
  ExtensionDocumentDataManager,
  ISuggestDataDto,
  ISuggestDataDtoField,
  ISuggestResultDto,
  ISuggestResultDtoField,
  RangeSuggestDataDto,
} from '../../../../common/vscode';
import * as Converter from '../../../../common/vscode/converter';
import { CompletionItemLabel, CompletionList, Range, SnippetString } from '../../../../common/vscode/ext-types';
import {
  ChainedCacheId,
  CompletionContext,
  CompletionItemInsertTextRule,
  Range as ModelRange,
  Position,
} from '../../../../common/vscode/model.api';
import { CommandsConverter } from '../ext.host.command';

import { getPerformance } from './util';

import type vscode from 'vscode';

export class CompletionAdapter {
  private cache = new Cache<{
    item: vscode.CompletionItem;
    resource: URI;
    ranges: { inserting: vscode.Range; replacing: vscode.Range };
  }>('CompletionItem');
  private toDispose = new Map<number, DisposableStore>();

  static supportsResolving(provider: vscode.CompletionItemProvider): boolean {
    return typeof provider.resolveCompletionItem === 'function';
  }

  constructor(
    private readonly delegate: vscode.CompletionItemProvider,
    private readonly commandConverter: CommandsConverter,
    private readonly documents: ExtensionDocumentDataManager,
  ) {}

  async provideCompletionItems(
    resource: URI,
    position: Position,
    context: CompletionContext,
    token: vscode.CancellationToken,
  ) {
    const request = this.getInsertOrReplace(resource, position);
    if (!request || !this.isCurrent(request.doc, request.version, token)) {
      return undefined;
    }
    const { doc, pos, replacing, inserting, version } = request;

    const perf = getPerformance();
    const startTime = perf ? perf.now() : 0;
    let itemOrList: vscode.CompletionItem[] | vscode.CompletionList | null | undefined;
    try {
      itemOrList = await this.delegate.provideCompletionItems(doc, pos, token, context);
    } catch (error) {
      // 提供者等待期间文档可能缩短或关闭，旧位置的错误随请求失效；当前请求的真实错误仍传播。
      if (!this.isCurrent(doc, version, token)) {
        return undefined;
      }
      throw error;
    }
    const duration = perf ? Math.round(perf.now() - startTime) : 0;
    if (!itemOrList || !this.isCurrent(doc, version, token)) {
      return undefined;
    }

    const isIncomplete = Array.isArray(itemOrList) ? false : itemOrList.isIncomplete;
    const list = Array.isArray(itemOrList) ? new CompletionList(itemOrList) : itemOrList;
    const ranges = { inserting, replacing };
    const pid = CompletionAdapter.supportsResolving(this.delegate)
      ? this.cache.add(list.items.map((e: vscode.CompletionItem) => ({ item: e, resource, ranges })))
      : this.cache.add([]);

    const disposables = new DisposableStore();
    this.toDispose.set(pid, disposables);

    const completions: ISuggestDataDto[] = [];
    const result: ISuggestResultDto = {
      x: pid,
      [ISuggestResultDtoField.completions]: completions,
      [ISuggestResultDtoField.defaultRanges]: {
        replace: Converter.Range.from(replacing)!,
        insert: Converter.Range.from(inserting)!,
      },
      [ISuggestResultDtoField.isIncomplete]: isIncomplete || undefined,
      [ISuggestResultDtoField.duration]: duration,
    };

    for (let i = 0; i < list.items.length; i++) {
      const item = list.items[i];
      // check for bad completion item first
      const dto = this.convertCompletionItem(item, [pid, i], inserting, replacing);
      completions.push(dto);
    }
    return result;
  }

  async resolveCompletionItem(
    id: ChainedCacheId,
    token: vscode.CancellationToken,
  ): Promise<ISuggestDataDto | undefined> {
    const _cache = this.cache.get(...id);
    if (!_cache) {
      return undefined;
    }

    const { item, resource, ranges } = _cache;
    const doc = this.documents.getDocumentData(resource)?.document;
    if (!doc || doc.isClosed || token.isCancellationRequested) {
      return undefined;
    }
    const version = doc.version;
    const { inserting, replacing } = ranges;

    if (typeof this.delegate.resolveCompletionItem !== 'function') {
      return this.convertCompletionItem(item, id, inserting, replacing);
    }

    try {
      const resolvedItem = await this.delegate.resolveCompletionItem(item, token);
      // 完整列表会在继续输入时复用；成功的详情解析不因正常版本变化而失效。
      if (doc.isClosed || token.isCancellationRequested) {
        return undefined;
      }
      // 确定返回值后只转换一次，避免为未使用的回退项重复注册命令和释放资源。
      return resolvedItem
        ? this.convertCompletionItem(resolvedItem, id)
        : this.convertCompletionItem(item, id, inserting, replacing);
    } catch (error) {
      if (!this.isCurrent(doc, version, token)) {
        return undefined;
      }
      throw error;
    }
  }

  async releaseCompletionItems(id: number) {
    this.cache.delete(id);
    const toDispose = this.toDispose.get(id);
    if (toDispose) {
      toDispose.dispose();
      this.toDispose.delete(id);
    }
    return Promise.resolve();
  }

  private isCurrent(document: vscode.TextDocument, version: number, token: vscode.CancellationToken): boolean {
    return !token.isCancellationRequested && !document.isClosed && document.version === version;
  }

  private getInsertOrReplace(resource: URI, position: Position) {
    const document = this.documents.getDocumentData(resource);
    if (!document || document.document.isClosed) {
      return undefined;
    }

    const doc = document.document;
    const pos = Converter.toPosition(position);
    const validPosition = doc.validatePosition(pos);
    if (pos.line !== validPosition.line || pos.character !== validPosition.character) {
      return undefined;
    }
    const replacing = doc.getWordRangeAtPosition(pos) || new Range(pos, pos);
    const inserting = replacing.with({ end: pos });
    return { inserting, replacing, doc, pos, version: doc.version };
  }

  private convertRange(
    item: vscode.CompletionItem,
    defaultInserting?: vscode.Range,
    defaultReplacing?: vscode.Range,
  ): RangeSuggestDataDto.ISuggestRangeDto | { insert: ModelRange; replace: ModelRange } | undefined {
    let range: vscode.Range | { inserting: vscode.Range; replacing: vscode.Range } | undefined;
    if (item.textEdit) {
      range = item.textEdit.range;
    } else if (item.range) {
      range = item.range;
    }

    let toRange: RangeSuggestDataDto.ISuggestRangeDto | undefined;

    if (Range.isRange(range)) {
      toRange = RangeSuggestDataDto.to(Converter.Range.from(range));
    } else if (range && (!defaultInserting?.isEqual(range.inserting) || !defaultReplacing?.isEqual(range.replacing))) {
      toRange = {
        insert: Converter.Range.from(range.inserting),
        replace: Converter.Range.from(range.replacing),
      };
    }

    return toRange;
  }

  private convertCompletionLabel(label: CompletionItemLabel): string {
    let labelStr = label.label;
    if (label.description) {
      labelStr += `~|${label.description}`;
    }
    if (label.detail) {
      labelStr += `~|${label.detail}`;
    }
    return labelStr;
  }

  private convertCompletionItem(
    item: vscode.CompletionItem,
    id: ChainedCacheId,
    defaultInserting?: vscode.Range,
    defaultReplacing?: vscode.Range,
  ): ISuggestDataDto {
    const disposables = this.toDispose.get(id[0]);
    if (!disposables) {
      throw Error('DisposableStore is missing...');
    }

    const result: ISuggestDataDto = {
      x: id,
      [ISuggestDataDtoField.kind]: item.kind ? Converter.CompletionItemKind.from(item.kind) : undefined,
      [ISuggestDataDtoField.kindModifier]: item.tags && item.tags.map(Converter.CompletionItemTag.from),
      [ISuggestDataDtoField.label]:
        typeof item.label === 'string' ? item.label : this.convertCompletionLabel(item.label),
      [ISuggestDataDtoField.detail]: item.detail,
      [ISuggestDataDtoField.documentation]: item.documentation,
      [ISuggestDataDtoField.filterText]: item.filterText,
      [ISuggestDataDtoField.sortText]: item.sortText,
      [ISuggestDataDtoField.preselect]: item.preselect ? item.preselect : undefined,
      [ISuggestDataDtoField.insertText]: '',
      [ISuggestDataDtoField.additionalTextEdits]:
        item.additionalTextEdits && item.additionalTextEdits.map(Converter.fromTextEdit),
      [ISuggestDataDtoField.command]: this.commandConverter.toInternal(item.command, disposables),
      [ISuggestDataDtoField.commitCharacters]: item.commitCharacters,
      [ISuggestDataDtoField.insertTextRules]: item.keepWhitespace
        ? CompletionItemInsertTextRule.KeepWhitespace
        : CompletionItemInsertTextRule.None,
    };

    const convertRange = this.convertRange(item, defaultInserting, defaultReplacing);

    if (convertRange) {
      result[ISuggestDataDtoField.range] = convertRange;
    }

    if (item.textEdit) {
      result[ISuggestDataDtoField.insertText] = item.textEdit.newText;
    } else if (typeof item.insertText === 'string') {
      result[ISuggestDataDtoField.insertText] = item.insertText;
    } else if (item.insertText instanceof SnippetString) {
      result[ISuggestDataDtoField.insertText] = item.insertText.value;
      result[ISuggestDataDtoField.insertTextRules] = CompletionItemInsertTextRule.InsertAsSnippet;
    } else {
      result[ISuggestDataDtoField.insertText] = typeof item.label === 'string' ? item.label : item.label.label;
    }
    return result;
  }

  static hasResolveSupport(provider: vscode.CompletionItemProvider): boolean {
    return typeof provider.resolveCompletionItem === 'function';
  }
}
