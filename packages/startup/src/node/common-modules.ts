import { AddonsModule } from '@opensumi/ide-addons/node';
import { ConstructorOf, NodeModule, ServerCommonModule } from '@opensumi/ide-core-node';
import { ExtensionModule } from '@opensumi/ide-extension/node';
import { OpenVsxExtensionManagerModule } from '@opensumi/ide-extension-manager/node';
import { FileSchemeNodeModule } from '@opensumi/ide-file-scheme/node';
import { FileSearchModule } from '@opensumi/ide-file-search/node';
import { FileServiceModule } from '@opensumi/ide-file-service/node';
import { LogServiceModule } from '@opensumi/ide-logs/node';
import { ProcessModule } from '@opensumi/ide-process/node';
import { SearchModule } from '@opensumi/ide-search/node';
import { TerminalNodePtyModule } from '@opensumi/ide-terminal-next/node';

import {
  AddonsFeature,
  CoreFeature,
  ExtensionFeature,
  ExtensionManagerFeature,
  FileSearchFeature,
  FileServiceFeature,
  NodeFileSchemeFeature,
  NodeLogFeature,
  ProcessFeature,
  SearchFeature,
  TerminalFeature,
} from '../product-profile';
import { ProductModuleBinding, compileOpenSumiProductRuntimePlan } from '../product-runtime-plan';

export const CommonNodeBindings: readonly ProductModuleBinding<ConstructorOf<NodeModule>>[] = [
  { feature: CoreFeature, module: ServerCommonModule },
  { feature: NodeLogFeature, module: LogServiceModule },
  { feature: FileServiceFeature, module: FileServiceModule },
  { feature: ProcessFeature, module: ProcessModule },
  { feature: FileSearchFeature, module: FileSearchModule },
  { feature: SearchFeature, module: SearchModule },
  { feature: TerminalFeature, module: TerminalNodePtyModule },
  { feature: ExtensionFeature, module: ExtensionModule },
  { feature: ExtensionManagerFeature, module: OpenVsxExtensionManagerModule },
  { feature: NodeFileSchemeFeature, module: FileSchemeNodeModule },
  { feature: AddonsFeature, module: AddonsModule },
];

export const CommonNodeRuntimePlan = compileOpenSumiProductRuntimePlan({
  runtime: 'node',
  commonBindings: CommonNodeBindings,
});

/** Compatibility module view, derived from the same bound plan used by the product. */
export const CommonNodeModules: ConstructorOf<NodeModule>[] = CommonNodeRuntimePlan.entries.map(
  (entry) => entry.module,
);
