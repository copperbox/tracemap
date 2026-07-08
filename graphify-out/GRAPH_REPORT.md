# Graph Report - workspace  (2026-07-08)

## Corpus Check
- 206 files · ~72,800 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 850 nodes · 2181 edges · 37 communities (36 shown, 1 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 25 edges (avg confidence: 0.78)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `829dc046`
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
- [[_COMMUNITY_Sim CLI Args|Sim CLI Args]]
- [[_COMMUNITY_Theme Contrast|Theme Contrast]]
- [[_COMMUNITY_Theme Fonts|Theme Fonts]]
- [[_COMMUNITY_Web HTML Entry|Web HTML Entry]]
- [[_COMMUNITY_ServicePage.tsx|ServicePage.tsx]]

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

## Communities (37 total, 1 thin omitted)

### Community 0 - "ServiceRegistry"
Cohesion: 0.13
Nodes (10): ServiceRegistry, LoadRow, { queryMock }, initialResource(), ResourceAction, resourcePhase, resourceReducer(), ResourceState (+2 more)

### Community 1 - "Server Error Aggregation API"
Cohesion: 0.09
Nodes (43): errorRoutes(), Row, toRows(), aggregateErrors(), ErrorCount, ErrorSig, errorSignature(), ErrorSpanRow (+35 more)

### Community 2 - "App Shell & Global State"
Cohesion: 0.08
Nodes (23): dependencies, fastify, @fastify/cors, pg, protobufjs, devDependencies, tsx, @types/node (+15 more)

### Community 3 - "Force Graph & Dimming"
Cohesion: 0.12
Nodes (18): ForceGraph(), Palette, buildDimmer(), graph, group(), svc(), Adj, computeFocusSet() (+10 more)

### Community 4 - "UI Icons & Components"
Cohesion: 0.07
Nodes (25): TopologyService, ChevronIcon(), CommunityGraphIcon(), FitIcon(), FlowGraphIcon(), GroupExpandIcon(), LogoIcon(), ResetLayoutIcon() (+17 more)

### Community 5 - "Packet Animation Canvas"
Cohesion: 0.08
Nodes (35): EdgeLayer(), EdgeView, base, geom, geoms, fadeEnvelope(), mod1(), PacketSample (+27 more)

### Community 6 - "Topology Generator (Sim)"
Cohesion: 0.11
Nodes (28): BACKEND_WORDS, buildTopology(), clamp(), GenTopology, INFRA_KINDS, LANGS, opsFor(), pickOne() (+20 more)

### Community 7 - "Map Animation Frames"
Cohesion: 0.14
Nodes (13): easeOut(), FrameView, team, Bounds, useGraphTransition(), GraphNode, centerOn(), computeGraphTransition() (+5 more)

### Community 8 - "Service Panel Skeletons"
Cohesion: 0.08
Nodes (23): dependencies, d3-force, react, react-dom, zustand, devDependencies, @types/d3-force, @types/react (+15 more)

### Community 9 - "Server Dependencies"
Cohesion: 0.17
Nodes (22): LabelZoomLevel, Theme, TeamFilterValue, QUICK_RANGES, TimeRange, decodeRange(), decodeTeam(), encodeRange() (+14 more)

### Community 10 - "Web Dependencies"
Cohesion: 0.18
Nodes (10): api, TraceSpan, CloseIcon(), EditServiceModal(), TYPES, Field(), buildRows(), Row (+2 more)

### Community 11 - "Form Controls & Filters"
Cohesion: 0.19
Nodes (13): Team, Combobox(), TeamFilter(), TeamChips(), ComboOption, filterOptions(), OPTS, matchesTeamFilter() (+5 more)

### Community 12 - "OTLP Protobuf Codec"
Cohesion: 0.06
Nodes (58): config, migrate(), MIGRATIONS_DIR, main(), anyValueToJs(), decodeMetrics(), decodeTraces(), encodeMetricsResponse() (+50 more)

### Community 13 - "useStore"
Cohesion: 0.38
Nodes (8): App(), TopBar(), MapView(), ServicePage(), TraceModal(), WallboardPage(), useStore, useLiveData()

### Community 14 - "Sim HTTP & Metrics Emitter"
Cohesion: 0.23
Nodes (17): postJson(), sendMetricsSample(), hex(), pick(), rand(), ARGS, attachKeyboard(), main() (+9 more)

### Community 15 - "Charts & Hover Sync"
Cohesion: 0.32
Nodes (11): BigChart(), ChartSeries, HoverSyncContext, HoverSyncValue, useHoverFrac(), Sparkline(), fmtClock(), chartPath() (+3 more)

### Community 16 - "Service Registry (OTLP)"
Cohesion: 0.06
Nodes (67): ErrorBreakdown, ErrorCount, LiveMetrics, NeighborEdge, OperationErrors, SeriesPoint, ServiceDetail, ServiceList (+59 more)

### Community 17 - "OTLP Ingest & Normalization"
Cohesion: 0.17
Nodes (17): LayeredMap(), dotAlphaScale(), buildEdgeViews(), buildFrameViews(), IsolateBanner(), isolateGraph(), Legend(), nodeCardBounds() (+9 more)

### Community 18 - "TopBar.tsx"
Cohesion: 0.20
Nodes (9): clusterOf(), depsWithin(), dimsOf(), layoutClusteredGraph(), layoutFlatGraph(), Rect, layoutGraph(), LayoutInput (+1 more)

### Community 19 - "Simulated Error Catalog"
Cohesion: 0.15
Nodes (14): ELASTIC_ERRORS, errorFor(), EXTERNAL_ERRORS, GENERIC_EXTERNAL, HTTP_EXCEPTIONS, httpError(), KAFKA_ERRORS, PG_ERRORS (+6 more)

### Community 20 - "Sim Trace Payloads"
Cohesion: 0.23
Nodes (12): exportPayload(), toAnyValue(), BASE_ROOTS, byId, DEPS, ERROR_RATE, LATENCY_MULTIPLIER, clientAttrsFor() (+4 more)

### Community 21 - "Map Camera & Pan/Zoom"
Cohesion: 0.12
Nodes (16): compilerOptions, declaration, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, outDir (+8 more)

### Community 22 - "timerange.ts"
Cohesion: 0.29
Nodes (5): rangeEdgeLabels(), DEFAULT_RANGE, isLiveRange(), resolveRange(), base

### Community 23 - "usePanZoom.ts"
Cohesion: 0.25
Nodes (10): centerTransform(), fitZoom(), box, center(), Transform, usePanZoom(), ViewBounds, rectsOverlap() (+2 more)

### Community 24 - "compilerOptions"
Cohesion: 0.14
Nodes (13): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, jsx, lib, module, moduleResolution, noEmit (+5 more)

### Community 25 - "preferences.ts"
Cohesion: 0.33
Nodes (7): DEFAULT_PREFS, LABEL_ZOOM_FACTOR, LABEL_ZOOM_LEVELS, loadPrefs(), Prefs, savePrefs(), THEMES

### Community 26 - "clusterForce"
Cohesion: 0.60
Nodes (3): ClusterDatum, clusterForce, communityCentroids()

### Community 27 - "useForceSimulation.ts"
Cohesion: 0.22
Nodes (12): Status, buildForceLinks(), buildForceNodes(), ForceLinkInput, ForceNodeInput, nodeRadius(), hash01(), SimLink (+4 more)

### Community 28 - "spanPalette.ts"
Cohesion: 0.33
Nodes (8): communityColor(), communityHue, FORBIDDEN, inAnyBand(), buildSpanColors(), paletteColor(), paletteHue(), ThemeName

### Community 29 - "Sim Rate Control"
Cohesion: 0.35
Nodes (3): applyKey(), clamp(), RateControl

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
Nodes (13): BackIcon(), ServiceErrorsPanel(), ChartSkeleton(), ErrorsSkeleton(), HeaderSkeleton(), KpiSkeleton(), NeighborsSkeleton(), OperationsSkeleton() (+5 more)

## Knowledge Gaps
- **172 isolated node(s):** `name`, `version`, `private`, `type`, `dev` (+167 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `span()` connect `Web Dependencies` to `OTLP Protobuf Codec`?**
  _High betweenness centrality (0.189) - this node is a cross-community bridge._
- **Why does `ingestTraces()` connect `OTLP Protobuf Codec` to `Server Error Aggregation API`, `Web Dependencies`?**
  _High betweenness centrality (0.189) - this node is a cross-community bridge._
- **Why does `walk()` connect `Sim HTTP & Metrics Emitter` to `Force Graph & Dimming`, `Web Dependencies`, `Simulated Error Catalog`, `Sim Trace Payloads`?**
  _High betweenness centrality (0.152) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `LayeredMap()` (e.g. with `loadPinnedPositions()` and `centerOn()`) actually correct?**
  _`LayeredMap()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _172 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `ServiceRegistry` be split into smaller, more focused modules?**
  _Cohesion score 0.12681159420289856 - nodes in this community are weakly interconnected._
- **Should `Server Error Aggregation API` be split into smaller, more focused modules?**
  _Cohesion score 0.0875 - nodes in this community are weakly interconnected._