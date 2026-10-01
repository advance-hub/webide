import { Workbench } from './app';
import { loadConfig } from './config';

const workbench = new Workbench(loadConfig());
await workbench.listen();
process.stdout.write(
  `OpenSumi workbench: ${workbench.config.publicURL} (Node ${process.versions.node}, ${workbench.driver.name})\n`,
);
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    if (stopping) {
      return;
    }
    stopping = true;
    void workbench.close().catch((error) => {
      process.stderr.write(`${error}\n`);
      process.exitCode = 1;
    });
  });
}
