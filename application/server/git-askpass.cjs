#!/usr/bin/env node
'use strict';
process.stdout.write(
  /username/i.test(process.argv[2] || '')
    ? `${process.env.OPENSUMI_GIT_USERNAME || 'oauth2'}\n`
    : `${process.env.OPENSUMI_GIT_TOKEN || ''}\n`,
);
