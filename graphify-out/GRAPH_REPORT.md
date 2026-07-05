# Graph Report - workspace  (2026-07-05)

## Corpus Check
- 199 files · ~70,878 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 830 nodes · 2055 edges · 39 communities (38 shown, 1 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 25 edges (avg confidence: 0.78)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `238f7b27`
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
- [[_COMMUNITY_Cluster Layout|Cluster Layout]]
- [[_COMMUNITY_edgeResolver.ts|edgeResolver.ts]]
- [[_COMMUNITY_Pinned Node Positions|Pinned Node Positions]]
- [[_COMMUNITY_Web TS Config|Web TS Config]]
- [[_COMMUNITY_Cluster Force Simulation|Cluster Force Simulation]]
- [[_COMMUNITY_Color Palettes|Color Palettes]]
- [[_COMMUNITY_Sim Rate Control|Sim Rate Control]]
- [[_COMMUNITY_infer.ts|infer.ts]]
- [[_COMMUNITY_Sim CLI Args|Sim CLI Args]]
- [[_COMMUNITY_Force Node Builders|Force Node Builders]]
- [[_COMMUNITY_Theme Contrast|Theme Contrast]]
- [[_COMMUNITY_Theme Fonts|Theme Fonts]]
- [[_COMMUNITY_Web HTML Entry|Web HTML Entry]]
- [[_COMMUNITY_PreferencesMenu.tsx|PreferencesMenu.tsx]]

## God Nodes (most connected - your core abstractions)
1. `query()` - 29 edges
2. `useStore` - 29 edges
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
Cohesion: 0.06
Nodes (54): api, ErrorBreakdown, ErrorCount, LiveMetrics, NeighborEdge, OperationErrors, ServiceDetail, ServiceList (+46 more)

### Community 1 - "Server Error Aggregation API"
Cohesion: 0.08
Nodes (48): errorRoutes(), Row, toRows(), aggregateErrors(), ErrorCount, ErrorSig, errorSignature(), ErrorSpanRow (+40 more)

### Community 2 - "App Shell & Global State"
Cohesion: 0.22
Nodes (14): DEFAULT_RANGE, QUICK_RANGES, decodeRange(), decodeTeam(), encodeRange(), encodeTeam(), quickLabel(), rangesEqual() (+6 more)

### Community 3 - "Force Graph & Dimming"
Cohesion: 0.16
Nodes (9): graph, group(), svc(), Adj, FocusSet, graph, graph, Graph (+1 more)

### Community 4 - "UI Icons & Components"
Cohesion: 0.14
Nodes (14): BackIcon(), ChevronIcon(), CloseIcon(), CommunityGraphIcon(), FitIcon(), FlowGraphIcon(), GroupExpandIcon(), ResetLayoutIcon() (+6 more)

### Community 5 - "Packet Animation Canvas"
Cohesion: 0.08
Nodes (35): EdgeLayer(), EdgeView, base, geom, geoms, fadeEnvelope(), mod1(), PacketSample (+27 more)

### Community 6 - "Topology Generator (Sim)"
Cohesion: 0.11
Nodes (28): BACKEND_WORDS, buildTopology(), clamp(), GenTopology, INFRA_KINDS, LANGS, opsFor(), pickOne() (+20 more)

### Community 7 - "Map Animation Frames"
Cohesion: 0.14
Nodes (15): easeOut(), buildFrameViews(), FrameView, team, Bounds, nodeCardBounds(), useGraphTransition(), GraphNode (+7 more)

### Community 8 - "Service Panel Skeletons"
Cohesion: 0.08
Nodes (23): dependencies, fastify, @fastify/cors, pg, protobufjs, devDependencies, tsx, @types/node (+15 more)

### Community 9 - "Server Dependencies"
Cohesion: 0.16
Nodes (18): ChartSkeleton(), ErrorsSkeleton(), HeaderSkeleton(), KpiSkeleton(), NeighborsSkeleton(), OperationsSkeleton(), TracesSkeleton(), ChartGrid (+10 more)

### Community 10 - "Web Dependencies"
Cohesion: 0.24
Nodes (5): TopologyEdge, buildForceLinks(), buildForceNodes(), nodeRadius(), GraphEdge

### Community 11 - "Form Controls & Filters"
Cohesion: 0.19
Nodes (13): Team, Combobox(), TeamFilter(), TeamChips(), ComboOption, filterOptions(), OPTS, matchesTeamFilter() (+5 more)

### Community 12 - "OTLP Protobuf Codec"
Cohesion: 0.06
Nodes (52): anyValueToJs(), decodeMetrics(), decodeTraces(), encodeMetricsResponse(), encodeTraceResponse(), idToHex(), kvListToObject(), loadRoot() (+44 more)

### Community 13 - "Map Edge & Dot Layers"
Cohesion: 0.08
Nodes (23): dependencies, d3-force, react, react-dom, zustand, devDependencies, @types/d3-force, @types/react (+15 more)

### Community 14 - "Sim HTTP & Metrics Emitter"
Cohesion: 0.23
Nodes (17): postJson(), sendMetricsSample(), hex(), pick(), rand(), ARGS, attachKeyboard(), main() (+9 more)

### Community 15 - "Charts & Hover Sync"
Cohesion: 0.12
Nodes (24): SeriesPoint, BigChart(), ChartSeries, HoverSync(), HoverSyncContext, HoverSyncValue, useHoverFrac(), Sparkline() (+16 more)

### Community 16 - "Service Registry (OTLP)"
Cohesion: 0.12
Nodes (16): compilerOptions, declaration, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, outDir (+8 more)

### Community 17 - "OTLP Ingest & Normalization"
Cohesion: 0.14
Nodes (13): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, jsx, lib, module, moduleResolution, noEmit (+5 more)

### Community 18 - "TopBar.tsx"
Cohesion: 0.23
Nodes (8): Status, TopologyService, LogoIcon(), SearchIcon(), STATUS_NOUN, servicesByStatus(), SERVICES, UnhealthyService

### Community 19 - "Simulated Error Catalog"
Cohesion: 0.15
Nodes (14): ELASTIC_ERRORS, errorFor(), EXTERNAL_ERRORS, GENERIC_EXTERNAL, HTTP_EXCEPTIONS, httpError(), KAFKA_ERRORS, PG_ERRORS (+6 more)

### Community 20 - "Sim Trace Payloads"
Cohesion: 0.23
Nodes (12): exportPayload(), toAnyValue(), BASE_ROOTS, byId, DEPS, ERROR_RATE, LATENCY_MULTIPLIER, clientAttrsFor() (+4 more)

### Community 21 - "Map Camera & Pan/Zoom"
Cohesion: 0.26
Nodes (9): centerTransform(), fitZoom(), box, center(), Transform, ViewBounds, rectsOverlap(), visibleWorldRect() (+1 more)

### Community 22 - "Span Edge Resolver"
Cohesion: 0.18
Nodes (4): ServiceType, ServiceRegistry, LoadRow, { queryMock }

### Community 23 - "Cluster Layout"
Cohesion: 0.20
Nodes (9): clusterOf(), depsWithin(), dimsOf(), layoutClusteredGraph(), layoutFlatGraph(), Rect, layoutGraph(), LayoutInput (+1 more)

### Community 24 - "edgeResolver.ts"
Cohesion: 0.29
Nodes (8): App(), TopBar(), MapView(), EditServiceModal(), TYPES, Field(), useStore, useLiveData()

### Community 25 - "Pinned Node Positions"
Cohesion: 0.15
Nodes (20): ForceGraph(), Palette, LayeredMap(), buildDimmer(), dotAlphaScale(), buildEdgeViews(), computeFocusSet(), GraphModeToggle() (+12 more)

### Community 26 - "Web TS Config"
Cohesion: 0.28
Nodes (8): clearPinnedPositions(), loadPinnedPositions(), NodePositions, savePinnedPositions(), useMergeHandoff(), DragItem, useNodeDrag(), groupKey()

### Community 27 - "Cluster Force Simulation"
Cohesion: 0.26
Nodes (9): ClusterDatum, clusterForce, communityCentroids(), ForceLinkInput, ForceNodeInput, hash01(), SimLink, SimNode (+1 more)

### Community 28 - "Color Palettes"
Cohesion: 0.33
Nodes (8): communityColor(), communityHue, FORBIDDEN, inAnyBand(), buildSpanColors(), paletteColor(), paletteHue(), ThemeName

### Community 29 - "Sim Rate Control"
Cohesion: 0.35
Nodes (3): applyKey(), clamp(), RateControl

### Community 30 - "infer.ts"
Cohesion: 0.32
Nodes (11): Topology, LabelZoomLevel, Theme, TeamFilterValue, TimeRange, RouteState, AppState, GraphType (+3 more)

### Community 31 - "Sim CLI Args"
Cohesion: 0.67
Nodes (4): argOf(), numOf(), parseSimArgs(), SimArgs

### Community 32 - "Force Node Builders"
Cohesion: 0.36
Nodes (6): DEFAULT_PREFS, LABEL_ZOOM_LEVELS, loadPrefs(), Prefs, savePrefs(), THEMES

### Community 33 - "Theme Contrast"
Cohesion: 0.40
Nodes (4): contrast(), css, light, luminance()

### Community 35 - "Web HTML Entry"
Cohesion: 0.67
Nodes (3): TraceMap Web App HTML Entry, React Root Mount Element, main.tsx Frontend Entry Module

### Community 38 - "PreferencesMenu.tsx"
Cohesion: 0.29
Nodes (6): SettingsIcon(), ThemeIcon(), LABEL_ZOOM_OPTIONS, PreferencesMenu(), TEAM_GROUPING_OPTIONS, THEME_OPTIONS

## Knowledge Gaps
- **171 isolated node(s):** `name`, `version`, `private`, `type`, `dev` (+166 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `span()` connect `Web API Client & Drawer UI` to `OTLP Protobuf Codec`?**
  _High betweenness centrality (0.192) - this node is a cross-community bridge._
- **Why does `ingestTraces()` connect `OTLP Protobuf Codec` to `Web API Client & Drawer UI`, `Server Error Aggregation API`?**
  _High betweenness centrality (0.192) - this node is a cross-community bridge._
- **Why does `walk()` connect `Sim HTTP & Metrics Emitter` to `Web API Client & Drawer UI`, `Pinned Node Positions`, `Simulated Error Catalog`, `Sim Trace Payloads`?**
  _High betweenness centrality (0.158) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `LayeredMap()` (e.g. with `loadPinnedPositions()` and `centerOn()`) actually correct?**
  _`LayeredMap()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _171 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Web API Client & Drawer UI` be split into smaller, more focused modules?**
  _Cohesion score 0.06317103620474407 - nodes in this community are weakly interconnected._
- **Should `Server Error Aggregation API` be split into smaller, more focused modules?**
  _Cohesion score 0.07663828211773417 - nodes in this community are weakly interconnected._