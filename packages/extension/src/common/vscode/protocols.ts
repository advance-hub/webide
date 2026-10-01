import { ExtensionDocumentProtocol } from '@opensumi/ide-connection/protocols';
import { TSumiProtocol } from '@opensumi/ide-connection/rpc';
import { ProxyIdentifier } from '@opensumi/ide-connection/rpc-contracts';

import { ExtHostAPIIdentifier } from '.';

export const knownProtocols = new Map<ProxyIdentifier<any>, TSumiProtocol>();

knownProtocols.set(ExtHostAPIIdentifier.ExtHostDocuments, ExtensionDocumentProtocol);
