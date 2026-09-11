# pi-throughput-meter

`pi-throughput-meter` is a small [Pi](https://pi.dev/) extension that displays per-turn latency and output throughput in Pi's TUI status area.

After each assistant turn it shows:

```text
TTFT 312 ms · ↓428 · 186.4 tok/s
```

- **TTFT**: milliseconds from Pi's `turn_start` event to the first streamed message update.
- **↓ tokens**: output tokens reported by the provider for the completed assistant message.
- **tok/s**: output tokens divided by the time from the first streamed update to `turn_end`.

These are client-observed measurements, so network latency, provider chunking, and Pi event timing affect the result. The extension does not report input tokens per second because input/prefill is not exposed as a token stream; TTFT is the useful observable proxy for that phase.

## Install

After the package is published:

```bash
pi install npm:@sugarforever/pi-throughput-meter
```

For local development from this repository:

```bash
pi -e ./pi-throughput-meter
```

You can also load the built entry point explicitly:

```bash
npm --prefix pi-throughput-meter run build
pi --extension ./pi-throughput-meter/dist/index.js
```

## Development

```bash
cd pi-throughput-meter
npm install
npm run check
```

## License

MIT
