import fs from 'node:fs';
import net from 'node:net';

const socketPath = process.argv[2];
if (!socketPath) throw new Error('A socket path is required.');

const server = net.createServer();
server.listen(socketPath, () => {
  fs.chmodSync(socketPath, 0o600);
  process.stdout.write('ready\n');
});
