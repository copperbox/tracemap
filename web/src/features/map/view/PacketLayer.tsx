import { packetCycle, packetDelays } from '../../../lib/flow';
import type { EdgeView } from './edgeViews';
import styles from './PacketLayer.module.css';

/**
 * Glowing packets traveling each live edge (pure CSS offset-path; the wrapper
 * carries dim/fade so the keyframes own opacity). Packet count per cycle
 * scales with the edge's measured call rate, so what you see tracks traces
 * actually being received.
 */
export function PacketLayer({ edges }: { edges: EdgeView[] }) {
  return (
    <>
      {edges
        .filter((v) => v.flowOp > 0)
        .map((v) => (
          <div key={`packet:${v.e.key}`} className={styles.edgePackets} style={{ opacity: v.flowOp }}>
            {packetDelays(v.e.key, v.e.rps).map((delay, i) => (
              <div
                key={i}
                className={styles.packet}
                style={{
                  background: v.flowStroke,
                  boxShadow: `0 0 7px 1px ${v.flowStroke}`,
                  offsetPath: `path("${v.d}")`,
                  animation: `packet ${packetCycle(v.e.rps)} linear infinite`,
                  animationDelay: delay,
                }}
              />
            ))}
          </div>
        ))}
    </>
  );
}
