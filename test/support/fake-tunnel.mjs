// A fake tunnel provider for the end-to-end test.
//
// The real providers in lib/tunnels/ each answer the same questions: is the
// tool installed, what does the person have to do, how do we start it, how do
// we stop it, and where does it point right now. This provider answers them
// the same way, so `agent-relay remote on` would treat it like any other, but
// instead of a real tunnel it forwards the gateway's port to an ephemeral
// loopback port and hands that port back as the public URL.
//
// Two rules it keeps: it never touches the network (nothing but 127.0.0.1),
// and it never leaves a process behind (the forwarder is an in-process HTTP
// server, not a child process). The port it listens on is always ephemeral, so
// the parallel test files never fight over one.
import http from 'node:http';

export const id = 'fake';
export const name = 'Fake tunnel (tests)';
export const stable = true;

// Headers that describe a single hop and must not be copied to the next one.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'upgrade',
]);

export function createFakeTunnel() {
  let server = null;
  let targetPort = null;
  let publicUrl = null;
  const requests = [];

  // Forward one request to the gateway, exactly as a tunnel would.
  const forward = (request, response) => {
    requests.push({method: request.method, url: request.url});
    const upstream = http.request({
      host: '127.0.0.1',
      port: targetPort,
      method: request.method,
      path: request.url,
      headers: {...request.headers, host: `127.0.0.1:${targetPort}`},
      // No keep-alive: every forwarded request owns its socket, so closing the
      // tunnel really closes everything.
      agent: false,
    }, incoming => {
      const headers = {...incoming.headers};
      for (const header of HOP_BY_HOP) delete headers[header];
      response.writeHead(incoming.statusCode ?? 502, headers);
      incoming.pipe(response);
    });
    upstream.on('error', () => {
      // The gateway behind the tunnel is gone. The client sees a broken
      // connection, the same as a tunnel that lost its target.
      if (!response.headersSent) response.writeHead(502, {'content-type': 'application/json'});
      response.end(JSON.stringify({error: 'The tunnel lost its target.'}));
    });
    request.pipe(upstream);
  };

  return {
    id,
    name,
    stable,

    // The provider interface every real provider implements.
    async detect() {
      return {available: true, installed: true, signedIn: true, hint: ''};
    },

    async signIn() {
      return {ok: true, message: 'The fake tunnel needs no sign-in.'};
    },

    async start({port} = {}) {
      if (server) await this.stop();
      targetPort = port;
      server = http.createServer(forward);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        // Port 0: the tunnel never takes a fixed port.
        server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      publicUrl = `http://127.0.0.1:${server.address().port}`;
      return {ok: true, url: publicUrl, message: `The fake tunnel is serving the gateway on port ${port}.`};
    },

    async stop() {
      const closing = server;
      server = null;
      publicUrl = null;
      if (closing) {
        closing.closeAllConnections?.();
        await new Promise(resolve => closing.close(() => resolve()));
      }
      return {ok: true, message: 'The fake tunnel is closed.'};
    },

    async status() {
      return {
        running: Boolean(server),
        url: publicUrl,
        message: server ? 'The fake tunnel is running.' : 'The fake tunnel is not running.',
      };
    },

    // What the test looks at.
    get url() { return publicUrl; },
    get targetPort() { return targetPort; },
    get running() { return Boolean(server); },
    requests,
  };
}

export default createFakeTunnel;
