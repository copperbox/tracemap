-- Reversible service merges.
--
-- Merging folds a duplicate (source) into a canonical service (target): its
-- telemetry is re-pointed and the source row is deleted. To make that undoable,
-- every merge is recorded here and each re-pointed telemetry row is tagged with
-- the merge that moved it, so an unmerge can restore exactly those rows.

-- One row per active (un-reversed) merge. The snapshots hold enough to recreate
-- the folded-in service and the surrounding edge graph exactly.
CREATE TABLE service_merges (
  id             BIGSERIAL PRIMARY KEY,
  source_id      TEXT NOT NULL,                       -- folded-in service (deleted on merge)
  target_id      TEXT NOT NULL,                       -- canonical service it was folded into
  merged_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_service JSONB NOT NULL,                      -- snapshot of the deleted services row
  edges_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb   -- edges touching source/target, pre-merge
);
CREATE INDEX service_merges_source_idx ON service_merges (source_id);
CREATE INDEX service_merges_target_idx ON service_merges (target_id);

-- Tag each re-pointed telemetry value with the merge that moved it (NULL = never
-- moved). Two columns per table because service_id and peer_service_id (and an
-- edge's source/target) can be re-pointed independently.
ALTER TABLE spans       ADD COLUMN svc_merge  BIGINT;
ALTER TABLE spans       ADD COLUMN peer_merge BIGINT;
ALTER TABLE edge_events ADD COLUMN src_merge  BIGINT;
ALTER TABLE edge_events ADD COLUMN tgt_merge  BIGINT;

-- Partial indexes stay empty until a merge happens, so they add no real cost on
-- the ingest hot path but let an unmerge find its tagged rows without a scan.
CREATE INDEX spans_svc_merge_idx       ON spans (svc_merge)        WHERE svc_merge  IS NOT NULL;
CREATE INDEX spans_peer_merge_idx      ON spans (peer_merge)       WHERE peer_merge IS NOT NULL;
CREATE INDEX edge_events_src_merge_idx ON edge_events (src_merge)  WHERE src_merge  IS NOT NULL;
CREATE INDEX edge_events_tgt_merge_idx ON edge_events (tgt_merge)  WHERE tgt_merge  IS NOT NULL;
