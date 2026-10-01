import { Type } from '@furyjs/fury';

import { UriComponentsProto } from '@opensumi/ide-connection/protocols';
import { TSumiProtocol } from '@opensumi/ide-connection/rpc';

import { DiskFileServicePath } from '../tokens';

export const DiskFileServiceProtocol = {
  name: DiskFileServicePath,
  methods: [
    {
      method: 'readFile',
      request: [
        {
          name: 'uri',
          type: UriComponentsProto,
        },
      ],
      response: {
        type: Type.binary(),
      },
    },
  ],
} as TSumiProtocol;
