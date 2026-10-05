# Validation

Run the repeatable release checks:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run release:check
```

The current automated suite has **52 passing tests** on macOS. The optional
`docs/ci-workflow.yml` template runs the suite on macOS, Linux, and Windows with
Node.js 20 and 22. Automatic GitHub Actions is not enabled in this repository;
activating it requires permission to push workflow files.

The suite covers project isolation, durable message delivery, acknowledgements,
replies, cooperative claims, restart retention, writer ownership, authentication,
corrupt-store handling, and runner configuration preservation. Adapter tests
exercise MCP transports, existing-thread delivery, OpenCode hooks, and safe
handling of uncertain notifications without launching a vendor model.

Dashboard tests cover project discovery, bounded snapshots, read-only observation,
authentication, origin checks, legacy-broker compatibility, HTTP assets, and
light/dark/system preferences. Test brokers and projects use disposable temporary
directories. Public-release checks have also verified a fresh npm installation,
two project rooms, history isolation, and the packaged dashboard assets.

The release checker inspects archive contents and checks help/version from the
extracted package. Runtime behavior in an actual vendor session depends on that
runner's supported interfaces and account policies. Transport success is separate
from model acknowledgement. Cloud-model behavior and cross-platform live runner
integrations are not established by these tests.

Local session evidence, machine-specific logs, and message histories are not part
of this public repository.
