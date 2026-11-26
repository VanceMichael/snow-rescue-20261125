import { pathToFileURL } from 'node:url';
import { createDispatchServer, startDispatchServer } from './support/dispatch-server.mjs';

export { createDispatchServer, startDispatchServer };
export const createServer = createDispatchServer;
export const createApp = createDispatchServer;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startDispatchServer();
}
