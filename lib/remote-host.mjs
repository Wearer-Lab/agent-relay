// The always-on host: the artifacts that run the relay somewhere else.
//
// `agent-relay remote host` (the CLI is the wiring lane's) asks this module
// for a plan and prints it. Nothing here deploys anything, opens a socket or
// reads a secret: it produces files and the exact steps, and the owner runs
// them.
//
// The host runs the same three things this machine runs: the broker (which
// holds the rooms), the gateway (the restricted public front) and a tunnel
// (which points at the gateway). The rooms are the same rooms: a room is a
// checkout, and on the host the checkout lives under one stable path. The
// token store is the same file, so the same commands approve and revoke.
//
// The local side then points at the hosted relay instead of the local broker,
// with the same rooms and the same tokens: `AGENT_RELAY_URL` and, for a
// machine that should not ask a person every time, `AGENT_RELAY_TOKEN`.
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {readState, writeState} from './remote.mjs';

const require = createRequire(import.meta.url);

export const HOST_DEFAULTS = {
  provider: 'tailscale',
  port: 47820,
  dataDir: '/opt/agent-relay/data',
  roomRoot: '/opt/agent-relay/rooms',
  user: 'agent-relay',
  packageName: '@wearer-haitch/agent-relay',
};

// The version of the relay the artifacts install.
export const relayVersion = () => {
  try {
    const parsed = JSON.parse(require('node:fs').readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    if (typeof parsed.version === 'string' && parsed.version) return parsed.version;
  } catch { /* the plan falls back to the published package */ }
  return 'latest';
};

// The tunnel, per provider: the unit that runs it, the image it runs in, the
// command that shows the public URL, and how it is installed.
export const HOST_TUNNELS = {
  tailscale: {
    label: 'Tailscale Funnel',
    unit: port => `tailscale funnel ${port}`,
    image: null,
    containerCommand: port => ['funnel', '--bg', String(port)],
    status: 'tailscale funnel status',
    needs: [],
    install: ['curl -fsSL https://tailscale.com/install.sh | sh', 'tailscale up'],
    note: 'Tailscale needs one browser approval and gives a stable https://<machine>.<tailnet>.ts.net URL.',
  },
  cloudflare: {
    label: 'Cloudflare tunnel',
    unit: port => `cloudflared tunnel --no-autogen --url http://127.0.0.1:${port}`,
    image: 'cloudflare/cloudflared:2024.9.0',
    containerCommand: port => ['tunnel', '--no-autogen', '--url', `http://127.0.0.1:${port}`],
    status: 'journalctl -u agent-relay-tunnel -n 20',
    needs: [],
    install: ['curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared', 'chmod +x /usr/local/bin/cloudflared'],
    note: 'A quick tunnel changes its URL on every start. Use a named tunnel and a hostname of your own for a stable URL.',
  },
  ngrok: {
    label: 'ngrok',
    unit: port => `ngrok http --log=stdout ${port}`,
    image: 'ngrok/ngrok:3.13.0',
    containerCommand: port => ['http', '--log=stdout', String(port)],
    status: 'journalctl -u agent-relay-tunnel -n 20',
    needs: [],
    install: ['curl -fsSL https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz -o /tmp/ngrok.tgz', 'tar -C /usr/local/bin -xzf /tmp/ngrok.tgz'],
    note: 'ngrok needs an authtoken, and the free plan caps requests.',
  },
};

// A room on the host: a name, the repository it comes from, and the path it
// lives at. The name is what the room is called everywhere; the path is only
// ever a path on the host.
export function hostRoom({name, repo, branch = 'main', path: givenPath, roomRoot = HOST_DEFAULTS.roomRoot} = {}) {
  const label = String(name ?? '').trim() || String(repo ?? '').trim().split('/').pop() || 'room';
  const slug = label.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'room';
  const clean = String(repo ?? '').trim().replace(/^https?:\/\//i, '').replace(/\.git$/i, '');
  return {
    name: label,
    slug,
    repo: clean,
    branch: branch || 'main',
    path: givenPath ?? path.posix.join(roomRoot, slug),
    cloneUrl: clean ? `https://${clean}.git` : '',
  };
}

// The unit that runs the broker.
const brokerUnit = plan => `[Unit]
Description=Agent Relay broker (the rooms)
After=network.target

[Service]
Type=simple
User=${plan.user}
WorkingDirectory=${plan.dataDir}
ExecStart=/usr/bin/env agent-relay daemon --data-dir ${plan.dataDir}
Restart=always
RestartSec=5
Environment=AGENT_RELAY_HOME=${plan.dataDir}
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
`;

// The unit that runs the gateway: the only thing the tunnel points at.
const gatewayUnit = plan => `[Unit]
Description=Agent Relay gateway (the restricted public front)
After=network.target agent-relay-broker.service
Wants=agent-relay-broker.service

[Service]
Type=simple
User=${plan.user}
WorkingDirectory=${plan.dataDir}
# Wait until the broker has written its address. Starting earlier would make the
# gateway try to spawn a second broker in the same data directory.
ExecStartPre=/bin/sh -c 'for n in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do test -f ${plan.dataDir}/broker.json && exit 0; sleep 1; done; exit 1'
ExecStart=/usr/bin/env agent-relay remote gateway --data-dir ${plan.dataDir} --port ${plan.port}
Restart=always
RestartSec=5
Environment=AGENT_RELAY_HOME=${plan.dataDir}
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
`;

// The unit that runs the tunnel. It runs as root: the provider talks to a
// system daemon.
const tunnelUnit = plan => `[Unit]
Description=Agent Relay tunnel (${plan.tunnel.label})
After=network.target agent-relay-gateway.service
Wants=agent-relay-gateway.service

[Service]
Type=simple
ExecStart=${plan.tunnel.unit}
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
`;

// The image the compose file builds.
const dockerfile = plan => `# The relay image: one image for the broker and the gateway.
FROM node:20-alpine
RUN npm install -g ${plan.packageName}@${plan.version}
ENV AGENT_RELAY_HOME=/var/lib/agent-relay
WORKDIR /var/lib/agent-relay
`;

// The compose file: the broker and the gateway as services, and the tunnel
// when the provider has an image for it.
const composeFile = plan => {
  const volumes = [
    '      - broker-data:/var/lib/agent-relay',
    `      - ${plan.roomRoot}:${plan.roomRoot}`,
  ];
  const services = [
    `  broker:
    build:
      context: .
      dockerfile: agent-relay.dockerfile
    image: agent-relay:${plan.version}
    command: ["agent-relay", "daemon", "--data-dir", "/var/lib/agent-relay"]
    environment:
      AGENT_RELAY_HOME: /var/lib/agent-relay
    # The gateway shares this network namespace, so this published port is the
    # gateway's. It stays on the host loopback. The broker itself listens on
    # 127.0.0.1 inside the namespace and is not published.
    ports:
      - "127.0.0.1:${plan.port}:${plan.port}"
    volumes:
${volumes.join('\n')}
    restart: unless-stopped
    healthcheck:
      test:
        - CMD-SHELL
        - >-
          node -e "const fs=require('fs');const i=JSON.parse(fs.readFileSync('/var/lib/agent-relay/broker.json','utf8'));fetch(i.url+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
      interval: 10s
      timeout: 5s
      retries: 6`,
    `  gateway:
    build:
      context: .
      dockerfile: agent-relay.dockerfile
    image: agent-relay:${plan.version}
    command: ["agent-relay", "remote", "gateway", "--data-dir", "/var/lib/agent-relay", "--port", "${plan.port}"]
    environment:
      AGENT_RELAY_HOME: /var/lib/agent-relay
    # Same network namespace as the broker, so the broker's 127.0.0.1 is this
    # process's 127.0.0.1. A separate container network cannot reach it.
    network_mode: "service:broker"
    volumes:
${volumes.join('\n')}
    depends_on:
      broker:
        condition: service_healthy
    restart: unless-stopped`,
  ];
  if (plan.tunnel.image) {
    services.push(`  tunnel:
    image: ${plan.tunnel.image}
    command: ${JSON.stringify(plan.tunnel.containerCommand)}
    network_mode: "service:broker"
    depends_on:
      - gateway
    restart: unless-stopped`);
  }
  return `# Agent Relay, hosted: the broker, the gateway${plan.tunnel.image ? ' and the tunnel' : ''}.
# The gateway and the tunnel share the broker's network namespace, so every
# one of them sees the broker on 127.0.0.1. The tunnel points at the gateway
# on that loopback, never at a published broker port.
name: agent-relay

services:
${services.join('\n\n')}

volumes:
  broker-data:
`;
};

// The cloud-init snippet: one paste that brings a fresh machine up.
const cloudInit = plan => `#cloud-config
# Agent Relay, hosted. Run this when the machine is created.
package_update: true
packages:
  - nodejs
  - npm
  - git
  - curl
  - ca-certificates
write_files:
  - path: /etc/systemd/system/agent-relay-broker.service
    permissions: "0644"
    content: |
${indent(brokerUnit(plan), 6)}
  - path: /etc/systemd/system/agent-relay-gateway.service
    permissions: "0644"
    content: |
${indent(gatewayUnit(plan), 6)}
  - path: /etc/systemd/system/agent-relay-tunnel.service
    permissions: "0644"
    content: |
${indent(tunnelUnit(plan), 6)}
runcmd:
  - [ bash, -lc, "npm install -g ${plan.packageName}@${plan.version}" ]
  - [ bash, -lc, "id -u ${plan.user} >/dev/null 2>&1 || useradd --system --home ${plan.dataDir} --shell /usr/sbin/nologin ${plan.user}" ]
  - [ bash, -lc, "mkdir -p ${plan.dataDir} ${plan.roomRoot} && chown -R ${plan.user} ${plan.dataDir} ${plan.roomRoot}" ]
${plan.rooms.map(room => `  - [ bash, -lc, "git clone --branch ${room.branch} ${room.cloneUrl} ${room.path} || git -C ${room.path} pull" ]`).join('\n')}
${plan.tunnel.install.map(command => `  - [ bash, -lc, ${JSON.stringify(command)} ]`).join('\n')}
  - [ bash, -lc, "systemctl daemon-reload" ]
  - [ bash, -lc, "systemctl enable --now agent-relay-broker.service" ]
  - [ bash, -lc, "systemctl enable --now agent-relay-gateway.service" ]
  - [ bash, -lc, "systemctl enable --now agent-relay-tunnel.service" ]
final_message: "Agent Relay is up. The public URL: ${plan.tunnel.status}"
`;

const indent = (text, spaces) => text.split('\n').map(line => (line ? ' '.repeat(spaces) + line : line)).join('\n');

// Build the plan: what runs where, the files, and the steps.
export function planRemoteHost(options = {}) {
  const defaults = HOST_DEFAULTS;
  const provider = String(options.provider ?? defaults.provider);
  const tunnel = HOST_TUNNELS[provider];
  if (!tunnel) {
    return {
      ok: false,
      message: `Unknown tunnel provider ${provider}. Choose one of: ${Object.keys(HOST_TUNNELS).join(', ')}.`,
    };
  }
  const port = Number(options.port ?? defaults.port);
  const roomRoot = options.roomRoot ?? defaults.roomRoot;
  const plan = {
    ok: true,
    provider,
    tunnel: {
      ...tunnel,
      unit: tunnel.unit(port),
      containerCommand: tunnel.containerCommand(port),
    },
    hostname: options.hostname ?? null,
    port,
    dataDir: options.dataDir ?? defaults.dataDir,
    roomRoot,
    user: options.user ?? defaults.user,
    packageName: options.packageName ?? defaults.packageName,
    version: options.version ?? relayVersion(),
    url: options.url ?? (options.hostname ? `https://${options.hostname}` : null),
    rooms: (options.rooms ?? []).map(room => hostRoom({...room, roomRoot})),
  };

  plan.files = [
    {name: 'agent-relay.dockerfile', mode: 0o644, contents: dockerfile(plan)},
    {name: 'agent-relay.compose.yml', mode: 0o644, contents: composeFile(plan)},
    {name: 'agent-relay-broker.service', mode: 0o644, contents: brokerUnit(plan)},
    {name: 'agent-relay-gateway.service', mode: 0o644, contents: gatewayUnit(plan)},
    {name: 'agent-relay-tunnel.service', mode: 0o644, contents: tunnelUnit(plan)},
    {name: 'cloud-init.yml', mode: 0o644, contents: cloudInit(plan)},
  ];
  plan.steps = hostSteps(plan);
  plan.local = hostLocalWiring(plan);
  plan.message = `Agent Relay can run on ${plan.tunnel.label}. The artifacts are ready; nothing has been deployed.`;
  return plan;
}

// The exact steps, in order. The owner runs them.
export function hostSteps(plan) {
  const steps = [
    `Install the relay on the host: npm install -g ${plan.packageName}@${plan.version}`,
    `Create the service account and the directories: sudo useradd --system --home ${plan.dataDir} --shell /usr/sbin/nologin ${plan.user} && sudo mkdir -p ${plan.dataDir} ${plan.roomRoot} && sudo chown -R ${plan.user} ${plan.dataDir} ${plan.roomRoot}`,
  ];
  for (const room of plan.rooms) {
    steps.push(`Put the room on the host: git clone --branch ${room.branch} ${room.cloneUrl} ${room.path}  (a private repository needs a deploy key)`);
  }
  for (const command of plan.tunnel.install) {
    steps.push(`Install the tunnel: sudo bash -c "${command}"`);
  }
  steps.push(
    `Install the units: sudo cp agent-relay-broker.service agent-relay-gateway.service agent-relay-tunnel.service /etc/systemd/system/ && sudo systemctl daemon-reload`,
    `Start the relay: sudo systemctl enable --now agent-relay-broker.service agent-relay-gateway.service agent-relay-tunnel.service`,
    `Read the public URL: ${plan.tunnel.status}`,
    plan.tunnel.note,
    `Approve an agent on the host: sudo -u ${plan.user} AGENT_RELAY_HOME=${plan.dataDir} agent-relay remote approve`,
    `Revoke everything on the host: sudo -u ${plan.user} AGENT_RELAY_HOME=${plan.dataDir} agent-relay remote revoke --all`,
  );
  return steps;
}

// The local side: the same rooms, the same tokens, the hosted URL.
export function hostLocalWiring(plan) {
  const steps = [
    `Point this machine at the hosted relay: export AGENT_RELAY_URL=${plan.url ?? '<the public URL the tunnel printed>'}`,
    `The first call asks to join. Approve it on the host: sudo -u ${plan.user} AGENT_RELAY_HOME=${plan.dataDir} agent-relay remote approve`,
    `For a machine that should never ask again, keep the token in the environment: AGENT_RELAY_TOKEN=<the token the host handed over>`,
    `Wire a repository for a cloud agent: agent-relay remote add claude`,
    `The local agents join the hosted room too: the room is the same one, and the token decides it, not the path`,
  ];
  return {
    url: plan.url ?? null,
    env: plan.url ? {AGENT_RELAY_URL: plan.url} : {},
    steps,
  };
}

// The artifacts of a plan, in the order they should be written.
export function remoteHostArtifacts(plan) {
  return (plan.files ?? []).map(file => ({name: file.name, mode: file.mode, contents: file.contents}));
}

// Write the artifacts into a directory. Nothing is deployed: this only writes
// files the owner can read, copy and run.
export async function writeRemoteHostArtifacts({dir, ...options} = {}) {
  if (!dir) throw new Error('A directory is required.');
  const plan = planRemoteHost(options);
  if (!plan.ok) return {ok: false, message: plan.message};
  const target = path.resolve(dir);
  await fs.mkdir(target, {recursive: true});
  const written = [];
  for (const file of plan.files) {
    const file_path = path.join(target, file.name);
    await fs.writeFile(file_path, file.contents, {mode: file.mode});
    written.push({name: file.name, path: file_path});
  }
  return {ok: true, plan, dir: target, written};
}

// Point this machine at the hosted relay, so `remote add`, `remote status` and
// `remote doctor` use the hosted URL from now on. The local broker is left
// alone: it is still there for the agents that talk to it directly.
export async function pointLocalAtHost({dataDir, url, provider = 'hosted', port} = {}) {
  if (!dataDir) throw new Error('A data directory is required.');
  if (!url) return {ok: false, message: 'The hosted URL is required.'};
  const state = await readState(dataDir);
  const next = {...state, url, provider, hosted: true, gatewayPort: port ?? state.gatewayPort ?? null};
  await writeState(dataDir, next);
  return {
    ok: true,
    url,
    message: `This machine now points at the hosted relay (${url}). Run \`agent-relay remote add claude\` to wire a repository.`,
    state: next,
  };
}

// The text the CLI prints: the artifacts, the steps, then the local wiring.
export function remoteHostInstructions(plan) {
  if (!plan?.ok) return plan?.message ?? 'No plan.';
  const lines = [];
  lines.push(plan.message);
  lines.push('');
  lines.push('The artifacts:');
  for (const file of plan.files ?? []) lines.push(`  ${file.name}`);
  lines.push('');
  lines.push('The steps:');
  for (const step of plan.steps ?? []) lines.push(`  - ${step}`);
  lines.push('');
  lines.push('On this machine:');
  for (const step of plan.local?.steps ?? []) lines.push(`  - ${step}`);
  return lines.join('\n');
}
