import { Download, X } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { P2PStateManager } from 'syncplay-p2p-client';

// ── Transfer item type (mirrors the one used in App.tsx) ─────────────────
export interface TransferItem {
  transferId: string;
  filename: string;
  progress: number;
  sentBytes: number;
  totalSize: number;
}

// ── Props ───────────────────────────────────────────────────────────────
export interface TransfersScreenProps {
  /** Active transfers to display */
  transfers: TransferItem[];
  /** Connected state manager (for cancel) */
  stateManager: P2PStateManager | null;
  /** Callback to remove a transfer from the parent list */
  onCancelTransfer?: (transferId: string) => void;
}

// ── Formatting ──────────────────────────────────────────────────────────
function formatBytes(bytes: number): string {
  if (!bytes || !Number.isFinite(bytes)) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Component ───────────────────────────────────────────────────────────

export default function TransfersScreen({
  transfers,
  stateManager,
  onCancelTransfer,
}: TransfersScreenProps) {
  if (transfers.length === 0) {
    return (
      <View style={styles.empty}>
        <Download color="#8fa3b8" size={40} />
        <Text style={styles.emptyTitle}>No Active Transfers</Text>
        <Text style={styles.emptySubtitle}>
          File transfers will appear here when peers share media.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {transfers.map(t => {
        const pct = Math.round(t.progress * 100);
        const done = t.progress >= 1;

        return (
          <View key={t.transferId} style={styles.transferCard}>
            <View style={styles.transferInfo}>
              <Download
                color={done ? '#9be28d' : '#7fd2ff'}
                size={18}
              />
              <View style={styles.transferMeta}>
                <Text style={styles.transferName} numberOfLines={1}>
                  {t.filename}
                </Text>
                <Text style={styles.transferSize}>
                  {formatBytes(t.sentBytes)} / {formatBytes(t.totalSize)}
                  {done ? ' · Complete' : ''}
                </Text>
              </View>
            </View>

            {/* Progress bar */}
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${pct}%` as any },
                  done && styles.progressFillDone,
                ]}
              />
            </View>

            {/* Footer: percentage + cancel */}
            <View style={styles.transferFooter}>
              <Text style={styles.transferPct}>
                {pct}%
              </Text>
              {!done && stateManager && (
                <Pressable
                  style={styles.cancelButton}
                  onPress={() => {
                    stateManager.cancelTransfer(t.transferId);
                    onCancelTransfer?.(t.transferId);
                  }}
                  accessibilityLabel={`Cancel transfer of ${t.filename}`}
                >
                  <X color="#ff8a80" size={16} />
                  <Text style={styles.cancelText}>Cancel</Text>
                </Pressable>
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────

const colors = {
  bg: '#061015',
  panel: '#101d25',
  panelSoft: '#142630',
  line: '#263a47',
  text: '#edf7fb',
  muted: '#8fa3b8',
  faint: '#64788b',
  accent: '#7fd2ff',
  green: '#9be28d',
  error: '#ff8a80',
};

const styles = StyleSheet.create({
  container: {
    gap: 10,
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
    gap: 12,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
  },
  emptySubtitle: {
    color: colors.muted,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
  },
  transferCard: {
    backgroundColor: colors.panel,
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.line,
    gap: 10,
  },
  transferInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  transferMeta: {
    flex: 1,
    gap: 2,
  },
  transferName: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  transferSize: {
    color: colors.muted,
    fontSize: 12,
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.panelSoft,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: colors.accent,
  },
  progressFillDone: {
    backgroundColor: colors.green,
  },
  transferFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  transferPct: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '600',
  },
  cancelButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.error,
  },
  cancelText: {
    color: colors.error,
    fontSize: 12,
    fontWeight: '600',
  },
});
