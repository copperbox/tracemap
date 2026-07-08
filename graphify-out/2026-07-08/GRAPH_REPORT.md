# Graph Report - workspace  (2026-07-08)

## Corpus Check
- 207 files · ~72,790 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 852 nodes · 2185 edges · 44 communities (42 shown, 2 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 25 edges (avg confidence: 0.78)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `4dfb715d`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_ServiceRegistry|ServiceRegistry]]
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
- [[_COMMUNITY_useStore|useStore]]
- [[_COMMUNITY_Sim HTTP & Metrics Emitter|Sim HTTP & Metrics Emitter]]
- [[_COMMUNITY_Charts & Hover Sync|Charts & Hover Sync]]
- [[_COMMUNITY_Service Registry (OTLP)|Service Registry (OTLP)]]
- [[_COMMUNITY_OTLP Ingest & Normalization|OTLP Ingest & Normalization]]
- [[_COMMUNITY_TopBar.tsx|TopBar.tsx]]
- [[_COMMUNITY_Simulated Error Catalog|Simulated Error Catalog]]
- [[_COMMUNITY_Sim Trace Payloads|Sim Trace Payloads]]
- [[_COMMUNITY_Map Camera & PanZoom|Map Camera & Pan/Zoom]]
- [[_COMMUNITY_timerange.ts|timerange.ts]]
- [[_COMMUNITY_usePanZoom.ts|usePanZoom.ts]]
- [[_COMMUNITY_compilerOptions|compilerOptions]]
- [[_COMMUNITY_preferences.ts|preferences.ts]]
- [[_COMMUNITY_clusterForce|clusterForce]]
- [[_COMMUNITY_useForceSimulation.ts|useForceSimulation.ts]]
- [[_COMMUNITY_spanPalette.ts|spanPalette.ts]]
- [[_COMMUNITY_Sim Rate Control|Sim Rate Control]]
- [[_COMMUNITY_ChartGrid.tsx|ChartGrid.tsx]]
- [[_COMMUNITY_Sim CLI Args|Sim CLI Args]]
- [[_COMMUNITY_edgeResolver.ts|edgeResolver.ts]]
- [[_COMMUNITY_Theme Contrast|Theme Contrast]]
- [[_COMMUNITY_Theme Fonts|Theme Fonts]]
- [[_COMMUNITY_Web HTML Entry|Web HTML Entry]]
- [[_COMMUNITY_ServicePage.tsx|ServicePage.tsx]]
- [[_COMMUNITY_status.ts|status.ts]]
- [[_COMMUNITY_TopologyService|TopologyService]]
- [[_COMMUNITY_index.ts|index.ts]]
- [[_COMMUNITY_payload.ts|payload.ts]]
- [[_COMMUNITY_serviceRank.ts|serviceRank.ts]]

## God Nodes (most connected - your core abstractions)
1. `useStore` - 34 edges
2. `fmtMs()` - 30 edges
3. `query()` - 29 edges
4. `LayeredMap()` - 24 edges
5. `fmtRps()` - 22 edges
6. `fmtErr()` - 20 edges
7. `GraphNode` - 18 edges
8. `MapDrawer()` - 15 edges
9. `ServiceDetails()` - 15 edges
10. `GraphEdge` - 15 edges

## Surprising Connections (you probably didn't know these)
- `ingestTraces()` --indirect_call--> `span()`  [INFERRED]
  server/src/otlp/ingest.ts → web/src/features/trace/buildRows.test.ts
- `Combobox()` --calls--> `pick()`  [INFERRED]
  web/src/components/Combobox.tsx → server/src/sim/random.ts
- `computeFocusSet()` --calls--> `walk()`  [INFERRED]
  web/src/features/map/view/focusSet.ts → server/src/sim/trace.ts
- `buildRows()` --calls--> `walk()`  [INFERRED]
  web/src/features/trace/buildRows.ts → server/src/sim/trace.ts
- `main()` --indirect_call--> `apiRoutes()`  [INFERRED]
  server/src/index.ts → server/src/api/routes.ts

## Import Cycles
- None detected.

## Communities (44 total, 2 thin omitted)

### Community 0 - "ServiceRegistry"
Cohesion: 0.16
Nodes (6): ServiceType, KnownService, registry, ServiceRegistry, LoadRow, { queryMock }

### Community 1 - "Server Error Aggregation API"
Cohesion: 0.09
Nodes (43): errorRoutes(), Row, toRows(), aggregateErrors(), ErrorCount, ErrorSig, errorSignature(), ErrorSpanRow (+35 more)

### Community 2 - "App Shell & Global State"
Cohesion: 0.08
Nodes (23): dependencies, fastify, @fastify/cors, pg, protobufjs, devDependencies, tsx, @types/node (+15 more)

### Community 3 - "Force Graph & Dimming"
Cohesion: 0.15
Nodes (11): buildDimmer(), graph, group(), svc(), Adj, computeFocusSet(), FocusSet, graph (+3 more)

### Community 4 - "UI Icons & Components"
Cohesion: 0.07
Nodes (37): TraceSpan, App(), BackIcon(), ChevronIcon(), CloseIcon(), CommunityGraphIcon(), FitIcon(), FlowGraphIcon() (+29 more)

### Community 5 - "Packet Animation Canvas"
Cohesion: 0.08
Nodes (35): EdgeLayer(), EdgeView, base, geom, geoms, fadeEnvelope(), mod1(), PacketSample (+27 more)

### Community 6 - "Topology Generator (Sim)"
Cohesion: 0.11
Nodes (27): BACKEND_WORDS, buildTopology(), clamp(), GenTopology, INFRA_KINDS, LANGS, opsFor(), pickOne() (+19 more)

### Community 7 - "Map Animation Frames"
Cohesion: 0.24
Nodes (8): easeOut(), useGraphTransition(), centerOn(), computeGraphTransition(), GhostNode, GraphSnapshot, GraphTransition, sizeOf()

### Community 8 - "Service Panel Skeletons"
Cohesion: 0.08
Nodes (23): dependencies, d3-force, react, react-dom, zustand, devDependencies, @types/d3-force, @types/react (+15 more)

### Community 9 - "Server Dependencies"
Cohesion: 0.06
Nodes (52): rangeEdgeLabels(), ChartSkeleton(), ErrorsSkeleton(), HeaderSkeleton(), KpiSkeleton(), NeighborsSkeleton(), OperationsSkeleton(), TracesSkeleton() (+44 more)

### Community 10 - "Web Dependencies"
Cohesion: 0.13
Nodes (17): api, ErrorBreakdown, ErrorCount, LiveMetrics, NeighborEdge, OperationErrors, ServiceDetail, ServiceList (+9 more)

### Community 11 - "Form Controls & Filters"
Cohesion: 0.19
Nodes (13): Team, Combobox(), TeamFilter(), TeamChips(), ComboOption, filterOptions(), OPTS, matchesTeamFilter() (+5 more)

### Community 12 - "OTLP Protobuf Codec"
Cohesion: 0.20
Nodes (19): anyValueToJs(), decodeMetrics(), decodeTraces(), encodeMetricsResponse(), encodeTraceResponse(), idToHex(), kvListToObject(), loadRoot() (+11 more)

### Community 13 - "useStore"
Cohesion: 0.18
Nodes (11): ForceGraph(), Palette, dotAlphaScale(), buildEdgeViews(), GraphModeToggle(), ZoomControls(), CommunityEdge, CommunityResult (+3 more)

### Community 14 - "Sim HTTP & Metrics Emitter"
Cohesion: 0.28
Nodes (12): postJson(), sendMetricsSample(), pick(), rand(), ARGS, attachKeyboard(), main(), rate (+4 more)

### Community 15 - "Charts & Hover Sync"
Cohesion: 0.42
Nodes (9): BigChart(), ChartSeries, useHoverFrac(), Sparkline(), fmtClock(), chartPath(), chartY(), hoverIndex() (+1 more)

### Community 16 - "Service Registry (OTLP)"
Cohesion: 0.13
Nodes (16): Topology, TopologyEdge, Card(), DepRow(), DrawerHeader(), FooterButton(), GhostChip(), KpiGrid() (+8 more)

### Community 17 - "OTLP Ingest & Normalization"
Cohesion: 0.15
Nodes (19): LayeredMap(), buildFrameViews(), FrameView, IsolateBanner(), Legend(), Bounds, nodeCardBounds(), clearPinnedPositions() (+11 more)

### Community 18 - "TopBar.tsx"
Cohesion: 0.15
Nodes (10): team, clusterOf(), depsWithin(), dimsOf(), layoutClusteredGraph(), layoutFlatGraph(), Rect, layoutGraph() (+2 more)

### Community 19 - "Simulated Error Catalog"
Cohesion: 0.15
Nodes (14): ELASTIC_ERRORS, errorFor(), EXTERNAL_ERRORS, GENERIC_EXTERNAL, HTTP_EXCEPTIONS, httpError(), KAFKA_ERRORS, PG_ERRORS (+6 more)

### Community 20 - "Sim Trace Payloads"
Cohesion: 0.22
Nodes (14): hex(), BASE_LATENCY, BASE_ROOTS, DEPS, ERROR_RATE, LATENCY_MULTIPLIER, clientAttrsFor(), errors() (+6 more)

### Community 21 - "Map Camera & Pan/Zoom"
Cohesion: 0.12
Nodes (16): compilerOptions, declaration, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, outDir (+8 more)

### Community 22 - "timerange.ts"
Cohesion: 0.25
Nodes (18): ServiceListItem, TYPE_LABELS, ForceLegend(), MapDrawer(), NodeCard(), EdgeLabelLayer(), KpiCards(), NeighborsPanel() (+10 more)

### Community 23 - "usePanZoom.ts"
Cohesion: 0.25
Nodes (10): centerTransform(), fitZoom(), box, center(), Transform, usePanZoom(), ViewBounds, rectsOverlap() (+2 more)

### Community 24 - "compilerOptions"
Cohesion: 0.14
Nodes (13): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, jsx, lib, module, moduleResolution, noEmit (+5 more)

### Community 25 - "preferences.ts"
Cohesion: 0.18
Nodes (15): NormalizedMetricPoint, NormalizedResourceSpans, NormalizedSpan, durationMs(), edgeCounts, edgeEventBuffer, flushAllForTest(), flushEdgeEvents() (+7 more)

### Community 26 - "clusterForce"
Cohesion: 0.26
Nodes (9): ClusterDatum, clusterForce, communityCentroids(), ForceLinkInput, ForceNodeInput, hash01(), SimLink, SimNode (+1 more)

### Community 27 - "useForceSimulation.ts"
Cohesion: 0.35
Nodes (8): Status, buildForceLinks(), buildForceNodes(), nodeRadius(), GraphEdge, GraphNode, UnhealthyService, RankableService

### Community 28 - "spanPalette.ts"
Cohesion: 0.33
Nodes (8): communityColor(), communityHue, FORBIDDEN, inAnyBand(), buildSpanColors(), paletteColor(), paletteHue(), ThemeName

### Community 29 - "Sim Rate Control"
Cohesion: 0.35
Nodes (3): applyKey(), clamp(), RateControl

### Community 30 - "ChartGrid.tsx"
Cohesion: 0.18
Nodes (11): SeriesPoint, HoverSync(), HoverSyncContext, HoverSyncValue, errLevel(), BAR_COLORS, ChartGrid(), LEGEND (+3 more)

### Community 31 - "Sim CLI Args"
Cohesion: 0.67
Nodes (4): argOf(), numOf(), parseSimArgs(), SimArgs

### Community 32 - "edgeResolver.ts"
Cohesion: 0.20
Nodes (6): ClientSpanInfo, EdgeObservation, EdgeResolver, HeldClient, HeldServer, PeerGuess

### Community 33 - "Theme Contrast"
Cohesion: 0.40
Nodes (4): contrast(), css, light, luminance()

### Community 35 - "Web HTML Entry"
Cohesion: 0.67
Nodes (3): TraceMap Web App HTML Entry, React Root Mount Element, main.tsx Frontend Entry Module

### Community 38 - "ServicePage.tsx"
Cohesion: 0.29
Nodes (11): attrStr(), DB_SYSTEM_TYPE, hostLabel(), hostOf(), inferOwnType(), inferPeer(), MESSAGING_TYPE, regionOf() (+3 more)

### Community 39 - "status.ts"
Cohesion: 0.35
Nodes (7): SloRing(), StatusPill(), ServiceHeader(), TracesPanel(), fmtAgo(), sloView, stLabel()

### Community 41 - "index.ts"
Cohesion: 0.52
Nodes (4): config, migrate(), MIGRATIONS_DIR, main()

### Community 42 - "payload.ts"
Cohesion: 0.67
Nodes (4): exportPayload(), toAnyValue(), byId, SimSpan

### Community 43 - "serviceRank.ts"
Cohesion: 0.40
Nodes (3): filterRankServices(), RANK, FLEET

## Knowledge Gaps
- **172 isolated node(s):** `name`, `version`, `private`, `type`, `dev` (+167 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `span()` connect `UI Icons & Components` to `preferences.ts`?**
  _High betweenness centrality (0.188) - this node is a cross-community bridge._
- **Why does `ingestTraces()` connect `preferences.ts` to `Server Error Aggregation API`, `UI Icons & Components`, `OTLP Protobuf Codec`, `ServicePage.tsx`?**
  _High betweenness centrality (0.188) - this node is a cross-community bridge._
- **Why does `walk()` connect `Sim Trace Payloads` to `Force Graph & Dimming`, `Simulated Error Catalog`, `UI Icons & Components`, `Sim HTTP & Metrics Emitter`?**
  _High betweenness centrality (0.152) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `LayeredMap()` (e.g. with `loadPinnedPositions()` and `centerOn()`) actually correct?**
  _`LayeredMap()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _172 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Server Error Aggregation API` be split into smaller, more focused modules?**
  _Cohesion score 0.0875 - nodes in this community are weakly interconnected._
- **Should `App Shell & Global State` be split into smaller, more focused modules?**
  _Cohesion score 0.08333333333333333 - nodes in this community are weakly interconnected._