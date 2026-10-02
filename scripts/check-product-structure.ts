import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript-api';

export interface ProductSource {
  file: string;
  source: string;
}
export interface StructureProblem {
  file: string;
  line: number;
  kind: 'dependency' | 'cycle' | 'unresolved' | 'comment';
  message: string;
}

const extensions = ['.ts', '.tsx', '.cjs', '.js'];
const ignored = new Set(['node_modules', 'dist', '.data']);
const chinese = /[\u3400-\u9fff]/;

function layer(file: string): string {
  if (file.startsWith('application/shared/')) {
    return 'shared';
  }
  if (file.startsWith('application/src/')) {
    return 'browser';
  }
  if (file.startsWith('application/runtime/')) {
    return 'helper';
  }
  const match = /^application\/server\/(platform|domain|modules|runtime|infrastructure|http)\//.exec(file);
  return match?.[1] || 'entry';
}

const allowed: Record<string, Set<string>> = {
  shared: new Set(['shared']),
  browser: new Set(['browser', 'shared']),
  helper: new Set(['helper']),
  platform: new Set(['platform']),
  domain: new Set(['domain', 'shared', 'platform']),
  modules: new Set(['modules', 'domain', 'shared', 'platform']),
  runtime: new Set(['runtime', 'infrastructure', 'domain', 'shared', 'platform']),
  infrastructure: new Set(['infrastructure', 'domain', 'shared', 'platform']),
};

/** 说明性注释使用中文；编译器指令、类型元数据和来源声明保持可解析的原文。 */
export function commentIsChinese(value: string): boolean {
  const text = value.replace(/^\s*\/\/?\*?|\*\/?\s*$/g, '').trim();
  return (
    !/[A-Za-z]{3}/.test(text) ||
    chinese.test(text) ||
    /^(?:!|eslint-|global\b|@ts-|@type\b|@param\b|@returns?\b|@license\b|\/\s*<reference\b)/.test(text) ||
    /(?:Copyright|SPDX-License-Identifier)/i.test(text)
  );
}

/** 从语法树读取导入和注释，避免把 URL、正则或字符串中的斜杠当成注释。 */
export function inspectProduct(sources: ProductSource[]): StructureProblem[] {
  const files = new Set(sources.map(({ file }) => file));
  const problems: StructureProblem[] = [];
  const edges = new Map<string, Set<string>>();
  for (const { file, source } of sources) {
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const comments = new Map<number, ts.CommentRange>();
    const imports: Array<{ value: string; position: number }> = [];
    const visit = (node: ts.Node) => {
      for (const position of [node.pos, node.end]) {
        for (const range of [
          ...(ts.getLeadingCommentRanges(source, position) || []),
          ...(ts.getTrailingCommentRanges(source, position) || []),
        ]) {
          comments.set(range.pos, range);
        }
      }
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        imports.push({ value: node.moduleSpecifier.text, position: node.getStart(tree) });
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        imports.push({ value: node.arguments[0].text, position: node.getStart(tree) });
      }
      // 包含标点令牌，才能读取空代码块和 JSX 花括号内的注释。
      for (const child of node.getChildren(tree)) {
        visit(child);
      }
    };
    visit(tree);
    const report = (position: number, kind: StructureProblem['kind'], message: string) =>
      problems.push({ file, line: tree.getLineAndCharacterOfPosition(position).line + 1, kind, message });
    for (const range of comments.values()) {
      if (!commentIsChinese(source.slice(range.pos, range.end))) {
        report(range.pos, 'comment', '说明性注释必须使用中文');
      }
    }
    for (const { value, position } of imports) {
      if (!value.startsWith('.')) {
        if (layer(file) === 'shared') {
          report(position, 'dependency', '共享契约不能依赖外部运行库');
        }
        continue;
      }
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), value));
      const target = [
        base,
        ...extensions.map((ext) => base + ext),
        ...extensions.map((ext) => base + '/index' + ext),
      ].find((candidate) => files.has(candidate));
      if (!target) {
        if (!/\.(css|svg|png|woff2?)$/.test(value)) {
          report(position, 'unresolved', `相对导入不存在：${value}`);
        }
        continue;
      }
      const targets = edges.get(file) || new Set<string>();
      targets.add(target);
      edges.set(file, targets);
      if (allowed[layer(file)] && !allowed[layer(file)].has(layer(target))) {
        report(position, 'dependency', `${layer(file)} 层不能依赖 ${layer(target)} 层：${value}`);
      }
    }
  }
  const stack: string[] = [];
  const active = new Set<string>();
  const visited = new Set<string>();
  const visit = (file: string) => {
    if (active.has(file)) {
      problems.push({
        file,
        line: 1,
        kind: 'cycle',
        message: `循环依赖：${[...stack.slice(stack.indexOf(file)), file].join(' → ')}`,
      });
      return;
    }
    if (visited.has(file)) {
      return;
    }
    visited.add(file);
    active.add(file);
    stack.push(file);
    for (const target of edges.get(file) || []) {
      visit(target);
    }
    stack.pop();
    active.delete(file);
  };
  sources.forEach(({ file }) => visit(file));
  return problems;
}

export function readProduct(root: string): ProductSource[] {
  const result: ProductSource[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      if (ignored.has(entry.name)) {
        continue;
      }
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(file);
      } else if (extensions.includes(path.extname(entry.name))) {
        result.push({ file, source: readFileSync(path.join(root, file), 'utf8') });
      }
    }
  };
  walk('application');
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sources = readProduct(path.resolve(import.meta.dirname, '..'));
  const problems = inspectProduct(sources);
  for (const problem of problems) {
    process.stderr.write(`${problem.file}:${problem.line} [${problem.kind}] ${problem.message}\n`);
  }
  process.exitCode = problems.length ? 1 : 0;
  process.stdout.write(`产品结构检查：${sources.length} 个源码文件，${problems.length} 个问题\n`);
}
