import { loadConfig } from './config';
import { createGatewayServer } from './server';

/* Loopback-bound: only Caddy (on the same host) reaches the gateway; TLS and the
   public interface are Caddy's job. */
const config = loadConfig();
const server = createGatewayServer(config);
server.listen(config.port, '127.0.0.1', () => {
  console.log(`local-tester gateway listening on 127.0.0.1:${config.port}`);
});
