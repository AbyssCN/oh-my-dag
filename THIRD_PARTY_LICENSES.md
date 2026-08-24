# Third-party licenses

oh-my-dag depends on the packages below. This file is generated — do not edit by hand:

```sh
bun run scripts/third-party-licenses.ts          # regenerate
bun run scripts/third-party-licenses.ts --check  # verify it is current (exit 1 if stale)
```

We do not vendor any of these. Installing from a registry fetches each package with its own licence text attached. This file exists for the paths where we *are* the distributor — a container image or a standalone binary carries these dependencies inside it, and licences such as BSD-3-Clause and Apache-2.0 require the notice to travel with them.

**235 packages** · 13 direct, 222 transitive.

## Needs a human, not a script

These do not carry a machine-readable SPDX licence. Their terms have to be read before anything is shipped commercially.

| Package | Version | Declared | Where the terms live |
|---|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | 0.3.226 | `SEE LICENSE IN README.md` | LICENSE.md |
| `@anthropic-ai/claude-agent-sdk-linux-x64` | 0.3.226 | `SEE LICENSE IN LICENSE.md` | LICENSE.md |
| `@anthropic-ai/claude-agent-sdk-linux-x64-musl` | 0.3.226 | `SEE LICENSE IN LICENSE.md` | LICENSE.md |

## By licence

| Licence | Packages |
|---|---:|
| MIT | 155 |
| Apache-2.0 | 47 |
| BSD-3-Clause | 17 |
| ISC | 9 |
| SEE LICENSE IN LICENSE.md | 2 |
| 0BSD | 1 |
| BlueOak-1.0.0 | 1 |
| BSD-2-Clause | 1 |
| Python-2.0 | 1 |
| SEE LICENSE IN README.md | 1 |

## Every package

| Package | Version | Licence | Direct |
|---|---|---|:--:|
| `@anthropic-ai/claude-agent-sdk` | 0.3.226 | SEE LICENSE IN README.md | ✓ |
| `@anthropic-ai/claude-agent-sdk-linux-x64` | 0.3.226 | SEE LICENSE IN LICENSE.md |  |
| `@anthropic-ai/claude-agent-sdk-linux-x64-musl` | 0.3.226 | SEE LICENSE IN LICENSE.md |  |
| `@anthropic-ai/sdk` | 0.91.1 | MIT |  |
| `@aws-crypto/crc32` | 5.2.0 | Apache-2.0 |  |
| `@aws-crypto/sha256-browser` | 5.2.0 | Apache-2.0 |  |
| `@aws-crypto/sha256-js` | 5.2.0 | Apache-2.0 |  |
| `@aws-crypto/supports-web-crypto` | 5.2.0 | Apache-2.0 |  |
| `@aws-crypto/util` | 5.2.0 | Apache-2.0 |  |
| `@aws-sdk/client-bedrock-runtime` | 3.1048.0 | Apache-2.0 |  |
| `@aws-sdk/core` | 3.974.17 | Apache-2.0 |  |
| `@aws-sdk/credential-provider-env` | 3.972.43 | Apache-2.0 |  |
| `@aws-sdk/credential-provider-http` | 3.972.45 | Apache-2.0 |  |
| `@aws-sdk/credential-provider-ini` | 3.972.48 | Apache-2.0 |  |
| `@aws-sdk/credential-provider-login` | 3.972.47 | Apache-2.0 |  |
| `@aws-sdk/credential-provider-node` | 3.972.50 | Apache-2.0 |  |
| `@aws-sdk/credential-provider-process` | 3.972.43 | Apache-2.0 |  |
| `@aws-sdk/credential-provider-sso` | 3.972.47 | Apache-2.0 |  |
| `@aws-sdk/credential-provider-web-identity` | 3.972.47 | Apache-2.0 |  |
| `@aws-sdk/eventstream-handler-node` | 3.972.19 | Apache-2.0 |  |
| `@aws-sdk/middleware-eventstream` | 3.972.15 | Apache-2.0 |  |
| `@aws-sdk/middleware-websocket` | 3.972.25 | Apache-2.0 |  |
| `@aws-sdk/nested-clients` | 3.997.15 | Apache-2.0 |  |
| `@aws-sdk/signature-v4-multi-region` | 3.996.31 | Apache-2.0 |  |
| `@aws-sdk/token-providers` | 3.1048.0 | Apache-2.0 |  |
| `@aws-sdk/types` | 3.973.10 | Apache-2.0 |  |
| `@aws-sdk/util-locate-window` | 3.965.5 | Apache-2.0 |  |
| `@aws-sdk/xml-builder` | 3.972.27 | Apache-2.0 |  |
| `@aws/lambda-invoke-store` | 0.2.4 | Apache-2.0 |  |
| `@babel/runtime` | 7.29.7 | MIT |  |
| `@earendil-works/pi-agent-core` | 0.84.0 | MIT | ✓ |
| `@earendil-works/pi-ai` | 0.84.0 | MIT | ✓ |
| `@earendil-works/pi-telemetry` | 0.84.0 | MIT |  |
| `@earendil-works/pi-tui` | 0.84.0 | MIT | ✓ |
| `@google/genai` | 1.52.0 | Apache-2.0 |  |
| `@hono/node-server` | 1.19.14 | MIT |  |
| `@lydell/node-pty` | 1.2.0-beta.14 | MIT |  |
| `@lydell/node-pty-linux-x64` | 1.2.0-beta.14 | MIT |  |
| `@mistralai/mistralai` | 2.2.6 | Apache-2.0 |  |
| `@modelcontextprotocol/sdk` | 1.29.0 | MIT | ✓ |
| `@nodable/entities` | 2.1.1 | MIT |  |
| `@oh-my-pi/hashline` | 15.9.0 | MIT | ✓ |
| `@opentelemetry/api` | 1.9.0 | Apache-2.0 |  |
| `@opentelemetry/semantic-conventions` | 1.43.0 | Apache-2.0 |  |
| `@pinojs/redact` | 0.4.0 | MIT |  |
| `@protobufjs/aspromise` | 1.1.2 | BSD-3-Clause |  |
| `@protobufjs/base64` | 1.1.2 | BSD-3-Clause |  |
| `@protobufjs/codegen` | 2.0.5 | BSD-3-Clause |  |
| `@protobufjs/eventemitter` | 1.1.1 | BSD-3-Clause |  |
| `@protobufjs/fetch` | 1.1.1 | BSD-3-Clause |  |
| `@protobufjs/float` | 1.0.2 | BSD-3-Clause |  |
| `@protobufjs/inquire` | 1.1.2 | BSD-3-Clause |  |
| `@protobufjs/path` | 1.1.2 | BSD-3-Clause |  |
| `@protobufjs/pool` | 1.1.0 | BSD-3-Clause |  |
| `@protobufjs/utf8` | 1.1.1 | BSD-3-Clause |  |
| `@sinclair/typebox` | 0.34.49 | MIT | ✓ |
| `@smithy/core` | 3.24.6 | Apache-2.0 |  |
| `@smithy/credential-provider-imds` | 4.3.7 | Apache-2.0 |  |
| `@smithy/fetch-http-handler` | 5.4.6 | Apache-2.0 |  |
| `@smithy/is-array-buffer` | 2.2.0 | Apache-2.0 |  |
| `@smithy/node-http-handler` | 4.7.3 | Apache-2.0 |  |
| `@smithy/signature-v4` | 5.4.6 | Apache-2.0 |  |
| `@smithy/types` | 4.14.3 | Apache-2.0 |  |
| `@smithy/util-buffer-from` | 2.2.0 | Apache-2.0 |  |
| `@smithy/util-utf8` | 2.3.0 | Apache-2.0 |  |
| `@types/bun` | 1.3.14 | MIT |  |
| `@types/js-yaml` | 4.0.9 | MIT |  |
| `@types/node` | 25.9.1 | MIT |  |
| `@types/retry` | 0.12.0 | MIT |  |
| `@xterm/headless` | 6.0.0 | MIT |  |
| `accepts` | 2.0.0 | MIT |  |
| `agent-base` | 7.1.4 | MIT |  |
| `ajv` | 8.20.0 | MIT |  |
| `ajv-formats` | 3.0.1 | MIT |  |
| `argparse` | 2.0.1 | Python-2.0 |  |
| `atomic-sleep` | 1.0.0 | MIT |  |
| `base64-js` | 1.5.1 | MIT |  |
| `bignumber.js` | 9.3.1 | MIT |  |
| `body-parser` | 2.2.2 | MIT |  |
| `bowser` | 2.14.1 | MIT |  |
| `buffer-equal-constant-time` | 1.0.1 | BSD-3-Clause |  |
| `bun-types` | 1.3.14 | MIT |  |
| `bytes` | 3.1.2 | MIT |  |
| `call-bind-apply-helpers` | 1.0.2 | MIT |  |
| `call-bound` | 1.0.4 | MIT |  |
| `colorette` | 2.0.20 | MIT |  |
| `content-disposition` | 1.1.0 | MIT |  |
| `content-type` | 1.0.5 | MIT |  |
| `cookie` | 0.7.2 | MIT |  |
| `cookie-signature` | 1.2.2 | MIT |  |
| `cors` | 2.8.6 | MIT |  |
| `cross-spawn` | 7.0.6 | MIT |  |
| `data-uri-to-buffer` | 4.0.1 | MIT |  |
| `dateformat` | 4.6.3 | MIT |  |
| `debug` | 4.4.3 | MIT |  |
| `depd` | 2.0.0 | MIT |  |
| `diff` | 8.0.4 | BSD-3-Clause |  |
| `dunder-proto` | 1.0.1 | MIT |  |
| `ecdsa-sig-formatter` | 1.0.11 | Apache-2.0 |  |
| `ee-first` | 1.1.1 | MIT |  |
| `encodeurl` | 2.0.0 | MIT |  |
| `end-of-stream` | 1.4.5 | MIT |  |
| `es-define-property` | 1.0.1 | MIT |  |
| `es-errors` | 1.3.0 | MIT |  |
| `es-object-atoms` | 1.1.2 | MIT |  |
| `escape-html` | 1.0.3 | MIT |  |
| `etag` | 1.8.1 | MIT |  |
| `eventsource` | 3.0.7 | MIT |  |
| `eventsource-parser` | 3.1.0 | MIT |  |
| `express` | 5.2.1 | MIT |  |
| `express-rate-limit` | 8.5.2 | MIT |  |
| `extend` | 3.0.2 | MIT |  |
| `fast-copy` | 4.0.3 | MIT |  |
| `fast-deep-equal` | 3.1.3 | MIT |  |
| `fast-safe-stringify` | 2.1.1 | MIT |  |
| `fast-uri` | 3.1.2 | BSD-3-Clause |  |
| `fast-xml-builder` | 1.2.0 | MIT |  |
| `fast-xml-parser` | 5.7.3 | MIT |  |
| `fetch-blob` | 3.2.0 | MIT |  |
| `finalhandler` | 2.1.1 | MIT |  |
| `formdata-polyfill` | 4.0.10 | MIT |  |
| `forwarded` | 0.2.0 | MIT |  |
| `fresh` | 2.0.0 | MIT |  |
| `function-bind` | 1.1.2 | MIT |  |
| `gaxios` | 7.1.4 | Apache-2.0 |  |
| `gcp-metadata` | 8.1.2 | Apache-2.0 |  |
| `get-east-asian-width` | 1.6.0 | MIT |  |
| `get-intrinsic` | 1.3.0 | MIT |  |
| `get-proto` | 1.0.1 | MIT |  |
| `google-auth-library` | 10.6.2 | Apache-2.0 |  |
| `google-logging-utils` | 1.1.3 | Apache-2.0 |  |
| `gopd` | 1.2.0 | MIT |  |
| `has-symbols` | 1.1.0 | MIT |  |
| `hasown` | 2.0.4 | MIT |  |
| `help-me` | 5.0.0 | MIT |  |
| `highlight.js` | 11.11.1 | BSD-3-Clause | ✓ |
| `hono` | 4.12.23 | MIT |  |
| `http-errors` | 2.0.1 | MIT |  |
| `http-proxy-agent` | 7.0.2 | MIT |  |
| `https-proxy-agent` | 7.0.6 | MIT |  |
| `iconv-lite` | 0.7.2 | MIT |  |
| `ignore` | 7.0.5 | MIT |  |
| `inherits` | 2.0.4 | ISC |  |
| `ip-address` | 10.2.0 | MIT |  |
| `ipaddr.js` | 1.9.1 | MIT |  |
| `is-promise` | 4.0.0 | MIT |  |
| `isexe` | 2.0.0 | ISC |  |
| `jose` | 6.2.3 | MIT |  |
| `joycon` | 3.1.1 | MIT |  |
| `js-yaml` | 4.2.0 | MIT | ✓ |
| `json-bigint` | 1.0.0 | MIT |  |
| `json-schema-to-ts` | 3.1.1 | MIT |  |
| `json-schema-traverse` | 1.0.0 | MIT |  |
| `json-schema-typed` | 8.0.2 | BSD-2-Clause |  |
| `jwa` | 2.0.1 | MIT |  |
| `jws` | 4.0.1 | MIT |  |
| `long` | 5.3.2 | Apache-2.0 |  |
| `lru-cache` | 11.5.1 | BlueOak-1.0.0 |  |
| `marked` | 18.0.5 | MIT |  |
| `math-intrinsics` | 1.1.0 | MIT |  |
| `media-typer` | 1.1.0 | MIT |  |
| `merge-descriptors` | 2.0.0 | MIT |  |
| `mime-db` | 1.54.0 | MIT |  |
| `mime-types` | 3.0.2 | MIT |  |
| `minimist` | 1.2.8 | MIT |  |
| `ms` | 2.1.3 | MIT |  |
| `negotiator` | 1.0.0 | MIT |  |
| `node-domexception` | 1.0.0 | MIT |  |
| `node-fetch` | 3.3.2 | MIT |  |
| `object-assign` | 4.1.1 | MIT |  |
| `object-inspect` | 1.13.4 | MIT |  |
| `on-exit-leak-free` | 2.1.2 | MIT |  |
| `on-finished` | 2.4.1 | MIT |  |
| `once` | 1.4.0 | ISC |  |
| `openai` | 6.26.0 | Apache-2.0 |  |
| `p-retry` | 4.6.2 | MIT |  |
| `parseurl` | 1.3.3 | MIT |  |
| `partial-json` | 0.1.7 | MIT |  |
| `path-expression-matcher` | 1.5.0 | MIT |  |
| `path-key` | 3.1.1 | MIT |  |
| `path-to-regexp` | 8.4.2 | MIT |  |
| `pino` | 10.3.1 | MIT | ✓ |
| `pino-abstract-transport` | 3.0.0 | MIT |  |
| `pino-pretty` | 13.1.3 | MIT | ✓ |
| `pino-std-serializers` | 7.1.0 | MIT |  |
| `pkce-challenge` | 5.0.1 | MIT |  |
| `playwright-core` | 1.62.0 | Apache-2.0 |  |
| `process-warning` | 5.0.0 | MIT |  |
| `protobufjs` | 7.6.2 | BSD-3-Clause |  |
| `proxy-addr` | 2.0.7 | MIT |  |
| `pump` | 3.0.4 | MIT |  |
| `qs` | 6.15.2 | BSD-3-Clause |  |
| `quick-format-unescaped` | 4.0.4 | MIT |  |
| `range-parser` | 1.2.1 | MIT |  |
| `raw-body` | 3.0.2 | MIT |  |
| `real-require` | 0.2.0 | MIT |  |
| `require-from-string` | 2.0.2 | MIT |  |
| `retry` | 0.13.1 | MIT |  |
| `router` | 2.2.0 | MIT |  |
| `safe-buffer` | 5.2.1 | MIT |  |
| `safe-stable-stringify` | 2.5.0 | MIT |  |
| `safer-buffer` | 2.1.2 | MIT |  |
| `secure-json-parse` | 4.1.0 | BSD-3-Clause |  |
| `send` | 1.2.1 | MIT |  |
| `serve-static` | 2.2.1 | MIT |  |
| `setprototypeof` | 1.2.0 | ISC |  |
| `shebang-command` | 2.0.0 | MIT |  |
| `shebang-regex` | 3.0.0 | MIT |  |
| `side-channel` | 1.1.0 | MIT |  |
| `side-channel-list` | 1.0.1 | MIT |  |
| `side-channel-map` | 1.0.1 | MIT |  |
| `side-channel-weakmap` | 1.0.2 | MIT |  |
| `sonic-boom` | 4.2.1 | MIT |  |
| `split2` | 4.2.0 | ISC |  |
| `statuses` | 2.0.2 | MIT |  |
| `strip-json-comments` | 5.0.3 | MIT |  |
| `strnum` | 2.3.0 | MIT |  |
| `thread-stream` | 4.2.0 | MIT |  |
| `toidentifier` | 1.0.1 | MIT |  |
| `ts-algebra` | 2.0.0 | MIT |  |
| `tslib` | 2.8.1 | 0BSD |  |
| `type-is` | 2.1.0 | MIT |  |
| `typebox` | 1.3.7 | MIT | ✓ |
| `typescript` | 5.9.3 | Apache-2.0 |  |
| `undici-types` | 7.24.6 | MIT |  |
| `unpipe` | 1.0.0 | MIT |  |
| `vary` | 1.1.2 | MIT |  |
| `web-streams-polyfill` | 3.3.3 | MIT |  |
| `which` | 2.0.2 | ISC |  |
| `wrappy` | 1.0.2 | ISC |  |
| `ws` | 8.21.0 | MIT |  |
| `xml-naming` | 0.1.0 | MIT |  |
| `yaml` | 2.9.0 | ISC |  |
| `zod` | 4.4.3 | MIT | ✓ |
| `zod-to-json-schema` | 3.25.2 | ISC |  |

---

Generated from `package.json` and the `package.json` of each installed dependency. A package that declares its licence incorrectly is reported incorrectly here — this is a faithful reading of what is on disk, not a legal opinion.
