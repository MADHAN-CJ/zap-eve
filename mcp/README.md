# dhan-data MCP server

`dhan_mcp.py` is a self-contained MCP server that exposes the whole Dhan read
API through **one** tool, `run_python`: the model writes a Python script, the
server runs it with every Dhan function preloaded, and returns what it printed.

Give the model [`SKILL.md`](./SKILL.md) — that is the document that teaches it
which functions exist.

The Dhan layer is a port of `agent/lib/dhan/{client,specs,options-specs,underlying}.ts`,
including the rate limits, the `{data,status}` unwrapping, the column-oriented
candle zipping, and the "error 806 means no Data-API subscription, not a dead
token" distinction. It is read-only: there is no order path anywhere in it.

## Install

```sh
pip install "mcp[cli]" httpx        # SDK 1.x and 2.x both work
```

## Credentials

Environment variables, or a `.env` in `mcp/` or the repo root (real environment
variables win; `--env-file` points elsewhere):

```
DHAN_CLIENT_ID=...
DHAN_ACCESS_TOKEN=...      # Dhan tokens expire after 24h
DHAN_BASE_URL=...          # optional, defaults to https://api.dhan.co/v2
```

Optional knobs: `DHAN_MCP_EXEC_TIMEOUT` (seconds a script may run, default 120)
and `DHAN_MCP_MAX_OUTPUT` (characters returned, default 100000).

## Run

```sh
python mcp/dhan_mcp.py                       # stdio — what an MCP client launches
python mcp/dhan_mcp.py --http --port 8931    # streamable HTTP
python mcp/dhan_mcp.py --check               # credential + API smoke test
python mcp/dhan_mcp.py --exec 'pp(funds())'  # run one script locally
```

## Client config

```json
{
  "mcpServers": {
    "dhan-data": {
      "command": "python",
      "args": ["/absolute/path/to/zap-eve/mcp/dhan_mcp.py"],
      "env": { "DHAN_CLIENT_ID": "...", "DHAN_ACCESS_TOKEN": "..." }
    }
  }
}
```

Or, for Claude Code: `claude mcp add dhan-data -- python /absolute/path/to/zap-eve/mcp/dhan_mcp.py`

## A note on isolation

Submitted scripts run **in the server process** with full `__builtins__` — the
deliberate trade-off that lets them call the Dhan functions directly and share
the rate limiters. Anything the script does, the server process can do: run it
only with code from a model you're driving yourself, not as a public endpoint.
A script that overruns its timeout is interrupted, but a thread that ignores the
injected exception cannot be force-killed.

## Refreshing the F&O universe

`FNO_INDICES` / `FNO_STOCKS` are copied from `agent/lib/dhan/fno-underlyings.ts`,
which `scripts/gen-fno-underlyings.ts` regenerates from Dhan's scrip master.
Re-run that script and re-copy the two dicts when the F&O list changes.
