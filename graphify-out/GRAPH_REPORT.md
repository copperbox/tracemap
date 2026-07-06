# Graph Report - workspace  (2026-07-06)

## Corpus Check
- 200 files · ~71,179 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 831 nodes · 2059 edges · 39 communities (38 shown, 1 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 25 edges (avg confidence: 0.78)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `be8cdfe2`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Web API Client & Drawer UI|Web API Client & Drawer UI]]
- [[_COMMUNITY_Server Error Aggregation API|Server Error Aggregation API]]
- [[_COMMUNITY_App Shell & Global State|App Shell & Global State]]
- [[_COMMUNITY_Force Graph & Dimming|Force Graph & Dimming]]
- [[_COMMUNITY_UI Icons & Components|UI Icons & Components]]
- [[_COMMUNITY_Packet Animation Canvas|Packet Animation Canvas]]
- [[_COMMUNITY_Topology Generator (Sim)|Topology Generator (Sim)]]
- [[_COMMUNITY_Map Animation Frames|Map Animation Frames]]
- [[_COMMUNITY_Service Panel Skeletons|Service Panel Skeletons]]
- [[_COMMUNITY_Server Dependencies|Server Dependencies]]
- [[_COMMUNITY_Web Dependencies|Web Dependencies]]
- [[_COMMUNITY_Form Controls & Filters|Form Controls & Filters]]
- [[_COMMUNITY_OTLP Protobuf Codec|OTLP Protobuf Codec]]
- [[_COMMUNITY_Map Edge & Dot Layers|Map Edge & Dot Layers]]
- [[_COMMUNITY_Sim HTTP & Metrics Emitter|Sim HTTP & Metrics Emitter]]
- [[_COMMUNITY_Charts & Hover Sync|Charts & Hover Sync]]
- [[_COMMUNITY_Service Registry (OTLP)|Service Registry (OTLP)]]
- [[_COMMUNITY_OTLP Ingest & Normalization|OTLP Ingest & Normalization]]
- [[_COMMUNITY_TopBar.tsx|TopBar.tsx]]
- [[_COMMUNITY_Simulated Error Catalog|Simulated Error Catalog]]
- [[_COMMUNITY_Sim Trace Payloads|Sim Trace Payloads]]
- [[_COMMUNITY_Map Camera & PanZoom|Map Camera & Pan/Zoom]]
- [[_COMMUNITY_Span Edge Resolver|Span Edge Resolver]]
- [[_COMMUNITY_usePanZoom.ts|usePanZoom.ts]]
- [[_COMMUNITY_compilerOptions|compilerOptions]]
- [[_COMMUNITY_TopBar.tsx|TopBar.tsx]]
- [[_COMMUNITY_status.ts|status.ts]]
- [[_COMMUNITY_useForceSimulation.ts|useForceSimulation.ts]]
- [[_COMMUNITY_spanPalette.ts|spanPalette.ts]]
- [[_COMMUNITY_Sim Rate Control|Sim Rate Control]]
- [[_COMMUNITY_ChartGrid.tsx|ChartGrid.tsx]]
- [[_COMMUNITY_Sim CLI Args|Sim CLI Args]]
- [[_COMMUNITY_Theme Contrast|Theme Contrast]]
- [[_COMMUNITY_Theme Fonts|Theme Fonts]]
- [[_COMMUNITY_Web HTML Entry|Web HTML Entry]]
- [[_COMMUNITY_ServicePage.tsx|ServicePage.tsx]]

## God Nodes (most connected - your core abstractions)
1. `useStore` - 30 edges
2. `query()` - 29 edges
3. `fmtMs()` - 26 edges
4. `LayeredMap()` - 24 edges
5. `fmtRps()` - 18 edges
6. `GraphNode` - 18 edges
7. `MapDrawer()` - 17 edges
8. `fmtErr()` - 16 edges
9. `GraphEdge` - 15 edges
10. `ingestTraces()` - 14 edges

## Surprising Connections (you probably didn't know these)
- `ingestTraces()` --indirect_call--> `span()`  [INFERRED]
  server/src/otlp/ingest.ts → web/src/features/trace/buildRows.test.ts
- `Combobox()` --calls--> `pick()`  [INFERRED]
  web/src/components/Combobox.tsx → server/src/sim/random.ts
- `computeFocusSet()` --calls--> `walk()`  [INFERRED]
  web/src/features/map/view/focusSet.ts → server/src/sim/trace.ts
- `buildRows()` --calls--> `walk()`  [INFERRED]
  web/src/features/trace/buildRows.ts → server/src/sim/trace.ts
- `main()` --indirect_call--> `otlpRoutes()`  [INFERRED]
  server/src/index.ts → server/src/otlp/routes.ts

## Import Cycles
- None detected.

## Communities (39 total, 1 thin omitted)

### Community 0 - "Web API Client & Drawer UI"
Cohesion: 0.15
Nodes (13): ErrorBreakdown, ErrorCount, LiveMetrics, NeighborEdge, OperationErrors, SeriesPoint, ServiceDetail, ServiceList (+5 more)

### Community 1 - "Server Error Aggregation API"
Cohesion: 0.08
Nodes (48): errorRoutes(), Row, toRows(), aggregateErrors(), ErrorCount, ErrorSig, errorSignature(), ErrorSpanRow (+40 more)

### Community 2 - "App Shell & Global State"
Cohesion: 0.08
Nodes (23): dependencies, fastify, @fastify/cors, pg, protobufjs, devDependencies, tsx, @types/node (+15 more)

### Community 3 - "Force Graph & Dimming"
Cohesion: 0.13
Nodes (19): ForceGraph(), Palette, buildForceLinks(), buildForceNodes(), nodeRadius(), buildDimmer(), graph, group() (+11 more)

### Community 4 - "UI Icons & Components"
Cohesion: 0.07
Nodes (30): Status, TopologyService, BackIcon(), ChevronIcon(), CloseIcon(), CommunityGraphIcon(), FitIcon(), FlowGraphIcon() (+22 more)

### Community 5 - "Packet Animation Canvas"
Cohesion: 0.08
Nodes (35): EdgeLayer(), EdgeView, base, geom, geoms, fadeEnvelope(), mod1(), PacketSample (+27 more)

### Community 6 - "Topology Generator (Sim)"
Cohesion: 0.11
Nodes (28): BACKEND_WORDS, buildTopology(), clamp(), GenTopology, INFRA_KINDS, LANGS, opsFor(), pickOne() (+20 more)

### Community 7 - "Map Animation Frames"
Cohesion: 0.24
Nodes (9): easeOut(), useGraphTransition(), GraphNode, centerOn(), computeGraphTransition(), GhostNode, GraphSnapshot, GraphTransition (+1 more)

### Community 8 - "Service Panel Skeletons"
Cohesion: 0.08
Nodes (23): dependencies, d3-force, react, react-dom, zustand, devDependencies, @types/d3-force, @types/react (+15 more)

### Community 9 - "Server Dependencies"
Cohesion: 0.09
Nodes (41): Topology, App(), TopBar(), MapView(), ServicePage(), TimeRangePicker(), toLocalInput(), DEFAULT_PREFS (+33 more)

### Community 10 - "Web Dependencies"
Cohesion: 0.38
Nodes (5): buildEdgeViews(), CommunityEdge, CommunityResult, detectCommunities(), e()

### Community 11 - "Form Controls & Filters"
Cohesion: 0.15
Nodes (16): Team, Combobox(), TeamFilter(), TeamChips(), EditServiceModal(), TYPES, Field(), ComboOption (+8 more)

### Community 12 - "OTLP Protobuf Codec"
Cohesion: 0.06
Nodes (52): anyValueToJs(), decodeMetrics(), decodeTraces(), encodeMetricsResponse(), encodeTraceResponse(), idToHex(), kvListToObject(), loadRoot() (+44 more)

### Community 13 - "Map Edge & Dot Layers"
Cohesion: 0.33
Nodes (12): TYPE_LABELS, HealthPopover(), NodeCard(), EdgeLabelLayer(), KpiCards(), NeighborsPanel(), HEADERS, ServicesPage() (+4 more)

### Community 14 - "Sim HTTP & Metrics Emitter"
Cohesion: 0.23
Nodes (17): postJson(), sendMetricsSample(), hex(), pick(), rand(), ARGS, attachKeyboard(), main() (+9 more)

### Community 15 - "Charts & Hover Sync"
Cohesion: 0.24
Nodes (14): BigChart(), ChartSeries, HoverSync(), HoverSyncContext, HoverSyncValue, useHoverFrac(), Sparkline(), SparkRow() (+6 more)

### Community 16 - "Service Registry (OTLP)"
Cohesion: 0.15
Nodes (13): api, SloRing(), Card(), FooterButton(), GhostChip(), KpiGrid(), useEdgeOps(), SparkData (+5 more)

### Community 17 - "OTLP Ingest & Normalization"
Cohesion: 0.15
Nodes (18): LayeredMap(), dotAlphaScale(), buildFrameViews(), FrameView, IsolateBanner(), Legend(), Bounds, nodeCardBounds() (+10 more)

### Community 18 - "TopBar.tsx"
Cohesion: 0.15
Nodes (10): team, clusterOf(), depsWithin(), dimsOf(), layoutClusteredGraph(), layoutFlatGraph(), Rect, layoutGraph() (+2 more)

### Community 19 - "Simulated Error Catalog"
Cohesion: 0.15
Nodes (14): ELASTIC_ERRORS, errorFor(), EXTERNAL_ERRORS, GENERIC_EXTERNAL, HTTP_EXCEPTIONS, httpError(), KAFKA_ERRORS, PG_ERRORS (+6 more)

### Community 20 - "Sim Trace Payloads"
Cohesion: 0.23
Nodes (12): exportPayload(), toAnyValue(), BASE_ROOTS, byId, DEPS, ERROR_RATE, LATENCY_MULTIPLIER, clientAttrsFor() (+4 more)

### Community 21 - "Map Camera & Pan/Zoom"
Cohesion: 0.12
Nodes (16): compilerOptions, declaration, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, outDir (+8 more)

### Community 22 - "Span Edge Resolver"
Cohesion: 0.29
Nodes (7): TraceDetail, TraceSpan, buildRows(), Row, span(), SpanRow(), TraceModal()

### Community 23 - "usePanZoom.ts"
Cohesion: 0.25
Nodes (10): centerTransform(), fitZoom(), box, center(), Transform, usePanZoom(), ViewBounds, rectsOverlap() (+2 more)

### Community 24 - "compilerOptions"
Cohesion: 0.14
Nodes (13): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, jsx, lib, module, moduleResolution, noEmit (+5 more)

### Community 25 - "TopBar.tsx"
Cohesion: 0.12
Nodes (11): ServiceType, ServiceRegistry, LoadRow, { queryMock }, initialResource(), ResourceAction, resourcePhase, resourceReducer() (+3 more)

### Community 26 - "status.ts"
Cohesion: 0.39
Nodes (4): StatusPill(), ForceLegend(), stColor(), stLabel()

### Community 27 - "useForceSimulation.ts"
Cohesion: 0.26
Nodes (9): ClusterDatum, clusterForce, communityCentroids(), ForceLinkInput, ForceNodeInput, hash01(), SimLink, SimNode (+1 more)

### Community 28 - "spanPalette.ts"
Cohesion: 0.33
Nodes (8): communityColor(), communityHue, FORBIDDEN, inAnyBand(), buildSpanColors(), paletteColor(), paletteHue(), ThemeName

### Community 29 - "Sim Rate Control"
Cohesion: 0.35
Nodes (3): applyKey(), clamp(), RateControl

### Community 30 - "ChartGrid.tsx"
Cohesion: 0.25
Nodes (9): errLevel(), rangeEdgeLabels(), BAR_COLORS, ChartGrid(), LEGEND, HEADERS, OperationsTable(), isLiveRange() (+1 more)

### Community 31 - "Sim CLI Args"
Cohesion: 0.67
Nodes (4): argOf(), numOf(), parseSimArgs(), SimArgs

### Community 33 - "Theme Contrast"
Cohesion: 0.40
Nodes (4): contrast(), css, light, luminance()

### Community 35 - "Web HTML Entry"
Cohesion: 0.67
Nodes (3): TraceMap Web App HTML Entry, React Root Mount Element, main.tsx Frontend Entry Module

### Community 38 - "ServicePage.tsx"
Cohesion: 0.18
Nodes (14): TraceListItem, ServiceHeader(), ChartSkeleton(), ErrorsSkeleton(), HeaderSkeleton(), KpiSkeleton(), NeighborsSkeleton(), OperationsSkeleton() (+6 more)

## Knowledge Gaps
- **171 isolated node(s):** `name`, `version`, `private`, `type`, `dev` (+166 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `span()` connect `Span Edge Resolver` to `OTLP Protobuf Codec`?**
  _High betweenness centrality (0.192) - this node is a cross-community bridge._
- **Why does `ingestTraces()` connect `OTLP Protobuf Codec` to `Server Error Aggregation API`, `Span Edge Resolver`?**
  _High betweenness centrality (0.192) - this node is a cross-community bridge._
- **Why does `walk()` connect `Sim HTTP & Metrics Emitter` to `Force Graph & Dimming`, `Simulated Error Catalog`, `Sim Trace Payloads`, `Span Edge Resolver`?**
  _High betweenness centrality (0.158) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `LayeredMap()` (e.g. with `loadPinnedPositions()` and `centerOn()`) actually correct?**
  _`LayeredMap()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _171 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Server Error Aggregation API` be split into smaller, more focused modules?**
  _Cohesion score 0.07663828211773417 - nodes in this community are weakly interconnected._
- **Should `App Shell & Global State` be split into smaller, more focused modules?**
  _Cohesion score 0.08333333333333333 - nodes in this community are weakly interconnected._