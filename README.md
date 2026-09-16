# @pipeworx/japan-procurement

Japanese government tender notices — bid announcements from national ministries,
all 47 prefectures and municipalities, sourced from the 官公需情報ポータルサイト
(Kankōju public procurement portal) run by the Japan Small and Medium Enterprise
Agency.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1576+ live data sources.

## Tools

- `japan_tenders_search(query, …)` — keyword search across every publishing
  body. Accepts Japanese or ASCII and the portal's operators
  (`AND` / `OR` / `ANDNOT` / `NOT`, parentheses). Filters: category, prefecture,
  procedure type, organisation, notice title, announcement-date range.
- `japan_tenders_by_prefecture(prefecture, …)` — browse a prefecture's notices
  with no keyword. Takes `"Tokyo"`, `"東京都"` or `"13"`, comma-separated for
  several.
- `japan_tenders_by_organization(organization_name, …)` — everything a named
  buyer published (`"国土交通省"`, `"横浜市"`), partial match.
- `japan_tender_reference()` — the accepted categories, procedure types and all
  47 JIS X0401 prefecture codes. Call it when a filter value is rejected.

Every notice carries the buyer, title, announcement date, the original notice
URL, attachment links, and — where the publisher supplied them — the bid
submission date, opening date, delivery deadline, performance location and
required bidder certification.

## Auth

Keyless.

## Data sources

- <https://www.kkj.go.jp/api/> — the portal's documented search API, XML.
  Spec: <https://www.kkj.go.jp/doc/ja/api_guide.pdf> (V1.1, 2016-05-27).

Things the next person would otherwise rediscover the hard way:

- **`LG_Code` must be zero-padded to two digits.** `LG_Code=1` returns
  `SearchHits=0` — a clean 200 that reads as "Hokkaido publishes no tenders".
  `LG_Code=01` returns ~50k. The pack pads for you; don't undo that.
- **`Category` must be the numeric code (1 物品 / 2 工事 / 3 役務).** Passing the
  Japanese label returns `internal error: query error: syntax error`. Same for
  `Procedure_Type` (1–3). The pack maps names and labels to codes and rejects
  anything unmappable with the valid set named, rather than forwarding it.
- **No offset or page parameter exists.** `Count` caps at 1,000 per call
  (values above that are silently treated as 1,000). To walk a larger result
  set, narrow with `CFT_Issue_Date` — the pack surfaces this as `paging` in the
  response whenever `total_hits` exceeds what it returned.
- **At least one of `Query` / `Project_Name` / `Organization_Name` / `LG_Code`
  is required**; with none the API answers `<Error>no searchword</Error>`. That
  is why the browse tools require a prefecture or an organisation.
- **`ProjectDescription` is the full extracted notice text**, routinely tens of
  thousands of characters (it is the OCR/extract of the linked PDF, and can
  include the whole unit-price schedule). The pack returns a 600-character
  preview with `description_truncated`, and up to 20,000 characters under
  `full_text: true`.
- Optional fields are omitted, not emptied, when the publisher did not supply
  them — `TenderSubmissionDeadline`, `OpeningTendersEvent`, `Location`,
  `Certification` and `ItemCode` are frequently absent, especially on municipal
  notices.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "japan-procurement": {
      "url": "https://gateway.pipeworx.io/japan-procurement/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/japan-procurement/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1576+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "japan-procurement": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-japan-procurement"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-japan-procurement
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Japan Procurement data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
