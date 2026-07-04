# TraceMap

TraceMap is an observability service for incident response. It acts as an OTLP
collector, learns your company's entire service topology from the traces and
metrics your services already emit, and renders it as a live interactive
dependency map -- so you can spot an incident at its *source* instead of
working backwards from symptoms team by team.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying any code, ALWAYS run `graphify update .` to keep the graph current.
